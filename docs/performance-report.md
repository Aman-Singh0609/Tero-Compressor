# Performance report

Measured on this development machine (Windows 11, MySQL 8.4 in Docker, Node 24) with **20,000 files, 20,000 jobs and 20,000 audit rows**. Raw data: `docs/performance-measurements.json` (`npm run test:perf -w apps/api`). Each endpoint: 1 warm-up + 15 timed calls through supertest (in-process HTTP, authenticated admin session). Numbers are API + database latency only; **file-processing durations are separate and depend on file size and hardware.**

## Admin API latency

| Endpoint | Median | p95 | Max |
|---|---|---|---|
| file list, default sort (`/admin/files?page=1&limit=25`) | 11 ms | 12.7 ms | 15.6 ms |
| file list, deep page (`/admin/files?page=400&limit=25`) | 49.2 ms | 52.1 ms | 57.7 ms |
| file list, filter type+status (`/admin/files?type=pdf&status=AVAILABLE&limit=25`) | 29.8 ms | 32.1 ms | 32.5 ms |
| file list, name search (`/admin/files?q=wedding&limit=25`) | 84.1 ms | 86.5 ms | 87.3 ms |
| file list, sort by size (`/admin/files?sort=sizeBytes&order=desc&limit=25`) | 98 ms | 100.1 ms | 109.2 ms |
| job list (`/admin/jobs?limit=25`) | 9.7 ms | 10.1 ms | 11.3 ms |
| job list, filter status (`/admin/jobs?status=FAILED&limit=25`) | 10.2 ms | 13.1 ms | 15.4 ms |
| audit log list (`/admin/audit-logs?limit=25`) | 9 ms | 9.5 ms | 9.5 ms |
| dashboard (`/admin/dashboard`) | 91.2 ms | 94.7 ms | 101.6 ms |
| storage (`/admin/storage`) | 12.5 ms | 13.9 ms | 14.1 ms |

## EXPLAIN of important queries

| Query | Table | Access | Index used | Est. rows | Extra |
|---|---|---|---|---|---|
| files: list newest (ORDER BY createdAt DESC LIMIT) | File | ref | File_role_createdAt_idx | 9837 | Backward index scan; Using index |
| files: category + status filter | File | ref | File_status_createdAt_idx | 9382 | Using where; Backward index scan |
| files: status filter count | File | ref | File_status_createdAt_idx | 9264 | Using where |
| files: retention scan (expiresAt, status) | File | range | File_expiresAt_status_idx | 9837 | Using where; Using index |
| files: retention scan (expiresAt, status) | t0 | ref | ProcessingJob_fileId_idx | 1 | Using where; Not exists |
| jobs: list newest | ProcessingJob | index | ProcessingJob_createdAt_idx | 25 | Backward index scan; Using index |
| jobs: filter status + newest | ProcessingJob | ref | ProcessingJob_status_createdAt_idx | 9516 | Backward index scan; Using index |
| jobs: latest job per file (batched IN, no N+1) | ProcessingJob | range | ProcessingJob_fileId_idx | 25 | Using index condition; Using filesort |
| audit: list newest | AuditLog | index | AuditLog_createdAt_idx | 25 | Backward index scan; Using index |
| audit: by entity | AuditLog | ref | AuditLog_entityType_entityId_idx | 1 | Using index |
| dashboard: job aggregate (single pass) | ProcessingJob | ALL | — | 19936 |  |
| dashboard: uploads per day | File | range | File_role_createdAt_idx | 9837 | Using where; Using index; Using temporary |
| dashboard: files by category | File | ref | File_role_createdAt_idx | 9837 | Using temporary |

## What the measurements found (and what was fixed)

* **Fixed — filesort on every list.** Lists first ordered by `(createdAt DESC, id ASC)`; mixed directions defeated the `(…, createdAt)` indexes ("Using filesort" over ~10k rows). Ordering the `id` tie-breaker in the *same direction* lets MySQL scan the index backwards. Same dataset, before → after (median): file list 103.6 → 11.0 ms, job list 33.7 → 9.7 ms, audit list 29.5 → 9.0 ms, deep page 192 → 49 ms.
* **N+1 avoided.** The admin file list joins each row's latest job through one batched relation query (2 statements per page, independent of page size). Dashboard = 7 parallel statements, not one per widget.
* **Per-operation timing** is recorded for every Prisma call and every repository method (`FileRepository.findMany`, `DashboardRepository.getStats`, …); calls over `SLOW_QUERY_MS` log a warning; requests over `SLOW_REQUEST_MS` log a warning (uploads and downloads excluded). Both are visible in **Admin → Storage**.

## Known bottlenecks (not fixed)

* **Name search** (`LIKE '%x%'`) and **sort by size/name** scan the table: ~84–98 ms at 20k rows. Acceptable for a family archive; a FULLTEXT index or a `(role, sizeBytes)` index would be the next step if volume grows.
* **Dashboard** ~91 ms: the job aggregate scans `ProcessingJob` (20k rows) because it aggregates over everything. A rollup table or caching for a few seconds would remove this.
* **Deep pagination** uses OFFSET (49 ms at page 400); keyset pagination would flatten it.

## Processing durations actually measured (from the test suite / manual runs)

| Operation | Input | Duration |
|---|---|---|
| IMAGE_COMPRESS (SMALLEST) | 1200×900 noisy JPEG, 1.5 MB → 289 KB (−80.8%) | 312 ms |
| IMAGE_COMPRESS (BALANCED) via UI | 1600×1200 JPEG, 5.1 MB → 754 KB (−85.6%) | 527 ms |
| VIDEO_COMPRESS, PDF_COMPRESS, DOCX_COMPRESS, VIDEO_EXTRACT_AUDIO | synthetic fixtures in the test suite | pass; durations depend on fixture size, not benchmarked |

Not measured: large real-world videos (minutes of FFmpeg time), concurrent uploads under load, production HTTPS proxy overhead.
