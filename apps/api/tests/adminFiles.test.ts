import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getEnv } from '../src/config/env';
import { db } from '../src/db/prisma';
import { makeJpeg, makePdfWithPhoto } from './helpers/fixtures';
import { adminAgent, closeAll, processFile, resetAll, upload } from './helpers/harness';

beforeEach(resetAll);
afterAll(closeAll);

async function seedFiles(count: number) {
  const now = Date.now();
  await db().file.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      originalName: `file-${String(i).padStart(3, '0')}.${i % 2 ? 'pdf' : 'jpg'}`,
      storedName: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      extension: i % 2 ? 'pdf' : 'jpg',
      mimeType: i % 2 ? 'application/pdf' : 'image/jpeg',
      category: i % 2 ? 'pdf' : 'image',
      sizeBytes: 1000 + i,
      storageArea: 'ORIGINAL',
      storagePath: `ORIGINAL/x${i}`,
      checksum: 'a'.repeat(64),
      status: i % 5 === 0 ? ('FAILED' as const) : ('AVAILABLE' as const),
      createdAt: new Date(now - i * 60_000),
    })),
  });
}

describe('GET /api/v1/admin/files', () => {
  it('paginates in SQL with metadata, and sorts', async () => {
    const { agent } = await adminAgent();
    await seedFiles(30);
    const p1 = await agent.get('/api/v1/admin/files?page=1&limit=10&sort=originalName&order=asc');
    expect(p1.status).toBe(200);
    expect(p1.body.data).toHaveLength(10);
    expect(p1.body.meta.pagination).toEqual({ page: 1, limit: 10, total: 30, totalPages: 3 });
    expect(p1.body.data[0].originalName).toBe('file-000.jpg');
    const p3 = await agent.get('/api/v1/admin/files?page=3&limit=10&sort=originalName&order=asc');
    expect(p3.body.data.map((f: { originalName: string }) => f.originalName)[9]).toBe('file-029.pdf');
    const bySize = await agent.get('/api/v1/admin/files?limit=3&sort=sizeBytes&order=desc');
    expect(bySize.body.data.map((f: { sizeBytes: number }) => f.sizeBytes)).toEqual([1029, 1028, 1027]);
  });

  it('filters by type, status and searches by name', async () => {
    const { agent } = await adminAgent();
    await seedFiles(30);
    const pdfs = await agent.get('/api/v1/admin/files?type=pdf&limit=100');
    expect(pdfs.body.meta.pagination.total).toBe(15);
    expect(pdfs.body.data.every((f: { category: string }) => f.category === 'pdf')).toBe(true);
    const failed = await agent.get('/api/v1/admin/files?status=FAILED&type=image&limit=100');
    expect(failed.body.data.every((f: { status: string }) => f.status === 'FAILED')).toBe(true);
    const search = await agent.get('/api/v1/admin/files?q=file-01');
    expect(search.body.meta.pagination.total).toBe(10);
    const none = await agent.get('/api/v1/admin/files?q=zzz-nothing');
    expect(none.body.data).toEqual([]);
  });

  it('rejects invalid query parameters (including SQL-ish sort fields)', async () => {
    const { agent } = await adminAgent();
    for (const q of [
      'limit=1000',
      'page=0',
      'sort=passwordHash',
      'sort=createdAt;DROP TABLE File',
      'status=NOPE',
      'type=exe',
    ]) {
      const res = await agent.get(`/api/v1/admin/files?${q}`);
      expect(res.status, q).toBe(400);
    }
  });

  it('does not leak the checksum-less public shape differences: list rows omit storage paths', async () => {
    const { agent } = await adminAgent();
    await seedFiles(2);
    const res = await agent.get('/api/v1/admin/files');
    expect(res.body.data[0]).not.toHaveProperty('storagePath');
    expect(res.body.data[0]).not.toHaveProperty('storedName');
  });
});

describe('admin file detail / download / delete', () => {
  it('shows metadata with job history, downloads the original, and deletes', async () => {
    const { agent } = await adminAgent();
    const jpeg = await makeJpeg(800, 600);
    const up = await upload(jpeg, 'family.jpg');
    const fileId = up.body.data.file.id as string;
    await processFile(fileId, 'IMAGE_COMPRESS');

    const detail = await agent.get(`/api/v1/admin/files/${fileId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({
      id: fileId,
      originalName: 'family.jpg',
      status: 'AVAILABLE',
      category: 'image',
    });
    expect(detail.body.data.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.body.data.jobs).toHaveLength(1);
    expect(detail.body.data.jobs[0]).toMatchObject({ operation: 'IMAGE_COMPRESS', status: 'COMPLETED' });

    const list = await agent.get('/api/v1/admin/files');
    expect(list.body.data[0].jobs[0].operation).toBe('IMAGE_COMPRESS'); // latest job joined without N+1

    const dl = await agent
      .get(`/api/v1/admin/files/${fileId}/download`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('family.jpg');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect((dl.body as Buffer).equals(jpeg)).toBe(true);

    const del = await agent.delete(`/api/v1/admin/files/${fileId}`);
    expect(del.body).toEqual({ success: true, data: { id: fileId, status: 'DELETED' } });
    expect(await fs.readdir(path.join(getEnv().storageRoot, 'originals'))).toEqual([]);
    expect(await fs.readdir(path.join(getEnv().storageRoot, 'processed'))).toEqual([]); // outputs removed too
    expect((await agent.get(`/api/v1/admin/files/${fileId}/download`)).status).toBe(410);
    expect((await agent.delete(`/api/v1/admin/files/${fileId}`)).status).toBe(404);
  });

  it('404s unknown ids and 400s malformed ids; downloads resolve only from database ids', async () => {
    const { agent } = await adminAgent();
    expect((await agent.get('/api/v1/admin/files/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    for (const bad of ['..%2F..%2F.env', '../../etc/passwd', 'C:%5CWindows%5Cwin.ini', '%00']) {
      const res = await agent.get(`/api/v1/admin/files/${bad}/download`);
      expect([400, 404]).toContain(res.status);
    }
  });
});

describe('admin jobs, dashboard, storage, metrics', () => {
  it('lists and filters jobs and shows detail', async () => {
    const { agent } = await adminAgent();
    const a = await upload(await makeJpeg(300, 200), 'a.jpg');
    const b = await upload(await makePdfWithPhoto(), 'b.pdf');
    await processFile(a.body.data.file.id, 'IMAGE_COMPRESS');
    await processFile(b.body.data.file.id, 'PDF_COMPRESS');
    const all = await agent.get('/api/v1/admin/jobs');
    expect(all.body.meta.pagination.total).toBe(2);
    const pdf = await agent.get('/api/v1/admin/jobs?operation=PDF_COMPRESS');
    expect(pdf.body.data).toHaveLength(1);
    expect(pdf.body.data[0].fileName).toBe('b.pdf');
    const one = await agent.get(`/api/v1/admin/jobs/${pdf.body.data[0].id}`);
    expect(one.body.data.status).toBe('COMPLETED');
    expect((await agent.get('/api/v1/admin/jobs/00000000-0000-4000-8000-000000000000')).body.error.code).toBe(
      'JOB_NOT_FOUND',
    );
  });

  it('dashboard aggregates uploads, jobs, savings and breakdowns', async () => {
    const { agent } = await adminAgent();
    const a = await upload(await makeJpeg(1200, 900), 'a.jpg');
    await processFile(a.body.data.file.id, 'IMAGE_COMPRESS');
    const dash = (await agent.get('/api/v1/admin/dashboard')).body.data;
    expect(dash.uploads).toMatchObject({ total: 1, today: 1, thisWeek: 1 });
    expect(dash.jobs).toMatchObject({ total: 1, completed: 1, failed: 0, active: 0 });
    expect(dash.jobs.savedBytes).toBeGreaterThan(0);
    expect(dash.jobs.inputBytes).toBeGreaterThan(dash.jobs.outputBytes);
    expect(dash.operations).toEqual([{ operation: 'IMAGE_COMPRESS', count: 1 }]);
    expect(dash.filesByCategory).toEqual([{ category: 'image', count: 1 }]);
    expect(dash.uploadsByDay).toHaveLength(1);
    expect(dash.recentUploads[0].originalName).toBe('a.jpg');
  });

  it('storage, metrics and settings endpoints respond', async () => {
    const { agent } = await adminAgent();
    await upload(await makeJpeg(100, 100), 'a.jpg');
    const storage = (await agent.get('/api/v1/admin/storage')).body.data;
    expect(storage.disk.ORIGINAL.files).toBe(1);
    expect(storage.database.temporaryFiles.count).toBe(1);
    const metrics = (await agent.get('/api/v1/admin/metrics')).body.data;
    expect(metrics.requests.length).toBeGreaterThan(0);
    expect(metrics.queue).toHaveProperty('concurrency');
    const settings = (await agent.get('/api/v1/admin/settings')).body.data;
    expect(settings.retentionDays).toBe(7);
    expect(JSON.stringify(settings)).not.toMatch(/SECRET|PASSWORD|DATABASE_URL/i);
  });
});
