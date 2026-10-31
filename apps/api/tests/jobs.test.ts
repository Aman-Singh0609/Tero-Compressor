import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEnv } from '../src/config/env';
import { db } from '../src/db/prisma';
import { overrideProcessor } from '../src/processors/registry';
import { ProcessorError } from '../src/processors/types';
import {
  makeDocx,
  makeJpeg,
  makeJpegWithExif,
  makeMp4,
  makePdfWithPhoto,
  makePng,
  makeSilentMp4,
  makeTextPdf,
} from './helpers/fixtures';
import { closeAll, processFile, request, resetAll, upload } from './helpers/harness';

beforeEach(resetAll);
afterEach(() => overrideProcessor('IMAGE_COMPRESS', undefined));
afterAll(closeAll);

async function uploadId(buf: Buffer, name: string): Promise<string> {
  const res = await upload(buf, name);
  expect(res.status).toBe(201);
  return res.body.data.file.id;
}

async function download(jobId: string): Promise<Buffer> {
  const res = await request()
    .get(`/api/v1/jobs/${jobId}/download`)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  return res.body as Buffer;
}

describe('POST /api/v1/jobs validation', () => {
  it('rejects invalid operation, wrong file kind, bad options and unknown files', async () => {
    const id = await uploadId(await makeJpeg(200, 150), 'a.jpg');
    const bad = await request().post('/api/v1/jobs').send({ fileId: id, operation: 'NOPE' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_OPERATION');

    const wrongKind = await request().post('/api/v1/jobs').send({ fileId: id, operation: 'VIDEO_COMPRESS' });
    expect(wrongKind.body.error.code).toBe('INVALID_OPERATION');

    const badOptions = await request()
      .post('/api/v1/jobs')
      .send({ fileId: id, operation: 'IMAGE_COMPRESS', options: { preset: 'EXTREME' } });
    expect(badOptions.status).toBe(400);
    expect(badOptions.body.error.code).toBe('INVALID_OPTIONS');

    const unknownKey = await request()
      .post('/api/v1/jobs')
      .send({ fileId: id, operation: 'IMAGE_COMPRESS', options: { crf: 18 } });
    expect(unknownKey.body.error.code).toBe('INVALID_OPTIONS');

    const missing = await request()
      .post('/api/v1/jobs')
      .send({ fileId: '00000000-0000-4000-8000-000000000000', operation: 'IMAGE_COMPRESS' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('FILE_NOT_FOUND');

    const noBody = await request().post('/api/v1/jobs').send({});
    expect(noBody.body.error.code).toBe('VALIDATION_ERROR');
    expect(await db().processingJob.count()).toBe(0);
  });

  it('GET /jobs/:id for an unknown job is JOB_NOT_FOUND; download before completion is JOB_NOT_READY', async () => {
    expect((await request().get('/api/v1/jobs/00000000-0000-4000-8000-000000000000')).body.error.code).toBe(
      'JOB_NOT_FOUND',
    );
    const id = await uploadId(await makeJpeg(200, 150), 'a.jpg');
    let release!: () => void;
    const slow = new Promise<{ outputMime: string; outputExt: string }>(
      (r) => (release = () => r({ outputMime: 'image/jpeg', outputExt: 'jpg' })),
    );
    overrideProcessor('IMAGE_COMPRESS', {
      operations: ['IMAGE_COMPRESS'],
      validate: async () => undefined,
      outputExtensionFor: () => 'jpg',
      process: () => slow,
      cleanup: async () => undefined,
    });
    const created = await request().post('/api/v1/jobs').send({ fileId: id, operation: 'IMAGE_COMPRESS' });
    const dl = await request().get(`/api/v1/jobs/${created.body.data.jobId}/download`);
    expect(dl.status).toBe(409);
    expect(dl.body.error.code).toBe('JOB_NOT_READY');
    release();
  });
});

describe('image processing', () => {
  it('compresses a JPEG with real savings and exposes honest statistics', async () => {
    const src = await makeJpeg(1600, 1200, 100);
    const id = await uploadId(src, 'photo.jpg');
    const { created, job } = await processFile(id, 'IMAGE_COMPRESS', { preset: 'BALANCED' });
    expect(created.body).toMatchObject({ success: true, data: { status: 'QUEUED' } });
    expect(job.status).toBe('COMPLETED');
    expect(job.progress).toBe(100);
    expect(job.originalSizeBytes).toBe(src.length);
    expect(job.outputSizeBytes).toBeLessThan(src.length);
    expect(job.savingPercent).toBeGreaterThan(10);
    expect(job.processingDurationMs).toBeGreaterThanOrEqual(0);
    expect(job.downloadUrl).toBe(`/api/v1/jobs/${job.id}/download`);

    const out = await download(job.id);
    expect(out.length).toBe(job.outputSizeBytes);
    expect((await sharp(out).metadata()).format).toBe('jpeg');

    // database: job row, output file row, input file back to AVAILABLE; all in sync
    const row = await db().processingJob.findUniqueOrThrow({
      where: { id: job.id },
      include: { outputFile: true, file: true },
    });
    expect(row.status).toBe('COMPLETED');
    expect(row.outputFile?.role).toBe('OUTPUT');
    expect(Number(row.outputFile?.sizeBytes)).toBe(out.length);
    expect(row.file.status).toBe('AVAILABLE');
    const processed = await fs.readdir(path.join(getEnv().storageRoot, 'processed'));
    expect(processed).toEqual([row.outputFile!.storedName]);
    expect(await fs.readdir(path.join(getEnv().storageRoot, 'temporary'))).toEqual([]);
  });

  it('does not upscale small images and returns the original when it cannot do better', async () => {
    const small = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } })
      .jpeg({ quality: 40 })
      .toBuffer();
    const id = await uploadId(small, 'tiny.jpg');
    const { job } = await processFile(id, 'IMAGE_RESIZE', { width: 2000 });
    expect(job.status).toBe('COMPLETED');
    const dims = await sharp(await download(job.id)).metadata();
    expect(dims.width).toBe(64);

    const { job: c } = await processFile(id, 'IMAGE_COMPRESS', { preset: 'SMALLEST' });
    expect(c.result.keptOriginal).toBe(true);
    expect(c.outputSizeBytes).toBe(small.length);
    expect(c.savingPercent).toBe(0);
  });

  it('resizes, converts and strips metadata', async () => {
    const withExif = await makeJpegWithExif();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const id = await uploadId(withExif, 'exif.jpg');

    const { job: stripped } = await processFile(id, 'IMAGE_STRIP_METADATA');
    const meta = await sharp(await download(stripped.id)).metadata();
    expect(meta.exif).toBeUndefined();

    const { job: resized } = await processFile(id, 'IMAGE_RESIZE', { width: 100 });
    expect((await sharp(await download(resized.id)).metadata()).width).toBe(100);

    const { job: webp } = await processFile(id, 'IMAGE_CONVERT', { format: 'webp' });
    expect((await sharp(await download(webp.id)).metadata()).format).toBe('webp');

    const missingDim = await request()
      .post('/api/v1/jobs')
      .send({ fileId: id, operation: 'IMAGE_RESIZE', options: {} });
    expect(missingDim.body.error.code).toBe('INVALID_OPTIONS');
  });

  it('converts a PNG to PDF', async () => {
    const id = await uploadId(await makePng(), 'pic.png');
    const { job } = await processFile(id, 'IMAGE_TO_PDF');
    expect(job.status).toBe('COMPLETED');
    const pdf = await PDFDocument.load(await download(job.id));
    expect(pdf.getPageCount()).toBe(1);
  });
});

describe('document processing', () => {
  it('shrinks a photo-heavy PDF by re-encoding embedded JPEGs and still opens', async () => {
    const src = await makePdfWithPhoto();
    const id = await uploadId(src, 'scan.pdf');
    const { job } = await processFile(id, 'PDF_COMPRESS', { preset: 'SMALLEST' });
    expect(job.status).toBe('COMPLETED');
    expect(job.result.imagesRecompressed).toBeGreaterThan(0);
    expect(job.outputSizeBytes).toBeLessThan(src.length * 0.8);
    expect((await PDFDocument.load(await download(job.id))).getPageCount()).toBe(1);
  });

  it('is truthful when a PDF has nothing to shrink', async () => {
    const src = await makeTextPdf();
    const id = await uploadId(src, 'text.pdf');
    const { job } = await processFile(id, 'PDF_COMPRESS');
    expect(job.status).toBe('COMPLETED');
    expect(job.result.keptOriginal).toBe(true);
    expect(job.savingPercent).toBe(0);
    expect(job.outputSizeBytes).toBe(src.length);
  });

  it('shrinks images inside a DOCX and keeps it a valid package', async () => {
    const src = await makeDocx(true);
    const id = await uploadId(src, 'report.docx');
    const { job } = await processFile(id, 'DOCX_COMPRESS', { preset: 'BALANCED' });
    expect(job.status).toBe('COMPLETED');
    expect(job.outputSizeBytes).toBeLessThan(src.length);
    const zip = await JSZip.loadAsync(await download(job.id));
    expect(zip.file('word/document.xml')).not.toBeNull();
    expect(zip.file('word/media/image1.jpeg')).not.toBeNull();
  });
});

describe('video processing (ffmpeg)', () => {
  it('compresses an MP4 with progress reaching 100 and a smaller output', async () => {
    const src = await makeMp4(2);
    const id = await uploadId(src, 'clip.mp4');
    const { job } = await processFile(id, 'VIDEO_COMPRESS', { preset: 'SMALLEST' });
    expect(job.status, JSON.stringify(job.error)).toBe('COMPLETED');
    expect(job.progress).toBe(100);
    expect(job.outputSizeBytes).toBeLessThan(src.length);
    const out = await download(job.id);
    expect(out.subarray(4, 8).toString()).toBe('ftyp');
  }, 120_000);

  it('extracts audio as MP3 and reports a clear error when there is no audio', async () => {
    const id = await uploadId(await makeMp4(1), 'clip.mp4');
    const { job } = await processFile(id, 'VIDEO_EXTRACT_AUDIO');
    expect(job.status).toBe('COMPLETED');
    const mp3 = await download(job.id);
    expect(mp3.length).toBeGreaterThan(1000);

    const silent = await uploadId(await makeSilentMp4(), 'silent.mp4');
    const { job: failed } = await processFile(silent, 'VIDEO_EXTRACT_AUDIO');
    expect(failed.status).toBe('FAILED');
    expect(failed.error.message).toMatch(/no sound/i);
  }, 120_000);
});

describe('failure handling', () => {
  it('records a failed processor on the job, keeps the input usable and leaves no output bytes', async () => {
    const id = await uploadId(await makeJpeg(200, 150), 'a.jpg');
    overrideProcessor('IMAGE_COMPRESS', {
      operations: ['IMAGE_COMPRESS'],
      validate: async () => undefined,
      outputExtensionFor: () => 'jpg',
      process: async (input) => {
        await fs.writeFile(input.outputPath, 'partial');
        throw new ProcessorError('The image could not be processed.', 'PROCESSING_FAILED', {
          cause: 'secret internal detail',
        });
      },
      cleanup: async (input) => fs.rm(input.outputPath, { force: true }),
    });
    const { job } = await processFile(id, 'IMAGE_COMPRESS');
    expect(job.status).toBe('FAILED');
    expect(job.error).toEqual({ code: 'PROCESSING_FAILED', message: 'The image could not be processed.' });
    expect(JSON.stringify(job)).not.toContain('secret internal detail');
    expect(job.downloadUrl).toBeNull();
    expect(await fs.readdir(path.join(getEnv().storageRoot, 'processed'))).toEqual([]);
    expect(await fs.readdir(path.join(getEnv().storageRoot, 'temporary'))).toEqual([]);
    expect(await db().file.count({ where: { role: 'OUTPUT' } })).toBe(0);
    expect((await db().file.findFirstOrThrow()).status).toBe('UPLOADED');
    expect((await request().get(`/api/v1/jobs/${job.id}/download`)).body.error.code).toBe('JOB_NOT_READY');
  });

  it('marks a damaged file as FAILED with a friendly message (no stack trace)', async () => {
    const jpeg = await makeJpeg(200, 150);
    const damaged = Buffer.concat([jpeg.subarray(0, 4), Buffer.alloc(50, 7)]);
    const id = await uploadId(damaged, 'broken.jpg');
    const { job } = await processFile(id, 'IMAGE_COMPRESS');
    expect(job.status).toBe('FAILED');
    expect(job.error.code).toBe('INVALID_FILE');
    expect(JSON.stringify(job)).not.toMatch(/at .*\.ts|node_modules/);
    expect((await db().file.findUniqueOrThrow({ where: { id } })).status).toBe('FAILED');
  });

  it('cancels a running job and rolls back without leaving output', async () => {
    const id = await uploadId(await makeJpeg(200, 150), 'a.jpg');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    overrideProcessor('IMAGE_COMPRESS', {
      operations: ['IMAGE_COMPRESS'],
      validate: async () => undefined,
      outputExtensionFor: () => 'jpg',
      process: async (input) => {
        await gate;
        await fs.writeFile(input.outputPath, 'x');
        return { outputMime: 'image/jpeg', outputExt: 'jpg' };
      },
      cleanup: async (input) => fs.rm(input.outputPath, { force: true }),
    });
    const created = await request().post('/api/v1/jobs').send({ fileId: id, operation: 'IMAGE_COMPRESS' });
    const jobId = created.body.data.jobId as string;
    await new Promise((r) => setTimeout(r, 300));
    const cancelled = await request().post(`/api/v1/jobs/${jobId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');
    release();
    await new Promise((r) => setTimeout(r, 300));
    const after = await request().get(`/api/v1/jobs/${jobId}`);
    expect(after.body.data.status).toBe('CANCELLED');
    expect(await fs.readdir(path.join(getEnv().storageRoot, 'processed'))).toEqual([]);
    expect((await request().post(`/api/v1/jobs/${jobId}/cancel`)).body.error.code).toBe('JOB_NOT_CANCELLABLE');
  });
});

describe('PDF with lossless (Flate) images', () => {
  it('converts them to JPEG for BALANCED/SMALLEST, keeps them for HIGH_QUALITY, and the result stays valid', async () => {
    const { makePdfWithFlateImage } = await import('./helpers/fixtures');
    const { PDFDocument, PDFName, PDFRawStream } = await import('pdf-lib');
    const src = await makePdfWithFlateImage();
    const id = await uploadId(src, 'screens.pdf');

    const high = (await processFile(id, 'PDF_COMPRESS', { preset: 'HIGH_QUALITY' })).job;
    expect(high.status).toBe('COMPLETED');
    expect(high.result.imagesFound).toBe(1);
    expect(high.result.imagesRecompressed).toBe(0);

    const { job } = await processFile(id, 'PDF_COMPRESS', { preset: 'BALANCED' });
    expect(job.status, JSON.stringify(job.error)).toBe('COMPLETED');
    expect(job.result).toMatchObject({ imagesFound: 1, imagesRecompressed: 1 });
    expect(job.outputSizeBytes).toBeLessThan(src.length * 0.6);

    const out = await PDFDocument.load(await download(job.id));
    expect(out.getPageCount()).toBe(1);
    let checked = 0;
    for (const [, obj] of out.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
      expect(obj.dict.get(PDFName.of('Filter'))).toBe(PDFName.of('DCTDecode'));
      expect(obj.dict.has(PDFName.of('DecodeParms'))).toBe(false);
      const meta = await sharp(Buffer.from(obj.contents)).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBe((obj.dict.get(PDFName.of('Width')) as unknown as { asNumber(): number }).asNumber());
      expect(meta.height).toBe((obj.dict.get(PDFName.of('Height')) as unknown as { asNumber(): number }).asNumber());
      checked++;
    }
    expect(checked).toBe(1);
  });
});
