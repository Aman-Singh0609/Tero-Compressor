import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnv } from '../src/config/env';
import { db } from '../src/db/prisma';
import { storage } from '../src/storage';
import { runCleanup } from '../src/services/retentionService';
import { makeJpeg } from './helpers/fixtures';
import { adminAgent, closeAll, processFile, resetAll, upload } from './helpers/harness';

beforeEach(resetAll);
afterAll(closeAll);

const dir = (name: string) => path.join(getEnv().storageRoot, name);
const DAY = 86_400_000;

async function expire(fileId: string, days = 8) {
  await db().file.update({ where: { id: fileId }, data: { expiresAt: new Date(Date.now() - (days - 7) * DAY) } });
}

describe('retention cleanup', () => {
  it('removes expired uploads and outputs, keeps metadata, and preserves vault files', async () => {
    const { agent } = await adminAgent();
    const up = await upload(await makeJpeg(400, 300), 'old.jpg');
    const fileId = up.body.data.file.id as string;
    const { job } = await processFile(fileId, 'IMAGE_COMPRESS');
    const fresh = await upload(await makeJpeg(300, 300), 'new.jpg');
    const vault = await agent.post('/api/v1/admin/vault').attach('file', Buffer.from('keep me forever'), 'keep.txt');

    await expire(fileId);
    await db().file.update({
      where: {
        id: job.id ? (await db().processingJob.findUniqueOrThrow({ where: { id: job.id } })).outputFileId! : '',
      },
      data: { expiresAt: new Date(Date.now() - DAY) },
    });
    // vault rows are old but must never be touched
    await db().vaultFile.update({
      where: { id: vault.body.data.id },
      data: { createdAt: new Date(Date.now() - 400 * DAY) },
    });

    const report = await runCleanup();
    expect(report.deleted).toBe(2);
    expect(report.failed).toBe(0);

    expect(await fs.readdir(dir('originals'))).toHaveLength(1); // only the fresh upload remains
    expect(await fs.readdir(dir('processed'))).toEqual([]);
    const gone = await db().file.findUniqueOrThrow({ where: { id: fileId } });
    expect(gone.status).toBe('DELETED');
    expect(gone.deletedAt).not.toBeNull();
    expect(gone.originalName).toBe('old.jpg'); // useful metadata retained
    expect((await db().file.findUniqueOrThrow({ where: { id: fresh.body.data.file.id } })).status).toBe('UPLOADED');
    expect((await db().processingJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('COMPLETED');

    // vault survives, row and bytes, and is still downloadable
    expect(await fs.readdir(dir('vault'))).toHaveLength(1);
    expect(await db().vaultFile.count()).toBe(1);
    const dl = await agent.get(`/api/v1/admin/vault/${vault.body.data.id}/download`);
    expect(dl.status).toBe(200);

    // idempotent
    expect((await runCleanup()).deleted).toBe(0);
  });

  it('copes with files already missing on disk and rows with no bytes', async () => {
    const up = await upload(await makeJpeg(200, 200), 'a.jpg');
    const id = up.body.data.file.id as string;
    const row = await db().file.findUniqueOrThrow({ where: { id } });
    await fs.rm(path.join(dir('originals'), row.storedName));
    await expire(id);
    const report = await runCleanup();
    expect(report).toMatchObject({ deleted: 0, alreadyMissing: 1, failed: 0 });
    expect((await db().file.findUniqueOrThrow({ where: { id } })).status).toBe('DELETED');
  });

  it('keeps the record for retry when deletion fails (locked file) and continues with others', async () => {
    const a = await upload(await makeJpeg(200, 200), 'a.jpg');
    const b = await upload(await makeJpeg(210, 210), 'b.jpg');
    const aId = a.body.data.file.id as string;
    const bId = b.body.data.file.id as string;
    await expire(aId);
    await expire(bId);
    const rowA = await db().file.findUniqueOrThrow({ where: { id: aId } });
    const original = storage().delete.bind(storage());
    const spy = vi.spyOn(storage(), 'delete').mockImplementation(async (area, name) => {
      if (name === rowA.storedName) throw new Error('EBUSY: resource busy or locked');
      return original(area, name);
    });
    const report = await runCleanup();
    spy.mockRestore();
    expect(report).toMatchObject({ deleted: 1, failed: 1 });
    expect((await db().file.findUniqueOrThrow({ where: { id: aId } })).status).toBe('UPLOADED'); // retried next run
    expect((await db().file.findUniqueOrThrow({ where: { id: bId } })).status).toBe('DELETED');
    expect((await runCleanup()).deleted).toBe(1); // second run succeeds
  });

  it('does not delete a file that a queued/processing job still needs', async () => {
    const up = await upload(await makeJpeg(200, 200), 'a.jpg');
    const id = up.body.data.file.id as string;
    await db().processingJob.create({
      data: {
        fileId: id,
        operation: 'IMAGE_COMPRESS',
        originalSizeBytes: 1,
        status: 'PROCESSING',
        startedAt: new Date(),
      },
    });
    await expire(id);
    expect((await runCleanup()).deleted).toBe(0);
    expect(await fs.readdir(dir('originals'))).toHaveLength(1);
  });

  it('fails jobs stuck in PROCESSING and sweeps stale scratch files', async () => {
    const up = await upload(await makeJpeg(200, 200), 'a.jpg');
    const job = await db().processingJob.create({
      data: {
        fileId: up.body.data.file.id,
        operation: 'IMAGE_COMPRESS',
        originalSizeBytes: 1,
        status: 'PROCESSING',
        startedAt: new Date(Date.now() - 3 * 3_600_000),
      },
    });
    const work = storage().allocateWorkPath('tmp');
    await fs.writeFile(work, 'x');
    await fs.utimes(work, new Date(Date.now() - 3 * DAY), new Date(Date.now() - 3 * DAY));
    const report = await runCleanup();
    expect(report.staleJobsFailed).toBe(1);
    expect(report.workFilesSwept).toBe(1);
    expect((await db().processingJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED');
  });

  it('admin can trigger cleanup via API', async () => {
    const { agent } = await adminAgent();
    const res = await agent.post('/api/v1/admin/storage/cleanup');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ deleted: 0, failed: 0 });
  });
});
