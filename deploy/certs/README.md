# TLS certificates

Put the certificate for your domain here, then restart the web container
(`docker compose up -d web`):

- `fullchain.pem`: the certificate followed by its intermediate certificates
- `privkey.pem`: the private key

When both files exist, nginx serves HTTPS on `HTTPS_PORT` and redirects plain HTTP to
`PUBLIC_URL`, which must then start with `https://`. Without them it serves plain HTTP.

These files are ignored by git. See docs/DEPLOY.md for getting a certificate.
