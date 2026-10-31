# TERO API v1

> Generated from `apps/api/src/openapi.ts` — do not edit by hand. Live OpenAPI JSON: `GET /api/v1/openapi.json`.

All responses use one envelope:

```json
{ "success": true, "data": {}, "meta": {} }
{ "success": false, "error": { "code": "INVALID_FILE_TYPE", "message": "Human readable text" } }
```

Admin endpoints require the `tero_admin` HttpOnly session cookie obtained from `POST /api/v1/admin/auth/login`.
Unauthenticated calls return `401 UNAUTHORIZED`. File and job ids are random UUIDs; no client-supplied path is ever read.

## Public endpoints

### `GET /api/v1/formats`

Supported file types, operations and limits.

- **Auth:** none
- **Success:** `200` → { maxUploadBytes, retentionDays, types[], presets[], operations[] }

### `POST /api/v1/files/upload`

Upload a file (multipart field "file").

- **Auth:** none
- **Body (multipart/form-data):** `file` (required)
- **Success:** `201` → { file, suggestedOperations[] }
- **Errors:** `INVALID_FILE`, `FILE_TOO_LARGE`, `UNSUPPORTED_FILE_TYPE`, `TOO_MANY_REQUESTS`

### `GET /api/v1/files/{id}`

File metadata and suggested operations.

- **Auth:** none
- **Success:** `200` → { file, suggestedOperations[] }
- **Errors:** `FILE_NOT_FOUND`, `FILE_EXPIRED`, `VALIDATION_ERROR`

### `GET /api/v1/files/{id}/thumbnail`

WebP preview of an uploaded image.

- **Auth:** none
- **Success:** `200` → image/webp
- **Errors:** `FILE_NOT_FOUND`, `FILE_EXPIRED`, `INVALID_OPERATION`

### `DELETE /api/v1/files/{id}`

Delete a file and everything generated from it.

- **Auth:** none
- **Success:** `200` → { id, status: "DELETED" }
- **Errors:** `FILE_NOT_FOUND`, `STORAGE_ERROR`

### `POST /api/v1/jobs`

Create a processing job.

- **Auth:** none
- **Body (JSON):** `{ fileId, operation, options? }`
- **Success:** `202` → { jobId, status: "QUEUED" }
- **Errors:** `FILE_NOT_FOUND`, `FILE_EXPIRED`, `INVALID_OPERATION`, `INVALID_OPTIONS`, `VALIDATION_ERROR`

### `GET /api/v1/jobs/{id}`

Job status, progress and result statistics.

- **Auth:** none
- **Success:** `200` → { id, status, progress, originalSizeBytes, outputSizeBytes, savingPercent, processingDurationMs, downloadUrl, result, error }
- **Errors:** `JOB_NOT_FOUND`

### `POST /api/v1/jobs/{id}/cancel`

Cancel a queued or running job.

- **Auth:** none
- **Success:** `200` → job
- **Errors:** `JOB_NOT_FOUND`, `JOB_NOT_CANCELLABLE`

### `GET /api/v1/jobs/{id}/download`

Download the output of a completed job.

- **Auth:** none
- **Success:** `200` → file bytes (attachment)
- **Errors:** `JOB_NOT_FOUND`, `JOB_NOT_READY`, `FILE_EXPIRED`, `FILE_NOT_FOUND`

## Admin endpoints

### `POST /api/v1/admin/auth/login`

Sign in; sets the HttpOnly session cookie.

- **Auth:** none
- **Body (JSON):** `{ email, password }`
- **Success:** `200` → { admin, expiresAt }
- **Errors:** `INVALID_CREDENTIALS`, `TOO_MANY_REQUESTS`, `VALIDATION_ERROR`

### `POST /api/v1/admin/auth/logout`

Sign out and invalidate the session.

- **Auth:** admin session
- **Success:** `200` → { loggedOut: true }
- **Errors:** `UNAUTHORIZED`

### `GET /api/v1/admin/auth/me`

Current administrator.

- **Auth:** admin session
- **Success:** `200` → { admin }
- **Errors:** `UNAUTHORIZED`

### `GET /api/v1/admin/dashboard`

Aggregated operational statistics.

- **Auth:** admin session
- **Success:** `200` → { uploads, jobs, operations[], filesByCategory[], uploadsByDay[], recentUploads[], recentFailures[] }
- **Errors:** `UNAUTHORIZED`

### `GET /api/v1/admin/storage`

Storage usage per area and database totals.

- **Auth:** admin session
- **Success:** `200` → { disk, database, retentionDays }
- **Errors:** `UNAUTHORIZED`

### `POST /api/v1/admin/storage/cleanup`

Run the retention cleanup now.

- **Auth:** admin session
- **Success:** `200` → cleanup report
- **Errors:** `UNAUTHORIZED`

### `GET /api/v1/admin/metrics`

Request latency, data-layer timings, queue state.

- **Auth:** admin session
- **Success:** `200` → { requests[], dataOperations[], queue, process }
- **Errors:** `UNAUTHORIZED`

### `GET /api/v1/admin/settings`

Effective (read-only) configuration.

- **Auth:** admin session
- **Success:** `200` → settings object
- **Errors:** `UNAUTHORIZED`

### `GET /api/v1/admin/files`

Paginated, filterable file list.

- **Auth:** admin session
- **Query:** `page`, `limit`, `q`, `type`, `status`, `role`, `sort`, `order`
- **Success:** `200` → file[] + meta.pagination
- **Errors:** `UNAUTHORIZED`, `VALIDATION_ERROR`

### `GET /api/v1/admin/files/{id}`

File detail with job history.

- **Auth:** admin session
- **Success:** `200` → file
- **Errors:** `UNAUTHORIZED`, `FILE_NOT_FOUND`

### `GET /api/v1/admin/files/{id}/download`

Download a stored file.

- **Auth:** admin session
- **Success:** `200` → file bytes (attachment)
- **Errors:** `UNAUTHORIZED`, `FILE_NOT_FOUND`, `FILE_EXPIRED`

### `DELETE /api/v1/admin/files/{id}`

Delete a file.

- **Auth:** admin session
- **Success:** `200` → { id, status: "DELETED" }
- **Errors:** `UNAUTHORIZED`, `FILE_NOT_FOUND`

### `GET /api/v1/admin/jobs`

Paginated job list.

- **Auth:** admin session
- **Query:** `page`, `limit`, `status`, `operation`, `fileId`
- **Success:** `200` → job[] + meta.pagination
- **Errors:** `UNAUTHORIZED`

### `GET /api/v1/admin/jobs/{id}`

Job detail.

- **Auth:** admin session
- **Success:** `200` → job
- **Errors:** `UNAUTHORIZED`, `JOB_NOT_FOUND`

### `GET /api/v1/admin/audit-logs`

Paginated audit log.

- **Auth:** admin session
- **Query:** `page`, `limit`, `action`, `entityType`, `entityId`
- **Success:** `200` → audit entry[] + meta.pagination
- **Errors:** `UNAUTHORIZED`

### `POST /api/v1/admin/vault`

Add a file to the vault (multipart "file", optional description/displayName).

- **Auth:** admin session
- **Body (multipart/form-data):** `file` (required)
- **Success:** `201` → vault file
- **Errors:** `UNAUTHORIZED`, `FILE_TOO_LARGE`, `UNSUPPORTED_FILE_TYPE`, `INVALID_FILE`

### `GET /api/v1/admin/vault`

Paginated vault list.

- **Auth:** admin session
- **Query:** `page`, `limit`, `q`, `type`, `sort`, `order`
- **Success:** `200` → vault file[] + meta.pagination
- **Errors:** `UNAUTHORIZED`

### `GET /api/v1/admin/vault/{id}`

Vault file metadata.

- **Auth:** admin session
- **Success:** `200` → vault file
- **Errors:** `UNAUTHORIZED`, `VAULT_FILE_NOT_FOUND`

### `GET /api/v1/admin/vault/{id}/download`

Download a vault file (increments download count).

- **Auth:** admin session
- **Success:** `200` → file bytes (attachment)
- **Errors:** `UNAUTHORIZED`, `VAULT_FILE_NOT_FOUND`

### `PATCH /api/v1/admin/vault/{id}`

Rename display name / edit description.

- **Auth:** admin session
- **Body (JSON):** `{ displayName?, description? }`
- **Success:** `200` → vault file
- **Errors:** `UNAUTHORIZED`, `VAULT_FILE_NOT_FOUND`, `VALIDATION_ERROR`

### `PUT /api/v1/admin/vault/{id}/file`

Replace the stored bytes of a vault file.

- **Auth:** admin session
- **Body (multipart/form-data):** `file` (required)
- **Success:** `200` → vault file
- **Errors:** `UNAUTHORIZED`, `VAULT_FILE_NOT_FOUND`, `FILE_TOO_LARGE`

### `DELETE /api/v1/admin/vault/{id}`

Delete a vault file.

- **Auth:** admin session
- **Success:** `200` → { id, deleted: true }
- **Errors:** `UNAUTHORIZED`, `VAULT_FILE_NOT_FOUND`
