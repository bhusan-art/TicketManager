# Build context: repository root
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @ticketmanager/web --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w packages/shared && npm run build -w apps/web

FROM nginx:1.27-alpine
# HTTP or HTTPS is chosen at start by pick-config.sh (HTTPS when deploy/certs has a certificate).
COPY apps/web/nginx/common.conf apps/web/nginx/app.conf apps/web/nginx/headers.conf apps/web/nginx/proxy.conf /etc/nginx/snippets/
COPY apps/web/nginx/http.conf.template apps/web/nginx/https.conf.template /etc/nginx/
COPY --chmod=755 apps/web/nginx/pick-config.sh /docker-entrypoint.d/15-pick-config.sh
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
RUN mkdir -p /etc/nginx/certs /var/www/acme
# The official image sends access.log to stdout, so `docker compose logs web` shows requests.
EXPOSE 80 443
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1/nginx-health || exit 1
