#!/bin/sh
# Runs before nginx starts (official image hook). Serves HTTPS when certificates are present,
# otherwise plain HTTP. Reloads every 6 hours so renewed certificates are picked up.
set -eu
mkdir -p /etc/nginx/templates
rm -f /etc/nginx/conf.d/default.conf /etc/nginx/templates/*.template
if [ -s /etc/nginx/certs/fullchain.pem ] && [ -s /etc/nginx/certs/privkey.pem ]; then
  case "${PUBLIC_URL:-}" in
    https://*) ;;
    *) echo "pick-config: certificates found but PUBLIC_URL is not https://; set it in .env" >&2; exit 1 ;;
  esac
  cp /etc/nginx/https.conf.template /etc/nginx/templates/default.conf.template
  echo "pick-config: HTTPS on, redirecting HTTP to ${PUBLIC_URL}"
  (while sleep 21600; do nginx -s reload 2>/dev/null || true; done) &
else
  cp /etc/nginx/http.conf.template /etc/nginx/templates/default.conf.template
  echo "pick-config: no certificates in /etc/nginx/certs, serving plain HTTP"
fi
