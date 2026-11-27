# Build context: repository root
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
RUN npm ci --workspace @ticketmanager/worker --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/worker apps/worker
RUN npm run build -w packages/shared && npm run build -w apps/worker \
  && npm prune --omit=dev --workspace @ticketmanager/worker --include-workspace-root=false

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/worker/package.json apps/worker/package.json
COPY --from=build /app/apps/worker/dist apps/worker/dist
USER node
# Healthy while the outbox sweep (every 15 s) keeps touching the heartbeat file.
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD test -n "$(find /tmp/worker-heartbeat -mmin -2 2>/dev/null)" || exit 1
CMD ["node", "apps/worker/dist/index.js"]
