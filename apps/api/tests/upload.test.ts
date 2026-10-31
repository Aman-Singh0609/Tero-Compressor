import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/prisma';
import { getEnv } from '../src/config/env';
import { EXE_BYTES, makeDocx, makeJpeg, makePdfWithPhoto, makePng } from './helpers/fixtures';
import { closeAll, request, resetAll, upload } from './helpers/harness';

beforeEach(resetAll);
afterAll(closeAll);

async function filesOnDisk(dir: string): Promise<string[]> {
  return fs.readdir(path.join(getEnv().storageRoot, dir));
}

describe('POST /api/v1/files/upload', () => {
  it('accepts a valid JPEG, stores metadata in MySQL and bytes on disk', async () => {
    const jpeg = await makeJpeg(200, 150);
    const res = await upload(jpeg, 'holiday.jpg', 'image/jpeg');
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    const { file, suggestedOperations } = res.body.data;
    expect(file).toMatchObject({
      name: 'holiday.jpg',
      mimeType: 'image/jpeg',
      category: 'image',
      sizeBytes: jpeg.length,
    });
    expect(file).not.toHaveProperty('storedName');
    expect(file).not.toHaveProperty('checksum');
    expect(suggestedOperations.map((o: { operation: string }) => o.operation)).toContain('IMAGE_COMPRESS');

    const row = await db().file.findUniqueOrThrow({ where: { id: file.id } });
    expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(row.status).toBe('UPLOADED');
    expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(await filesOnDisk('originals')).toEqual([row.storedName]);
    expect(row.storedName).toMatch(/^[0-9a-f-]{36}\.jpg$/);
    expect(await filesOnDisk('temporary')).toEqual([]); // scratch file consumed
  });

  it('detects PDF and DOCX from content', async () => {
    const pdf = await upload(await makePdfWithPhoto(), 'scan.pdf', 'application/pdf');
    expect(pdf.body.data.file.category).toBe('pdf');
    const docx = await upload(await makeDocx(false), 'letter.docx');
    expect(docx.body.data.file.category).toBe('document');
  });

  it('rejects a request without a file', async () => {
    const res = await request().post('/api/v1/files/upload').field('x', 'y');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: { code: 'INVALID_FILE' } });
  });

  it('rejects unsupported content (executable renamed to .jpg is spoofing)', async () => {
    const res = await upload(EXE_BYTES, 'holiday.jpg', 'image/jpeg');
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect(await db().file.count()).toBe(0);
    expect(await filesOnDisk('originals')).toEqual([]);
    expect(await filesOnDisk('temporary')).toEqual([]);
  });

  it('rejects a real PNG named .pdf (extension spoofing) even with a matching Content-Type', async () => {
    const res = await upload(await makePng(), 'invoice.pdf', 'application/pdf');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_FILE');
    expect(await db().file.count()).toBe(0);
  });

  it('rejects files over the size limit and leaves nothing behind', async () => {
    const big = Buffer.concat([await makeJpeg(100, 100), Buffer.alloc(6 * 1024 * 1024)]);
    const res = await upload(big, 'big.jpg', 'image/jpeg');
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
    expect(await db().file.count()).toBe(0);
    expect(await filesOnDisk('temporary')).toEqual([]);
    expect(await filesOnDisk('originals')).toEqual([]);
  });

  it('rejects empty files', async () => {
    const res = await upload(Buffer.alloc(0), 'empty.jpg', 'image/jpeg');
    expect(res.status).toBe(400);
  });

  it('never uses the client file name as a path (traversal / null bytes)', async () => {
    const jpeg = await makeJpeg(120, 90);
    const res = await upload(jpeg, '../../../etc/pass\0wd..\\..\\evil.jpg', 'image/jpeg');
    expect(res.status).toBe(201);
    expect(res.body.data.file.name).toBe('evil.jpg');
    const row = await db().file.findFirstOrThrow();
    expect(row.storedName).toMatch(/^[0-9a-f-]{36}\.jpg$/);
    expect(row.originalName).not.toMatch(/[\\/\0]/);
    const outside = await fs.readdir(path.dirname(getEnv().storageRoot));
    expect(outside.some((n) => n.includes('evil'))).toBe(false);
  });

  it('returns the same checksum for identical content (duplicate detection)', async () => {
    const jpeg = await makeJpeg(100, 100);
    await upload(jpeg, 'a.jpg');
    await upload(jpeg, 'b.jpg');
    const rows = await db().file.findMany({ select: { checksum: true } });
    expect(new Set(rows.map((r) => r.checksum)).size).toBe(1);
  });
});

describe('file metadata / delete', () => {
  it('GET /files/:id returns metadata; unknown or malformed ids fail cleanly', async () => {
    const up = await upload(await makeJpeg(100, 100), 'x.jpg');
    const id = up.body.data.file.id;
    expect((await request().get(`/api/v1/files/${id}`)).body.data.file.id).toBe(id);
    const missing = await request().get('/api/v1/files/00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('FILE_NOT_FOUND');
    const bad = await request().get('/api/v1/files/not-a-uuid');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('DELETE /files/:id removes bytes and marks the row DELETED', async () => {
    const up = await upload(await makeJpeg(100, 100), 'x.jpg');
    const id = up.body.data.file.id;
    const del = await request().delete(`/api/v1/files/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.data).toEqual({ id, status: 'DELETED' });
    expect(await filesOnDisk('originals')).toEqual([]);
    const row = await db().file.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('DELETED');
    expect(row.deletedAt).not.toBeNull();
    expect((await request().get(`/api/v1/files/${id}`)).status).toBe(410);
    expect((await request().delete(`/api/v1/files/${id}`)).status).toBe(404);
  });

  it('serves an image thumbnail and refuses it for non-images', async () => {
    const img = await upload(await makeJpeg(900, 700), 'x.jpg');
    const thumb = await request().get(`/api/v1/files/${img.body.data.file.id}/thumbnail`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/webp');
    const pdf = await upload(await makePdfWithPhoto(), 'x.pdf');
    expect((await request().get(`/api/v1/files/${pdf.body.data.file.id}/thumbnail`)).status).toBe(400);
  });
});
