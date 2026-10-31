# TERO

Private tools for everyday files — a self-hosted, family-friendly alternative to online "compress my PDF" websites.
Drop a file, choose what you need, download the result. Nothing leaves your own machine.

**Full code-level explanation:** see `functionalityRead.md`.

**Today TERO can:** compress images (with presets), resize, convert JPG/PNG/WebP, strip private metadata, turn an image into a PDF,
compress PDFs (by re-encoding embedded photos), compress Word files (pictures inside), compress video, and extract audio from video.
An admin area shows uploads, jobs, storage, audit logs and a **Vault** of files the administrator keeps on purpose.

## Architecture

```
apps/
  web/   Next.js 16 · React 19 · Tailwind 4 · typed API client      (port 3000)
  api/   Express 5 · TypeScript · Prisma · MySQL                      (port 4000)
docs/    API.md (generated) · repository-audit.md · performance-report.md
legacy/  archived pre-2.0 code (reference only)
```

The browser talks only to the Next.js origin; `/api/*` is proxied to the API, so the admin cookie is first-party.

```
HTTP route (zod validation) → controller → service → repository → Prisma → MySQL
                                   ↓
                              job queue → processor (image | pdf | document | video) → storage service
```

* **Controllers** (`src/http`) handle HTTP only. **Services** hold business rules. **Repositories** are the only code that touches Prisma and are timed individually.
* **Processors** (`src/processors`) implement one contract (`validate`, `outputExtensionFor`, `process`, `cleanup`) and never see HTTP.
* **Storage service** (`src/storage`) is the only code that touches file bytes. It exposes `save/importFile/read/exists/delete/getMetadata/materialize` over four logical areas — `TEMPORARY`, `ORIGINAL`, `PROCESSED`, `VAULT` — and has two drivers chosen by `STORAGE_DRIVER`:
  * **`mysql` (default):** bytes are stored in MySQL (`StorageObject` + `StorageChunk`, 4 MB `MEDIUMBLOB` chunks), so everything is visible in MySQL Workbench and backed up with the database. A small local scratch folder (`FILE_STORAGE_PATH/temporary`) holds files only while a job runs, then they are deleted.
  * **`local`:** bytes live on disk under `FILE_STORAGE_PATH` (`originals/ processed/ vault/`).
  Switching an existing install: `npm run storage:to-mysql -w apps/api` copies disk files into MySQL.
* **Jobs** run in an in-process queue (`JOB_CONCURRENCY`), never inside the HTTP request. State of record lives in MySQL; after a restart queued jobs are re-queued and interrupted ones are marked failed.

### Database (MySQL, Prisma migrations)

| Table | Purpose |
| --- | --- |
| `Admin`, `AdminSession` | Admin accounts (bcrypt) and server-side sessions (only an HMAC of the cookie token is stored) |
| `File` | Metadata for temporary uploads **and** processor outputs (`role` = UPLOAD/OUTPUT), checksum, status, `expiresAt` |
| `ProcessingJob` | Operation, options, status, progress, sizes, duration, error, result info, link to output `File` |
| `VaultFile` | Files the admin intentionally keeps (never touched by retention) |
| `AuditLog` | Admin actions (no secrets) |
| `StorageObject`, `StorageChunk` | File bytes when `STORAGE_DRIVER=mysql` |
| `ImageResult`, `PdfResult`, `DocumentResult`, `VideoResult` | One row per finished job of that tool (dimensions, images recompressed, video duration, …), written in the same transaction that completes the job; each tool has its own migration |

Indexes (all verified with `EXPLAIN`, see `docs/performance-report.md`): `File(createdAt)`, `File(status,createdAt)`, `File(category,createdAt)`, `File(role,createdAt)`,
`File(expiresAt,status)` (retention scan), `File(checksum)`, `ProcessingJob(status,createdAt)`, `ProcessingJob(createdAt)`, `ProcessingJob(fileId)`, `ProcessingJob(operation,createdAt)`,
`AuditLog(createdAt)`, `AuditLog(adminId,createdAt)`, `AuditLog(action,createdAt)`, `AuditLog(entityType,entityId)`, `VaultFile(createdAt)`, `VaultFile(category,createdAt)`,
`AdminSession(tokenHash)` unique, `AdminSession(expiresAt)`.

Lists order by `(sortField, id)` in the **same direction** so MySQL can walk the `(…, createdAt)` index backwards instead of filesorting — this took the default admin file list from ~104 ms to ~12 ms on 20,000 rows.

## Prerequisites

* Node.js 20+ (developed on 24) and npm 10+
* MySQL 8 (a local server, or Docker — see below)
* FFmpeg + ffprobe on `PATH` (or set `FFMPEG_PATH` / `FFPROBE_PATH`) — only needed for video operations

### MySQL

Use any MySQL 8 server. MySQL Workbench is a *client*; it does not include a server. Easiest options:

```bash
# Docker (no install)
docker run -d --name tero-mysql -e MYSQL_ROOT_PASSWORD=tero_dev_root -e MYSQL_DATABASE=tero -p 3306:3306 mysql:8.4
```

or install "MySQL Community Server" and create a database: `CREATE DATABASE tero CHARACTER SET utf8mb4;`

### FFmpeg

Windows: `winget install Gyan.FFmpeg` · macOS: `brew install ffmpeg` · Debian/Ubuntu: `sudo apt install ffmpeg`. Open a new terminal afterwards.

## Setup from scratch

```bash
npm install                                  # installs both apps (npm workspaces)

cp apps/api/.env.example apps/api/.env       # then edit: DATABASE_URL, SESSION_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
cp apps/web/.env.example apps/web/.env.local # optional (API_URL, default http://localhost:4000)

npx prisma generate --schema apps/api/prisma/schema.prisma   # or: npm run db:generate
npm run db:create -w apps/api                # creates the database from DATABASE_URL if it does not exist
npm run db:migrate                           # dev: applies migrations (prisma migrate dev)
npm run db:seed                              # creates/updates the admin from ADMIN_EMAIL / ADMIN_PASSWORD
```

Production deployments use `npm run db:deploy` (`prisma migrate deploy`) — never `db push`.

Environment is validated at startup with a readable error listing every problem (missing `DATABASE_URL`, `SESSION_SECRET` shorter than 32 chars, …).
Real secrets live only in `.env` files, which are git-ignored.

### Environment variables (`apps/api/.env`)

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | – (required) | `mysql://USER:PASSWORD@localhost:3306/tero` |
| `SESSION_SECRET` | – (required) | ≥ 32 chars; keys the HMAC of session tokens |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | – | Used by `db:seed` only; password ≥ 12 chars, never stored in plaintext |
| `STORAGE_DRIVER` | `mysql` | `mysql` = bytes in the database, `local` = bytes on disk |
| `FILE_STORAGE_PATH` | `./storage` | `local`: all files. `mysql`: only short-lived scratch files in `temporary/` |
| `MAX_UPLOAD_SIZE_MB` / `VAULT_MAX_SIZE_MB` | 500 / 2000 | |
| `FILE_RETENTION_DAYS` | 7 | Temporary files and results expire after this |
| `CLEANUP_INTERVAL_MINUTES` | 60 | Scheduled cleanup |
| `JOB_CONCURRENCY` | 2 | Parallel jobs |
| `VIDEO_TIMEOUT_MINUTES` | 60 | FFmpeg hard limit |
| `SLOW_REQUEST_MS` / `SLOW_QUERY_MS` | 500 / 100 | Warn thresholds in the structured log |
| `APP_ORIGIN` | `http://localhost:3000` | Comma-separated browser origins allowed for admin mutations (the host the browser used is also accepted) |
| `COOKIE_SECURE` | prod: true | Set `false` to use the admin login over plain HTTP on a trusted home network |
| `RATE_LIMIT_ENABLED` | true | |

## Run

```bash
npm run dev        # API on :4000 and web on :3000 together
```

Open <http://localhost:3000>. Admin: <http://localhost:3000/admin> (sign in with the seeded credentials).

Production:

```bash
npm run build
NODE_ENV=production npm start        # session cookie becomes Secure — serve over HTTPS (reverse proxy)
```

Run the retention job manually (e.g. from cron / Task Scheduler): `npm run cleanup -w apps/api`.
The API also runs it on a timer, and admins can trigger it from **Admin → Storage**.

## Tests and checks

```bash
npm test               # 137 API tests against a real MySQL test database (tero_test, created automatically)
npm run lint           # ESLint (api + web)
npm run typecheck      # tsc --noEmit (api + web)
npm run build          # production builds
npm run test:perf -w apps/api    # opt-in: seeds 20k rows, measures latency and runs EXPLAIN (writes docs/performance-measurements.json)
npm run docs:api -w apps/api     # regenerate docs/API.md
```

The test DB name must contain `test`; override the connection with `TEST_DATABASE_URL`. Video tests need FFmpeg on `PATH`.
Suites: upload, jobs/processors (incl. real FFmpeg), admin auth, admin files/jobs/dashboard, vault, audit, retention, security, database (constraints, transactions, indexes), OpenAPI drift, end-to-end workflow.

## API

`/api/v1/...`, versioned and documented: [`docs/API.md`](docs/API.md) (generated) and live OpenAPI at `GET /api/v1/openapi.json`.
A test fails if a route exists that is not documented (or vice versa).

Envelope: `{ "success": true, "data": …, "meta": … }` or `{ "success": false, "error": { "code": "FILE_TOO_LARGE", "message": "…" } }`.

Family flow:

```
POST /api/v1/files/upload            multipart "file"  → { file, suggestedOperations }
POST /api/v1/jobs                    { fileId, operation, options } → 202 { jobId, status: "QUEUED" }
GET  /api/v1/jobs/:id                → { status, progress, originalSizeBytes, outputSizeBytes, savingPercent, processingDurationMs, downloadUrl }
GET  /api/v1/jobs/:id/download       → file
DELETE /api/v1/files/:id             → remove now
```

## Security model

* **Uploads:** size limit while streaming; type detected from **magic bytes** against an allow-list (JPEG, PNG, WebP, PDF, DOCX, MP4/MOV/WebM/MKV/AVI); the client extension must match the content (`invoice.pdf` that is really a PNG is rejected); Content-Type is never trusted; executables are unsupported by construction.
* **Names/paths:** user file names are sanitised and kept only as display metadata. Physical names are generated UUIDs; the storage service rejects anything else and verifies the resolved path stays inside its area. Downloads resolve **only from database ids**.
* **FFmpeg:** `spawn` with argument arrays, timeout, cancellation; no shell.
* **Admin:** bcrypt password hashes, server-side sessions (new random token per login, HMAC stored, expiry, logout invalidates), `HttpOnly` + `SameSite=Lax` (+ `Secure` in production) cookie, login throttling (5 failures / 15 min per IP+email) plus per-IP rate limit, constant-time-ish unknown-user handling, `Origin` check on state-changing admin requests. **Every** admin route is guarded in the backend.
* **Family access model:** there are no user accounts. File and job ids are random UUIDv4 capability tokens; anyone holding one can download that result. Files are deleted after `FILE_RETENTION_DAYS`.
* **Errors:** one handler; no stack traces to clients. Logs are structured JSON with request ids and never include passwords, cookies or file contents.
* Vault downloads are always `attachment` with `nosniff`; unknown content is served as `application/octet-stream`. Executable/script extensions cannot be stored.

## Retention

`expiresAt = upload time + FILE_RETENTION_DAYS` on every temporary file and result. The cleanup job (timer, CLI, or admin button) deletes bytes, marks the row `DELETED`, **keeps the metadata** (name, type, size, checksum, jobs) for analytics, and tolerates already-missing files, locked files (retried next run), and jobs still in progress. It also fails jobs stuck in `PROCESSING`, removes stale scratch files and expired admin sessions.
The vault lives in its own table/directory and is never visited by cleanup.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Invalid environment configuration` at start | Fill the listed variables in `apps/api/.env` |
| `Can't reach database server` | MySQL not running / wrong `DATABASE_URL` (`docker start tero-mysql`) |
| Video jobs fail with "Video tools are not installed" | Install FFmpeg and open a new terminal, or set `FFMPEG_PATH`/`FFPROBE_PATH` |
| Admin login says too many attempts | Wait 15 minutes (or restart the API in development) |
| Tests skip/fail on DB | Ensure the MySQL user can create `tero_test`; set `TEST_DATABASE_URL` |
| `EADDRINUSE` on 3000/4000 | Another instance is running; stop it or change `PORT` / `next start -p` |

## Limitations (honest list)

* Not implemented yet: PDF merge/split/convert/Word→PDF/watermark/protect/unlock, audio tools, video convert/trim, batch uploads, multi-file operations. The UI only offers what the backend can do.
* PDF compression only recompresses embedded **DCT (JPEG) RGB/Gray** images; vector/text-only PDFs are returned unchanged (and the result says so). It is not Ghostscript.
* The job queue is in-process (single API instance). Rate limiting and login throttling are in-memory.
* Name search uses `LIKE '%…%'` (full scan, ~90 ms at 20k rows); deep pagination uses `OFFSET`.
* Not tested here: the production `Secure` cookie flow over real HTTPS, S3/R2 storage (only the interface exists), Windows file-locking behaviour beyond a simulated locked file.
