# Repository audit (pre-2.0 → 2.0)

Findings from inspecting the original TERO Compressor before any change, and what happened to each piece.

## What existed

| Area | Finding | Decision |
| --- | --- | --- |
| Backend (`js_files/node.js`, 175 lines) | One Express file doing upload, processing, download and cleanup. Port hard-coded to 3000. | **REPLACE** → `apps/api` (controllers → services → repositories → Prisma; processors; storage service) |
| Frontend (`public/index.html`) | Static Bootstrap page posting a form, background image, hover "scale" animations. Advertised formats it could not process. | **REPLACE** → `apps/web` (Next.js, typed API client, real status) |
| Upload | `multer({ dest: 'uploads/' })`, no size limit, client file name used to build output paths (`compressed_${originalName}`), type detection via `file-type` then **falling back to the client extension**. | **REPLACE** — size limit, magic-byte allow-list, extension must match content, generated storage names, sanitised display names |
| Download | `/download/:filename` resolved a client-supplied name with `path.resolve(compressedDir, filename)` — **path traversal** (e.g. `../../.env`) and it deleted the file after download. | **REPLACE** — downloads resolve only from database ids; retention handles expiry |
| Image (Sharp) | Always resized to 800 px wide (upscaling small images), no quality control. | **REFACTOR** → `ImageProcessor` (presets, no upscale, never returns a bigger file, strips metadata) |
| Video (FFmpeg) | `exec()` with string interpolation of the file path into a shell command — **command injection**; no timeout; `-crf 28` only. | **REPLACE** → `spawn` with argument array, timeout, cancellation, real `-progress` parsing |
| PDF | Loaded and re-saved with pdf-lib and called it "compression"; reports no numbers. | **REPLACE** → real image re-encoding inside the PDF; honest "returned unchanged" when nothing can shrink |
| DOCX | JSZip + Sharp resize of `word/media/*` to 800 px width (broke non-image media, upscaled). | **REFACTOR** → `DocxProcessor` (jpg/png only, no upscale, keeps names so relationships stay valid, keeps original when not smaller) |
| TXT "compression" | Called an undefined `compressTextFile` → crashed. | **REMOVE** (no useful operation) |
| Huffman scripts (`huffman.js`, `imagecompress.js`, `videocompress.js`) | Experiments, not wired into the app. | **REMOVE** from the active tree; archived in `legacy/` |
| Java utilities (`FFmpegVideoCompressor.*`, `AudioCompressor.class`, …) | Unused by the server; compiled `.class` files tracked. | **REMOVE** (history keeps them) |
| Tracked artefacts | `node_modules/` (164 files), `uploads/` (30 user files), `compressed/` outputs (PDFs, videos), `ffmpeg2pass-0.log*`, `.class`. No `.gitignore`. | **REMOVE from git**, `.gitignore` added (files on disk are untouched) |
| Dependencies | `express`, `multer`, `pdf-lib`, `adm-zip`, `file-type` used but never declared in `package.json`; two `package.json`/lockfiles. | **REPLACE** → one npm workspace with declared deps |
| Error handling | `res.status(500).send(error.message)`, leaking internals; `req.file` undefined crashed the handler. | **REPLACE** → typed error envelope, no stack traces |
| Temporary storage | Uploads in `./uploads` relative to CWD, removed in `finally`; outputs removed only after a successful download; no retention. | **REPLACE** → storage service with areas, DB-tracked retention |
| Tests | None. | 110 automated API/integration/security/database tests |

## Security issues in the original code (all fixed)

1. Path traversal on `/download/:filename`.
2. OS command injection through the uploaded file name in `exec()`.
3. Extension fallback made content spoofing trivial; no size limit (disk exhaustion).
4. Output names derived from user-controlled `originalname`.
5. Internal error text returned to clients.

## Not carried over (and why)

* TXT → ZIP, HTML background image / Bootstrap CDN: no value, external dependency.
* Audio, PDF merge/split/convert, Word→PDF, watermark, protect/unlock: out of scope for this phase (see README "Limitations").
