#!/usr/bin/env bash
# Writes .env for a server: asks for the domain, the first admin and the mailbox, and generates
# the database password, the sign-in secret and a first admin password.
#
#   ./deploy/setup.sh            ask each question (press Enter for the value in brackets)
#   ./deploy/setup.sh --yes      no questions: take answers from TM_* variables or the defaults
#
# Answers can also come from the environment (handy for scripts):
#   TM_DOMAIN, TM_ADMIN_EMAIL, TM_ADMIN_NAME, TM_MAIL (none | gmail | microsoft | other),
#   TM_SMTP_HOST, TM_SMTP_PORT, TM_SMTP_SECURE, TM_SMTP_USER, TM_SMTP_PASSWORD, TM_TZ
#
# An existing .env is copied to .env.backup-<time> first. Its POSTGRES_PASSWORD and JWT_SECRET
# are kept: the database only knows the password it was created with, and a new JWT_SECRET
# would sign everyone out.
set -euo pipefail

cd "$(dirname "$0")/.."
yes=false
[[ "${1:-}" == "--yes" ]] && yes=true

die() {
  echo "setup: $*" >&2
  exit 1
}
command -v openssl >/dev/null || die "openssl is needed (sudo apt -y install openssl)"
[[ -f .env.example ]] || die "run this from the TicketManager folder"

# ask VAR "Question" "default" [secret]
ask() {
  local var=$1 question=$2 default=$3 secret=${4:-} answer
  local preset="${!var:-}"
  if [[ -n "$preset" ]]; then
    printf -v "$var" '%s' "$preset"
    return
  fi
  if $yes; then
    printf -v "$var" '%s' "$default"
    return
  fi
  if [[ -n "$secret" ]]; then
    read -r -s -p "$question: " answer
    echo
  else
    read -r -p "$question${default:+ [$default]}: " answer
  fi
  printf -v "$var" '%s' "${answer:-$default}"
}

# Reads KEY from a .env file, without running it.
env_value() {
  [[ -f "$2" ]] || return 0
  grep -E "^$1=" "$2" | tail -n 1 | cut -d= -f2- || true
}

# Values must not contain characters Docker Compose would read specially.
check_value() {
  [[ "$2" != *'$'* && "$2" != *'"'* && "$2" != *"'"* && "$2" != *$'\n'* ]] ||
    die "$1 can't contain \$, quotes or line breaks"
}

echo "TicketManager server setup. Press Enter to accept the value in [brackets]."
echo

# Running it again offers the current answers as the defaults.
old_url=$(env_value PUBLIC_URL .env)
old_domain=""
[[ "$old_url" == https://* ]] && old_domain=${old_url#https://}
old_email=$(env_value BOOTSTRAP_ADMIN_EMAIL .env)
[[ "$old_email" == admin@example.com ]] && old_email=""
old_name=$(env_value BOOTSTRAP_ADMIN_NAME .env)
old_tz=$(env_value TZ .env)
old_smtp_host=$(env_value SMTP_HOST .env)

ask TM_DOMAIN "Domain people will open, e.g. expenses.yourcompany.com" "$old_domain"
domain=${TM_DOMAIN#https://}
domain=${domain#http://}
domain=${domain%%/*}
[[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] ||
  die "'$TM_DOMAIN' is not a domain name like expenses.yourcompany.com"

ask TM_ADMIN_EMAIL "Your email (the first admin)" "${old_email:-admin@$domain}"
[[ "$TM_ADMIN_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] ||
  die "'$TM_ADMIN_EMAIL' is not an email address"
ask TM_ADMIN_NAME "Your name" "${old_name:-Administrator}"
check_value "Your name" "$TM_ADMIN_NAME"
ask TM_TZ "Time zone for backups" "${old_tz:-Asia/Kolkata}"

echo
echo "Which mailbox sends invitations and notifications?"
echo "  none       no real email yet (you can read them on the server with Mailpit)"
echo "  gmail      Gmail or Google Workspace, with an app password"
echo "  microsoft  Microsoft 365 / Outlook"
echo "  other      any other SMTP server"
mail_default=none
if [[ -n "$old_smtp_host" && "$old_smtp_host" != mailpit ]]; then
  echo "  keep       keep the current one ($old_smtp_host)"
  mail_default=keep
fi
ask TM_MAIL "Mailbox" "$mail_default"

smtp_host=mailpit smtp_port=1025 smtp_secure=false smtp_user='' smtp_password=''
mail_from="TicketManager <no-reply@$domain>"
case "$TM_MAIL" in
  none) ;;
  keep)
    [[ "$mail_default" == keep ]] || die "there is no mailbox to keep yet"
    smtp_host=$old_smtp_host
    smtp_port=$(env_value SMTP_PORT .env)
    smtp_secure=$(env_value SMTP_SECURE .env)
    smtp_user=$(env_value SMTP_USER .env)
    smtp_password=$(env_value SMTP_PASSWORD .env)
    mail_from=$(env_value MAIL_FROM .env)
    ;;
  gmail | microsoft | other)
    if [[ "$TM_MAIL" == gmail ]]; then
      smtp_host=smtp.gmail.com smtp_port=465 smtp_secure=true
      echo "Gmail: make an app password at https://myaccount.google.com/apppasswords (needs 2-step verification)."
    elif [[ "$TM_MAIL" == microsoft ]]; then
      smtp_host=smtp.office365.com smtp_port=587 smtp_secure=false
      echo "Microsoft 365: the mailbox needs 'Authenticated SMTP' turned on in the admin centre."
    else
      ask TM_SMTP_HOST "SMTP server" ""
      ask TM_SMTP_PORT "SMTP port (465 for SSL, 587 for STARTTLS)" "587"
      smtp_host=$TM_SMTP_HOST smtp_port=$TM_SMTP_PORT
      [[ "$smtp_port" == 465 ]] && smtp_secure=true
    fi
    ask TM_SMTP_SECURE "Use SSL from the start (true for port 465)" "$smtp_secure"
    smtp_secure=$TM_SMTP_SECURE
    ask TM_SMTP_USER "Mailbox address" "$TM_ADMIN_EMAIL"
    ask TM_SMTP_PASSWORD "Mailbox password or app password (not shown)" "" secret
    smtp_user=$TM_SMTP_USER smtp_password=${TM_SMTP_PASSWORD// /}
    [[ -n "$smtp_host" && -n "$smtp_user" && -n "$smtp_password" ]] ||
      die "the mailbox needs a server, an address and a password"
    check_value "The mailbox password" "$smtp_password"
    mail_from="TicketManager <$smtp_user>"
    ;;
  *) die "mailbox must be none, gmail, microsoft or other" ;;
esac

# Keep the secrets an existing .env already has.
pg_password=$(env_value POSTGRES_PASSWORD .env)
jwt_secret=$(env_value JWT_SECRET .env)
[[ -z "$pg_password" || "$pg_password" == change-me* ]] && pg_password=$(openssl rand -hex 24)
[[ -z "$jwt_secret" || "$jwt_secret" == change-me* ]] &&
  jwt_secret=$(openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-64)
# A new first-admin password, unless .env already has its own (or it was removed on purpose).
# Meets the password rules: 8+ characters with an uppercase letter, a number and a symbol.
admin_password="Tm-$(openssl rand -hex 6)-$(openssl rand -base64 9 | tr -d '/+=\n')#7"
if [[ -f .env ]] && [[ "$(env_value BOOTSTRAP_ADMIN_PASSWORD .env)" != "ChangeMe#2026" ]]; then
  admin_password=$(env_value BOOTSTRAP_ADMIN_PASSWORD .env)
fi

if [[ -f .env ]]; then
  saved=".env.backup-$(date +%Y%m%d-%H%M%S)"
  cp -p .env "$saved"
  echo
  echo "Saved your old settings as $saved (kept its database password and sign-in secret)."
fi

# Start from .env.example so comments and new settings come along, then set each value.
declare -A values=(
  [PUBLIC_URL]="https://$domain"
  [WEB_PORT]=80
  [HTTPS_PORT]=443
  [POSTGRES_PASSWORD]="$pg_password"
  [JWT_SECRET]="$jwt_secret"
  [BOOTSTRAP_ADMIN_EMAIL]="$TM_ADMIN_EMAIL"
  [BOOTSTRAP_ADMIN_PASSWORD]="$admin_password"
  [BOOTSTRAP_ADMIN_NAME]="$TM_ADMIN_NAME"
  [SMTP_HOST]="$smtp_host"
  [SMTP_PORT]="$smtp_port"
  [SMTP_SECURE]="$smtp_secure"
  [SMTP_USER]="$smtp_user"
  [SMTP_PASSWORD]="$smtp_password"
  [MAIL_FROM]="$mail_from"
  [TZ]="$TM_TZ"
  [GOOGLE_CLIENT_ID]="$(env_value GOOGLE_CLIENT_ID .env)"
  [GOOGLE_CLIENT_SECRET]="$(env_value GOOGLE_CLIENT_SECRET .env)"
)
tmp=$(mktemp .env.XXXXXX)
chmod 600 "$tmp"
while IFS= read -r line || [[ -n "$line" ]]; do
  line=${line%$'\r'}
  key=${line%%=*}
  if [[ "$line" == *=* && "$line" != \#* && -v "values[$key]" ]]; then
    printf '%s=%s\n' "$key" "${values[$key]}"
  else
    printf '%s\n' "$line"
  fi
done <.env.example >"$tmp"
mv "$tmp" .env
mkdir -p backups

cat <<EOF

Wrote .env (only you can read it).

  App address:     https://$domain
  First admin:     $TM_ADMIN_EMAIL
  Admin password:  ${admin_password:-(removed from .env: use the password you set)}
  Email:           $([[ "$smtp_host" == mailpit ]] && echo "not set up yet (Mailpit)" || echo "$smtp_user via $smtp_host")

Write the admin password down now. You change it after the first sign-in, then remove
BOOTSTRAP_ADMIN_PASSWORD from .env. Keep a copy of .env in a password manager: backups don't
include it.

Next:
  1. Point $domain at this machine (DNS A record).
  2. Get a certificate (docs/DEPLOY.md step 5).
  3. ./deploy/preflight.sh       checks everything
  4. docker compose up -d --build
  5. ./deploy/preflight.sh       again, to check the running app
EOF
