import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/prisma';
import { secretStore } from '../src/services/secretStore';
import { adminAgent, closeAll, request, resetAll } from './helpers/harness';
import {
  inkPixels,
  makeImageOnlyPdf,
  makeNumberedPdf,
  makePdfWithMetadata,
  makeRedSquarePdf,
  pdfTexts,
  pixelAt,
  renderPdfPage,
  unzipEntry,
  unzipNames,
} from './helpers/toolFixtures';
import { downloadBytes, processFiles, runTool, uploadId } from './helpers/toolHarness';

beforeEach(resetAll);
afterAll(closeAll);

// updateMetadata:false so that loading the output for inspection does not itself write a Producer
const load = (b: Buffer) => PDFDocument.load(b, { updateMetadata: false });
/** JSON for assertions: MySQL BIGINT columns arrive as BigInt. */
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x));

describe('Merge PDF', () => {
  it('combines files in the order given', async () => {
    const a = await uploadId(await makeNumberedPdf(3), 'a.pdf');
    const b = await uploadId(await makeNumberedPdf(2), 'b.pdf');
    const { job } = await processFiles([b, a], 'PDF_MERGE');
    expect(job.status, JSON.stringify(job.error)).toBe('COMPLETED');
    const out = await downloadBytes(job.downloadUrl);
    expect(await pdfTexts(out)).toEqual(['PAGE-1', 'PAGE-2', 'PAGE-1', 'PAGE-2', 'PAGE-3']); // b (2 pages) then a (3)
    expect(job.inputs.map((i: { name: string }) => i.name)).toEqual(['b.pdf', 'a.pdf']);
    expect(job.result.outputPages).toBe(5);
    // output name uses the first file
    const file = await db().file.findFirstOrThrow({ where: { role: 'OUTPUT' } });
    expect(file.originalName).toBe('b-merged.pdf');
  });

  it('rejects too few / too many / mixed / unknown inputs', async () => {
    const a = await uploadId(await makeNumberedPdf(1), 'a.pdf');
    const one = await request()
      .post('/api/v1/jobs')
      .send({ fileIds: [a], operation: 'PDF_MERGE' });
    expect(one.status).toBe(400);
    expect(one.body.error.code).toBe('INVALID_OPERATION');
    expect(one.body.error.message).toMatch(/at least 2/);

    const bad = await request()
      .post('/api/v1/jobs')
      .send({ fileIds: [a, '00000000-0000-4000-8000-000000000000'], operation: 'PDF_MERGE' });
    expect(bad.status).toBe(404);

    const many = await request()
      .post('/api/v1/jobs')
      .send({ fileIds: Array(21).fill(a), operation: 'PDF_MERGE' });
    expect(many.body.error.code).toBe('INVALID_OPERATION');

    const both = await request()
      .post('/api/v1/jobs')
      .send({ fileId: a, fileIds: [a, a], operation: 'PDF_MERGE' });
    expect(both.status).toBe(400);
    expect(both.body.error.code).toBe('VALIDATION_ERROR');

    const none = await request().post('/api/v1/jobs').send({ operation: 'PDF_MERGE' });
    expect(none.status).toBe(400);
  });

  it('refuses a password-protected input with a pointer to Unlock PDF', async () => {
    const plain = await uploadId(await makeNumberedPdf(1), 'plain.pdf');
    const locked = await runTool(await makeNumberedPdf(1), 'secret.pdf', 'PDF_PROTECT', { password: 'open-sesame' });
    expect(locked.job.status).toBe('COMPLETED');
    const lockedId = await uploadId(locked.output!, 'locked.pdf');
    const { job } = await processFiles([plain, lockedId], 'PDF_MERGE');
    expect(job.status).toBe('FAILED');
    expect(job.error.message).toMatch(/Unlock PDF/);
  });
});

describe('Split PDF', () => {
  it('splits by page ranges into one ZIP of separate PDFs', async () => {
    const r = await runTool(await makeNumberedPdf(5), 'doc.pdf', 'PDF_SPLIT', {
      mode: 'ranges',
      ranges: '1-2, 3, 4-5',
    });
    expect(r.job.status, JSON.stringify(r.job.error)).toBe('COMPLETED');
    expect(r.job.result.files).toBe(3);
    expect(await unzipNames(r.output!)).toEqual([
      'part-001-pages-1-2.pdf',
      'part-002-page-3.pdf',
      'part-003-pages-4-5.pdf',
    ]);
    expect(await pdfTexts(await unzipEntry(r.output!, 'part-003-pages-4-5.pdf'))).toEqual(['PAGE-4', 'PAGE-5']);
    const file = await db().file.findFirstOrThrow({ where: { role: 'OUTPUT' } });
    expect(file).toMatchObject({
      originalName: 'doc-split.zip',
      extension: 'zip',
      mimeType: 'application/zip',
      category: 'archive',
    });
  });

  it('splits every N pages and every page', async () => {
    const every = await runTool(await makeNumberedPdf(5), 'doc.pdf', 'PDF_SPLIT', { mode: 'every', every: 2 });
    expect(await unzipNames(every.output!)).toHaveLength(3); // 2 + 2 + 1
    const each = await runTool(await makeNumberedPdf(4), 'doc.pdf', 'PDF_SPLIT', { mode: 'each' });
    expect(await unzipNames(each.output!)).toHaveLength(4);
  });

  it('validates the options and page numbers', async () => {
    const missing = await runTool(await makeNumberedPdf(3), 'd.pdf', 'PDF_SPLIT', { mode: 'ranges' });
    expect(missing.created.status).toBe(400);
    expect(missing.created.body.error.code).toBe('INVALID_OPTIONS');
    const outOfRange = await runTool(await makeNumberedPdf(3), 'd.pdf', 'PDF_SPLIT', { mode: 'ranges', ranges: '1-9' });
    expect(outOfRange.job.status).toBe('FAILED');
    expect(outOfRange.job.error).toEqual({
      code: 'INVALID_OPTIONS',
      message: 'Page 9 does not exist: this file has 3 pages.',
    });
    const garbage = await request()
      .post('/api/v1/jobs')
      .send({ fileIds: [outOfRange.id], operation: 'PDF_SPLIT', options: { mode: 'ranges', ranges: '1;DROP TABLE' } });
    expect(garbage.status).toBe(400);
    const tooShort = await runTool(await makeNumberedPdf(1), 'd.pdf', 'PDF_SPLIT', { mode: 'every', every: 5 });
    expect(tooShort.job.error.message).toMatch(/too short/);
  });
});

describe('Extract / remove / reorder pages', () => {
  it('extracts and removes pages', async () => {
    const ex = await runTool(await makeNumberedPdf(5), 'd.pdf', 'PDF_EXTRACT_PAGES', { pages: '5, 2-3' });
    expect(await pdfTexts(ex.output!)).toEqual(['PAGE-2', 'PAGE-3', 'PAGE-5']); // document order
    const rm = await runTool(await makeNumberedPdf(5), 'd.pdf', 'PDF_REMOVE_PAGES', { pages: '2, 4' });
    expect(await pdfTexts(rm.output!)).toEqual(['PAGE-1', 'PAGE-3', 'PAGE-5']);
    expect(rm.job.result).toMatchObject({ inputPages: 5, outputPages: 3, removed: 2 });
    const all = await runTool(await makeNumberedPdf(2), 'd.pdf', 'PDF_REMOVE_PAGES', { pages: '1-2' });
    expect(all.job.status).toBe('FAILED');
    expect(all.job.error.message).toMatch(/every page/);
  });

  it('reorders pages, requiring each page exactly once', async () => {
    const ok = await runTool(await makeNumberedPdf(4), 'd.pdf', 'PDF_REORDER_PAGES', { order: '4, 1-2, 3' });
    expect(await pdfTexts(ok.output!)).toEqual(['PAGE-4', 'PAGE-1', 'PAGE-2', 'PAGE-3']);
    const rev = await runTool(await makeNumberedPdf(3), 'd.pdf', 'PDF_REORDER_PAGES', { order: '3-1' });
    expect(await pdfTexts(rev.output!)).toEqual(['PAGE-3', 'PAGE-2', 'PAGE-1']);
    const missing = await runTool(await makeNumberedPdf(4), 'd.pdf', 'PDF_REORDER_PAGES', { order: '1, 2, 3' });
    expect(missing.job.error.message).toBe('List every page exactly once. Missing: 4.');
    const dup = await runTool(await makeNumberedPdf(3), 'd.pdf', 'PDF_REORDER_PAGES', { order: '1, 1, 2, 3' });
    expect(dup.job.error.message).toMatch(/exactly once/);
  });
});

describe('Rotate and crop', () => {
  it('rotates selected pages and accumulates', async () => {
    const first = await runTool(await makeNumberedPdf(3), 'd.pdf', 'PDF_ROTATE', { angle: 90, pages: '1' });
    let doc = await load(first.output!);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([90, 0, 0]);
    const again = await runTool(first.output!, 'd2.pdf', 'PDF_ROTATE', { angle: 90 });
    doc = await load(again.output!);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([180, 90, 90]);
    const bad = await request()
      .post('/api/v1/jobs')
      .send({ fileIds: [first.id], operation: 'PDF_ROTATE', options: { angle: 45 } });
    expect(bad.status).toBe(400);
  });

  it('crops margins as percentages, also on rotated pages', async () => {
    const r = await runTool(await makeNumberedPdf(1), 'd.pdf', 'PDF_CROP', { left: 10, right: 10, top: 5, bottom: 0 });
    const page = (await load(r.output!)).getPage(0);
    expect(page.getWidth()).toBeCloseTo(320, 0); // 400 * 0.8
    expect(page.getHeight()).toBeCloseTo(380, 0); // 400 * 0.95

    // on a page rotated 90°, "top" in the viewer is the page's own left edge
    const rotated = await runTool(await makeNumberedPdf(1), 'd.pdf', 'PDF_ROTATE', { angle: 90 });
    const cropped = await runTool(rotated.output!, 'd2.pdf', 'PDF_CROP', { top: 25 });
    const p = (await load(cropped.output!)).getPage(0);
    expect(p.getWidth()).toBeCloseTo(300, 0); // own width 400 reduced by 25% (viewer-top)
    expect(p.getHeight()).toBeCloseTo(400, 0);

    const none = await request()
      .post('/api/v1/jobs')
      .send({ fileIds: [r.id], operation: 'PDF_CROP', options: {} });
    expect(none.status).toBe(400);
    expect(none.body.error.message).toMatch(/at least one margin/);
  });
});

describe('Watermark and page numbers', () => {
  it('stamps coloured text that is visible on every selected page', async () => {
    const src = await makeNumberedPdf(2);
    const before = inkPixels(await renderPdfPage(src, 1, 1));
    const r = await runTool(src, 'd.pdf', 'PDF_WATERMARK', {
      text: 'CONFIDENTIAL',
      color: 'red',
      opacity: 80,
      pages: '2',
    });
    expect(r.job.status, JSON.stringify(r.job.error)).toBe('COMPLETED');
    expect(r.job.result).toMatchObject({ stamped: 1, outputPages: 2 });
    const stamped = await renderPdfPage(r.output!, 1, 1);
    expect(inkPixels(stamped)).toBeGreaterThan(before + 500);
    const untouched = await renderPdfPage(r.output!, 0, 1);
    expect(inkPixels(untouched)).toBe(inkPixels(await renderPdfPage(src, 0, 1)));
    // red-dominant ink exists (and the render's channel order is right)
    let reddish = 0;
    for (let i = 0; i < stamped.data.length; i += 4)
      if (stamped.data[i]! > 150 && stamped.data[i + 1]! < 140 && stamped.data[i + 2]! < 140) reddish++;
    expect(reddish).toBeGreaterThan(200);
    expect(await pdfTexts(r.output!)).toEqual(['PAGE-1', expect.stringContaining('CONFIDENTIAL')]);
  });

  it('works on rotated pages, with every position, unicode text and oversize text', async () => {
    const rotated = await runTool(await makeNumberedPdf(1), 'd.pdf', 'PDF_ROTATE', { angle: 90 });
    for (const position of ['diagonal', 'center', 'top', 'bottom']) {
      const r = await runTool(rotated.output!, `w-${position}.pdf`, 'PDF_WATERMARK', {
        text: 'Ünïcode ©',
        position,
        fontSize: 200,
      });
      expect(r.job.status, `${position}: ${JSON.stringify(r.job.error)}`).toBe('COMPLETED');
      const img = await renderPdfPage(r.output!, 0, 0.5);
      expect(inkPixels(img)).toBeGreaterThan(inkPixels(await renderPdfPage(rotated.output!, 0, 0.5)));
    }
    const bad = await request()
      .post('/api/v1/jobs')
      .send({ fileIds: [rotated.id], operation: 'PDF_WATERMARK', options: { text: '' } });
    expect(bad.status).toBe(400);
    const long = await request()
      .post('/api/v1/jobs')
      .send({ fileIds: [rotated.id], operation: 'PDF_WATERMARK', options: { text: 'x'.repeat(61) } });
    expect(long.status).toBe(400);
    const color = await request()
      .post('/api/v1/jobs')
      .send({
        fileIds: [rotated.id],
        operation: 'PDF_WATERMARK',
        options: { text: 'a', color: 'javascript:alert(1)' },
      });
    expect(color.status).toBe(400);
  });

  it('numbers pages in the chosen style, start and skipping the first page', async () => {
    const a = await runTool(await makeNumberedPdf(3), 'd.pdf', 'PDF_PAGE_NUMBERS', {
      format: 'n-of-total',
      position: 'bottom-right',
    });
    const texts = await pdfTexts(a.output!);
    expect(texts[0]).toContain('1 of 3');
    expect(texts[2]).toContain('3 of 3');
    const b = await runTool(await makeNumberedPdf(3), 'd.pdf', 'PDF_PAGE_NUMBERS', {
      format: 'page-n',
      start: 10,
      skipFirst: true,
      position: 'top-left',
    });
    const t = await pdfTexts(b.output!);
    expect(t[0]).not.toMatch(/Page \d/);
    expect(t[1]).toContain('Page 10');
    expect(t[2]).toContain('Page 11');
    expect(b.job.result.numbered).toBe(2);
  });
});

describe('Protect and Unlock PDF', () => {
  it('encrypts, refuses a wrong password and unlocks with the right one — without ever storing the password', async () => {
    const { agent } = await adminAgent();
    const password = 'Tr0ub4dor&3-unique-marker';
    const protectedRun = await runTool(await makeNumberedPdf(2), 'secret.pdf', 'PDF_PROTECT', {
      password,
      allowCopying: false,
    });
    expect(protectedRun.job.status, JSON.stringify(protectedRun.job.error)).toBe('COMPLETED');
    expect(protectedRun.output!.includes(Buffer.from('/Encrypt'))).toBe(true);
    await expect(load(protectedRun.output!)).rejects.toThrow(/encrypt/i);

    // the password is nowhere in MySQL or in any API response
    const jobRow = await db().processingJob.findUniqueOrThrow({ where: { id: protectedRun.job.id } });
    expect(json(jobRow)).not.toContain(password);
    expect(jobRow.options).toMatchObject({ password: '[hidden]' });
    const dump = json([
      await db().pdfResult.findMany(),
      await db().auditLog.findMany(),
      await db().processingJob.findMany(),
    ]);
    expect(dump).not.toContain(password);
    expect(JSON.stringify(protectedRun.job)).not.toContain(password);
    const adminView = await agent.get(`/api/v1/admin/jobs/${protectedRun.job.id}`);
    expect(JSON.stringify(adminView.body)).not.toContain(password);
    expect(secretStore.size()).toBe(0); // forgotten after the job

    const lockedId = await uploadId(protectedRun.output!, 'locked.pdf');
    const wrong = await processFiles([lockedId], 'PDF_UNLOCK', { password: 'definitely-wrong' });
    expect(wrong.job.status).toBe('FAILED');
    expect(wrong.job.error).toEqual({ code: 'INVALID_OPTIONS', message: 'That password is not correct.' });
    expect(json(await db().processingJob.findMany())).not.toContain('definitely-wrong');

    const right = await processFiles([lockedId], 'PDF_UNLOCK', { password });
    expect(right.job.status, JSON.stringify(right.job.error)).toBe('COMPLETED');
    const opened = await downloadBytes(right.job.downloadUrl);
    expect(opened.includes(Buffer.from('/Encrypt'))).toBe(false);
    expect(await pdfTexts(opened)).toEqual(['PAGE-1', 'PAGE-2']);
    expect(secretStore.size()).toBe(0);
  });

  it('reports sensible errors: already protected, not protected, missing/short password', async () => {
    const plain = await runTool(await makeNumberedPdf(1), 'p.pdf', 'PDF_UNLOCK', { password: 'whatever' });
    expect(plain.job.status).toBe('COMPLETED');
    expect(plain.job.result.note).toMatch(/not password-protected/);

    const locked = await runTool(await makeNumberedPdf(1), 's.pdf', 'PDF_PROTECT', { password: 'abcd1234' });
    const again = await runTool(locked.output!, 'locked.pdf', 'PDF_PROTECT', { password: 'another-one' });
    expect(again.job.status).toBe('FAILED');
    expect(again.job.error.message).toMatch(/already password-protected/);

    const short = await request()
      .post('/api/v1/jobs')
      .send({ fileIds: [plain.id], operation: 'PDF_PROTECT', options: { password: 'abc' } });
    expect(short.status).toBe(400);
    const none = await request()
      .post('/api/v1/jobs')
      .send({ fileIds: [plain.id], operation: 'PDF_PROTECT', options: {} });
    expect(none.status).toBe(400);
  });

  it('cancelling a queued job forgets the password', async () => {
    const id = await uploadId(await makeNumberedPdf(1), 'a.pdf');
    const created = await request()
      .post('/api/v1/jobs')
      .send({ fileIds: [id], operation: 'PDF_PROTECT', options: { password: 'queued-secret' } });
    await request().post(`/api/v1/jobs/${created.body.data.jobId}/cancel`);
    await new Promise((r) => setTimeout(r, 300));
    expect(secretStore.size()).toBe(0);
  });
});

describe('Remove PDF metadata', () => {
  it('erases author, title, producer and XMP', async () => {
    const src = await makePdfWithMetadata();
    const before = await load(src);
    expect([before.getAuthor(), before.getTitle(), before.getKeywords()]).toEqual([
      'Secret Author Name',
      'Private Title',
      'secret-keyword',
    ]);
    const r = await runTool(src, 'd.pdf', 'PDF_STRIP_METADATA');
    expect(r.job.status).toBe('COMPLETED');
    const out = await load(r.output!);
    expect([
      out.getTitle(),
      out.getAuthor(),
      out.getSubject(),
      out.getKeywords(),
      out.getCreator(),
      out.getProducer(),
    ]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    // no Info dictionary / XMP is left in the file structure at all
    expect(r.output!.includes(Buffer.from('/Author'))).toBe(false);
    expect(r.output!.includes(Buffer.from('/Producer'))).toBe(false);
    expect(r.job.result.removed).toContain('document properties');
    expect(await pdfTexts(r.output!)).toEqual(['hello']);
  });
});

describe('PDF to images / text / Word', () => {
  it('renders pages to JPG in a ZIP with correct colours and sizes', async () => {
    const r = await runTool(await makeRedSquarePdf(), 'red.pdf', 'PDF_TO_IMAGES', { format: 'png', dpi: 144 });
    expect(r.job.status, JSON.stringify(r.job.error)).toBe('COMPLETED');
    expect(await unzipNames(r.output!)).toEqual(['page-001.png']);
    const png = await unzipEntry(r.output!, 'page-001.png');
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([800, 800]); // 400pt at 144 dpi
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => [0, 1, 2].map((c) => data[(y * info.width + x) * info.channels + c]);
    expect(px(400, 400)).toEqual([255, 0, 0]); // red square, correct channel order
    expect(px(20, 20)).toEqual([255, 255, 255]); // white page
  });

  it('converts selected pages only and respects JPG output', async () => {
    const r = await runTool(await makeNumberedPdf(4), 'd.pdf', 'PDF_TO_IMAGES', {
      format: 'jpg',
      dpi: 96,
      pages: '2-3',
    });
    expect(await unzipNames(r.output!)).toEqual(['page-002.jpg', 'page-003.jpg']);
    expect((await sharp(await unzipEntry(r.output!, 'page-002.jpg')).metadata()).format).toBe('jpeg');
    const out = await runTool(await makeNumberedPdf(2), 'd.pdf', 'PDF_TO_IMAGES', { pages: '3' });
    expect(out.job.error.message).toMatch(/Page 3 does not exist/);
  });

  it('extracts text, and says so when there is none', async () => {
    const t = await runTool(await makeNumberedPdf(2), 'd.pdf', 'PDF_TO_TEXT');
    const text = t.output!.toString('utf8');
    expect(text).toContain('--- Page 1 ---');
    expect(text).toContain('PAGE-2');
    expect(t.job.result.inputPages).toBe(2);
    const scan = await runTool(await makeImageOnlyPdf(), 'scan.pdf', 'PDF_TO_TEXT');
    expect(scan.job.status).toBe('FAILED');
    expect(scan.job.error.message).toMatch(/no selectable text/);
  });

  it('creates an editable Word file from the text', async () => {
    const r = await runTool(await makeNumberedPdf(2), 'd.pdf', 'PDF_TO_WORD');
    expect(r.job.status, JSON.stringify(r.job.error)).toBe('COMPLETED');
    expect(r.job.result.note).toMatch(/Only the text/);
    const xml = (await unzipEntry(r.output!, 'word/document.xml')).toString('utf8');
    expect(xml).toContain('PAGE-1');
    expect(xml).toContain('PAGE-2');
    const file = await db().file.findFirstOrThrow({ where: { role: 'OUTPUT' } });
    expect(file.extension).toBe('docx');
    expect(file.originalName).toBe('d.docx');
  });

  it('gives a friendly error for protected PDFs and damaged files', async () => {
    const locked = await runTool(await makeNumberedPdf(1), 's.pdf', 'PDF_PROTECT', { password: 'abcd1234' });
    const r = await runTool(locked.output!, 'l.pdf', 'PDF_TO_TEXT');
    expect(r.job.status).toBe('FAILED');
    expect(r.job.error.message).toMatch(/Unlock PDF/);
    const damaged = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300, 7)]);
    const d = await runTool(damaged, 'broken.pdf', 'PDF_ROTATE', { angle: 90 });
    expect(d.job.status).toBe('FAILED');
    expect(d.job.error.code).toBe('INVALID_FILE');
    expect(d.job.error.message).toMatch(/damaged/);
    expect(pixelAt).toBeDefined();
  });
});
