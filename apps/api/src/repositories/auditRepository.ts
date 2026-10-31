import type { AuditAction, Prisma } from '@prisma/client';
import { db } from '../db/prisma';
import { instrument } from '../lib/timing';

export interface NewAuditEntry {
  adminId?: string | null;
  action: AuditAction;
  entityType?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string;
}

export interface AuditFilter {
  action?: AuditAction;
  adminId?: string;
  entityType?: string;
  entityId?: string;
}

const repo = {
  create(entry: NewAuditEntry) {
    return db().auditLog.create({ data: entry, select: { id: true } });
  },

  async findMany(filter: AuditFilter, page: number, limit: number) {
    const w: Prisma.AuditLogWhereInput = {
      ...(filter.action ? { action: filter.action } : {}),
      ...(filter.adminId ? { adminId: filter.adminId } : {}),
      ...(filter.entityType ? { entityType: filter.entityType } : {}),
      ...(filter.entityId ? { entityId: filter.entityId } : {}),
    };
    const [items, total] = await Promise.all([
      db().auditLog.findMany({
        where: w,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          metadata: true,
          ipAddress: true,
          createdAt: true,
          admin: { select: { id: true, email: true, name: true } },
        },
      }),
      db().auditLog.count({ where: w }),
    ]);
    return { items, total };
  },
};

export const auditRepository = instrument('AuditRepository', repo);
