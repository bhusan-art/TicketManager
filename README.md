# TicketManager

Expense management web app: employees submit expense vouchers, managers approve them, and Accounts
verifies and pays them. Built with MongoDB, Express, React and Node (TypeScript throughout).

This is **Phase 0 (foundation)**: the project layout, local stack, CI and the API conventions that
every later phase builds on. Login, vouchers and approvals arrive in Phases 1 to 3.

## Run everything with Docker

Needs Docker with Compose v2.

```sh
cp .env.example .env          # then change S3_SECRET_KEY
docker compose up -d --build
```

| What                   | Where                                                  |
| ---------------------- | ------------------------------------------------------ |
| App                    | http://localhost:8080                                  |
| API health             | http://localhost:8080/api/v1/health                    |
| Mail catcher (Mailpit) | http://localhost:8025                                  |
| MongoDB                | localhost:27017 (single-node replica set `rs0`)        |
| Redis                  | localhost:6379                                         |
| File storage (S3 API)  | http://localhost:8333 (SeaweedFS, bucket made on boot) |

Only the app port is open to the network; the others listen on `127.0.0.1` only.
`docker compose down` stops the stack and keeps the data; `docker compose down -v` deletes it.

## Develop locally

Needs Node 22 (see `.nvmrc`).

```sh
npm install
npm run services:up   # MongoDB, Redis, storage and Mailpit in Docker
npm run dev:api       # http://localhost:4000
npm run dev:worker
npm run dev:web       # http://localhost:5173, proxies /api to the API
```

When running the API outside Docker, set
`MONGO_URL=mongodb://localhost:27017/ticketmanager?directConnection=true` (see `.env.example`).

| Command             | What it does                |
| ------------------- | --------------------------- |
| `npm run lint`      | ESLint across the repo      |
| `npm run format`    | Prettier                    |
| `npm run typecheck` | TypeScript in every package |
| `npm test`          | All tests (Vitest)          |
| `npm run build`     | Production builds           |

API tests that need MongoDB run when `MONGO_URL_TEST` is set and are skipped otherwise:

```sh
MONGO_URL_TEST="mongodb://localhost:27017/tm_test?directConnection=true" npm test
```

## Layout

```
apps/api        Express REST API (/api/v1)
apps/web        React app (Vite), served by nginx in Docker
apps/worker     Background jobs on Redis (BullMQ): email now, exports and reminders later
packages/shared Types and schemas used by api, web and worker
```

## API conventions

Every endpoint in later phases follows these.

- **Base path** `/api/v1`. JSON in and out.
- **Errors** always look like
  `{ "error": { "code": "VALIDATION_FAILED", "message": "...", "details": [...], "requestId": "..." } }`.
  Codes and HTTP statuses are listed in `packages/shared/src/errors.ts`. Throw `AppError` (or
  `notFound()`, `forbidden()`, `conflict()`) from a handler; Zod and Mongoose errors are converted
  automatically, and unexpected errors return a generic 500 without internal details.
- **Request ids.** Every response has `X-Request-Id`, also included in logs and error bodies.
- **Validation** with Zod: `parseBody(schema, req)`, `parseQuery`, `parseParams`.
- **Pagination.** List endpoints take `?page=1&pageSize=20&sort=-createdAt` (max 100 per page) and
  return `{ data, meta: { page, pageSize, total, totalPages } }`. Use `paginate()` with an explicit
  list of sortable fields.
- **Idempotency.** Clients may send `Idempotency-Key` on POST/PUT/PATCH/DELETE. The first response
  is stored for 24 hours and replayed on retry (`Idempotent-Replayed: true`); the same key with a
  different body gets 422. Use it for submit, approve and payment actions so a double click or a
  network retry can't act twice.
- **Audit.** Call `recordAudit({ action, entityType, entityId, actorId, before, after, req })` for
  every state change. The audit log is append-only: updates and deletes are blocked in the model.
- **Health.** `GET /api/v1/health` checks MongoDB, Redis and storage (503 when any is down);
  `GET /api/v1/health/live` checks only the process.

## Notes

- File storage uses **SeaweedFS** with its S3 API rather than MinIO, because MinIO no longer
  publishes free container images. The API talks plain S3, so any S3-compatible store works.
- MongoDB runs without authentication inside the private Compose network for now. Phase 8 adds
  credentials, HTTPS, backups and the Proxmox deployment runbook.
