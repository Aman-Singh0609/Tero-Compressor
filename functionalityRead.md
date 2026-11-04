# TERO 2.0 — Functionality Guide (code level)

This document explains what every part of TERO does and how the pieces call each other. File paths are relative to the repository root. For setup and run instructions see `README.md`; for the endpoint list see `docs/API.md`.

---

## 1. What TERO is

A private, self-hosted file toolbox for a family. A user uploads a file, picks an operation (compress, convert, …), the server processes it in the background, and the user downloads the result. An administrator has a protected area to inspect uploads, jobs, storage, audit logs and to keep files forever in a **Vault**.

```
Browser ──► Next.js (apps/web, :3000) ──/api/* proxy──► Express API (apps/api, :4000) ──► MySQL
                                                              │
                                                              ├─► job queue ─► processors (sharp / pdf-lib / jszip / FFmpeg)
                                                              └─► storage service ─► MySQL tables (default) or local disk
```

Everything the browser does goes through `/api/v1/...`. Next.js proxies that path to the API (see `apps/web/next.config.ts`), so the admin cookie is first-party and no CORS is needed.

---

## 2. Repository map

```
apps/api/
  prisma/schema.prisma          database model (MySQL)          prisma/migrations/*   6 migrations     prisma/seed.ts   admin seeding
  src/server.ts                 process entry (boot, shutdown)  src/app.ts            Express app factory
  src/config/env.ts             validated configuration
  src/http/                     routes/, middleware/, sendFile.ts, types.d.ts      (HTTP layer only)
  src/services/                 business rules (files, jobs, runner, vault, auth, retention, audit, dto)
  src/repositories/             the only code that calls Prisma (all timed)
  src/processors/               image/ pdf/ document/ video/ + operations.ts, registry.ts, types.ts
  src/storage/                  storage.ts (contract), localStorage.ts, mysqlStorage.ts, index.ts (factory)
  src/queue/jobQueue.ts         in-process FIFO queue
  src/security/                 fileTypes.ts (magic bytes), filename.ts, vaultTypes.ts
  src/lib/                      errors, logger, timing, http helpers, hash, like
  src/scripts/                  cleanup.ts, createDatabase.ts, migrateFilesToMysql.ts, generateApiDocs.ts
  src/openapi.ts                endpoint table → OpenAPI + docs/API.md
  tests/                        14 suites (137 tests) + helpers/
apps/web/
  src/app/                      pages (App Router): page.tsx (home), admin/…, not-found.tsx, error.tsx, globals.css
  src/components/               home/FileTool.tsx, admin/AdminShell.tsx, admin/common.tsx, ui/primitives.tsx, Wordmark.tsx
  src/lib/api/                  client.ts (fetch/XHR wrapper), index.ts (typed API objects), types.ts (wire types)
  src/lib/                      format.ts (sizes, dates, friendly errors), hooks.ts (useResource, useDebounced), cn.ts
docs/                           API.md (generated), repository-audit.md, performance-report.md
```

Layering rule: **route → service → repository → Prisma**, and **service → processor / storage**. Routes never touch Prisma; repositories never touch HTTP; processors never touch HTTP or the database.

---

## 3. Process start-up (`apps/api/src/server.ts`)

1. `getEnv()` parses and validates environment variables (zod). On failure it throws `ConfigError`; `main().catch` prints the readable list of problems and exits with code 1.
2. `storage().ensureReady()` creates the scratch folder(s).
3. `storage().sweepWorkFiles(new Date())` deletes every leftover scratch file (nothing can be mid-job at boot).
4. `db().$queryRaw\`SELECT 1\`` – fail fast if MySQL is unreachable.
5. `jobQueue.recover()` – jobs left `QUEUED` are re-queued; jobs left `PROCESSING` (crash) are marked `FAILED` with code `SERVER_RESTART` and their file is set back to `UPLOADED`.
6. `startCleanupSchedule()` – `setInterval` running the retention job every `CLEANUP_INTERVAL_MINUTES` (timer is `unref`'d).
7. `createApp().listen(PORT)`; `server.requestTimeout = 0` so large uploads are not cut by Node.
8. Shutdown (`SIGINT`/`SIGTERM`): stop the timer, `server.close()`, wait up to 10 s for jobs to finish, then `abortAllRunning()` and wait 5 s more, disconnect Prisma, exit. A second signal exits immediately.
9. `unhandledRejection` is logged; `uncaughtException` is logged and exits.

### Configuration (`src/config/env.ts`)
`parseEnv()` validates with zod and returns `Env` = parsed values + derived fields: `storageRoot` (absolute path), `maxUploadBytes`, `vaultMaxBytes`, `appOrigins` (APP_ORIGIN split on commas, each normalised with `new URL().origin`), `cookieSecure` (`COOKIE_SECURE` if set, else `NODE_ENV === 'production'`). `getEnv()` memoises and loads `.env` via dotenv (not in tests). Notable variables: `DATABASE_URL`, `SESSION_SECRET` (≥32 chars), `STORAGE_DRIVER` (`mysql` default | `local`), `FILE_STORAGE_PATH`, `MAX_UPLOAD_SIZE_MB`, `VAULT_MAX_SIZE_MB`, `FILE_RETENTION_DAYS`, `JOB_CONCURRENCY`, `VIDEO_TIMEOUT_MINUTES`, `SLOW_REQUEST_MS`, `SLOW_QUERY_MS`, `RATE_LIMIT_ENABLED`.

### App factory (`src/app.ts`)
Order of middleware: `requestContext` → `express.json({limit:'100kb'})` → `cookie-parser` → routes → `notFound` → `errorHandler`. `trust proxy` is `loopback` so `req.ip` is the real client IP (from `X-Forwarded-For` set by the Next proxy). `json replacer` converts `BigInt` to `Number` (file sizes). Besides the API routers it serves:
- `GET /health` – runs `SELECT 1`; `200 {status:'ok', database:'up'}` or `503 DATABASE_ERROR`.
- `GET /api/v1/openapi.json` – the OpenAPI document from `src/openapi.ts`.

---

## 4. HTTP layer

### 4.1 Response contract
All JSON uses `{ "success": true, "data": …, "meta": … }` (helper `ok()` in `src/lib/http.ts`; `paginate()` builds `meta.pagination = {page, limit, total, totalPages}`) or `{ "success": false, "error": { "code", "message", "details"? } }`.

### 4.2 Error model (`src/lib/errors.ts`, `middleware/errorHandler.ts`)
`AppError(code, message, details?)` maps each `ErrorCode` to an HTTP status (e.g. `FILE_TOO_LARGE`→413, `UNSUPPORTED_FILE_TYPE`→415, `FILE_NOT_FOUND`→404, `FILE_EXPIRED`→410, `UNAUTHORIZED`→401, `INVALID_CREDENTIALS`→401, `TOO_MANY_REQUESTS`→429, `JOB_NOT_READY`→409). `errorHandler` converts: `AppError` → as is; `ZodError` → 400 `VALIDATION_ERROR` with `details:[{path,message}]`; `multer.MulterError` → 413 `FILE_TOO_LARGE` or 400 `INVALID_FILE`; JSON `SyntaxError` → 400; Prisma errors → 500 `DATABASE_ERROR`; anything else → 500 `INTERNAL_ERROR` with a generic message. The stack goes only to the log (`req.log`), never to the client. `notFound` raises `NOT_FOUND` for unknown routes.

### 4.3 Request context and metrics (`middleware/requestContext.ts`)
For every request: accepts a client `X-Request-Id` only if it matches `^[\w-]{8,64}$` (else generates a UUID), creates `req.log = logger().child({requestId})`, sets `X-Request-Id`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. On `finish` it records duration per route key (`METHOD /path/:id`) into an in-memory ring (500 samples) used by `GET /admin/metrics`, and logs `{method, path, status, durationMs}`; durations ≥ `SLOW_REQUEST_MS` are logged as `warn` unless the route is marked `longRunning` (uploads/downloads, via the `longRunning` middleware or `res.locals.longRunning`).

### 4.4 Security middleware (`middleware/security.ts`)
- `requireAdmin` – reads cookie `tero_admin`, calls `resolveSession(token)`; no valid session → `401 UNAUTHORIZED`; otherwise sets `req.admin` and `req.sessionToken`.
- `originGuard` – for non-GET/HEAD/OPTIONS requests that carry an `Origin` header, the origin must be in `APP_ORIGIN` **or** equal the host the browser used (`X-Forwarded-Host` set by the Next proxy). Otherwise `403 FORBIDDEN`. (Defence in depth on top of `SameSite=Lax`; this is why opening TERO through a LAN IP works.)
- `rateLimit(name, max, windowMs)` – fixed-window in-memory limiter per `req.ip`; disabled when `RATE_LIMIT_ENABLED=false`. Used on upload (60/min), job creation (60/min) and admin login (30/15 min).

### 4.4b Upload parsing (`middleware/upload.ts`)
`singleFileUpload(maxBytes)` wraps multer with a **custom storage engine**: the incoming stream is piped to a scratch path from `storage().allocateWorkPath()` (a generated UUID name — the client name never touches the filesystem). Limits: `fileSize`, `files:1`, `fields:10`, `fieldSize:4096`. When multer reports the size limit the partial file is deleted. Any parser error that is not a multer/App error (malformed boundary, truncated body) becomes `400 INVALID_FILE`. If no file arrived: `400 INVALID_FILE`. `uploadedFile(req)` returns `{path, originalname}`.

### 4.5 Downloads (`http/sendFile.ts`)
`sendStored(res, next, area, storedName, downloadName, mime)`: reads metadata (size) from the storage service, sets `Content-Type`, `Content-Length`, `Content-Disposition: attachment` (header-safe name via `contentDisposition()` with ASCII fallback + RFC 5987 `filename*`), `Cache-Control: private, no-store`, then `pipeline(storageStream, res)` so the source stream (file handle or DB cursor) is destroyed if the client disconnects. The location always comes from a DB row — never from the client.

---

## 5. API endpoints, one by one

`:id` parameters are validated as UUIDs by zod before anything else (`400 VALIDATION_ERROR` otherwise).

### 5.1 Public API (`src/http/routes/publicRoutes.ts`)

| Endpoint | What happens in code |
| --- | --- |
| `GET /api/v1/formats` | Returns `maxUploadBytes`, `retentionDays`, the supported types (`SUPPORTED_TYPES` in `security/fileTypes.ts`), presets and the operation catalog (`OPERATIONS`). The UI builds its "supported formats" text and file-picker `accept` list from this — it cannot advertise something the backend cannot do. |
| `POST /api/v1/files/upload` | `rateLimit` → `longRunning` → `singleFileUpload` → `ingestUpload(path, originalname)` (see §6) → `201 {file, suggestedOperations}`. `file` is the *public* shape (`publicFile` in `services/dto.ts`: no checksum, stored name or path). |
| `GET /api/v1/files/:id` | `fileRepository.findById`; 404 `FILE_NOT_FOUND`, 410 `FILE_EXPIRED` if status `DELETED`; returns file + suggested operations. |
| `GET /api/v1/files/:id/thumbnail` | `getFileForDownload(id)`; only `category === 'image'` (else `INVALID_OPERATION`); `storage().materialize()` gives a local copy, sharp `rotate().resize(480,480,inside).webp(70)`, `release()` in `finally`; `image/webp`, private 5-minute cache. Always re-encoded — the raw upload is never served inline. |
| `DELETE /api/v1/files/:id` | `deleteFile(id)` (§7.4) → `{id, status:'DELETED'}`. |
| `POST /api/v1/jobs` | zod body `{fileId, operation, options?}` → `createJob()` (§8.1) → `202 {jobId, status:'QUEUED'}`. The job is queued; nothing runs in the request. |
| `GET /api/v1/jobs/:id` | `getJob` → `publicJob()` (§8.5): status, progress, sizes, `savingPercent`, `processingDurationMs`, `downloadUrl`, `result`, `error`. This is what the UI polls. |
| `POST /api/v1/jobs/:id/cancel` | `cancelJob`: only `QUEUED`/`PROCESSING` (else `JOB_NOT_CANCELLABLE`); sets `CANCELLED` in DB and aborts the running controller. |
| `GET /api/v1/jobs/:id/download` | `getJobDownload`: job must be `COMPLETED` with `outputFileId` (else `JOB_NOT_READY` 409); `getFileForDownload(outputFileId)` (410 if expired); streams with the name `<original base>-tero.<ext>`. |

### 5.2 Admin API (`src/http/routes/adminRoutes.ts`)
`adminRouter.use(originGuard)` runs for everything; `POST /auth/login` is registered before `adminRouter.use(requireAdmin)`, so **every other admin route requires a valid session**.

| Endpoint | What happens in code |
| --- | --- |
| `POST /admin/auth/login` | rate-limited; zod `{email, password}`; `login()` (§9); sets cookie `tero_admin` (`httpOnly`, `sameSite:'lax'`, `secure: cookieSecure`, `expires`, `path:'/'`); audit `ADMIN_LOGIN`. On `INVALID_CREDENTIALS` it audits `ADMIN_LOGIN_FAILED` (no email, no password) and rethrows. |
| `POST /admin/auth/logout` | deletes the session row by token hash, audits `ADMIN_LOGOUT`, clears cookie. |
| `GET /admin/auth/me` | returns `req.admin`; the web shell uses it as its auth check. |
| `GET /admin/dashboard` | `dashboardRepository.getStats(now)` (§10.3): uploads today/week/total, job counts, bytes in/out/saved, average duration, operations, files by category, uploads per local day (14 days), recent uploads and failures. |
| `GET /admin/storage` | `storage().usage()` (per area, files+bytes), file and vault totals from MySQL, retention days. |
| `POST /admin/storage/cleanup` | runs `runCleanup()` now and returns its report. |
| `GET /admin/metrics` | per-route latency (count, errors, avg, p95, max), data-layer timings grouped by name (from `recentTimings()`), queue stats, process uptime/RSS. |
| `GET /admin/settings` | effective configuration (never secrets) including `storageDriver`. |
| `GET /admin/files` | zod query `{page ≤ 100 000, limit ≤ 100, q, type, status, role, sort∈{createdAt,sizeBytes,originalName,status}, order}`; `fileRepository.findMany` filters/sorts/paginates **in SQL**; `meta.pagination`. |
| `GET /admin/files/:id` | full metadata incl. checksum, storage location and the last 20 jobs; audits `FILE_VIEW`. |
| `GET /admin/files/:id/download` | `getFileForDownload`, audits `FILE_DOWNLOAD`, streams with the original name. |
| `DELETE /admin/files/:id` | `deleteFile`, audits `FILE_DELETE`. |
| `GET /admin/jobs`, `GET /admin/jobs/:id` | list (filters status/operation/fileId) and detail (audits `JOB_VIEW`). |
| `GET /admin/audit-logs` | filters action/entityType/entityId, newest first, joined with the admin's name/email. |
| `POST /admin/vault` | multipart `file` (+ optional `description`, `displayName`); `createVaultFile` (§11); audits `VAULT_UPLOAD` with `{name,sizeBytes}`. |
| `GET /admin/vault` | filters `q` (name/description), `type`; sort `createdAt|displayName|sizeBytes|downloadCount`. |
| `GET /admin/vault/:id` | metadata; audits `VAULT_VIEW`. |
| `GET /admin/vault/:id/download` | `openVaultDownload`, `recordDownload` (count+timestamp), audits `VAULT_DOWNLOAD`, streams. |
| `PATCH /admin/vault/:id` | rename (`displayName`) and/or `description` (nullable); at least one field; audits `VAULT_UPDATE`. |
| `PUT /admin/vault/:id/file` | replace bytes (`replaceVaultFile`), resets download count; audits `VAULT_REPLACE`. |
| `DELETE /admin/vault/:id` | `deleteVaultFile`; audits `VAULT_DELETE`. |

---

## 6. Upload ingestion (`src/services/fileService.ts → ingestUpload`)

Input: scratch file path + client-supplied name. Steps (any failure deletes the scratch file in `finally`):
1. `fs.stat` — empty → `INVALID_FILE`; larger than `maxUploadBytes` → `FILE_TOO_LARGE`.
2. `sanitizeFilename()` (`security/filename.ts`): recovers UTF-8 names that multer decoded as latin1, strips NUL, keeps only the text after the last `/` or `\`, replaces control chars and `<>:"|?*`, NFC-normalises, trims leading dots and trailing dots/spaces, caps at 180 chars keeping the extension, falls back to `file`. The result is **display metadata only**.
3. `detectType()` (`security/fileTypes.ts`) reads magic bytes — never `Content-Type`, never the extension: JPEG `FFD8FF`, PNG signature, WebP/AVI via `RIFF…WEBP/AVI `, PDF `%PDF-`, Matroska/WebM `1A45DFA3` (WebM if "webm" appears in the first 4 KB), ISO base media `ftyp` (MOV if brand `qt  `; HEIC/AVIF/M4A brands are **refused**, not mistaken for video), ZIP `PK\x03\x04` → DOCX only if `word/document.xml` and `[Content_Types].xml` exist (JSZip; skipped above 200 MB). Unknown → `UNSUPPORTED_FILE_TYPE`.
4. The claimed extension must be in the detected type's `allowedExtensions` (a PNG named `.pdf` → `INVALID_FILE`).
5. `sha256File()` streams the file for the checksum (resolves on stream `close` so the handle is released before moving the file on Windows).
6. `storage().importFile('ORIGINAL', path, detected.ext)` moves the bytes into storage under a generated name.
7. `fileRepository.create({role:'UPLOAD', status:'UPLOADED', expiresAt = now + retention, …})`. If the DB insert fails, the stored bytes are deleted (no bytes without a row).

---

## 7. Files, retention and deletion

### 7.1 `purgeFile(target)`
`storage().delete(area, storedName)` (idempotent) then `fileRepository.setStatus(id,'DELETED')`. Returns `'deleted' | 'missing' | 'failed'`. A deletion error (e.g. locked file) leaves the row untouched so the next run retries.

### 7.2 `setStatus` rules (`fileRepository`)
`DELETED` is terminal. Setting any other status uses `updateMany … where status != 'DELETED'`, so a job that finishes after its file was deleted cannot resurrect it.

### 7.3 `runCleanup(now)` (`services/retentionService.ts`)
1. Fail jobs stuck in `PROCESSING` longer than `VIDEO_TIMEOUT_MINUTES + 10` that are not running in this process (`STALE_JOB`), resetting their file to `UPLOADED`.
2. Loop (≤50 batches of 200): `fileRepository.findExpired(now, 200, excludeIds)` = rows with `expiresAt <= now`, status ≠ `DELETED`, and **no QUEUED/PROCESSING job**. Each is purged; failures are remembered in `failedIds` and excluded for the rest of this run.
3. `storage().sweepWorkFiles(now - 24h)` – old scratch files (and, for the MySQL driver, incomplete `StorageObject`s).
4. Delete expired admin sessions.
Returns `{deleted, alreadyMissing, failed, staleJobsFailed, workFilesSwept, expiredSessions}`. Only `File` rows are visited — **Vault files are never touched**. Metadata rows are kept (status `DELETED`, `deletedAt`) for analytics.
Triggers: the timer in `server.ts`, `npm run cleanup`, and `POST /admin/storage/cleanup`.

### 7.4 `deleteFile(id)`
`findStorageInfo` (404 if missing/deleted) → `cancelJobsForFile(id)` (marks active jobs `CANCELLED`, aborts them, then **waits up to 30 s** for the runner to release its files, via `waitForStop`) → purge every output file of its jobs → purge the file itself → `{id, status:'DELETED'}`; a failed physical deletion → `STORAGE_ERROR`.

---

## 8. Jobs and processing

### 8.1 Creating a job (`services/jobService.ts → createJob`)
Validates in order: operation name (`isOperation`) → file exists → not `DELETED` (`FILE_EXPIRED`) → file category accepted by the operation (`OPERATIONS[op].accepts`) → options parsed by that operation's zod schema (`OPTION_SCHEMAS`, `.strict()` so unknown keys are rejected → `INVALID_OPTIONS`). Then `jobRepository.create` (status `QUEUED`) and `jobQueue.enqueue(job.id)`.

### 8.2 Operations (`src/processors/operations.ts`)
The file is a **declarative catalog** — the single source of truth for 31 tools (`OPERATION_NAMES`, `OPTION_SCHEMAS`, `OPERATIONS: Record<OperationName, ToolDef>`). Each `ToolDef` has: `slug` (URL), `label`, `description`, `category` (pdf/word/image/video), `accepts`, `minFiles/maxFiles`, `fields` (form description: `type`, `label`, `hint`, `required`, `default`, `options`, `showIf`, `valueType`, `min/max/unit`), `secretFields`, `outputKind` (`file` | `zip`) and `outputSuffix`.
- **PDF (16):** `PDF_COMPRESS, PDF_MERGE, PDF_SPLIT, PDF_EXTRACT_PAGES, PDF_REMOVE_PAGES, PDF_REORDER_PAGES, PDF_ROTATE, PDF_CROP, PDF_WATERMARK, PDF_PAGE_NUMBERS, PDF_PROTECT, PDF_UNLOCK, PDF_STRIP_METADATA, PDF_TO_IMAGES, PDF_TO_TEXT, PDF_TO_WORD`
- **Word (4):** `DOCX_COMPRESS, DOCX_STRIP_METADATA, DOCX_TO_TEXT, DOCX_EXTRACT_IMAGES`
- **Image (9):** `IMAGE_COMPRESS` (preset or `targetKb`), `IMAGE_RESIZE` (pixels or `percent`), `IMAGE_CONVERT` (jpeg/png/webp/avif/tiff/gif), `IMAGE_CROP`, `IMAGE_ROTATE`, `IMAGE_WATERMARK`, `IMAGE_ADJUST`, `IMAGE_STRIP_METADATA`, `IMAGE_TO_PDF` (multi-file)
- **Video (2):** `VIDEO_COMPRESS, VIDEO_EXTRACT_AUDIO`
Presets: `HIGH_QUALITY`, `BALANCED` (UI "Recommended"), `SMALLEST`. `parseOptions(op, raw)` runs the strict zod schema; `splitSecrets(op, options)` separates `secretFields` (passwords) from storable options; `suggestedOperations(category)` drives the upload response. `GET /formats` publishes the catalog, so the web app builds every form from it.

### 8.2b Multi-file jobs, secrets, admin error detail
- `POST /jobs` takes `fileId` **xor** `fileIds[]` (≤ 30, ordered). `ProcessingJob.fileId` is the first input; `JobInput(jobId, position, fileId)` stores the full ordered list. Retention (a file used by an active job is not purged) and cancel/delete logic consider `JobInput`, not just `fileId`. The runner materialises every input and passes `inputPaths` / `inputNames` to the processor.
- **Secrets** (`services/secretStore.ts`): passwords for `PDF_PROTECT` / `PDF_UNLOCK` are split off by `splitSecrets`, held in memory keyed by job id and deleted when the job finishes or is cancelled. The DB `options` JSON contains `"[hidden]"`. After a restart the secret is gone, so the job fails with a friendly "please start again" message.
- **`errorDetail`**: `failureFor()` stores a short technical reason (`ProcessingJob.errorDetail`). Only `dto.adminJob` returns it (admin job drawer); `publicJob` never does.

### 8.3 Queue (`src/queue/jobQueue.ts`)
In-process FIFO with `JOB_CONCURRENCY` workers. `enqueue` pushes an id and pumps; each started id runs `runJob(id)` and re-pumps in `finally`. `onIdle()` resolves when nothing is queued/running. `recover()` is described in §3. The database is the source of truth; the queue holds only ids.

### 8.4 Running a job (`services/jobRunner.ts → runJob`)
1. `jobRepository.claim(id)` – atomic `updateMany where status='QUEUED'` → `PROCESSING`; if it returns 0 (cancelled/claimed) the function returns.
2. Registers a `RunningJob {controller, stopped, fileId}` (the `AbortController` is passed to processors; `stopped` lets deletion wait for completion).
3. Loads job and input file; missing/deleted/bytes gone → `ProcessorError('INVALID_FILE')`. Sets the file `PROCESSING`.
4. `storage().materialize(area, storedName)` gives a **local path** (real path for the local driver; a scratch copy for the MySQL driver). `allocateWorkPath(ext)` gives the output path.
5. `processor.validate()` then `processor.process({…, signal, reportProgress})`. `reportProgress` clamps to 0–99, ignores non-increasing values and throttles DB writes to ≈ every 750 ms (`jobRepository.setProgress`).
6. If aborted → `CancelledError`. Else compute SHA-256 of the output scratch file, `storage().importFile('PROCESSED', …)`.
7. **One DB transaction**: create the output `File` (`role:'OUTPUT'`, `AVAILABLE`, own `expiresAt`); `jobRepository.complete` (guarded by `status='PROCESSING'` — if 0 rows, the job was cancelled → `CancelledError`, rollback); `toolResultRepository.create` (§10.4); set the input file `AVAILABLE`. If the transaction fails the stored output bytes are deleted.
8. Errors: `CancelledError`/`ProcessorError('CANCELLED')` → `jobRepository.cancel`; otherwise `failureFor()` maps to `{code,message}` (`INVALID_FILE`, `PROCESSING_TIMEOUT`, `PROCESSING_FAILED`; unknown errors get a generic message, details only in logs) and `jobRepository.fail`. The input file goes to `FAILED` for `INVALID_FILE`, else back to `UPLOADED`.
9. `finally`: release the materialised input, run `processor.cleanup`, remove from `running`, resolve `stopped`.

### 8.5 Job DTO (`services/dto.ts → publicJob`)
`savingPercent = round1((original − output) / original × 100)` only for `COMPLETED`; `downloadUrl` only when completed; `error` only for `FAILED`/`CANCELLED`; `result` is the processor's honest info (`keptOriginal`, `note`, image counts…).

### 8.6 Processor contract (`processors/types.ts`)
```ts
interface Processor {
  operations: readonly OperationName[];
  validate(input): Promise<void>;                         // cheap pre-flight
  outputExtensionFor(op, options, inputExt): string;      // picks the scratch file extension
  process(input: ProcessorInput): Promise<ProcessorResult>; // {outputMime, outputExt, info}
  cleanup({outputPath}): Promise<void>;
}
```
`ProcessorError(userMessage, code)` carries a message safe to show users. `registry.ts` maps an operation to its processor (with a test override seam, `overrideProcessor`).

### 8.7 Image processor (`image/imageProcessor.ts`, sharp)
`sharp.cache(false)` is set globally (libvips otherwise keeps files open and blocks renames on Windows). `validate`: reads metadata (pixel limit 268 M); animated images (`pages > 1`) are refused — silently dropping frames would be wrong. `transform`: always `rotate()` (bakes EXIF orientation before metadata is dropped). Presets → quality 90/78/60; `IMAGE_COMPRESS` also caps the longest side (none / 4096 / 2048) with `withoutEnlargement`; `IMAGE_RESIZE` uses `fit:'inside'`, never upscales unless `allowUpscale`; JPEG output flattens transparency on white. PNG is lossless except `SMALLEST` (palette). If a compression result is not smaller than the input, the **original is returned** (`info.keptOriginal`, `info.note`). `info` also records input/output width and height (stored in `ImageResult`). `IMAGE_TO_PDF` embeds the image on an A4 page (landscape if wider), scaled down only. `IMAGE_STRIP_METADATA` re-encodes without EXIF/GPS.

### 8.8 PDF processor (`pdf/pdfProcessor.ts`, pdf-lib + sharp)
`validate` loads the PDF (encrypted → "password-protected" message; corrupt → "damaged"). `recompressImages` walks every indirect object:
- **JPEG (`DCTDecode`) RGB/Gray 8-bit** images: re-encoded at quality 85/70/50 (resized to ≤ none/2400/1400 px) when ≥ 5 % smaller.
- **Lossless (`FlateDecode`) RGB/Gray 8-bit** images (screenshots, slides): decoded with `decodePDFRawStream` (handles predictors), converted to JPEG for `BALANCED`/`SMALLEST` only (quality 78/60) and only if ≥ 25 % smaller; the stream's `Filter` becomes `DCTDecode` and `DecodeParms` is removed.
- Images with `Mask`/`SMask`/`Decode`, other colour spaces or bit depths are left untouched. Undecodable images are left untouched.
Then `doc.save({useObjectStreams:true})`; if the result is not smaller the original is returned with a note ("no photos or scans" when none were found, otherwise "already compact"). `info = {imagesFound, imagesRecompressed, keptOriginal?, note?}`.

### 8.9 Word processor (`document/docxProcessor.ts`, JSZip + sharp)
Re-encodes `word/media/*.jpg|jpeg|png` (same file names, so relationships stay valid) to a max side of 3000/1800/1200 px (quality 85/72/55; PNG stays PNG, level 9) only when smaller; rebuilds the zip with DEFLATE level 9; if the package is not smaller the original is returned.

### 8.9b New offline PDF / Word / image engines (all pure npm or WebAssembly)
| File | Tools | How it works |
| --- | --- | --- |
| `pdf/pdfEditProcessor.ts` | merge, split, extract, remove, reorder, rotate, crop, watermark, page numbers, strip metadata | pdf-lib. Page selections go through `shared/pageRanges.ts` (`parsePageSet/Sequence/Ranges`: 1-based, `3-`, `-5`, `last`, bounds-checked). Watermark/page numbers use bundled DejaVu fonts (`shared/fonts.ts`, fontkit) so non-English text works. Split writes a ZIP (≤ 500 files, generated entry names). |
| `pdf/pdfSecurityProcessor.ts` + `pdf/qpdf.ts` | protect, unlock | qpdf compiled to WebAssembly, run in a **worker thread** with a timeout/abort, 250 MB limit. Protect = AES-256. Wrong password → "That password is not correct." |
| `pdf/pdfConvertProcessor.ts` | PDF → images, text, Word | PDFium WASM (`@hyzyla/pdfium`) renders pages (≤ `MAX_RENDER_PAGES`) to PNG/JPEG → ZIP; extracts text; the `docx` library builds a text-only Word file. |
| `document/docxToolsProcessor.ts` + `shared/docxZip.ts` | strip metadata, text, extract pictures | JSZip. `loadOfficeZip` rejects zip bombs from the *declared* sizes before inflating. Strip metadata clears core/app properties, comments, and accepts tracked changes. |
| `image/imageProcessor.ts` + `image/watermarkSvg.ts` | compress (target KB), resize %, convert (+AVIF/TIFF/GIF), crop, rotate/flip, watermark, adjust | sharp. Target size is a quality binary search. Watermark text is turned into SVG paths by opentype.js (no system fonts needed). |
`shared/pdfLoad.ts → loadPdf` is the one place PDFs are opened: it enforces `MAX_PDF_PAGES`, maps "encrypted" to "Use Unlock PDF" and corruption to a friendly "damaged" message (including pdf-lib's lazy errors).

### 8.10 Video processor (`video/videoProcessor.ts`, `video/ffmpeg.ts`)
`ffprobe` checks there is a video stream (and an audio stream for extraction). `VIDEO_COMPRESS`: `libx264`, preset `medium`, CRF 20/25/30, `yuv420p`, AAC 160/128/96 kbps, `+faststart`, scale-down only (longest side ≤ none/1920/1280, `-2` keeps even dimensions, portrait-safe), maps `0:v:0` and optional `0:a:0?`. `VIDEO_EXTRACT_AUDIO`: `-vn`, `libmp3lame -q:a 2`. `runFfmpeg()` uses `spawn` with an **argument array** (no shell), adds `-progress pipe:1`, turns `out_time_us/ms` into 0–99 % using the probed duration (no duration → no progress → UI shows an indeterminate bar), enforces `VIDEO_TIMEOUT_MINUTES`, kills the process on `AbortSignal`, and keeps only the last 4 KB of stderr for the log (never shown to users). An MP4 that ends up larger than its source is replaced by the original.

---

## 9. Authentication and sessions (`services/authService.ts`, `repositories/adminRepository.ts`)
- Passwords: bcryptjs (cost 12); stored only as hashes. Seeding: `prisma/seed.ts` upserts the admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD` (≥12 chars).
- `login(email, password, ip)`: throttle key `ip|email` — 5 failures within 15 minutes → `TOO_MANY_REQUESTS`. The password is compared against a dummy hash when the email is unknown (equal timing, identical error). Inactive admins are rejected. On success a **new** 32-byte random token is created (no session fixation); only its **HMAC-SHA256 (keyed by `SESSION_SECRET`)** is stored in `AdminSession` with `expiresAt = now + SESSION_TTL_HOURS`; `lastLoginAt` is updated.
- `resolveSession(token)`: one query joins session → admin and checks expiry and `isActive` in SQL. `logout` deletes the row (so a stolen cookie dies immediately).

---

## 10. Data layer

### 10.1 Prisma client (`src/db/prisma.ts`)
One client, extended with `$allModels.$allOperations` that times every Prisma call and records `prisma.<Model>.<op>` into the timing ring.

### 10.2 Repositories and timing (`src/repositories`, `lib/timing.ts`)
Each repository object is wrapped with `instrument('FileRepository', repo)`, so every method is timed as `FileRepository.findMany` etc. (`recordTiming` warns above `SLOW_QUERY_MS`; `Admin → Storage` shows the aggregates). They select only needed columns. Lists run `findMany` + `count` in parallel and order by `(sortField, id)` with `id` in the **same direction** so MySQL can walk the index backwards instead of filesorting. User search text goes through `escapeLike()` (`lib/like.ts`) so `%`/`_` match literally.

### 10.3 Dashboard (`dashboardRepository.getStats`)
Seven statements in parallel: file counts (conditional `SUM(createdAt >= ?)`), one job aggregate (counts, bytes in/out, saved bytes, average duration), operations group-by, category group-by, uploads per day grouped by `DATE(CONVERT_TZ(createdAt,'+00:00',<server offset>))` so the chart's "today" matches the "uploads today" tile, recent uploads, recent failures.

### 10.4 Tool result rows (`toolResultRepository.create`)
Inside the completion transaction, one row in the tool's own table: `ImageResult` (operation, preset, target format, input/output dimensions, metadata-stripped, kept-original), `PdfResult` and `DocumentResult` (preset, images found/recompressed, kept-original), `VideoResult` (operation, preset, duration seconds, output format, kept-original). Each has `jobId @unique` with `onDelete: Cascade`.

### 10.5 Schema (`prisma/schema.prisma`, 6 migrations)
`Admin`, `AdminSession` · `File` (role UPLOAD/OUTPUT, category, size, checksum, status, `expiresAt`, `deletedAt`; indexes on createdAt, (status,createdAt), (category,createdAt), (expiresAt,status), checksum, (role,createdAt)) · `ProcessingJob` (operation, options JSON, status, progress, sizes, `outputFileId` unique FK → File `SetNull`, `fileId` FK `Restrict`, `resultInfo` JSON) · `VaultFile` · `AuditLog` (adminId `SetNull`) · `StorageObject`/`StorageChunk` (bytes) · `ImageResult`/`PdfResult`/`DocumentResult`/`VideoResult`. Migrations: `init`, `mysql_storage`, `image_tool_results`, `pdf_tool_results`, `document_tool_results`, `video_tool_results`.

---

## 11. Vault (`services/vaultService.ts`, `security/vaultTypes.ts`)
The Vault is separate from temporary files: its own table (`VaultFile`) and storage area (`VAULT`), never visited by cleanup. `classifyVaultFile` rejects executable/script extensions (`exe, dll, bat, cmd, msi, ps1, js, jar, sh, …`), detects the type from content when possible, else uses extension maps (audio, documents, archives) or `application/octet-stream`/`other`. Size limit `VAULT_MAX_SIZE_MB`. `createVaultFile` imports bytes and inserts the row (bytes removed if the insert fails). `replaceVaultFile` stores the new bytes, updates the row, then deletes the old bytes. `deleteVaultFile` deletes the row first, then the bytes (a failure to delete bytes is logged, not fatal). `openVaultDownload` verifies availability and existence.

---

## 12. Storage service (`src/storage`)
Contract (`storage.ts`): `save`, `importFile`, `read`, `createReadStream`, `exists`, `delete`, `getMetadata`, `materialize`, `allocateWorkPath`, `sweepWorkFiles`, `usage`, `ensureReady`, `generateStoredName`. Areas: `TEMPORARY`, `ORIGINAL`, `PROCESSED`, `VAULT`. Stored names are `uuid[.ext]`; the DB stores `storagePath = "AREA/storedName"`.

- **`LocalStorageService`** – the only place a path is built (`resolve()`): the name must match `STORED_NAME` (uuid + optional short lowercase extension) and the resolved path must stay inside the area directory, else `STORAGE_ERROR`. `importFile` renames (copy+delete on `EXDEV`). `sweepWorkFiles` only deletes UUID-named files in `temporary/`.
- **`MysqlStorageService`** (default driver) – bytes live in `StorageObject` (unique `(area, storedName)`, `complete` flag) and `StorageChunk` (`objectId`, `seq`, `MEDIUMBLOB`, 4 MB chunks). `store()` streams input into 4 MB chunks, sets `sizeBytes` and `complete=true` at the end, and deletes the object (cascading to chunks) on any error. Reads stream chunks 4 at a time (bounded memory); incomplete objects are invisible. `materialize()` writes a scratch file for processors and returns a `release()`; scratch files live in `FILE_STORAGE_PATH/temporary`. `sweepWorkFiles` also removes `complete=false` objects older than 24 h.
- `index.ts` picks the driver from `STORAGE_DRIVER`. `npm run storage:to-mysql` copies existing disk files into MySQL.

---

## 13. Audit log (`services/auditService.ts`)
`audit(ctx, action, entity?, metadata?)` writes `AuditLog` (admin id, action, entity type/id, small JSON metadata, IP). Failures are logged and swallowed so auditing never breaks a request. Metadata contains ids/names/sizes only — no passwords, tokens or file contents. Actions: `ADMIN_LOGIN`, `ADMIN_LOGIN_FAILED`, `ADMIN_LOGOUT`, `FILE_VIEW`, `FILE_DOWNLOAD`, `FILE_DELETE`, `VAULT_UPLOAD/VIEW/DOWNLOAD/UPDATE/REPLACE/DELETE`, `JOB_VIEW` (`SETTINGS_CHANGE` is defined but settings are read-only).

---

## 14. Frontend (`apps/web`)

### 14.1 API layer (`src/lib/api`)
- `types.ts` – wire types mirroring the backend DTOs.
- `client.ts` – `send()` wraps `fetch` (same-origin credentials, JSON or FormData), parses the envelope and throws `ApiError(code, message, status)`; non-JSON responses (proxy down) become `NETWORK_ERROR`. A `401` from any `/admin/*` call (except login) redirects to `/admin/login`. `getPage()` returns `{items, pagination}`. `uploadWithProgress()` uses `XMLHttpRequest` for real byte progress and supports an `AbortSignal` (`ApiError('ABORTED')`).
- `index.ts` – typed objects `filesApi`, `jobsApi`, `authApi`, `adminApi`, `vaultApi`; components never call `fetch` directly.
- `format.ts` – `formatBytes/Duration/Date/Relative`, preset and operation labels, and `friendlyError(code)` which maps backend codes to plain-language messages (family users never see codes or stack traces).
- `hooks.ts` – `useResource(load, deps)` (loading is derived from a request key, stale data stays visible while refetching, `refetch()`), `useDebounced`.

### 14.2a Tool pages (current UI; replaces the old single `FileTool`)
- `lib/tools.ts` `useTools()` loads the catalog from `/formats`. `app/page.tsx` shows `ToolGrid` (tabs All/PDF/Word/Image/Video + search, iLovePDF-style cards with `toolIcons.tsx`). `app/tools/[slug]/page.tsx` renders `ToolWorkspace` for one tool. `app/start/page.tsx` + `SmartStart` is "drop a file and we suggest tools".
- `ToolWorkspace` is the state machine (`idle → uploading → ready → processing → done | failed`) for single and multi-file tools (add/reorder/remove files, per-file upload progress). `ToolForm` renders `fields` generically (`showIf`, numbers, password, select, checkbox, "pages" input) with labels, hints and `aria-invalid`. `lib/toolForm.ts` builds the options JSON and does fast client checks (the server validates again). `lib/resultSummary.ts` turns the backend's result info into plain sentences (pages in/out, images shrunk, target vs achieved KB…). `friendlyError` shows the backend's own message for `INVALID_OPTIONS`.
- **Admin ⇄ TERO switch** (`components/ModeSwitch.tsx`): `SiteHeader` asks `authApi.session()` (a quiet `GET /admin/auth/me` that returns `null` on 401 and never redirects). Only a signed-in admin sees the "Use TERO | Admin" switch; visitors see no admin link at all. `AdminShell` shows the same switch in its top bar. It is navigation only — the admin cookie is shared and every `/admin/*` API route still checks the session on the server.
- Admin pages show the new operations, input-file lists, and (jobs drawer) the technical `errorDetail`.

### 14.2 Home page — original single-tool flow (superseded by 14.2a, kept for the state-machine description)
`FileTool` is a state machine: `idle → uploading → ready → processing → done | failed`.
- **idle**: drag-and-drop zone and "Choose file" (hidden `<input type=file>` whose `accept` comes from `/formats`; category tiles open the picker filtered to that category). Client-side size pre-check against `maxUploadBytes`. Errors are shown with `friendlyError`.
- **uploading**: real percentage from XHR progress; at 100 % it shows an indeterminate "Checking file…" (server-side validation/storage); a **Cancel upload** button aborts the request.
- **ready** (`Workspace`): file card (thumbnail via `/files/:id/thumbnail` for images, icon otherwise), name, type, size, Delete; radio list of `suggestedOperations`; for compress operations a preset selector (High quality / Recommended / Smallest file); width/height inputs for resize (validated); format select for convert. A single suggested operation is pre-selected (PDF, Word).
- **processing**: polls `GET /jobs/:id` every 700 ms; shows "Waiting to start…" while queued, a percentage only when the backend reports one, otherwise an indeterminate bar; **Cancel** calls the cancel endpoint. `CANCELLED` returns to *ready*; `FAILED` shows the friendly message inside the form so the user can retry.
- **done**: original size, result size, percentage saved (clamped/labelled honestly — "None" when the original was returned), duration, the backend's note, **Download** (`<a href=/api/v1/jobs/:id/download>`), "Another file", and "Delete from TERO".
- Privacy text uses the real retention days from `/formats`.

### 14.3 Admin (`app/admin/**`, `components/admin`)
- `AdminShell` calls `authApi.me()`; 401 → redirect to login; shows sidebar (desktop) / hamburger menu (mobile), signed-in admin, sign-out.
- `admin/login/page.tsx` – accessible form (labels, autocomplete), friendly errors.
- **Dashboard** – stat tiles, 14-day uploads bar chart (`DayBars`, local-day keys), files by type and operations (`BarList`), recent failures and uploads.
- **Files** – search (debounced), type/status/kind filters, sortable columns, pagination (`Pager`), row → drawer with metadata, storage location, checksum, job history, Download and Delete (confirm dialog). Deleted rows stay visible with status `deleted`.
- **Jobs** – filters, table, detail drawer (progress, sizes, saving, options, error).
- **Vault** – list/grid toggle, search, type filter, upload dialog, rename/describe dialog, replace file, delete confirm, download (count refreshes), empty/error/loading states.
- **Storage** – usage per area, queue state, slowest routes, database operation timings, "Run cleanup now".
- **Audit logs** – action filter, pagination, admin, target and IP.
- **Settings** – read-only effective configuration (including storage driver).
- `ui/primitives.tsx` – Button, Input, Select, Badge (always text + dot, never colour alone), Skeleton, Card, EmptyState, ErrorState, Notice, `Modal` (Radix Dialog: focus trap, Esc, aria title/description; `side` renders a drawer), `ConfirmDialog`, `ProgressBar` (`role=progressbar`, indeterminate when no value).
- `app/not-found.tsx` and `app/error.tsx` give friendly 404/crash pages. Dark mode follows `prefers-color-scheme` via CSS variables in `globals.css`; animations respect `prefers-reduced-motion`.

### 14.4 Next config (`next.config.ts`)
`/api/:path*` rewrite to `API_URL` (build-time), `proxyClientMaxBodySize: '2100mb'` and `proxyTimeout: 30 min` (the defaults of 10 MB and 30 s cut large uploads), and security headers (`nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`).

---

## 15. Scripts and tooling
`npm run dev|build|start|test|lint|typecheck` (root, fan out to both apps) · `db:create` (create database from `DATABASE_URL`) · `db:migrate` / `db:deploy` / `db:seed` / `db:generate` · `npm run cleanup -w apps/api` · `storage:to-mysql` · `docs:api` (regenerate `docs/API.md`) · `test:perf` (20 000-row measurements + `EXPLAIN`).

## 16. Tests (`apps/api/tests`, 195 tests, real MySQL `tero_test`)
New suites: `toolsPdf` (every PDF tool, wrong/right passwords, damaged and encrypted files), `toolsWordImage` (Word + image tools), `toolsCatalog` (catalog consistency, multi-file retention, cancel via a second input, admin-only `errorDetail`, per-tool result rows, resource limits); fixtures in `helpers/toolFixtures.ts`, `helpers/toolHarness.ts`. Earlier suites:
`upload`, `jobs` (all processors incl. real FFmpeg and Flate PDFs), `adminAuth`, `adminFiles` (files/jobs/dashboard/storage/metrics), `vault`, `audit`, `retention`, `security` (filenames, path safety, env validation, headers), `database` (constraints, cascade/restrict, transactions, indexes), `openapi` (routes vs documentation), `workflow` (end to end), `mysqlStorage` (driver + MySQL-backed workflow + per-tool rows), `regression` (bugs below), `perf` (opt-in). `helpers/globalSetup.ts` creates the test DB and runs `prisma migrate deploy`; `helpers/setupEnv.ts` sets a temp storage dir and `STORAGE_DRIVER=local` (the MySQL driver is tested explicitly).

## 17. Bugs found and fixed during the test pass
| Found by | Bug | Fix |
| --- | --- | --- |
| Live run through the proxy | Admin login from a LAN address (e.g. `http://192.168.1.6:3000`) returned 403 | `originGuard` accepts the origin the browser used (`X-Forwarded-Host`) and `APP_ORIGIN` takes a comma-separated list; `COOKIE_SECURE` override for plain-HTTP home networks |
| 60 MB upload via port 3000 | 500 after 30 s (Next proxy body/time limits) | `proxyClientMaxBodySize`, `proxyTimeout` in `next.config.ts` |
| Probing | HEIC/AVIF/M4A files looked like MP4 and failed with a confusing message | ISO-brand check → clear `UNSUPPORTED_FILE_TYPE` |
| Probing | Animated WebP silently lost its frames | refused with a clear message |
| Probing | Malformed multipart body → 500 | mapped to 400 `INVALID_FILE` |
| Probing | Admin search treated `%` and `_` as SQL wildcards | `escapeLike()` |
| Probing | Absurd `page` values accepted | `max(100 000)` |
| Race test | Deleting a file while its job ran left it `FAILED`/`UPLOADED` (resurrected) or the delete failed on a locked file | terminal `DELETED` rule + `deleteFile` waits for running jobs to stop |
| Review | A client aborting a download leaked the stream (file handle / DB cursor) | `pipeline()` instead of `pipe()` |
| Crash test | After a crash the file stayed `PROCESSING` forever and scratch files remained | `recover()` resets file status; boot-time scratch sweep |
| Review | Ctrl+C waited for hour-long jobs | timed shutdown that aborts jobs |
| Real PDFs | Screenshots (Flate images) were ignored and the note claimed "no photos" | Flate → JPEG recompression with a ≥25 % gain rule (1228 KB → 892 KB on a real file) |
| Chart review | "Uploads per day" used UTC days while "today" used local midnight | grouped with `CONVERT_TZ` to the server offset; UI keys use local dates |
| UI testing | Expired admin session left an error panel instead of the login page | global 401 → redirect |
| UI testing | Confirm dialog had an empty band; sm buttons were small touch targets; no 404/error pages; no way to cancel an upload | fixed |
| Windows | Output file locked by sharp's cache / read stream (`EBUSY` on rename) | `sharp.cache(false)`, hash resolves on `close` |
| Review | `/health` did not check the database | now runs `SELECT 1` |

### 17b. Bugs found while building the 31-tool set
| Bug | Fix |
| --- | --- |
| `@napi-rs/canvas` native add-on blocked by Windows Application Control | Switched to PDFium WebAssembly (pure WASM) |
| qpdf `--is-encrypted` exit code 2 and stderr not captured | Capture worker stderr; "invalid password" ⇒ encrypted; friendly wrong-password error |
| Damaged PDF reported as `PROCESSING_FAILED` (pdf-lib throws lazily) | `loadPdf` includes `getPageCount()` inside the `try` |
| opentype.js crashed on GSUB format 2 when laying out text | Per-glyph layout |
| Generic "Those settings aren't valid" in the UI | Show backend message for `INVALID_OPTIONS` |
| Strip-metadata missed self-closing `<w:del/>` / `<w:ins/>` | Handled both forms |
| Stale Next.js build served old chunks after changes | Kill old node processes, clear `.next`, rebuild |

## 18. Known limits
No Docker/hosting setup yet; the job queue, rate limits and login throttle are in-memory (single API instance); family pages have no login (anyone with a file/job UUID can use it — IDs are random v4); PDF recompression covers 8-bit RGB/Gray images without masks (not CMYK/indexed); no Word→PDF (needs LibreOffice) or OCR; PDF→Word is text-only; PDF crop only sets the page box; `npm audit` shows 3 high findings in the Prisma CLI chain (needs Prisma 7); storing bytes in MySQL grows the database (set `STORAGE_DRIVER=local` to use disk); name search is a `LIKE '%…%'` scan; deep pagination uses `OFFSET`.
