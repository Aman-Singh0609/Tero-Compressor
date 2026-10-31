import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getEnv } from '../src/config/env';
import { db } from '../src/db/prisma';
import { runCleanup } from '../src/services/retentionService';
import { makeMp4, makePdfWithPhoto } from './helpers/fixtures';
import { adminAgent, closeAll, request, resetAll, upload, waitForJob } from './helpers/harness';

beforeEach(resetAll);
afterAll(closeAll);

/** Full path through every layer: HTTP → storage → MySQL → queue → processor → storage → MySQL → download → admin view → cleanup. */
describe('end-to-end workflow', () => {
  it('PDF: upload → job → poll → download → admin inspection → delete', async () => {
    const { agent } = await adminAgent();
    const src = await makePdfWithPhoto();

    // 1. upload
    const up = await upload(src, 'Holiday Scan.pdf', 'application/pdf');
    expect(up.status).toBe(201);
    const fileId = up.body.data.file.id as string;
    expect(up.body.data.suggestedOperations.map((o: { operation: string }) => o.operation)).toEqual(['PDF_COMPRESS']);

    // 2. create job; it is queued, not run inside the request
    const created = await request()
      .post('/api/v1/jobs')
      .send({ fileId, operation: 'PDF_COMPRESS', options: { preset: 'BALANCED' } });
    expect(created.status).toBe(202);
    const jobId = created.body.data.jobId as string;

    // 3. poll until completion, tracking observed states
    const seen = new Set<string>();
    const done = await (async () => {
      for (;;) {
        const r = await request().get(`/api/v1/jobs/${jobId}`);
        seen.add(r.body.data.status);
        if (r.body.data.status === 'COMPLETED' || r.body.data.status === 'FAILED') return r.body.data;
        await new Promise((res) => setTimeout(res, 20));
      }
    })();
    expect(done.status).toBe('COMPLETED');
    expect(done).toMatchObject({ progress: 100, originalSizeBytes: src.length });
    expect(done.outputSizeBytes).toBeLessThan(src.length);
    expect(done.savingPercent).toBeGreaterThan(0);
    expect(done.processingDurationMs).toBeGreaterThan(0);

    // 4. download and verify bytes are a real, smaller PDF
    const dl = await request()
      .get(done.downloadUrl)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('Holiday Scan-tero.pdf');
    expect((dl.body as Buffer).length).toBe(done.outputSizeBytes);
    expect((await PDFDocument.load(dl.body as Buffer)).getPageCount()).toBe(1);

    // 5. storage and MySQL agree
    const job = await db().processingJob.findUniqueOrThrow({
      where: { id: jobId },
      include: { outputFile: true, file: true },
    });
    expect(job.outputFile?.status).toBe('AVAILABLE');
    expect(await fs.readdir(path.join(getEnv().storageRoot, 'processed'))).toEqual([job.outputFile!.storedName]);
    expect(await fs.readdir(path.join(getEnv().storageRoot, 'originals'))).toEqual([job.file.storedName]);

    // 6. admin sees the upload and the processing details
    const list = await agent.get('/api/v1/admin/files?q=Holiday');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].jobs[0]).toMatchObject({ operation: 'PDF_COMPRESS', status: 'COMPLETED' });
    const detail = await agent.get(`/api/v1/admin/files/${fileId}`);
    expect(detail.body.data.jobs[0].processingDurationMs).toBe(done.processingDurationMs);
    const adminJob = await agent.get(`/api/v1/admin/jobs/${jobId}`);
    expect(adminJob.body.data.savingPercent).toBe(done.savingPercent);

    // 7. user deletes: bytes and outputs gone, download no longer possible
    expect((await request().delete(`/api/v1/files/${fileId}`)).status).toBe(200);
    expect(await fs.readdir(path.join(getEnv().storageRoot, 'processed'))).toEqual([]);
    expect((await request().get(done.downloadUrl)).status).toBe(410);
  });

  it('video: progress is real (queued → processing → 100) and the job survives cleanup of unrelated files', async () => {
    const up = await upload(await makeMp4(3), 'party.mp4', 'video/mp4');
    const created = await request()
      .post('/api/v1/jobs')
      .send({ fileId: up.body.data.file.id, operation: 'VIDEO_COMPRESS', options: { preset: 'BALANCED' } });
    const progress: number[] = [];
    const final = await (async () => {
      for (;;) {
        const r = await request().get(`/api/v1/jobs/${created.body.data.jobId}`);
        progress.push(r.body.data.progress);
        if (['COMPLETED', 'FAILED'].includes(r.body.data.status)) return r.body.data;
        await new Promise((res) => setTimeout(res, 15));
      }
    })();
    expect(final.status).toBe('COMPLETED');
    expect(progress[progress.length - 1]).toBe(100);
    expect(progress).toEqual([...progress].sort((a, b) => a - b)); // monotonic
    expect((await runCleanup()).deleted).toBe(0); // nothing expired
    expect((await waitForJob(final.id)).status).toBe('COMPLETED');
  }, 120_000);

  it('GET /formats reflects exactly what the backend supports', async () => {
    const res = await request().get('/api/v1/formats');
    expect(res.body.data.types.map((t: { extension: string }) => t.extension).sort()).toEqual([
      'avi',
      'docx',
      'jpg',
      'mkv',
      'mov',
      'mp4',
      'pdf',
      'png',
      'webm',
      'webp',
    ]);
    expect(res.body.data.operations.map((o: { operation: string }) => o.operation)).toContain('VIDEO_COMPRESS');
    expect(res.body.data.maxUploadBytes).toBe(5 * 1024 * 1024);
  });
});
