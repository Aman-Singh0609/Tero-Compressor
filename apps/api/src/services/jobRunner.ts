import { db } from '../db/prisma';
import { getEnv } from '../config/env';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { sha256File } from '../lib/hash';
import { baseNameOf } from '../security/filename';
import { processorFor } from '../processors/registry';
import { ProcessorError, type ProcessorResult } from '../processors/types';
import type { OperationName } from '../processors/operations';
import { fileRepository } from '../repositories/fileRepository';
import { toolResultRepository } from '../repositories/toolResultRepository';
import { jobRepository } from '../repositories/jobRepository';
import { storage, type StorageArea } from '../storage';

interface RunningJob {
  fileId?: string;
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
    cancelRunning(job.id);
  }
  await waitForStop(fileId);
}

/**
 * Wait until jobs of this file have released their input before its bytes are deleted (an open handle
 * makes deletion fail on Windows, and a vanished input would crash a half-finished job).
 */
async function waitForStop(fileId: string): Promise<void> {
  const pending = [...running.values()].filter((j) => j.fileId === fileId).map((j) => j.stopped);
  if (pending.length === 0) return;
  await Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS))]);
}

function outputDisplayName(originalName: string, ext: string, operation: OperationName): string {
  const suffix = operation === 'IMAGE_TO_PDF' || operation === 'VIDEO_EXTRACT_AUDIO' ? '' : '-tero';
  return `${baseNameOf(originalName)}${suffix}.${ext}`;
}

function failureFor(err: unknown): { code: string; message: string } {
  if (err instanceof ProcessorError) {
    if (err.code === 'INVALID_FILE') return { code: 'INVALID_FILE', message: err.userMessage };
    return { code: err.code === 'TIMEOUT' ? 'PROCESSING_TIMEOUT' : 'PROCESSING_FAILED', message: err.userMessage };
  }
  return { code: 'PROCESSING_FAILED', message: 'Something went wrong while processing this file.' };
}

/** Execute one queued job end to end. Never throws: failures are recorded on the job. */
export async function runJob(jobId: string): Promise<void> {
  if (!(await jobRepository.claim(jobId))) return; // cancelled or already claimed
  const started = Date.now();
  const controller = new AbortController();
  let markStopped!: () => void;
  const stopped = new Promise<void>((resolve) => (markStopped = resolve));
  const entry: RunningJob = { controller, stopped, markStopped };
  running.set(jobId, entry);
  const log = logger().child({ jobId });
  let outputPath: string | undefined;
  let releaseInput: (() => Promise<void>) | undefined;
  let fileId: string | undefined;
  let inputFileFailed = false;
  const processorRef: { current?: ReturnType<typeof processorFor> } = {};

  try {
    const job = await jobRepository.findById(jobId);
    if (!job) return;
    fileId = job.fileId;
    entry.fileId = job.fileId;
    const file = await fileRepository.findStorageInfo(job.fileId);
    if (!file || file.status === 'DELETED') throw new ProcessorError('This file has expired.', 'INVALID_FILE');
    const area = file.storageArea as StorageArea;
    if (!(await storage().exists(area, file.storedName))) {
      throw new ProcessorError('The uploaded file is no longer available.', 'INVALID_FILE');
    }
    const processor = processorFor(job.operation);
    if (!processor) throw new ProcessorError('This operation is not available.');
    processorRef.current = processor;

    await fileRepository.setStatus(file.id, 'PROCESSING');
    const options = (job.options ?? {}) as Record<string, unknown>;
    const inputCopy = await storage().materialize(area, file.storedName);
    releaseInput = inputCopy.release;
    const inputPath = inputCopy.path;
    outputPath = storage().allocateWorkPath(processor.outputExtensionFor(job.operation, options, file.extension));
    const common = { inputPath, inputExt: file.extension, inputMime: file.mimeType, operation: job.operation, options };

    await processor.validate(common);

    let lastPersisted = 0;
    let lastValue = 0;
    const result: ProcessorResult = await processor.process({
      ...common,
      inputSizeBytes: Number(file.sizeBytes),
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
            originalName: outputDisplayName(file.originalName, result.outputExt, job.operation),
            storedName: stored.storedName,
            extension: result.outputExt,
            mimeType: result.outputMime,
            category:
              file.category === 'video' && result.outputExt === 'mp3'
                ? 'audio'
                : file.category === 'image' && result.outputExt === 'pdf'
                  ? 'pdf'
                  : file.category,
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
        await fileRepository.setStatus(file.id, 'AVAILABLE', tx);
      });
    } catch (err) {
      // keep storage and database consistent: no output bytes without a record
      await storage()
        .delete(stored.area, stored.storedName)
        .catch(() => undefined);
      throw err;
    }
    log.info({ fileId: file.id, operation: job.operation, durationMs: Date.now() - started }, 'job completed');
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
        .fail(jobId, { errorCode: failure.code, errorMessage: failure.message, durationMs: Date.now() - started })
        .catch((e) => log.error({ err: String(e) }, 'could not record job failure'));
    }
    if (fileId) {
      await fileRepository.setStatus(fileId, inputFileFailed ? 'FAILED' : 'UPLOADED').catch(() => undefined);
    }
  } finally {
    await releaseInput?.().catch(() => undefined);
    if (outputPath) {
      await processorRef.current?.cleanup({ outputPath }).catch(() => undefined);
    }
    running.delete(jobId);
    entry.markStopped();
  }
}
