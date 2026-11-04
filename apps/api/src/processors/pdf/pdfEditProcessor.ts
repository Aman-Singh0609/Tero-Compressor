import fs from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFName, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { OperationName } from '../operations';
import { fontBytes } from '../shared/fonts';
import { parsePageSequence, parsePageSet, parseRanges } from '../shared/pageRanges';
import { loadPdf } from '../shared/pdfLoad';
import { pad, writeZip, type ZipEntry } from '../shared/zip';
import {
  ProcessorError,
  type Processor,
  type ProcessorInput,
  type ProcessorResult,
  type ValidateInput,
} from '../types';

const MAX_SPLIT_FILES = 500;
const PDF_MIME = 'application/pdf';

const COLORS = {
  gray: rgb(0.5, 0.5, 0.5),
  red: rgb(0.85, 0.1, 0.1),
  blue: rgb(0.1, 0.25, 0.85),
  black: rgb(0, 0, 0),
} as const;

type Rotation = 0 | 90 | 180 | 270;

function pageRotation(page: PDFPage): Rotation {
  const a = (((Math.round(page.getRotation().angle / 90) * 90) % 360) + 360) % 360;
  return a as Rotation;
}

/** The page as the viewer sees it: width/height after the page's own /Rotate is applied. */
function visualSize(page: PDFPage): {
  vw: number;
  vh: number;
  rot: Rotation;
  w: number;
  h: number;
  ox: number;
  oy: number;
} {
  const mb = page.getMediaBox();
  const rot = pageRotation(page);
  const swap = rot === 90 || rot === 270;
  return {
    vw: swap ? mb.height : mb.width,
    vh: swap ? mb.width : mb.height,
    rot,
    w: mb.width,
    h: mb.height,
    ox: mb.x,
    oy: mb.y,
  };
}

/**
 * Draw text where the *viewer* sees (vx, vy) — baseline-left start, y up — at a visual angle,
 * regardless of whether the page carries a /Rotate entry.
 */
function drawVisualText(
  page: PDFPage,
  font: PDFFont,
  text: string,
  size: number,
  vx: number,
  vy: number,
  visualAngle: number,
  color: ReturnType<typeof rgb>,
  opacity: number,
): void {
  const { rot, w, h, ox, oy } = visualSize(page);
  let ux: number;
  let uy: number;
  switch (rot) {
    case 90:
      ux = w - vy;
      uy = vx;
      break;
    case 180:
      ux = w - vx;
      uy = h - vy;
      break;
    case 270:
      ux = vy;
      uy = h - vx;
      break;
    default:
      ux = vx;
      uy = vy;
  }
  page.drawText(text, { x: ox + ux, y: oy + uy, size, font, color, opacity, rotate: degrees(visualAngle + rot) });
}

async function embedUnicodeFont(doc: PDFDocument): Promise<PDFFont> {
  doc.registerFontkit(fontkit);
  return doc.embedFont(await fontBytes('bold'), { subset: true });
}

function pagesFor(spec: unknown, count: number): number[] {
  if (typeof spec === 'string' && spec.trim()) return parsePageSet(spec, count);
  return Array.from({ length: count }, (_, i) => i + 1);
}

export class PdfEditProcessor implements Processor {
  readonly operations: readonly OperationName[] = [
    'PDF_MERGE',
    'PDF_SPLIT',
    'PDF_EXTRACT_PAGES',
    'PDF_REMOVE_PAGES',
    'PDF_REORDER_PAGES',
    'PDF_ROTATE',
    'PDF_CROP',
    'PDF_WATERMARK',
    'PDF_PAGE_NUMBERS',
    'PDF_STRIP_METADATA',
  ];

  async validate(input: ValidateInput): Promise<void> {
    for (const p of input.inputPaths) await loadPdf(p);
  }

  outputExtensionFor(operation: OperationName): string {
    return operation === 'PDF_SPLIT' ? 'zip' : 'pdf';
  }

  async process(input: ProcessorInput): Promise<ProcessorResult> {
    input.reportProgress(5);
    let result: ProcessorResult;
    switch (input.operation) {
      case 'PDF_MERGE':
        result = await this.merge(input);
        break;
      case 'PDF_SPLIT':
        result = await this.split(input);
        break;
      default:
        result = await this.editSingle(input);
    }
    input.reportProgress(95);
    return result;
  }

  private async merge(input: ProcessorInput): Promise<ProcessorResult> {
    const out = await PDFDocument.create({ updateMetadata: false });
    let total = 0;
    for (const [i, path] of input.inputPaths.entries()) {
      if (input.signal.aborted) throw new ProcessorError('Cancelled', 'CANCELLED');
      const { doc } = await loadPdf(path);
      total += doc.getPageCount();
      if (total > 3000)
        throw new ProcessorError('The combined document would be too long (over 3000 pages).', 'BAD_REQUEST');
      for (const page of await out.copyPages(doc, doc.getPageIndices())) out.addPage(page);
      input.reportProgress(5 + Math.round(((i + 1) / input.inputPaths.length) * 85));
    }
    await fs.writeFile(input.outputPath, await out.save({ useObjectStreams: true }));
    return { outputMime: PDF_MIME, outputExt: 'pdf', info: { files: input.inputPaths.length, outputPages: total } };
  }

  private async split(input: ProcessorInput): Promise<ProcessorResult> {
    const { doc } = await loadPdf(input.inputPath);
    const count = doc.getPageCount();
    const mode = (input.options.mode as string) ?? 'ranges';
    let ranges: Array<{ from: number; to: number }>;
    if (mode === 'each') {
      ranges = Array.from({ length: count }, (_, i) => ({ from: i + 1, to: i + 1 }));
    } else if (mode === 'every') {
      const n = Number(input.options.every);
      ranges = [];
      for (let from = 1; from <= count; from += n) ranges.push({ from, to: Math.min(count, from + n - 1) });
    } else {
      ranges = parseRanges(String(input.options.ranges ?? ''), count);
    }
    if (ranges.length > MAX_SPLIT_FILES) {
      throw new ProcessorError(
        `That would create more than ${MAX_SPLIT_FILES} files. Choose bigger parts.`,
        'BAD_REQUEST',
      );
    }
    if (ranges.length < 2 && mode !== 'ranges') {
      throw new ProcessorError('This PDF is too short to split that way.', 'BAD_REQUEST');
    }
    const entries: ZipEntry[] = [];
    for (const [i, r] of ranges.entries()) {
      if (input.signal.aborted) throw new ProcessorError('Cancelled', 'CANCELLED');
      const part = await PDFDocument.create({ updateMetadata: false });
      const idx = Array.from({ length: r.to - r.from + 1 }, (_, k) => r.from - 1 + k);
      for (const page of await part.copyPages(doc, idx)) part.addPage(page);
      const label = r.from === r.to ? `page-${r.from}` : `pages-${r.from}-${r.to}`;
      entries.push({
        name: `part-${pad(i + 1)}-${label}.pdf`,
        data: Buffer.from(await part.save({ useObjectStreams: true })),
      });
      input.reportProgress(5 + Math.round(((i + 1) / ranges.length) * 85));
    }
    await writeZip(input.outputPath, entries, false);
    return { outputMime: 'application/zip', outputExt: 'zip', info: { inputPages: count, files: entries.length } };
  }

  private async editSingle(input: ProcessorInput): Promise<ProcessorResult> {
    const { doc, bytes } = await loadPdf(input.inputPath);
    const count = doc.getPageCount();
    const o = input.options;
    let info: Record<string, unknown> = { inputPages: count };
    let out: PDFDocument = doc;

    switch (input.operation) {
      case 'PDF_EXTRACT_PAGES': {
        const keep = parsePageSet(String(o.pages), count);
        out = await this.copyPagesTo(doc, keep);
        info = { ...info, outputPages: keep.length };
        break;
      }
      case 'PDF_REMOVE_PAGES': {
        const drop = new Set(parsePageSet(String(o.pages), count));
        if (drop.size >= count)
          throw new ProcessorError('You cannot remove every page of the document.', 'BAD_REQUEST');
        const keep = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !drop.has(n));
        out = await this.copyPagesTo(doc, keep);
        info = { ...info, outputPages: keep.length, removed: drop.size };
        break;
      }
      case 'PDF_REORDER_PAGES': {
        const order = parsePageSequence(String(o.order), count);
        const seen = new Set(order);
        if (order.length !== count || seen.size !== count) {
          const missing = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !seen.has(n));
          throw new ProcessorError(
            missing.length
              ? `List every page exactly once. Missing: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}.`
              : 'List every page exactly once (some pages are repeated).',
            'BAD_REQUEST',
          );
        }
        out = await this.copyPagesTo(doc, order);
        info = { ...info, outputPages: count };
        break;
      }
      case 'PDF_ROTATE': {
        const angle = Number(o.angle);
        const pages = pagesFor(o.pages, count);
        for (const n of pages) {
          const page = doc.getPage(n - 1);
          page.setRotation(degrees((((pageRotation(page) + angle) % 360) + 360) % 360));
        }
        info = { ...info, outputPages: count, rotated: pages.length, angle };
        break;
      }
      case 'PDF_CROP': {
        this.crop(doc, o);
        info = { ...info, outputPages: count };
        break;
      }
      case 'PDF_WATERMARK': {
        const pages = pagesFor(o.pages, count);
        await this.watermark(doc, o, pages, input);
        info = { ...info, outputPages: count, stamped: pages.length };
        break;
      }
      case 'PDF_PAGE_NUMBERS': {
        const numbered = await this.pageNumbers(doc, o);
        info = { ...info, outputPages: count, numbered };
        break;
      }
      case 'PDF_STRIP_METADATA': {
        info = { ...info, outputPages: count, removed: this.stripMetadata(doc) };
        break;
      }
      default:
        throw new ProcessorError('Unsupported PDF operation.');
    }

    await fs.writeFile(input.outputPath, await out.save({ useObjectStreams: true }));
    void bytes;
    return { outputMime: PDF_MIME, outputExt: 'pdf', info };
  }

  private async copyPagesTo(src: PDFDocument, pages1Based: number[]): Promise<PDFDocument> {
    const out = await PDFDocument.create({ updateMetadata: false });
    for (const page of await out.copyPages(
      src,
      pages1Based.map((n) => n - 1),
    ))
      out.addPage(page);
    return out;
  }

  private crop(doc: PDFDocument, o: Record<string, unknown>): void {
    const pct = (k: string) => Number(o[k] ?? 0) / 100;
    for (const page of doc.getPages()) {
      const { vw, vh, rot, w, h, ox, oy } = visualSize(page);
      // margins in points as the viewer sees them
      const vt = pct('top') * vh;
      const vb = pct('bottom') * vh;
      const vl = pct('left') * vw;
      const vr = pct('right') * vw;
      // map to the page's own (unrotated) sides
      const [ul, ur, ub, ut] =
        rot === 90
          ? [vt, vb, vl, vr]
          : rot === 180
            ? [vr, vl, vt, vb]
            : rot === 270
              ? [vb, vt, vr, vl]
              : [vl, vr, vb, vt];
      const x = ox + ul;
      const y = oy + ub;
      const nw = w - ul - ur;
      const nh = h - ub - ut;
      page.setMediaBox(x, y, nw, nh);
      page.setCropBox(x, y, nw, nh);
    }
  }

  private async watermark(
    doc: PDFDocument,
    o: Record<string, unknown>,
    pages: number[],
    input: ProcessorInput,
  ): Promise<void> {
    const font = await embedUnicodeFont(doc);
    const text = String(o.text);
    const color = COLORS[(o.color as keyof typeof COLORS) ?? 'gray'];
    const opacity = Number(o.opacity ?? 30) / 100;
    const position = String(o.position ?? 'diagonal');
    for (const [i, n] of pages.entries()) {
      if (input.signal.aborted) throw new ProcessorError('Cancelled', 'CANCELLED');
      const page = doc.getPage(n - 1);
      const { vw, vh } = visualSize(page);
      let size = Number(o.fontSize ?? 60);
      let angle = 0;
      const cx = vw / 2;
      let cy = vh / 2;
      if (position === 'diagonal') angle = (Math.atan2(vh, vw) * 180) / Math.PI;
      if (position === 'top') cy = vh - size * 1.2;
      if (position === 'bottom') cy = size * 1.2;
      // never let the text run off the page
      const room = position === 'diagonal' ? Math.hypot(vw, vh) * 0.85 : vw * 0.92;
      const textWidth = font.widthOfTextAtSize(text, size);
      if (textWidth > room) size = Math.max(6, (size * room) / textWidth);
      const w = font.widthOfTextAtSize(text, size);
      const h = size * 0.7;
      const a = (angle * Math.PI) / 180;
      const sx = cx - (w / 2) * Math.cos(a) + (h / 2) * Math.sin(a);
      const sy = cy - (w / 2) * Math.sin(a) - (h / 2) * Math.cos(a);
      drawVisualText(page, font, text, size, sx, sy, angle, color, opacity);
      input.reportProgress(5 + Math.round(((i + 1) / pages.length) * 85));
    }
  }

  private async pageNumbers(doc: PDFDocument, o: Record<string, unknown>): Promise<number> {
    const font = await embedUnicodeFont(doc);
    const size = Number(o.fontSize ?? 11);
    const start = Number(o.start ?? 1);
    const skipFirst = o.skipFirst === true;
    const format = String(o.format ?? 'n');
    const position = String(o.position ?? 'bottom-center');
    const margin = 28;
    const total = doc.getPageCount();
    let numbered = 0;
    for (const [i, page] of doc.getPages().entries()) {
      if (skipFirst && i === 0) continue;
      const n = start + i - (skipFirst ? 1 : 0);
      const label =
        format === 'page-n'
          ? `Page ${n}`
          : format === 'n-of-total'
            ? `${n} of ${start + total - 1 - (skipFirst ? 1 : 0)}`
            : String(n);
      const { vw, vh } = visualSize(page);
      const w = font.widthOfTextAtSize(label, size);
      const x = position.endsWith('left') ? margin : position.endsWith('right') ? vw - margin - w : (vw - w) / 2;
      const y = position.startsWith('top') ? vh - margin - size * 0.7 : margin;
      drawVisualText(page, font, label, size, x, y, 0, rgb(0.2, 0.2, 0.2), 1);
      numbered++;
    }
    return numbered;
  }

  /** Remove the Info dictionary, XMP packet and document ids that identify the author or software. */
  private stripMetadata(doc: PDFDocument): string[] {
    const removed: string[] = [];
    if (
      doc.getTitle() ||
      doc.getAuthor() ||
      doc.getSubject() ||
      doc.getCreator() ||
      doc.getProducer() ||
      doc.getKeywords()
    ) {
      removed.push('document properties');
    }
    const trailer = doc.context.trailerInfo as { Info?: unknown; ID?: unknown };
    trailer.Info = undefined;
    trailer.ID = undefined;
    if (doc.catalog.has(PDFName.of('Metadata'))) {
      doc.catalog.delete(PDFName.of('Metadata'));
      removed.push('XMP metadata');
    }
    if (doc.catalog.has(PDFName.of('PieceInfo'))) {
      doc.catalog.delete(PDFName.of('PieceInfo'));
      removed.push('application data');
    }
    return removed;
  }

  async cleanup(input: Pick<ProcessorInput, 'outputPath'>): Promise<void> {
    await fs.rm(input.outputPath, { force: true });
  }
}
