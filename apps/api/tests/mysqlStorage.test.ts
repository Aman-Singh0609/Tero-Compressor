import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getEnv } from '../src/config/env';
import { db } from '../src/db/prisma';
import { CHUNK_BYTES, MysqlStorageService } from '../src/storage/mysqlStorage';
import { setStorageForTests, storage } from '../src/storage';
import { runCleanup } from '../src/services/retentionService';
import { makeDocx, makeJpeg, makeMp4, makePdfWithPhoto } from './helpers/fixtures';
import { adminAgent, closeAll, processFile, request, resetAll, upload } from './helpers/harness';

const mysql = () => new MysqlStorageService(getEnv().storageRoot);

beforeAll(async () => {
  await mysql().ensureReady();
});
beforeEach(async () => {
  await resetAll();
  setStorageForTests(mysql());
});
afterEach(() => setStorageForTests(undefined));
afterAll(closeAll);

const download = (url: string, agent = request()) =>
  agent
    .get(url)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

describe('MysqlStorageService', () => {
  it('saves, reads, streams, reports metadata and deletes (idempotently)', async () => {
    const s = mysql();
    const data = randomBytes(10_000);
    const obj = await s.save('ORIGINAL', data, 'bin');
    expect(obj.storagePath).toBe(`ORIGINAL/${obj.storedName}`);
    expect(obj.sizeBytes).toBe(10_000);
    expect((await s.read('ORIGINAL', obj.storedName)).equals(data)).toBe(true);
    const streamed: Buffer[] = [];
    for await (const c of s.createReadStream('ORIGINAL', obj.storedName)) streamed.push(c as Buffer);
    expect(Buffer.concat(streamed).equals(data)).toBe(true);
    expect((await s.getMetadata('ORIGINAL', obj.storedName))?.sizeBytes).toBe(10_000);
    expect(await s.exists('VAULT', obj.storedName)).toBe(false); // areas are separate namespaces
    expect(await s.delete('ORIGINAL', obj.storedName)).toBe(true);
    expect(await s.delete('ORIGINAL', obj.storedName)).toBe(false);
    expect(await s.exists('ORIGINAL', obj.storedName)).toBe(false);
    expect(await db().storageChunk.count()).toBe(0);
  });

  it('splits large files into 4 MB chunks and reads them back byte-for-byte', async () => {
    const s = mysql();
    const big = randomBytes(CHUNK_BYTES * 2 + 12_345);
    const src = s.allocateWorkPath('bin');
    await fs.writeFile(src, big);
    const obj = await s.importFile('PROCESSED', src, 'bin');
    await expect(fs.access(src)).rejects.toThrow(); // scratch file consumed
    expect(obj.sizeBytes).toBe(big.length);
    const row = await db().storageObject.findFirstOrThrow({ include: { _count: { select: { chunks: true } } } });
    expect(row._count.chunks).toBe(3);
    expect(row.complete).toBe(true);
    expect((await s.read('PROCESSED', obj.storedName)).equals(big)).toBe(true);

    const copy = await s.materialize('PROCESSED', obj.storedName);
    expect((await fs.readFile(copy.path)).equals(big)).toBe(true);
    await copy.release();
    await expect(fs.access(copy.path)).rejects.toThrow();
  });

  it('rejects unsafe names and hides incomplete objects; sweep removes stale ones', async () => {
    const s = mysql();
    for (const bad of ['../x', 'a/b', '', 'not-a-uuid']) {
      await expect(s.read('ORIGINAL', bad)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
      await expect(s.delete('ORIGINAL', bad)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    }
    const name = s.generateStoredName('bin');
    await db().storageObject.create({
      data: { area: 'ORIGINAL', storedName: name, createdAt: new Date(Date.now() - 2 * 86_400_000) },
    });
    expect(await s.exists('ORIGINAL', name)).toBe(false);
    expect(await s.sweepWorkFiles(new Date())).toBe(1);
    expect(await db().storageObject.count()).toBe(0);
  });

  it('reports usage per area', async () => {
    const s = mysql();
    await s.save('VAULT', Buffer.alloc(100), 'bin');
    await s.save('ORIGINAL', Buffer.alloc(40), 'bin');
    const usage = await s.usage();
    expect(usage.VAULT).toEqual({ files: 1, bytes: 100 });
    expect(usage.ORIGINAL).toEqual({ files: 1, bytes: 40 });
  });
});

describe('workflow with STORAGE_DRIVER=mysql', () => {
  it('stores upload and result in MySQL (no files in originals/processed) and records the image result row', async () => {
    const src = await makeJpeg(1200, 900);
    const up = await upload(src, 'beach.jpg', 'image/jpeg');
    expect(up.status).toBe(201);
    const fileId = up.body.data.file.id as string;
    const row = await db().file.findUniqueOrThrow({ where: { id: fileId } });
    expect(row.storagePath).toBe(`ORIGINAL/${row.storedName}`);
    expect(
      await db().storageObject.count({ where: { area: 'ORIGINAL', storedName: row.storedName, complete: true } }),
    ).toBe(1);

    const { job } = await processFile(fileId, 'IMAGE_COMPRESS', { preset: 'SMALLEST' });
    expect(job.status, JSON.stringify(job.error)).toBe('COMPLETED');
    const dl = await download(job.downloadUrl);
    expect(dl.status).toBe(200);
    expect((dl.body as Buffer).length).toBe(job.outputSizeBytes);

    // bytes live in the database, not on disk
    for (const dir of ['originals', 'processed', 'vault']) {
      const files = await fs.readdir(path.join(getEnv().storageRoot, dir)).catch(() => []);
      expect(files, dir).toEqual([]);
    }
    expect(await fs.readdir(path.join(getEnv().storageRoot, 'temporary'))).toEqual([]); // scratch cleaned
    expect(await db().storageObject.count()).toBe(2);

    const result = await db().imageResult.findUniqueOrThrow({ where: { jobId: job.id } });
    expect(result).toMatchObject({
      operation: 'IMAGE_COMPRESS',
      preset: 'SMALLEST',
      inputWidth: 1200,
      inputHeight: 900,
      keptOriginal: false,
    });
    expect(result.outputWidth).toBeLessThanOrEqual(1200);

    // thumbnails also work through materialize()
    const thumb = await request().get(`/api/v1/files/${fileId}/thumbnail`);
    expect(thumb.status).toBe(200);

    // deleting the file removes its bytes from MySQL
    await request().delete(`/api/v1/files/${fileId}`);
    expect(await db().storageObject.count()).toBe(0);
    expect(await db().storageChunk.count()).toBe(0);
  });

  it('writes one tool-specific result row for PDF, Word and video jobs', async () => {
    const pdf = await upload(await makePdfWithPhoto(), 'a.pdf');
    const pdfJob = (await processFile(pdf.body.data.file.id, 'PDF_COMPRESS', { preset: 'SMALLEST' })).job;
    const docx = await upload(await makeDocx(true), 'a.docx');
    const docJob = (await processFile(docx.body.data.file.id, 'DOCX_COMPRESS')).job;
    const mp4 = await upload(await makeMp4(1), 'a.mp4');
    const vidJob = (await processFile(mp4.body.data.file.id, 'VIDEO_COMPRESS', { preset: 'SMALLEST' })).job;
    const audJob = (await processFile(mp4.body.data.file.id, 'VIDEO_EXTRACT_AUDIO')).job;
    for (const j of [pdfJob, docJob, vidJob, audJob]) expect(j.status, JSON.stringify(j.error)).toBe('COMPLETED');

    expect(await db().pdfResult.findUniqueOrThrow({ where: { jobId: pdfJob.id } })).toMatchObject({
      preset: 'SMALLEST',
      imagesFound: 1,
      imagesRecompressed: 1,
    });
    expect(await db().documentResult.findUniqueOrThrow({ where: { jobId: docJob.id } })).toMatchObject({
      imagesFound: 1,
    });
    const v = await db().videoResult.findUniqueOrThrow({ where: { jobId: vidJob.id } });
    expect(v).toMatchObject({ operation: 'VIDEO_COMPRESS', outputFormat: 'mp4' });
    expect(v.durationSeconds).toBeGreaterThan(0.5);
    expect(await db().videoResult.findUniqueOrThrow({ where: { jobId: audJob.id } })).toMatchObject({
      operation: 'VIDEO_EXTRACT_AUDIO',
      outputFormat: 'mp3',
    });
    // deleting a job's rows cascades to its tool record
    expect(await db().imageResult.count()).toBe(0);
  }, 120_000);

  it('vault files live in MySQL, survive retention cleanup and download intact', async () => {
    const { agent } = await adminAgent();
    const content = randomBytes(5000);
    const created = await agent.post('/api/v1/admin/vault').attach('file', content, 'keepsake.bin');
    expect(created.status).toBe(201);
    expect(await db().storageObject.count({ where: { area: 'VAULT' } })).toBe(1);
    await db().vaultFile.update({
      where: { id: created.body.data.id },
      data: { createdAt: new Date(Date.now() - 400 * 86_400_000) },
    });
    await runCleanup();
    const dl = await download(
      `/api/v1/admin/vault/${created.body.data.id}/download`,
      agent as unknown as ReturnType<typeof request>,
    );
    expect(dl.status).toBe(200);
    expect((dl.body as Buffer).equals(content)).toBe(true);
    expect(storage().usage).toBeDefined();
    const del = await agent.delete(`/api/v1/admin/vault/${created.body.data.id}`);
    expect(del.status).toBe(200);
    expect(await db().storageObject.count()).toBe(0);
  });
});
