#!/usr/bin/env bash
# Makes a self-signed certificate in deploy/certs, for trying HTTPS before you have a real one
# or for a LAN-only server. Browsers will warn until you trust it, and Google sign-in needs a
# real certificate. Usage: ./deploy/self-signed-cert.sh expenses.example.com
set -euo pipefail
host="${1:?Usage: $0 <host name, e.g. expenses.example.com>}"
cd "$(dirname "$0")/certs"
openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
  -keyout privkey.pem -out fullchain.pem -subj "/CN=$host" \
  -addext "subjectAltName=DNS:$host,DNS:localhost,IP:127.0.0.1"
chmod 600 privkey.pem
echo "Wrote deploy/certs/fullchain.pem and privkey.pem for $host."
echo "Set PUBLIC_URL=https://$host in .env, then: docker compose up -d"
