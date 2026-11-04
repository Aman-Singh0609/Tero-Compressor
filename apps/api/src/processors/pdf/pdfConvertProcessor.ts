import fs from 'node:fs/promises';
import { PDFiumLibrary, type PDFiumDocument } from '@hyzyla/pdfium';
import { AlignmentType, Document, PageBreak, Packer, Paragraph, TextRun } from 'docx';
import sharp from 'sharp';
import { getEnv } from '../../config/env';
import type { OperationName } from '../operations';
import { parsePageSet } from '../shared/pageRanges';
import { pad, writeZip, type ZipEntry } from '../shared/zip';
import {
  ProcessorError,
  type Processor,
  type ProcessorInput,
  type ProcessorResult,
  type ValidateInput,
} from '../types';

/** One rendered bitmap is capped so a poster-sized page at 300 dpi cannot exhaust memory. */
const MAX_PAGE_PIXELS = 40_000_000;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * PDFium (the engine inside Chrome) compiled to WebAssembly: renders pages and extracts text with no
 * native add-ons, no installation and no network.
 */
async function openPdf(path: string): Promise<{ lib: PDFiumLibrary; doc: PDFiumDocument; close: () => void }> {
  const bytes = await fs.readFile(path);
  const lib = await PDFiumLibrary.init();
  try {
    const doc = await lib.loadDocument(new Uint8Array(bytes));
    const limit = getEnv().MAX_PDF_PAGES;
    if (doc.getPageCount() > limit) {
      doc.destroy();
      throw new ProcessorError(
        `This PDF has more than ${limit} pages, which is more than TERO can handle at once.`,
        'INVALID_FILE',
      );
    }
    return {
      lib,
      doc,
      close: () => {
        try {
          doc.destroy();
        } finally {
          lib.destroy();
        }
      },
    };
  } catch (err) {
    lib.destroy();
    if (err instanceof ProcessorError) throw err;
    const text = String(err);
    throw new ProcessorError(
      /password/i.test(text)
        ? 'This PDF is password-protected. Use "Unlock PDF" first, then try again.'
        : 'This PDF could not be read. It may be damaged.',
      'INVALID_FILE',
      { cause: err },
    );
  }
}

/** Join hard-wrapped lines back into paragraphs so the Word file is comfortable to edit. */
function toParagraphs(pageText: string): string[] {
  const lines = pageText
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim());
  const paragraphs: string[] = [];
  let current = '';
  for (const line of lines) {
    if (!line) {
      if (current) paragraphs.push(current);
      current = '';
      continue;
    }
    current = current ? `${current} ${line}` : line;
    if (/[.!?:;)]$/.test(line) || line.length < 40) {
      paragraphs.push(current);
      current = '';
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

export class PdfConvertProcessor implements Processor {
  readonly operations: readonly OperationName[] = ['PDF_TO_IMAGES', 'PDF_TO_TEXT', 'PDF_TO_WORD'];

  async validate(input: ValidateInput): Promise<void> {
    const { close } = await openPdf(input.inputPath);
    close();
  }

  outputExtensionFor(operation: OperationName): string {
    return operation === 'PDF_TO_IMAGES' ? 'zip' : operation === 'PDF_TO_TEXT' ? 'txt' : 'docx';
  }

  async process(input: ProcessorInput): Promise<ProcessorResult> {
    const { doc, close } = await openPdf(input.inputPath);
    try {
      input.reportProgress(5);
      switch (input.operation) {
        case 'PDF_TO_IMAGES':
          return await this.toImages(doc, input);
        case 'PDF_TO_TEXT':
          return await this.toText(doc, input);
        default:
          return await this.toWord(doc, input);
      }
    } finally {
      close();
    }
  }

  private async toImages(doc: PDFiumDocument, input: ProcessorInput): Promise<ProcessorResult> {
    const count = doc.getPageCount();
    const pages =
      typeof input.options.pages === 'string' && input.options.pages.trim()
        ? parsePageSet(input.options.pages, count)
        : Array.from({ length: count }, (_, i) => i + 1);
    const limit = getEnv().MAX_RENDER_PAGES;
    if (pages.length > limit) {
      throw new ProcessorError(
        `That is ${pages.length} pages; at most ${limit} can be converted at a time. Pick a page range.`,
        'BAD_REQUEST',
      );
    }
    const format = String(input.options.format ?? 'jpg');
    const dpi = Number(input.options.dpi ?? 150);
    const entries: ZipEntry[] = [];
    for (const [i, n] of pages.entries()) {
      if (input.signal.aborted) throw new ProcessorError('Cancelled', 'CANCELLED');
      const page = doc.getPage(n - 1);
      try {
        const { originalWidth, originalHeight } = page.getOriginalSize();
        let scale = dpi / 72;
        const pixels = originalWidth * scale * (originalHeight * scale);
        if (pixels > MAX_PAGE_PIXELS) scale *= Math.sqrt(MAX_PAGE_PIXELS / pixels);
        const bitmap = await page.render({ scale, render: 'bitmap' });
        const raw = sharp(bitmap.data, { raw: { width: bitmap.width, height: bitmap.height, channels: 4 } });
        const data =
          format === 'png'
            ? await raw.png({ compressionLevel: 6 }).toBuffer()
            : await raw.flatten({ background: '#ffffff' }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
        entries.push({ name: `page-${pad(n)}.${format}`, data });
      } finally {
        page.close();
      }
      input.reportProgress(5 + Math.round(((i + 1) / pages.length) * 85));
    }
    await writeZip(input.outputPath, entries, false);
    return {
      outputMime: 'application/zip',
      outputExt: 'zip',
      info: { inputPages: count, images: entries.length, dpi, format },
    };
  }

  private async extractPages(doc: PDFiumDocument, input: ProcessorInput): Promise<string[]> {
    const texts: string[] = [];
    const count = doc.getPageCount();
    for (let i = 0; i < count; i++) {
      if (input.signal.aborted) throw new ProcessorError('Cancelled', 'CANCELLED');
      const page = doc.getPage(i);
      try {
        texts.push(page.getText());
      } finally {
        page.close();
      }
      input.reportProgress(5 + Math.round(((i + 1) / count) * 80));
    }
    if (!texts.some((t) => t.trim())) {
      throw new ProcessorError(
        'This PDF has no selectable text. It may be a scan or photo of a document.',
        'BAD_REQUEST',
      );
    }
    return texts;
  }

  private async toText(doc: PDFiumDocument, input: ProcessorInput): Promise<ProcessorResult> {
    const texts = await this.extractPages(doc, input);
    const body = texts.map((t, i) => `--- Page ${i + 1} ---\n${t.replace(/\r\n/g, '\n').trim()}`).join('\n\n');
    await fs.writeFile(input.outputPath, body + '\n', 'utf8');
    return {
      outputMime: 'text/plain; charset=utf-8',
      outputExt: 'txt',
      info: { inputPages: texts.length, characters: body.length },
    };
  }

  private async toWord(doc: PDFiumDocument, input: ProcessorInput): Promise<ProcessorResult> {
    const texts = await this.extractPages(doc, input);
    const children: Paragraph[] = [];
    texts.forEach((pageText, i) => {
      if (i > 0) children.push(new Paragraph({ children: [new PageBreak()] }));
      for (const p of toParagraphs(pageText)) {
        children.push(
          new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 120 }, children: [new TextRun(p)] }),
        );
      }
    });
    const document = new Document({ creator: 'TERO', title: '', sections: [{ children }] });
    await fs.writeFile(input.outputPath, await Packer.toBuffer(document));
    return {
      outputMime: DOCX_MIME,
      outputExt: 'docx',
      info: {
        inputPages: texts.length,
        note: 'Only the text was converted. Layout, tables and pictures are not kept.',
      },
    };
  }

  async cleanup(input: Pick<ProcessorInput, 'outputPath'>): Promise<void> {
    await fs.rm(input.outputPath, { force: true });
  }
}
