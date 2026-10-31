import type { Operation } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { jobQueue } from '../queue/jobQueue';
import { isOperation, OPERATIONS, parseOptions } from '../processors/operations';
import { fileRepository } from '../repositories/fileRepository';
import { jobRepository } from '../repositories/jobRepository';
import { getFileForDownload } from './fileService';
import { cancelRunning } from './jobRunner';

export async function createJob(fileId: string, operation: string, rawOptions: unknown) {
  if (!isOperation(operation)) throw new AppError('INVALID_OPERATION', 'That operation is not supported.');
  const file = await fileRepository.findStorageInfo(fileId);
  if (!file) throw new AppError('FILE_NOT_FOUND', 'That file was not found.');
  if (file.status === 'DELETED')
    throw new AppError('FILE_EXPIRED', 'This file has been removed. Please upload it again.');
  if (!(OPERATIONS[operation].accepts as string[]).includes(file.category)) {
    throw new AppError('INVALID_OPERATION', 'That tool does not work with this kind of file.');
  }

  let options: Record<string, unknown>;
  try {
    options = parseOptions(operation, rawOptions);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new AppError(
        'INVALID_OPTIONS',
        'Those settings are not valid.',
        err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    throw err;
  }

  const job = await jobRepository.create({
    fileId,
    operation: operation as Operation,
    options: options as Record<string, string | number | boolean>,
    originalSizeBytes: Number(file.sizeBytes),
  });
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
