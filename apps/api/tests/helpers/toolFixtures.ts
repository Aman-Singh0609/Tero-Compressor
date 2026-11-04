import { PDFiumLibrary } from '@hyzyla/pdfium';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';
import { makeJpeg, makePng } from './fixtures';

/** A small PDF whose page n contains the text "PAGE-n" (and a different width per page when `varySize`). */
export async function makeNumberedPdf(pages = 5, varySize = false): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = pdf.addPage([varySize ? 300 + i * 20 : 400, 400]);
    page.drawText(`PAGE-${i}`, { x: 40, y: 300, size: 28, font });
  }
  return Buffer.from(await pdf.save());
}

export async function makeRedSquarePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([400, 400]).drawRectangle({ x: 100, y: 100, width: 200, height: 200, color: rgb(1, 0, 0) });
  return Buffer.from(await pdf.save());
}

export async function makePdfWithMetadata(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 300]).drawText('hello');
  pdf.setTitle('Private Title');
  pdf.setAuthor('Secret Author Name');
  pdf.setSubject('Private Subject');
  pdf.setKeywords(['secret-keyword']);
  pdf.setCreator('PrivateCreatorApp');
  pdf.setProducer('PrivateProducerApp');
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

/** A scanned-looking PDF: one big image, no text. */
export async function makeImageOnlyPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const img = await pdf.embedJpg(await makeJpeg(400, 300, 80));
  pdf.addPage([400, 300]).drawImage(img, { x: 0, y: 0, width: 400, height: 300 });
  return Buffer.from(await pdf.save());
}

export async function pdfTexts(buf: Buffer): Promise<string[]> {
  const lib = await PDFiumLibrary.init();
  try {
    const doc = await lib.loadDocument(new Uint8Array(buf));
    const out: string[] = [];
    for (let i = 0; i < doc.getPageCount(); i++) {
      const page = doc.getPage(i);
      out.push(page.getText().trim());
      page.close();
    }
    doc.destroy();
    return out;
  } finally {
    lib.destroy();
  }
}

export interface Bitmap {
  data: Buffer;
  width: number;
  height: number;
}

export async function renderPdfPage(buf: Buffer, index = 0, scale = 1): Promise<Bitmap> {
  const lib = await PDFiumLibrary.init();
  try {
    const doc = await lib.loadDocument(new Uint8Array(buf));
    const page = doc.getPage(index);
    const r = await page.render({ scale, render: 'bitmap' });
    page.close();
    doc.destroy();
    return { data: Buffer.from(r.data), width: r.width, height: r.height };
  } finally {
    lib.destroy();
  }
}

export function pixelAt(img: Bitmap, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
}

/** Count pixels that are not (nearly) white. */
export function inkPixels(img: Bitmap): number {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i]! < 240 || img.data[i + 1]! < 240 || img.data[i + 2]! < 240) n++;
  }
  return n;
}

export async function makeDocxWithMetadata(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  );
  zip.file(
    'docProps/core.xml',
    '<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><dc:title>Private Title</dc:title><dc:creator>Secret Author</dc:creator><cp:lastModifiedBy>Secret Editor</cp:lastModifiedBy><dcterms:created>2024-01-02T03:04:05Z</dcterms:created><dcterms:modified>2025-01-02T03:04:05Z</dcterms:modified></cp:coreProperties>',
  );
  zip.file(
    'docProps/app.xml',
    '<?xml version="1.0"?><Properties><Company>Secret Corp</Company><Application>Microsoft Office Word</Application><TotalTime>742</TotalTime></Properties>',
  );
  zip.file(
    'docProps/custom.xml',
    '<?xml version="1.0"?><Properties><property name="secret">classified value</property></Properties>',
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p w:rsidR="00AB12CD"><w:r><w:t>Hello </w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>wor</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r><w:r><w:t>ld &amp; friends</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:rPr><w:del w:id="9" w:author="Secret Author" w:date="2025-01-01T00:00:00Z"/></w:rPr></w:pPr><w:ins w:id="1" w:author="Secret Author"><w:r><w:t>Inserted text</w:t></w:r></w:ins><w:del w:id="2" w:author="Secret Author"><w:r><w:delText>Deleted text</w:delText></w:r></w:del></w:p>' +
      '<w:p><w:r><w:t>Last paragraph</w:t></w:r></w:p></w:body></w:document>',
  );
  zip.file(
    'word/comments.xml',
    '<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="Secret Author"><w:p><w:r><w:t>private comment text</w:t></w:r></w:p></w:comment></w:comments>',
  );
  zip.file('word/media/image1.png', await makePng(120, 80));
  zip.file('word/media/image2.jpeg', await makeJpeg(200, 150, 80));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Rewrite the uncompressed size declared in the ZIP central directory (simulates a zip bomb header). */
export function patchZipDeclaredSize(buf: Buffer, entryName: string, declared: number): Buffer {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length - 46; i++) {
    if (out.readUInt32LE(i) !== 0x02014b50) continue;
    const nameLen = out.readUInt16LE(i + 28);
    if (out.toString('utf8', i + 46, i + 46 + nameLen) === entryName) {
      out.writeUInt32LE(declared, i + 24);
      return out;
    }
  }
  throw new Error(`entry ${entryName} not found`);
}

export async function makeExifJpeg(orientation = 6, width = 400, height = 300): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#2266cc' } })
    .jpeg()
    .withMetadata({ orientation })
    .toBuffer();
}

/** Left half red, right half blue: lets tests see flips and crops. */
export async function makeTwoToneImage(format: 'png' | 'jpeg' = 'png', width = 400, height = 300): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = x < width / 2 ? 255 : 0;
      raw[i + 1] = 0;
      raw[i + 2] = x < width / 2 ? 0 : 255;
    }
  }
  const img = sharp(raw, { raw: { width, height, channels: 3 } });
  return format === 'png' ? img.png().toBuffer() : img.jpeg({ quality: 95 }).toBuffer();
}

export async function makeGif(): Promise<Buffer> {
  return sharp({ create: { width: 60, height: 40, channels: 3, background: '#00aa44' } })
    .gif()
    .toBuffer();
}

export async function makeTiff(): Promise<Buffer> {
  return sharp({ create: { width: 60, height: 40, channels: 3, background: '#aa4400' } })
    .tiff()
    .toBuffer();
}

export async function unzipNames(buf: Buffer): Promise<string[]> {
  return Object.keys((await JSZip.loadAsync(buf)).files).sort();
}

export async function unzipEntry(buf: Buffer, name: string): Promise<Buffer> {
  return (await JSZip.loadAsync(buf)).file(name)!.async('nodebuffer');
}
