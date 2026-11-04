import fs from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { getEnv } from '../../config/env';
import { ProcessorError } from '../types';

/**
 * Load a PDF with friendly failures: password-protected files point the user to "Unlock PDF",
 * damaged files say so, and absurdly long documents are refused (memory protection).
 */
export async function loadPdf(source: string | Buffer): Promise<{ doc: PDFDocument; bytes: Buffer }> {
  const bytes = typeof source === 'string' ? await fs.readFile(source) : source;
  let doc: PDFDocument;
  let pages: number;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
    // pdf-lib parses lazily: a damaged file often only fails once the page tree is first read
    pages = doc.getPageCount();
  } catch (err) {
    const encrypted = /encrypt/i.test(String(err));
    throw new ProcessorError(
      encrypted
        ? 'This PDF is password-protected. Use "Unlock PDF" first, then try again.'
        : 'This PDF could not be read. It may be damaged.',
      'INVALID_FILE',
      { cause: err },
    );
  }
  const limit = getEnv().MAX_PDF_PAGES;
  if (pages > limit) {
    throw new ProcessorError(
      `This PDF has more than ${limit} pages, which is more than TERO can handle at once.`,
      'INVALID_FILE',
    );
  }
  if (pages === 0) throw new ProcessorError('This PDF has no pages.', 'INVALID_FILE');
  return { doc, bytes };
}
