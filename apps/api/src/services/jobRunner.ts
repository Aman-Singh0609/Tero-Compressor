import { db } from '../db/prisma';
import { getEnv } from '../config/env';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { sha256File } from '../lib/hash';
import { baseNameOf } from '../security/filename';
import { processorFor } from '../processors/registry';
import { ProcessorError, type ProcessorResult } from '../processors/types';
import { OPERATIONS, type OperationName } from '../processors/operations';
import { fileRepository } from '../repositories/fileRepository';
import { toolResultRepository } from '../repositories/toolResultRepository';
import { jobRepository } from '../repositories/jobRepository';
import { storage, type StorageArea } from '../storage';
import { secretStore } from './secretStore';

interface RunningJob {
  fileIds: Set<string>;
  controller: AbortController;
  /** Settles once the job has fully stopped and released its files. */
  stopped: Promise<void>;
  markStopped: () => void;
}

/** Jobs currently executing in this process. */
const running = new Map<string, RunningJob>();
const STOP_WAIT_MS = 30_000;

class CancelledError extends Error {}

export function isRunning(jobId: string): boolean {
  return running.has(jobId);
}

export function cancelRunning(jobId: string): void {
  running.get(jobId)?.controller.abort();
}

export function abortAllRunning(): void {
  for (const job of running.values()) job.controller.abort();
}

export async function cancelJobsForFile(fileId: string): Promise<void> {
  for (const job of await jobRepository.activeJobsFor(fileId)) {
    await jobRepository.cancel(job.id);
    secretStore.discard(job.id);
    cancelRunning(job.id);
  }
  await waitForStop(fileId);
}

/**
 * Wait until jobs using this file have released their inputs before its bytes are deleted (an open handle
 * makes deletion fail on Windows, and a vanished input would crash a half-finished job).
 */
async function waitForStop(fileId: string): Promise<void> {
  const pending = [...running.values()].filter((j) => j.fileIds.has(fileId)).map((j) => j.stopped);
  if (pending.length === 0) return;
  await Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS))]);
}

function categoryForExt(ext: string, fallback: string): string {
  if (ext === 'pdf') return 'pdf';
  if (ext === 'zip') return 'archive';
  if (ext === 'txt' || ext === 'docx') return 'document';
  if (ext === 'mp3') return 'audio';
  if (['jpg', 'png', 'webp', 'avif', 'tiff', 'gif'].includes(ext)) return 'image';
  if (ext === 'mp4') return 'video';
  return fallback;
}

function outputDisplayName(firstName: string, inputCount: number, ext: string, operation: OperationName): string {
  const base = baseNameOf(firstName);
  const suffix = OPERATIONS[operation].outputSuffix;
  const combined = inputCount > 1 && suffix === '' ? '-combined' : '';
  return `${base}${suffix}${combined}.${ext}`;
}

function failureFor(err: unknown): { code: string; message: string; detail: string } {
  if (err instanceof ProcessorError) {
    const detail = [
      err.userMessage,
      err.cause ? String(err.cause instanceof Error ? (err.cause.stack ?? err.cause.message) : err.cause) : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (err.code === 'INVALID_FILE') return { code: 'INVALID_FILE', message: err.userMessage, detail };
    if (err.code === 'BAD_REQUEST') return { code: 'INVALID_OPTIONS', message: err.userMessage, detail };
    return {
      code: err.code === 'TIMEOUT' ? 'PROCESSING_TIMEOUT' : 'PROCESSING_FAILED',
      message: err.userMessage,
      detail,
    };
  }
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  return { code: 'PROCESSING_FAILED', message: 'Something went wrong while processing this file.', detail };
}

/** Execute one queued job end to end. Never throws: failures are recorded on the job. */
export async function runJob(jobId: string): Promise<void> {
  if (!(await jobRepository.claim(jobId))) {
    secretStore.discard(jobId);
    return; // cancelled or already claimed
  }
  const started = Date.now();
  const controller = new AbortController();
  let markStopped!: () => void;
  const stopped = new Promise<void>((resolve) => (markStopped = resolve));
  const entry: RunningJob = { fileIds: new Set(), controller, stopped, markStopped };
  running.set(jobId, entry);
  const log = logger().child({ jobId });
  let outputPath: string | undefined;
  const releases: Array<() => Promise<void>> = [];
  let inputIds: string[] = [];
  let inputFileFailed = false;
  const processorRef: { current?: ReturnType<typeof processorFor> } = {};
  const secrets = secretStore.take(jobId);

  try {
    const job = await jobRepository.findById(jobId);
    if (!job) return;
    const tool = OPERATIONS[job.operation];
    inputIds = job.inputs.length > 0 ? job.inputs.map((i) => i.file.id) : [job.fileId];
    inputIds.forEach((id) => entry.fileIds.add(id));
    const rows = await fileRepository.findStorageInfoMany(inputIds);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const files = inputIds.map((id) => byId.get(id));
    if (files.some((f) => !f || f.status === 'DELETED'))
      throw new ProcessorError('A file has expired.', 'INVALID_FILE');
    const present = files as NonNullable<(typeof files)[number]>[];
    for (const f of present) {
      if (!(await storage().exists(f.storageArea as StorageArea, f.storedName))) {
        throw new ProcessorError('An uploaded file is no longer available.', 'INVALID_FILE');
      }
    }
    const processor = processorFor(job.operation);
    if (!processor) throw new ProcessorError('This operation is not available.');
    processorRef.current = processor;
    if (tool.secretFields.some((k) => !secrets[k])) {
      throw new ProcessorError('The password was lost because the server restarted. Please try again.', 'BAD_REQUEST');
    }

    for (const id of inputIds) await fileRepository.setStatus(id, 'PROCESSING');
    const options = (job.options ?? {}) as Record<string, unknown>;
    const inputPaths: string[] = [];
    for (const f of present) {
      const copy = await storage().materialize(f.storageArea as StorageArea, f.storedName);
      releases.push(copy.release);
      inputPaths.push(copy.path);
    }
    const first = present[0]!;
    outputPath = storage().allocateWorkPath(processor.outputExtensionFor(job.operation, options, first.extension));
    const common = {
      inputPath: inputPaths[0]!,
      inputPaths,
      inputNames: present.map((f) => f.originalName),
      inputExt: first.extension,
      inputMime: first.mimeType,
      operation: job.operation,
      options,
      secrets,
    };

    await processor.validate(common);

    let lastPersisted = 0;
    let lastValue = 0;
    const result: ProcessorResult = await processor.process({
      ...common,
      inputSizeBytes: present.reduce((sum, f) => sum + Number(f.sizeBytes), 0),
      outputPath,
      signal: controller.signal,
      reportProgress: (percent) => {
        const value = Math.max(0, Math.min(99, Math.round(percent)));
        const now = Date.now();
        if (value <= lastValue || (now - lastPersisted < 750 && value < 99)) return;
        lastValue = value;
        lastPersisted = now;
        jobRepository.setProgress(jobId, value).catch(() => undefined);
      },
    });
    if (controller.signal.aborted) throw new CancelledError();

    const checksum = await sha256File(outputPath); // hashed from the scratch file before it is stored
    const stored = await storage().importFile('PROCESSED', outputPath, result.outputExt);
    outputPath = undefined;
    try {
      await db().$transaction(async (tx) => {
        const out = await fileRepository.create(
          {
            role: 'OUTPUT',
            originalName: outputDisplayName(first.originalName, present.length, result.outputExt, job.operation),
            storedName: stored.storedName,
            extension: result.outputExt,
            mimeType: result.outputMime,
            category: categoryForExt(result.outputExt, first.category),
            sizeBytes: stored.sizeBytes,
            storageArea: stored.area,
            storagePath: stored.storagePath,
            checksum,
            status: 'AVAILABLE',
            expiresAt: new Date(Date.now() + getEnv().FILE_RETENTION_DAYS * 86_400_000),
          },
          tx,
        );
        const done = await jobRepository.complete(
          jobId,
          {
            outputFileId: out.id,
            outputSizeBytes: stored.sizeBytes,
            durationMs: Date.now() - started,
            resultInfo: (result.info ?? {}) as Record<string, string | number | boolean>,
          },
          tx,
        );
        if (done.count !== 1) throw new CancelledError(); // cancelled while finishing: roll back
        await toolResultRepository.create(tx, {
          jobId,
          operation: job.operation,
          options,
          info: result.info ?? {},
          outputExt: result.outputExt,
        });
        for (const id of inputIds) await fileRepository.setStatus(id, 'AVAILABLE', tx);
      });
    } catch (err) {
      // keep storage and database consistent: no output bytes without a record
      await storage()
        .delete(stored.area, stored.storedName)
        .catch(() => undefined);
      throw err;
    }
    log.info({ fileIds: inputIds, operation: job.operation, durationMs: Date.now() - started }, 'job completed');
  } catch (err) {
    if (err instanceof CancelledError || (err instanceof ProcessorError && err.code === 'CANCELLED')) {
      await jobRepository.cancel(jobId);
      log.info('job cancelled');
    } else {
      const failure = failureFor(err);
      inputFileFailed = failure.code === 'INVALID_FILE';
      log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          cause: err instanceof ProcessorError ? String(err.cause ?? '') : undefined,
          details: err instanceof AppError ? err.details : undefined,
        },
        'job failed',
      );
      await jobRepository
        .fail(jobId, {
          errorCode: failure.code,
          errorMessage: failure.message,
          errorDetail: failure.detail,
          durationMs: Date.now() - started,
        })
        .catch((e) => log.error({ err: String(e) }, 'could not record job failure'));
    }
    for (const id of inputIds) {
      await fileRepository.setStatus(id, inputFileFailed ? 'FAILED' : 'UPLOADED').catch(() => undefined);
    }
  } finally {
    for (const release of releases) await release().catch(() => undefined);
    if (outputPath) {
      await processorRef.current?.cleanup({ outputPath }).catch(() => undefined);
    }
    secretStore.discard(jobId);
    running.delete(jobId);
    entry.markStopped();
  }
}
