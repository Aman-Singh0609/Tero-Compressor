import type { Prisma } from '@prisma/client';
import { db } from '../db/prisma';
import { escapeLike } from '../lib/like';
import { instrument } from '../lib/timing';

const VAULT_SELECT = {
  id: true,
  displayName: true,
  description: true,
  mimeType: true,
  extension: true,
  category: true,
  sizeBytes: true,
  checksum: true,
  createdAt: true,
  updatedAt: true,
  lastDownloadedAt: true,
  downloadCount: true,
  isAvailable: true,
  uploadedBy: { select: { id: true, name: true } },
} satisfies Prisma.VaultFileSelect;

export interface VaultFilter {
  q?: string;
  category?: string;
}

export interface NewVaultFile {
  displayName: string;
  storedName: string;
  description?: string | null;
  mimeType: string;
  extension: string;
  category: string;
  sizeBytes: number;
  checksum: string;
  storagePath: string;
  uploadedByAdminId: string;
}

function where(f: VaultFilter): Prisma.VaultFileWhereInput {
  return {
    ...(f.category ? { category: f.category } : {}),
    ...(f.q
      ? { OR: [{ displayName: { contains: escapeLike(f.q) } }, { description: { contains: escapeLike(f.q) } }] }
      : {}),
  };
}

const repo = {
  create(data: NewVaultFile) {
    return db().vaultFile.create({ data, select: VAULT_SELECT });
  },

  findById(id: string) {
    return db().vaultFile.findUnique({ where: { id }, select: VAULT_SELECT });
  },

  findStorageInfo(id: string) {
    return db().vaultFile.findUnique({
      where: { id },
      select: { id: true, displayName: true, storedName: true, mimeType: true, extension: true, isAvailable: true },
    });
  },

  async findMany(
    filter: VaultFilter,
    sort: { field: 'createdAt' | 'displayName' | 'sizeBytes' | 'downloadCount'; order: 'asc' | 'desc' },
    page: number,
    limit: number,
  ) {
    const w = where(filter);
    const [items, total] = await Promise.all([
      db().vaultFile.findMany({
        where: w,
        select: VAULT_SELECT,
        orderBy: [{ [sort.field]: sort.order }, { id: sort.order }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      db().vaultFile.count({ where: w }),
    ]);
    return { items, total };
  },

  update(id: string, data: { displayName?: string; description?: string | null }) {
    return db().vaultFile.update({ where: { id }, data, select: VAULT_SELECT });
  },

  replaceFile(
    id: string,
    data: {
      storedName: string;
      storagePath: string;
      mimeType: string;
      extension: string;
      category: string;
      sizeBytes: number;
      checksum: string;
    },
  ) {
    return db().vaultFile.update({
      where: { id },
      data: { ...data, downloadCount: 0, lastDownloadedAt: null },
      select: VAULT_SELECT,
    });
  },

  recordDownload(id: string) {
    return db().vaultFile.update({
      where: { id },
      data: { downloadCount: { increment: 1 }, lastDownloadedAt: new Date() },
      select: { id: true },
    });
  },

  delete(id: string) {
    return db().vaultFile.delete({ where: { id }, select: { id: true } });
  },

  totals() {
    return db().vaultFile.aggregate({ _sum: { sizeBytes: true }, _count: true });
  },
};

export const vaultRepository = instrument('VaultRepository', repo);
