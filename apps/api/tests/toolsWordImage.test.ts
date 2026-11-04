import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/prisma';
import { docxXmlToText } from '../src/processors/document/docxToolsProcessor';
import { closeAll, request, resetAll } from './helpers/harness';
import { makeJpeg, makePng } from './helpers/fixtures';
import {
  makeDocxWithMetadata,
  makeExifJpeg,
  makeGif,
  makeTiff,
  makeTwoToneImage,
  patchZipDeclaredSize,
  unzipEntry,
  unzipNames,
} from './helpers/toolFixtures';
import { downloadBytes, processFiles, runTool, uploadId } from './helpers/toolHarness';

beforeEach(resetAll);
afterAll(closeAll);

const pixel = async (buf: Buffer, x: number, y: number): Promise<number[]> => {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return [0, 1, 2].map((c) => data[(y * info.width + x) * 3 + c]!);
};
const dims = async (buf: Buffer) => {
  const m = await sharp(buf).metadata();
  return [m.width, m.height];
};

describe('Word tools', () => {
  it('removes author, company, comments, tracked changes and editing ids but keeps the text', async () => {
    const src = await makeDocxWithMetadata();
    const r = await runTool(src, 'letter.docx', 'DOCX_STRIP_METADATA');
    expect(r.job.status, JSON.stringify(r.job.error)).toBe('COMPLETED');
    const zip = await JSZip.loadAsync(r.output!);
    const all = (
      await Promise.all(
        Object.keys(zip.files)
          .filter((n) => n.endsWith('.xml'))
          .map((n) => zip.file(n)!.async('string')),
      )
    ).join('\n');
    for (const secret of [
      'Secret Author',
      'Secret Editor',
      'Secret Corp',
      'private comment text',
      'Deleted text',
      'classified value',
      'Microsoft Office Word',
      'Private Title',
      'w:rsidR',
    ]) {
      expect(all, secret).not.toContain(secret);
    }
    const text = docxXmlToText(await zip.file('word/document.xml')!.async('string'));
    expect(text).toBe('Hello world & friends\nInserted text\nLast paragraph'); // tracked insert accepted, deletion dropped
    expect(zip.file('word/media/image1.png')).not.toBeNull(); // pictures untouched
    expect(r.job.result.removed).toEqual(
      expect.arrayContaining(['author and document properties', 'custom properties']),
    );
    // original still contains them (so the test is meaningful)
    expect(await (await JSZip.loadAsync(src)).file('docProps/core.xml')!.async('string')).toContain('Secret Author');
  });

  it('extracts the plain text of a document', async () => {
    const r = await runTool(await makeDocxWithMetadata(), 'letter.docx', 'DOCX_TO_TEXT');
    expect(r.job.status).toBe('COMPLETED');
    expect(r.output!.toString('utf8')).toContain('Hello world & friends');
    expect((await db().file.findFirstOrThrow({ where: { role: 'OUTPUT' } })).originalName).toBe('letter.txt');
  });

  it('extracts pictures into a ZIP with generated names, and says when there are none', async () => {
    const r = await runTool(await makeDocxWithMetadata(), 'letter.docx', 'DOCX_EXTRACT_IMAGES');
    expect(await unzipNames(r.output!)).toEqual(['image-001.png', 'image-002.jpg']);
    expect((await sharp(await unzipEntry(r.output!, 'image-001.png')).metadata()).format).toBe('png');
    const bare = new JSZip();
    bare.file('[Content_Types].xml', '<Types/>');
    bare.file('word/document.xml', '<w:document/>');
    const none = await runTool(await bare.generateAsync({ type: 'nodebuffer' }), 'bare.docx', 'DOCX_EXTRACT_IMAGES');
    expect(none.job.error.message).toBe('This document has no pictures.');
  });

  it('refuses a zip bomb before inflating anything', async () => {
    const bomb = patchZipDeclaredSize(await makeDocxWithMetadata(), 'word/media/image1.png', 400 * 1024 * 1024);
    for (const op of ['DOCX_COMPRESS', 'DOCX_STRIP_METADATA', 'DOCX_TO_TEXT', 'DOCX_EXTRACT_IMAGES']) {
      const r = await runTool(bomb, 'bomb.docx', op, op === 'DOCX_COMPRESS' ? { preset: 'BALANCED' } : undefined);
      expect(r.job.status, op).toBe('FAILED');
      expect(r.job.error.code).toBe('INVALID_FILE');
      expect(r.job.error.message).toMatch(/unusually large|unsafe/);
    }
  });
});

describe('Image: convert', () => {
  it.each([
    ['jpeg', 'jpeg'],
    ['png', 'png'],
    ['webp', 'webp'],
    ['avif', 'heif'],
    ['tiff', 'tiff'],
    ['gif', 'gif'],
  ])('converts a PNG to %s', async (format, sharpFormat) => {
    const r = await runTool(await makeTwoToneImage('png', 120, 80), 'pic.png', 'IMAGE_CONVERT', { format });
    expect(r.job.status, JSON.stringify(r.job.error)).toBe('COMPLETED');
    expect((await sharp(r.output!).metadata()).format).toBe(sharpFormat);
    expect(await dims(r.output!)).toEqual([120, 80]);
    const file = await db().file.findFirstOrThrow({ where: { role: 'OUTPUT' } });
    expect(file.originalName).toBe(`pic.${format === 'jpeg' ? 'jpg' : format}`);
  });

  it('accepts GIF, TIFF and AVIF uploads and rejects animated images', async () => {
    const gif = await runTool(await makeGif(), 'a.gif', 'IMAGE_CONVERT', { format: 'png' });
    expect((await sharp(gif.output!).metadata()).format).toBe('png');
    const tif = await runTool(await makeTiff(), 'a.tif', 'IMAGE_CONVERT', { format: 'jpeg' });
    expect((await sharp(tif.output!).metadata()).format).toBe('jpeg');
    const avif = await runTool(
      await sharp({ create: { width: 50, height: 50, channels: 3, background: '#fff' } })
        .avif()
        .toBuffer(),
      'a.avif',
      'IMAGE_CONVERT',
      { format: 'png' },
    );
    expect(avif.job.status).toBe('COMPLETED');
    const frame = (c: string) =>
      sharp({ create: { width: 20, height: 20, channels: 3, background: c } })
        .png()
        .toBuffer();
    const animated = await sharp([await frame('#f00'), await frame('#0f0')], { join: { animated: true } })
      .gif()
      .toBuffer();
    const anim = await runTool(animated, 'anim.gif', 'IMAGE_CONVERT', { format: 'png' });
    expect(anim.job.error.message).toBe('Animated images are not supported yet.');
  });

  it('flattens transparency on white when converting to JPG', async () => {
    const transparent = await sharp({
      create: { width: 20, height: 20, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const r = await runTool(transparent, 't.png', 'IMAGE_CONVERT', { format: 'jpeg' });
    expect(await pixel(r.output!, 5, 5)).toEqual([255, 255, 255]);
    expect(r.job.result.flattenedTransparency).toBe(true);
  });
});

describe('Image: compress to a target size', () => {
  it('lands under the target, and is honest when it cannot', async () => {
    const src = await makeJpeg(1600, 1200, 100);
    const r = await runTool(src, 'big.jpg', 'IMAGE_COMPRESS', { targetKb: 150 });
    expect(r.job.status, JSON.stringify(r.job.error)).toBe('COMPLETED');
    expect(r.output!.length).toBeLessThanOrEqual(150 * 1024);
    expect(r.job.result).toMatchObject({ metTarget: true, targetKb: 150 });
    expect(r.output!.length).toBeGreaterThan(40 * 1024); // not needlessly tiny

    const impossible = await runTool(src, 'big2.jpg', 'IMAGE_COMPRESS', { targetKb: 10 });
    expect(impossible.job.status).toBe('COMPLETED');
    // honest either way: the flag says whether the 10 KB target was actually reached
    expect(impossible.job.result.metTarget).toBe(impossible.output!.length <= 10 * 1024);
    if (!impossible.job.result.metTarget)
      expect(impossible.job.result.note).toMatch(/smaller than this picture can go/);

    const tiff = await runTool(await makeTiff(), 'a.tif', 'IMAGE_COMPRESS', { targetKb: 20 });
    expect(tiff.job.error.message).toMatch(/JPG, PNG, WebP and AVIF/);
    const bad = await request()
      .post('/api/v1/jobs')
      .send({ fileIds: [r.id], operation: 'IMAGE_COMPRESS', options: { targetKb: 5 } });
    expect(bad.status).toBe(400);
  });
});

describe('Image: resize, crop, rotate', () => {
  it('resizes by percentage and by pixels', async () => {
    const pct = await runTool(await makeTwoToneImage('png', 400, 300), 'a.png', 'IMAGE_RESIZE', {
      mode: 'percent',
      percent: 50,
    });
    expect(await dims(pct.output!)).toEqual([200, 150]);
    const px = await runTool(await makeTwoToneImage('png', 400, 300), 'a.png', 'IMAGE_RESIZE', { width: 100 });
    expect(await dims(px.output!)).toEqual([100, 75]);
    const noUp = await runTool(await makeTwoToneImage('png', 400, 300), 'a.png', 'IMAGE_RESIZE', {
      mode: 'percent',
      percent: 200,
    });
    expect(await dims(noUp.output!)).toEqual([400, 300]); // never enlarges unless asked
    const up = await runTool(await makeTwoToneImage('png', 400, 300), 'a.png', 'IMAGE_RESIZE', {
      mode: 'percent',
      percent: 200,
      allowUpscale: true,
    });
    expect(await dims(up.output!)).toEqual([800, 600]);
    const missing = await request()
      .post('/api/v1/jobs')
      .send({ fileIds: [pct.id], operation: 'IMAGE_RESIZE', options: { mode: 'percent' } });
    expect(missing.status).toBe(400);
  });

  it('crops to an aspect ratio with the chosen focus, or trims edges', async () => {
    const sq = await runTool(await makeTwoToneImage('png', 400, 300), 'a.png', 'IMAGE_CROP', {
      mode: 'aspect',
      aspect: '1:1',
    });
    expect(await dims(sq.output!)).toEqual([300, 300]);
    const wide = await runTool(await makeTwoToneImage('png', 400, 300), 'a.png', 'IMAGE_CROP', {
      mode: 'aspect',
      aspect: '16:9',
    });
    expect(await dims(wide.output!)).toEqual([400, 225]);
    // 3:4 of a 400x300 picture is 225 px wide: keeping the left keeps the red half, the right keeps the blue
    const redShare = async (buf: Buffer) => {
      const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      let red = 0;
      for (let x = 0; x < info.width; x++) if (data[(10 * info.width + x) * 3] === 255) red++;
      return red / info.width;
    };
    for (const [focus, expected] of [
      ['left', 0.89],
      ['right', 0.11],
      ['center', 0.5],
    ] as const) {
      const r = await runTool(await makeTwoToneImage('png', 400, 300), 'a.png', 'IMAGE_CROP', {
        mode: 'aspect',
        aspect: '3:4',
        focus,
      });
      expect(await dims(r.output!), focus).toEqual([225, 300]);
      expect(await redShare(r.output!), focus).toBeCloseTo(expected, 1);
    }
    const trim = await runTool(await makeTwoToneImage('png', 400, 300), 'a.png', 'IMAGE_CROP', {
      mode: 'trim',
      left: 25,
      right: 25,
      top: 10,
      bottom: 0,
    });
    expect(await dims(trim.output!)).toEqual([200, 270]);
    const nothing = await request()
      .post('/api/v1/jobs')
      .send({ fileIds: [sq.id], operation: 'IMAGE_CROP', options: { mode: 'trim' } });
    expect(nothing.status).toBe(400);
  });

  it('crops what the viewer sees when the photo carries an EXIF orientation', async () => {
    const phone = await makeExifJpeg(6, 400, 300); // stored landscape, displayed portrait 300x400
    const r = await runTool(phone, 'phone.jpg', 'IMAGE_CROP', { mode: 'aspect', aspect: '1:1' });
    expect(await dims(r.output!)).toEqual([300, 300]);
    expect(r.job.result).toMatchObject({ inputWidth: 300, inputHeight: 400 });
  });

  it('rotates and flips', async () => {
    const rot = await runTool(await makeTwoToneImage('png', 400, 300), 'a.png', 'IMAGE_ROTATE', { angle: 90 });
    expect(await dims(rot.output!)).toEqual([300, 400]);
    expect(await pixel(rot.output!, 150, 10)).toEqual([255, 0, 0]); // red (left) is now on top
    const flip = await runTool(await makeTwoToneImage('png', 400, 300), 'a.png', 'IMAGE_ROTATE', {
      angle: 0,
      flipHorizontal: true,
    });
    expect(await pixel(flip.output!, 10, 150)).toEqual([0, 0, 255]);
    const flipV = await runTool(await makeTwoToneImage('png', 400, 300), 'a.png', 'IMAGE_ROTATE', {
      angle: 0,
      flipVertical: true,
    });
    expect(await pixel(flipV.output!, 10, 150)).toEqual([255, 0, 0]); // left-right unchanged
    const nothing = await request()
      .post('/api/v1/jobs')
      .send({ fileIds: [rot.id], operation: 'IMAGE_ROTATE', options: { angle: 0 } });
    expect(nothing.status).toBe(400);
  });
});

describe('Image: watermark and adjust', () => {
  it.each(['bottom-right', 'top-left', 'center', 'tile'])(
    'draws a watermark (%s) without changing the size',
    async (position) => {
      const base = await makeTwoToneImage('png', 400, 300);
      const r = await runTool(base, 'a.png', 'IMAGE_WATERMARK', {
        text: 'Ünï © Family',
        position,
        color: 'white',
        opacity: 90,
        sizePercent: 10,
      });
      expect(r.job.status, JSON.stringify(r.job.error)).toBe('COMPLETED');
      expect(await dims(r.output!)).toEqual([400, 300]);
      const a = await sharp(base).raw().toBuffer();
      const b = await sharp(r.output!).raw().toBuffer();
      let changed = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++;
      expect(changed).toBeGreaterThan(400);
    },
  );

  it('is applied after EXIF orientation and rejects bad input', async () => {
    const r = await runTool(await makeExifJpeg(6, 400, 300), 'phone.jpg', 'IMAGE_WATERMARK', {
      text: 'Hi',
      position: 'bottom-right',
    });
    expect(await dims(r.output!)).toEqual([300, 400]);
    const bad = await request()
      .post('/api/v1/jobs')
      .send({ fileIds: [r.id], operation: 'IMAGE_WATERMARK', options: { text: '<script>', color: 'pink' } });
    expect(bad.status).toBe(400);
    const xml = await runTool(await makeTwoToneImage('png', 200, 100), 'a.png', 'IMAGE_WATERMARK', {
      text: '</svg><script>alert(1)</script>',
    });
    expect(xml.job.status).toBe('COMPLETED'); // text is drawn as outlines, never parsed as markup
  });

  it('adjusts colour: black and white, brightness, contrast, blur', async () => {
    const gray = await runTool(await makeTwoToneImage('png', 100, 100), 'a.png', 'IMAGE_ADJUST', { grayscale: true });
    const [r0, g0, b0] = await pixel(gray.output!, 10, 50);
    expect(r0).toBe(g0);
    expect(g0).toBe(b0);
    const base = await makeJpeg(100, 100, 90);
    const bright = await runTool(base, 'a.jpg', 'IMAGE_ADJUST', { brightness: 40 });
    const mean = async (b: Buffer) => (await sharp(b).stats()).channels.reduce((s, c) => s + c.mean, 0) / 3;
    expect(await mean(bright.output!)).toBeGreaterThan(await mean(base));
    const blurred = await runTool(await makeTwoToneImage('png', 100, 100), 'a.png', 'IMAGE_ADJUST', { blur: 6 });
    expect(await pixel(blurred.output!, 50, 50)).not.toEqual([255, 0, 0]);
    const nothing = await request()
      .post('/api/v1/jobs')
      .send({ fileIds: [gray.id], operation: 'IMAGE_ADJUST', options: {} });
    expect(nothing.status).toBe(400);
    expect(nothing.body.error.message).toMatch(/at least one setting/);
  });

  it('strips EXIF but keeps the picture the right way up', async () => {
    const r = await runTool(await makeExifJpeg(6, 400, 300), 'phone.jpg', 'IMAGE_STRIP_METADATA');
    const meta = await sharp(r.output!).metadata();
    expect(meta.exif).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([300, 400]);
  });
});

describe('Images to PDF', () => {
  it('puts several pictures into one PDF in the chosen order', async () => {
    const a = await uploadId(await makeJpeg(300, 200, 90), 'a.jpg'); // landscape
    const b = await uploadId(await makePng(100, 300), 'b.png'); // portrait
    const c = await uploadId(await makeGif(), 'c.gif');
    const { job } = await processFiles([b, a, c], 'IMAGE_TO_PDF', { pageSize: 'a4', orientation: 'auto', margin: 10 });
    expect(job.status, JSON.stringify(job.error)).toBe('COMPLETED');
    const pdf = await PDFDocument.load(await downloadBytes(job.downloadUrl), { updateMetadata: false });
    expect(pdf.getPageCount()).toBe(3);
    const [p1, p2] = [pdf.getPage(0), pdf.getPage(1)];
    expect(p1.getWidth()).toBeLessThan(p1.getHeight()); // first picture (b) is portrait
    expect(p2.getWidth()).toBeGreaterThan(p2.getHeight()); // second (a) is landscape
    expect(job.inputs.map((i: { name: string }) => i.name)).toEqual(['b.png', 'a.jpg', 'c.gif']);
    expect((await db().file.findFirstOrThrow({ where: { role: 'OUTPUT' } })).originalName).toBe('b-combined.pdf');
  });

  it('supports Letter, forced orientation and "same size as the image"', async () => {
    const id = await uploadId(await makePng(200, 100), 'w.png');
    const letter = await processFiles([id], 'IMAGE_TO_PDF', { pageSize: 'letter', orientation: 'portrait' });
    const lp = (await PDFDocument.load(await downloadBytes(letter.job.downloadUrl), { updateMetadata: false })).getPage(
      0,
    );
    expect([Math.round(lp.getWidth()), Math.round(lp.getHeight())]).toEqual([612, 792]);
    const fit = await processFiles([id], 'IMAGE_TO_PDF', { pageSize: 'fit', margin: 0 });
    const fp = (await PDFDocument.load(await downloadBytes(fit.job.downloadUrl), { updateMetadata: false })).getPage(0);
    expect([Math.round(fp.getWidth()), Math.round(fp.getHeight())]).toEqual([150, 75]); // 200x100 px at 96 dpi
  });

  it('embeds upright JPEGs losslessly and fixes rotated ones', async () => {
    const jpeg = await makeJpeg(300, 200, 90);
    const plain = await runTool(jpeg, 'a.jpg', 'IMAGE_TO_PDF', {});
    expect(plain.output!.includes(jpeg)).toBe(true); // original JPEG bytes are inside the PDF
    const phone = await runTool(await makeExifJpeg(6, 400, 300), 'p.jpg', 'IMAGE_TO_PDF', {
      pageSize: 'a4',
      orientation: 'auto',
    });
    const page = (await PDFDocument.load(phone.output!, { updateMetadata: false })).getPage(0);
    expect(page.getWidth()).toBeLessThan(page.getHeight()); // displayed portrait
  });
});
