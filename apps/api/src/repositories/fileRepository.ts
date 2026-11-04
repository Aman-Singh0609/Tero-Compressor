import type { FileRole, FileStatus, Prisma } from '@prisma/client';
import { db, type Tx } from '../db/prisma';
import { escapeLike } from '../lib/like';
import { instrument } from '../lib/timing';

export const FILE_LIST_SELECT = {
  id: true,
  role: true,
  originalName: true,
  extension: true,
  mimeType: true,
  category: true,
  sizeBytes: true,
  checksum: true,
  status: true,
  createdAt: true,
  expiresAt: true,
  deletedAt: true,
} satisfies Prisma.FileSelect;

export const FILE_DETAIL_SELECT = {
  ...FILE_LIST_SELECT,
  storedName: true,
  storageArea: true,
  storagePath: true,
  updatedAt: true,
  jobs: {
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      operation: true,
      status: true,
      progress: true,
      outputSizeBytes: true,
      processingDurationMs: true,
      errorCode: true,
      createdAt: true,
    },
  },
} satisfies Prisma.FileSelect;

export interface FileFilter {
  category?: string;
  status?: FileStatus;
  role?: FileRole;
  q?: string;
}

export interface NewFile {
  id?: string;
  role: FileRole;
  originalName: string;
  storedName: string;
  extension: string;
  mimeType: string;
  category: string;
  sizeBytes: number;
  storageArea: string;
  storagePath: string;
  checksum: string;
  status: FileStatus;
  expiresAt: Date;
}

function where(filter: FileFilter): Prisma.FileWhereInput {
  return {
    role: filter.role ?? 'UPLOAD',
    ...(filter.category ? { category: filter.category } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    // Substring search: a leading wildcard cannot use an index, which is acceptable at family scale.
    ...(filter.q ? { originalName: { contains: escapeLike(filter.q) } } : {}),
  };
}

const repo = {
  create(data: NewFile, tx?: Tx) {
    return (tx ?? db()).file.create({ data, select: FILE_DETAIL_SELECT });
  },

  findById(id: string) {
    return db().file.findUnique({ where: { id }, select: { ...FILE_DETAIL_SELECT } });
  },

  /** Minimal columns needed to locate bytes — used by download/processing paths. */
  findStorageInfo(id: string) {
    return db().file.findUnique({
      where: { id },
      select: {
        id: true,
        originalName: true,
        storedName: true,
        storageArea: true,
        extension: true,
        mimeType: true,
        category: true,
        sizeBytes: true,
        status: true,
        role: true,
        expiresAt: true,
      },
    });
  },

  /** Storage info for several files at once (multi-file jobs), one query. */
  findStorageInfoMany(ids: string[]) {
    return db().file.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        originalName: true,
        storedName: true,
        storageArea: true,
        extension: true,
        mimeType: true,
        category: true,
        sizeBytes: true,
        status: true,
        role: true,
        expiresAt: true,
      },
    });
  },

  async findMany(
    filter: FileFilter,
    sort: { field: 'createdAt' | 'sizeBytes' | 'originalName' | 'status'; order: 'asc' | 'desc' },
    page: number,
    limit: number,
  ) {
    const w = where(filter);
    const [items, total] = await Promise.all([
      db().file.findMany({
        where: w,
        select: {
          ...FILE_LIST_SELECT,
          // latest job per file in one batched query (no N+1)
          jobs: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, operation: true, status: true, processingDurationMs: true, outputSizeBytes: true },
          },
        },
        // id follows the sort direction so the (…, createdAt, id) index can be scanned without a filesort
        orderBy: [{ [sort.field]: sort.order }, { id: sort.order }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      db().file.count({ where: w }),
    ]);
    return { items, total };
  },

  /**
   * DELETED is terminal: a job that finishes (or fails) after its file was deleted must not resurrect the
   * record, so every other status is applied only while the row is not already DELETED.
   */
  setStatus(id: string, status: FileStatus, tx?: Tx) {
    const client = tx ?? db();
    if (status === 'DELETED') {
      return client.file.updateMany({ where: { id }, data: { status, deletedAt: new Date() } });
    }
    return client.file.updateMany({ where: { id, status: { not: 'DELETED' } }, data: { status } });
  },

  /** Expired, not-yet-deleted files with no job still using them. Oldest first, bounded batch. */
  findExpired(now: Date, batch: number, excludeIds: string[] = []) {
    return db().file.findMany({
      where: {
        expiresAt: { lte: now },
        status: { not: 'DELETED' },
        ...(excludeIds.length ? { id: { notIn: excludeIds } } : {}),
        // never remove a file a queued/running job still needs
        jobs: { none: { status: { in: ['QUEUED', 'PROCESSING'] } } },
        jobInputs: { none: { job: { status: { in: ['QUEUED', 'PROCESSING'] } } } },
      },
      orderBy: { expiresAt: 'asc' },
      take: batch,
      select: { id: true, storedName: true, storageArea: true },
    });
  },

  findOutputsOf(fileId: string) {
    return db().file.findMany({
      where: { producedByJob: { fileId } },
      select: { id: true, storedName: true, storageArea: true, status: true },
    });
  },

  sizeTotals() {
    return db().file.aggregate({
      where: { status: { not: 'DELETED' } },
      _sum: { sizeBytes: true },
      _count: true,
    });
  },
};

export const fileRepository = instrument('FileRepository', repo);
