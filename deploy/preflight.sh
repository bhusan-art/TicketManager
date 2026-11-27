#!/usr/bin/env bash
# Checks a server before and after starting TicketManager. Run it from anywhere:
#
#   ./deploy/preflight.sh
#
# Each line says OK, WARN (works, but look at it) or FAIL (fix before going live).
# It exits with 1 when anything failed. Nothing is changed.
set -uo pipefail

cd "$(dirname "$0")/.."
fails=0 warns=0
ok() { printf '  OK    %s\n' "$*"; }
warn() {
  printf '  WARN  %s\n' "$*"
  warns=$((warns + 1))
}
fail() {
  printf '  FAIL  %s\n' "$*"
  fails=$((fails + 1))
}
section() { printf '\n%s\n' "$*"; }
env_value() { grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r'; }
# "a.b.c" >= "x.y.z"
version_at_least() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" == "$2" ]]; }

# ---------------------------------------------------------------------------------------------
section "Docker"
if ! command -v docker >/dev/null; then
  fail "Docker is not installed (docs/DEPLOY.md step 2)"
else
  compose=$(docker compose version --short 2>/dev/null | sed 's/^v//')
  if [[ -z "$compose" ]]; then
    fail "docker compose is missing (install Docker from get.docker.com)"
  elif version_at_least "$compose" 2.20; then
    ok "Docker Compose $compose"
  else
    fail "Docker Compose $compose is too old (needs 2.20 or newer)"
  fi
  docker info >/dev/null 2>&1 || fail "can't talk to Docker: is it running, and are you in the docker group?"
fi

# ---------------------------------------------------------------------------------------------
section "Settings (.env)"
running=false
if [[ ! -f .env ]]; then
  fail ".env is missing: run ./deploy/setup.sh"
else
  perms=$(stat -c %a .env 2>/dev/null || echo "?")
  [[ "$perms" == 600 || "$perms" == 400 ]] && ok ".env can only be read by you" ||
    warn ".env can be read by others (chmod 600 .env)"

  if grep -qE '^(POSTGRES_PASSWORD|JWT_SECRET)=change-me' .env; then
    fail "the example secrets are still in .env (run ./deploy/setup.sh)"
  else
    ok "database password and sign-in secret are set"
  fi
  jwt=$(env_value JWT_SECRET)
  ((${#jwt} >= 32)) || fail "JWT_SECRET is shorter than 32 characters"

  public_url=$(env_value PUBLIC_URL)
  domain=${public_url#*://}
  domain=${domain%%[:/]*}
  if [[ "$public_url" == https://* ]]; then
    ok "PUBLIC_URL is $public_url"
  else
    fail "PUBLIC_URL should be https://<your domain> on a server (now: ${public_url:-empty})"
  fi
  [[ "$(env_value WEB_PORT)" == 80 && "$(env_value HTTPS_PORT)" == 443 ]] &&
    ok "web ports are 80 and 443" ||
    warn "WEB_PORT/HTTPS_PORT are $(env_value WEB_PORT)/$(env_value HTTPS_PORT); a server normally uses 80/443"

  admin_email=$(env_value BOOTSTRAP_ADMIN_EMAIL)
  [[ "$admin_email" == admin@example.com ]] && warn "BOOTSTRAP_ADMIN_EMAIL is still admin@example.com"
  [[ "$(env_value BOOTSTRAP_ADMIN_PASSWORD)" == "ChangeMe#2026" ]] &&
    fail "BOOTSTRAP_ADMIN_PASSWORD is still the example one"

  if [[ "$(env_value SMTP_HOST)" == mailpit ]]; then
    warn "email goes to Mailpit, not a real mailbox: nobody gets invitations (set SMTP_* in .env)"
  else
    ok "email is sent through $(env_value SMTP_HOST) as $(env_value SMTP_USER)"
  fi

  if command -v docker >/dev/null &&
    [[ -n "$(docker compose ps -q --status running 2>/dev/null)" ]]; then
    running=true
  fi
fi

# ---------------------------------------------------------------------------------------------
section "Name and network"
if [[ -n "${domain:-}" && "$domain" != localhost ]]; then
  resolved=$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u | xargs)
  if [[ -z "$resolved" ]]; then
    fail "$domain doesn't resolve yet: add a DNS A record pointing at this machine"
  else
    addresses=$(hostname -I 2>/dev/null | xargs)
    mine=" $addresses "
    match=false
    for ip in $resolved; do [[ "$mine" == *" $ip "* || "$ip" == 127.* ]] && match=true; done
    if $match; then
      ok "$domain points at this machine ($resolved)"
    else
      warn "$domain points at ${resolved% }, which isn't one of this machine's addresses ($addresses). Fine behind a router or proxy that forwards to it"
    fi
  fi
fi

if command -v ss >/dev/null; then
  for port in 80 443; do
    owner=$(ss -Hltnp "sport = :$port" 2>/dev/null | head -n 1)
    # Without sudo, ss can't name the program, so ask Docker whether it is TicketManager's web.
    published=""
    if $running; then
      published=$( (docker compose port web 80 2>/dev/null; docker compose port web 443 2>/dev/null) |
        grep -c ":$port$" || true)
    fi
    program=$(grep -o 'users:(("[^"]*' <<<"$owner" | cut -d'"' -f2)
    if [[ -z "$owner" ]]; then
      $running && warn "nothing listens on port $port" || ok "port $port is free"
    elif [[ "${published:-0}" -gt 0 ]]; then
      ok "port $port is served by TicketManager"
    elif [[ "$program" == docker* ]]; then
      warn "port $port is held by another Docker container (docker ps shows which)"
    elif [[ -n "$program" ]]; then
      fail "port $port is taken by another program: $program"
    else
      fail "port $port is taken by another program (sudo ss -ltnp shows which)"
    fi
  done
fi

# ---------------------------------------------------------------------------------------------
section "Certificate"
cert=deploy/certs/fullchain.pem key=deploy/certs/privkey.pem
if [[ ! -f "$cert" || ! -f "$key" ]]; then
  warn "no certificate in deploy/certs yet: the app runs on plain HTTP until you add one (docs/DEPLOY.md step 5)"
elif ! command -v openssl >/dev/null; then
  warn "openssl isn't installed, so the certificate wasn't checked"
else
  if [[ "$(openssl x509 -in "$cert" -noout -pubkey 2>/dev/null | openssl sha256)" == \
    "$(openssl pkey -in "$key" -pubout 2>/dev/null | openssl sha256)" ]]; then
    ok "privkey.pem belongs to fullchain.pem"
  else
    fail "privkey.pem doesn't belong to fullchain.pem (or one of them is unreadable)"
  fi
  if [[ -n "${domain:-}" ]]; then
    openssl x509 -in "$cert" -noout -checkhost "$domain" 2>/dev/null | grep -q 'does match' &&
      ok "the certificate is for $domain" ||
      fail "the certificate is not for $domain: $(openssl x509 -in "$cert" -noout -subject 2>/dev/null)"
  fi
  end=$(openssl x509 -in "$cert" -noout -enddate 2>/dev/null | cut -d= -f2)
  if ! openssl x509 -in "$cert" -noout -checkend 0 >/dev/null 2>&1; then
    fail "the certificate expired on $end"
  elif ! openssl x509 -in "$cert" -noout -checkend $((14 * 86400)) >/dev/null 2>&1; then
    warn "the certificate expires within 14 days ($end): is certbot renewing it?"
  else
    ok "the certificate is valid until $end"
  fi
  [[ "$(openssl x509 -in "$cert" -noout -issuer 2>/dev/null | sed 's/^issuer=//')" == \
    "$(openssl x509 -in "$cert" -noout -subject 2>/dev/null | sed 's/^subject=//')" ]] &&
    warn "the certificate is self-signed: browsers warn and Google sign-in won't work"
fi

# ---------------------------------------------------------------------------------------------
section "Disk and backups"
free_gb=$(df -Pk . | awk 'NR==2 {printf "%d", $4 / 1048576}')
if ((free_gb < 2)); then
  fail "only ${free_gb} GB free on this disk"
elif ((free_gb < 10)); then
  warn "${free_gb} GB free on this disk; bills and backups need room to grow"
else
  ok "${free_gb} GB free on this disk"
fi
backup_dir=$(env_value BACKUP_DIR)
backup_dir=${backup_dir:-./backups}
latest=$(ls -1t "$backup_dir"/ticketmanager-*.dump 2>/dev/null | head -n 1)
if [[ -n "$latest" ]]; then
  age_h=$((($(date +%s) - $(stat -c %Y "$latest")) / 3600))
  ((age_h <= 26)) && ok "latest backup: $(basename "$latest") (${age_h} h old)" ||
    warn "latest backup is ${age_h} hours old: docker compose logs backup"
elif $running; then
  warn "no backup in $backup_dir yet (the backup service makes one within a few minutes of starting)"
fi

# ---------------------------------------------------------------------------------------------
if $running; then
  section "Running app"
  for service in postgres redis api worker web backup; do
    id=$(docker compose ps -q "$service" 2>/dev/null)
    if [[ -z "$id" ]]; then
      fail "$service is not running (docker compose up -d)"
      continue
    fi
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null)
    case "$health" in
      healthy) ok "$service is healthy" ;;
      starting) warn "$service is still starting; run this again in a minute" ;;
      *) fail "$service is $health: docker compose logs $service" ;;
    esac
  done

  if command -v curl >/dev/null && [[ -n "${domain:-}" ]]; then
    https_port=$(env_value HTTPS_PORT)
    web_port=$(env_value WEB_PORT)
    if [[ -f "$cert" ]]; then
      # Ask this machine directly, so the check works even before DNS is in place.
      body=$(curl -sk --noproxy '*' --max-time 10 --resolve "$domain:${https_port:-443}:127.0.0.1" \
        "https://$domain:${https_port:-443}/api/v1/health")
      [[ "$body" == *'"status":"ok"'* ]] && ok "https://$domain/api/v1/health answers ok" ||
        fail "the health check over HTTPS didn't answer ok: ${body:-no answer}"
      location=$(curl -s --noproxy '*' -o /dev/null -w '%{redirect_url}' --max-time 10 \
        -H "Host: $domain" "http://127.0.0.1:${web_port:-80}/")
      [[ "$location" == https://* ]] && ok "plain HTTP redirects to HTTPS" ||
        fail "plain HTTP doesn't redirect to HTTPS (got: ${location:-no redirect})"
    else
      body=$(curl -s --noproxy '*' --max-time 10 "http://127.0.0.1:${web_port:-80}/api/v1/health")
      [[ "$body" == *'"status":"ok"'* ]] && ok "the app answers on port ${web_port:-80} (HTTP only, no certificate yet)" ||
        fail "the health check didn't answer ok: ${body:-no answer}"
    fi
  fi
  if [[ -n "$(env_value BOOTSTRAP_ADMIN_PASSWORD)" ]]; then
    warn "once you've signed in and changed your password, remove BOOTSTRAP_ADMIN_PASSWORD from .env"
  fi
fi

# ---------------------------------------------------------------------------------------------
echo
if ((fails > 0)); then
  echo "$fails to fix, $warns to look at."
  exit 1
fi
((warns > 0)) && echo "Nothing to fix. $warns to look at." || echo "All good."
