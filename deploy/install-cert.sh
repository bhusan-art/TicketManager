#!/bin/sh
# Certbot deploy hook: copies the renewed certificate to deploy/certs and reloads nginx.
# certbot sets RENEWED_LINEAGE, e.g. /etc/letsencrypt/live/expenses.yourcompany.com
set -eu
dir="$(cd "$(dirname "$0")" && pwd)"
install -m 644 "$RENEWED_LINEAGE/fullchain.pem" "$dir/certs/fullchain.pem"
install -m 600 "$RENEWED_LINEAGE/privkey.pem" "$dir/certs/privkey.pem"
cd "$dir/.." && docker compose exec -T web nginx -s reload 2>/dev/null ||
  docker compose up -d web
echo "Installed the certificate from $RENEWED_LINEAGE"
