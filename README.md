# TicketManager

Expense management web app: employees submit expense vouchers, managers approve them, and Accounts
verifies and pays them. Built with PostgreSQL, Express, React and Node (TypeScript throughout).

Built so far: **Phase 0** (foundation) and **Phase 1** (sign-in, users, roles, departments).
Expense vouchers and approvals arrive in Phases 2 and 3.

## Run it on your computer (Windows, VS Code)

Install once: [Git](https://git-scm.com/download/win),
[Docker Desktop](https://www.docker.com/products/docker-desktop/) (start it and wait for
"Engine running") and [Node.js 22 LTS](https://nodejs.org/) (only needed for the tests).

In VS Code, open **Terminal → New Terminal** (PowerShell) and run:

```powershell
git clone https://github.com/bhusan-art/TicketManager.git
cd TicketManager
copy .env.example .env
```

Open `.env` and change `POSTGRES_PASSWORD`, `JWT_SECRET` and `BOOTSTRAP_ADMIN_PASSWORD`.
The defaults use these ports:

| Setting         | Value in `.env.example` | Why                                                          |
| --------------- | ----------------------- | ------------------------------------------------------------ |
| `WEB_PORT`      | `9080`                  | The port you open in the browser                             |
| `PUBLIC_URL`    | `http://localhost:9080` | Must match `WEB_PORT`; used for cookies, email links, Google |
| `POSTGRES_PORT` | `5433`                  | Avoids a clash with a PostgreSQL already installed on 5432   |

Then start everything:

```powershell
docker compose up -d --build
```

| What                   | Where                                                     |
| ---------------------- | --------------------------------------------------------- |
| App                    | http://localhost:9080                                     |
| API health             | http://localhost:9080/api/v1/health                       |
| Mail catcher (Mailpit) | http://localhost:8025 (invite and reset emails land here) |
| PostgreSQL             | localhost:5433 (database and user `ticketmanager`)        |
| Redis                  | localhost:6379                                            |

Sign in with `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` from `.env`. That admin is
created on the first start only (when there are no users). Then add departments and users under
**Users & roles**; each new user gets an email with a link to set their password.

Only the app port is open to the network; the others listen on `127.0.0.1` only.
`docker compose down` stops the stack and keeps the data; `docker compose down -v` deletes it.
To get the latest code later: `git pull`, then `docker compose up -d --build`.

To change a port, edit only `.env` (not `docker-compose.yml`), then run `docker compose up -d`.

## Develop locally

Needs Node 22 (see `.nvmrc`).

```sh
npm install
npm run services:up   # PostgreSQL, Redis and Mailpit in Docker
npm run dev:api       # http://localhost:4000
npm run dev:worker
npm run dev:web       # http://localhost:5173, proxies /api to the API
```

When running the API outside Docker, set
`DATABASE_URL=postgres://ticketmanager:<password>@localhost:5433/ticketmanager` and
`PUBLIC_URL=http://localhost:5173` (see `.env.example`).

| Command             | What it does                |
| ------------------- | --------------------------- |
| `npm run lint`      | ESLint across the repo      |
| `npm run format`    | Prettier                    |
| `npm run typecheck` | TypeScript in every package |
| `npm test`          | All tests (Vitest)          |
| `npm run build`     | Production builds           |

API tests that need PostgreSQL run when `DATABASE_URL_TEST` is set and are skipped otherwise.
They wipe that database, so use a separate one:

```powershell
npm install
docker compose exec postgres createdb -U ticketmanager tm_test     # once
$env:DATABASE_URL_TEST="postgres://ticketmanager:<password>@localhost:5433/tm_test"
npm test
```

(On macOS or Linux: `DATABASE_URL_TEST="…" npm test`.)

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
  `notFound()`, `forbidden()`, `conflict()`) from a handler; Zod and PostgreSQL errors (unique, foreign key, bad format) are converted
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
- **Auth.** `requireAuth` and `requireRole(...)` guard routes; `req.auth` holds the user id and
  active role. Idempotency keys are scoped per user.
- **Audit.** Call `recordAudit(db, { action, entityType, entityId, actorId, before, after, req })` for
  every state change. The audit log is append-only: a database trigger rejects updates and deletes.
- **Health.** `GET /api/v1/health` checks PostgreSQL and Redis (503 when either is down);
  `GET /api/v1/health/live` checks only the process.

## Sign-in, roles and permissions

- **Nobody signs up.** An admin creates each user (Users & roles) and the user gets an invite email
  to set a password (link valid 7 days). Admins can resend it, which also works as a reset.
- **Email and password.** Passwords are hashed with Argon2id and need 8+ characters, an uppercase
  letter, a number and a symbol. Five wrong passwords lock the account for 15 minutes.
  "Forgot password" emails a reset link valid for 1 hour.
- **Sessions.** A short-lived access token (15 minutes, kept in memory by the web app) plus a
  refresh token in an `httpOnly`, `SameSite=Strict` cookie (30 days). Refresh tokens rotate on every
  use, and reusing an old one signs out that sign-in everywhere. Deactivating a user or resetting a
  password signs them out at once.
- **Roles:** Employee, Manager, Accounts, Director and Admin. A user can hold several and picks the
  active one with the **Viewing as** switcher; the API checks the _active_ role
  (`requireRole('admin')`), so an admin browsing as Employee can't use admin endpoints.
- **Org chart.** Each user can have a department and a reporting manager. The manager must hold the
  Manager role, reporting loops are refused, a manager with active reports keeps the role, and the
  last active admin can't be removed.

### Google sign-in (optional)

Follow "Google sign-in setup" in the build plan to create an OAuth client, with:

- Authorized JavaScript origin: your `PUBLIC_URL`, e.g. `http://localhost:9080`
- Authorized redirect URI: `PUBLIC_URL` + `/api/v1/auth/google/callback`, e.g.
  `http://localhost:9080/api/v1/auth/google/callback`

Put the client ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then
`docker compose up -d`. The sign-in page then shows **Sign in with Google**. Only users an admin
already created can use it, and their Google email must match. Production needs a domain with
HTTPS (Google refuses private IP addresses).

## Expense vouchers

- A voucher has one or more expense lines. Money is stored as whole paise; the voucher total is the sum of its lines.
- Drafts can be incomplete. Submitting checks everything (purpose, category, date not in the future, description, amount, and for GST bills the GSTIN, invoice number and either CGST = SGST or IGST) and returns each problem with a field path like `lines.1.gstin`. The web review step runs the same check (`voucherSubmitIssues` in `packages/shared`).
- Each line needs a bill (PDF, JPG, PNG or WEBP, up to 10 MB, checked by its content, not its name) or a reason why there is none. Bills are stored in the `files` table; removing a line or voucher removes its files.
- Numbers like `EXP-2026-00001` are given on submit, restart each year (Indian time) and have no gaps.
- Where a voucher goes first: employees to their reporting manager, managers and directors to Accounts, Accounts users to the Director.
- The employee can cancel (with a reason) until Accounts starts review. Unsubmitted drafts are deleted instead.
- Every change needs the `version` the client last read, so two tabs can't overwrite each other (409 otherwise). Submit accepts an `Idempotency-Key`.
- Admins manage categories under **Categories**. Switch one off rather than deleting it.

## Database

PostgreSQL with [Drizzle ORM](https://orm.drizzle.team). Tables are defined in
`apps/api/src/db/schema.ts`; SQL migrations live in `apps/api/drizzle/` and run automatically
when the API starts.

To change the schema: edit `schema.ts`, run `npm run db:generate -w apps/api`, review the new SQL
file, and commit both. CI fails if the schema and migrations drift apart.

**Files** (receipts, proofs, exports) are stored in the `files` table, so one database backup
covers everything. Code goes through `apps/api/src/storage/files.ts` (`saveFile`, `readFile`,
`getFileInfo`, `deleteFile`, 10 MB limit per file), so files can move to S3 or disk later without
changing callers.

## Notes

- PostgreSQL uses a password from `.env` and listens only on `127.0.0.1` outside Docker. Phase 8
  adds HTTPS, backups and the Proxmox deployment runbook.
