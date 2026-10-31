import type { JobStatus, Operation, Prisma } from '@prisma/client';
import { db, type Tx } from '../db/prisma';
import { instrument } from '../lib/timing';

const JOB_SELECT = {
  id: true,
  fileId: true,
  operation: true,
  options: true,
  status: true,
  progress: true,
  originalSizeBytes: true,
  outputSizeBytes: true,
  outputFileId: true,
  startedAt: true,
  completedAt: true,
  failedAt: true,
  processingDurationMs: true,
  errorCode: true,
  errorMessage: true,
  resultInfo: true,
  createdAt: true,
  file: { select: { id: true, originalName: true, extension: true, category: true } },
} satisfies Prisma.ProcessingJobSelect;

export interface JobFilter {
  status?: JobStatus;
  operation?: Operation;
  fileId?: string;
}

function where(f: JobFilter): Prisma.ProcessingJobWhereInput {
  return {
    ...(f.status ? { status: f.status } : {}),
    ...(f.operation ? { operation: f.operation } : {}),
    ...(f.fileId ? { fileId: f.fileId } : {}),
  };
}

const repo = {
  create(data: { fileId: string; operation: Operation; options: Prisma.InputJsonValue; originalSizeBytes: number }) {
    return db().processingJob.create({ data, select: JOB_SELECT });
  },

  findById(id: string) {
    return db().processingJob.findUnique({ where: { id }, select: JOB_SELECT });
  },

  async findMany(filter: JobFilter, page: number, limit: number) {
    const w = where(filter);
    const [items, total] = await Promise.all([
      db().processingJob.findMany({
        where: w,
        select: JOB_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      db().processingJob.count({ where: w }),
    ]);
    return { items, total };
  },

  /** Atomically claim a queued job so two workers can never run the same job. */
  async claim(id: string): Promise<boolean> {
    const res = await db().processingJob.updateMany({
      where: { id, status: 'QUEUED' },
      data: { status: 'PROCESSING', startedAt: new Date(), progress: 0 },
    });
    return res.count === 1;
  },

  setProgress(id: string, progress: number) {
    return db().processingJob.updateMany({ where: { id, status: 'PROCESSING' }, data: { progress } });
  },

  fail(id: string, data: { errorCode: string; errorMessage: string; durationMs?: number }, tx?: Tx) {
    return (tx ?? db()).processingJob.updateMany({
      where: { id, status: { in: ['QUEUED', 'PROCESSING'] } },
      data: {
        status: 'FAILED',
        failedAt: new Date(),
        errorCode: data.errorCode,
        errorMessage: data.errorMessage.slice(0, 500),
        ...(data.durationMs !== undefined ? { processingDurationMs: data.durationMs } : {}),
      },
    });
  },

  cancel(id: string) {
    return db().processingJob.updateMany({
      where: { id, status: { in: ['QUEUED', 'PROCESSING'] } },
      data: { status: 'CANCELLED', failedAt: new Date(), errorCode: 'CANCELLED', errorMessage: 'Cancelled by user' },
    });
  },

  complete(
    id: string,
    data: { outputFileId: string; outputSizeBytes: number; durationMs: number; resultInfo: Prisma.InputJsonValue },
    tx: Tx,
  ) {
    return tx.processingJob.updateMany({
      where: { id, status: 'PROCESSING' },
      data: {
        status: 'COMPLETED',
        progress: 100,
        completedAt: new Date(),
        outputFileId: data.outputFileId,
        outputSizeBytes: data.outputSizeBytes,
        processingDurationMs: data.durationMs,
        resultInfo: data.resultInfo,
      },
    });
  },

  findByStatus(statuses: JobStatus[]) {
    return db().processingJob.findMany({
      where: { status: { in: statuses } },
      select: { id: true, fileId: true, status: true, startedAt: true },
      orderBy: { createdAt: 'asc' },
    });
  },

  activeJobsFor(fileId: string) {
    return db().processingJob.findMany({
      where: { fileId, status: { in: ['QUEUED', 'PROCESSING'] } },
      select: { id: true },
    });
  },
};

export const jobRepository = instrument('JobRepository', repo);
