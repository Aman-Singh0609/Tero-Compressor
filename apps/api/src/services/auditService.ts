import type { AuditAction, Prisma } from '@prisma/client';
import { logger } from '../lib/logger';
import { auditRepository } from '../repositories/auditRepository';

export interface AuditContext {
  adminId?: string | null;
  ip?: string;
}

/**
 * Record an administrative action. Metadata must never contain passwords, tokens or file contents;
 * callers pass identifiers and names only. A failing audit write is logged but does not break the request.
 */
export async function audit(
  ctx: AuditContext,
  action: AuditAction,
  entity?: { type: string; id: string },
  metadata?: Prisma.InputJsonValue,
): Promise<void> {
  try {
    await auditRepository.create({
      adminId: ctx.adminId ?? null,
      action,
      entityType: entity?.type,
      entityId: entity?.id,
      metadata,
      ipAddress: ctx.ip,
    });
  } catch (err) {
    logger().error({ err: String(err), action }, 'failed to write audit log');
  }
}
