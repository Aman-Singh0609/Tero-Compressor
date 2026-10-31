import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/prisma';
import { closeAll, createAdmin, resetAll } from './helpers/harness';

beforeEach(resetAll);
afterAll(closeAll);

const fileData = (n: number) => ({
  originalName: `f${n}.jpg`,
  storedName: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}.jpg`,
  extension: 'jpg',
  mimeType: 'image/jpeg',
  category: 'image',
  sizeBytes: 10,
  storageArea: 'ORIGINAL',
  storagePath: `ORIGINAL/${n}`,
  checksum: 'b'.repeat(64),
});

describe('schema constraints', () => {
  it('enforces unique stored names and admin emails', async () => {
    await db().file.create({ data: fileData(1) });
    await expect(db().file.create({ data: fileData(1) })).rejects.toMatchObject({ code: 'P2002' });
    await createAdmin();
    await expect(createAdmin()).rejects.toMatchObject({ code: 'P2002' });
  });

  it('restricts deleting a file that has jobs, and cascades sessions with their admin', async () => {
    const f = await db().file.create({ data: fileData(2) });
    await db().processingJob.create({ data: { fileId: f.id, operation: 'IMAGE_COMPRESS', originalSizeBytes: 10 } });
    await expect(db().file.delete({ where: { id: f.id } })).rejects.toMatchObject({ code: 'P2003' });

    const admin = await createAdmin();
    await db().adminSession.create({
      data: { adminId: admin.id, tokenHash: 'c'.repeat(64), expiresAt: new Date(Date.now() + 1000) },
    });
    await db().admin.delete({ where: { id: admin.id } });
    expect(await db().adminSession.count()).toBe(0);
  });

  it('keeps vault files and audit rows when the admin is removed (SET NULL)', async () => {
    const admin = await createAdmin();
    await db().vaultFile.create({
      data: {
        displayName: 'v',
        storedName: '00000000-0000-4000-8000-0000000000aa',
        mimeType: 'text/plain',
        extension: 'txt',
        category: 'document',
        sizeBytes: 1,
        checksum: 'd'.repeat(64),
        storagePath: 'VAULT/x',
        uploadedByAdminId: admin.id,
      },
    });
    await db().auditLog.create({ data: { adminId: admin.id, action: 'ADMIN_LOGIN' } });
    await db().admin.delete({ where: { id: admin.id } });
    expect((await db().vaultFile.findFirstOrThrow()).uploadedByAdminId).toBeNull();
    expect((await db().auditLog.findFirstOrThrow()).adminId).toBeNull();
  });

  it('rolls back a multi-write transaction on failure (job + output file consistency)', async () => {
    const f = await db().file.create({ data: fileData(3) });
    const job = await db().processingJob.create({
      data: { fileId: f.id, operation: 'IMAGE_COMPRESS', originalSizeBytes: 10, status: 'PROCESSING' },
    });
    await expect(
      db().$transaction(async (tx) => {
        const out = await tx.file.create({ data: { ...fileData(4), role: 'OUTPUT' } });
        await tx.processingJob.update({ where: { id: job.id }, data: { status: 'COMPLETED', outputFileId: out.id } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db().file.count({ where: { role: 'OUTPUT' } })).toBe(0);
    expect((await db().processingJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('PROCESSING');
  });

  it('migrations created the documented indexes', async () => {
    const rows = await db().$queryRaw<Array<{ TABLE_NAME: string; INDEX_NAME: string }>>`
      SELECT DISTINCT TABLE_NAME, INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()`;
    const names = new Set(rows.map((r) => `${r.TABLE_NAME}.${r.INDEX_NAME}`));
    for (const idx of [
      'File.File_createdAt_idx',
      'File.File_status_createdAt_idx',
      'File.File_category_createdAt_idx',
      'File.File_expiresAt_status_idx',
      'File.File_checksum_idx',
      'ProcessingJob.ProcessingJob_status_createdAt_idx',
      'ProcessingJob.ProcessingJob_fileId_idx',
      'ProcessingJob.ProcessingJob_createdAt_idx',
      'AuditLog.AuditLog_createdAt_idx',
      'AuditLog.AuditLog_adminId_createdAt_idx',
      'VaultFile.VaultFile_createdAt_idx',
      'AdminSession.AdminSession_tokenHash_key',
    ]) {
      expect(names.has(idx), idx).toBe(true);
    }
  });
});
