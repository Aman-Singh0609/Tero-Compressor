import type { Operation } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { jobQueue } from '../queue/jobQueue';
import { isOperation, OPERATIONS, parseOptions, splitSecrets } from '../processors/operations';
import { fileRepository } from '../repositories/fileRepository';
import { jobRepository } from '../repositories/jobRepository';
import { getFileForDownload } from './fileService';
import { cancelRunning } from './jobRunner';
import { secretStore } from './secretStore';

/** Combined size of all inputs of one job (merge / images to PDF). */
const MAX_COMBINED_BYTES = 1.5 * 1024 * 1024 * 1024;

export async function createJob(fileIds: string[], operation: string, rawOptions: unknown) {
  if (!isOperation(operation)) throw new AppError('INVALID_OPERATION', 'That operation is not supported.');
  const tool = OPERATIONS[operation];
  if (fileIds.length < tool.minFiles) {
    throw new AppError(
      'INVALID_OPERATION',
      `${tool.label} needs at least ${tool.minFiles} file${tool.minFiles === 1 ? '' : 's'}.`,
    );
  }
  if (fileIds.length > tool.maxFiles) {
    throw new AppError(
      'INVALID_OPERATION',
      `${tool.label} accepts at most ${tool.maxFiles} file${tool.maxFiles === 1 ? '' : 's'}.`,
    );
  }

  const files = await fileRepository.findStorageInfoMany(fileIds);
  const byId = new Map(files.map((f) => [f.id, f]));
  let total = 0;
  for (const id of fileIds) {
    const file = byId.get(id);
    if (!file) throw new AppError('FILE_NOT_FOUND', 'One of the files was not found.');
    if (file.status === 'DELETED')
      throw new AppError('FILE_EXPIRED', 'A file has been removed. Please upload it again.');
    if (!(tool.accepts as string[]).includes(file.category)) {
      throw new AppError('INVALID_OPERATION', 'That tool does not work with this kind of file.');
    }
    total += Number(file.sizeBytes);
  }
  if (total > MAX_COMBINED_BYTES)
    throw new AppError('FILE_TOO_LARGE', 'These files are too large to process together.');

  let options: Record<string, unknown>;
  try {
    options = parseOptions(operation, rawOptions);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new AppError(
        'INVALID_OPTIONS',
        err.issues[0]?.message ?? 'Those settings are not valid.',
        err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    throw err;
  }

  // Passwords never reach the database: only a placeholder is stored, the real value stays in memory.
  const { publicOptions, secrets } = splitSecrets(operation, options);
  const job = await jobRepository.create({
    fileIds,
    operation: operation as Operation,
    options: publicOptions as Record<string, string | number | boolean>,
    originalSizeBytes: total,
  });
  secretStore.put(job.id, secrets);
  jobQueue.enqueue(job.id);
  return job;
}

export async function getJob(id: string) {
  const job = await jobRepository.findById(id);
  if (!job) throw new AppError('JOB_NOT_FOUND', 'That job was not found.');
  return job;
}

export async function cancelJob(id: string) {
  const job = await getJob(id);
  if (job.status !== 'QUEUED' && job.status !== 'PROCESSING') {
    throw new AppError('JOB_NOT_CANCELLABLE', 'This job has already finished.');
  }
  await jobRepository.cancel(id);
  secretStore.discard(id);
  cancelRunning(id);
  return getJob(id);
}

export async function getJobDownload(id: string) {
  const job = await getJob(id);
  if (job.status !== 'COMPLETED' || !job.outputFileId) {
    throw new AppError('JOB_NOT_READY', 'This file is not ready yet.');
  }
  return getFileForDownload(job.outputFileId);
}
