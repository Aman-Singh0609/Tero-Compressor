import fs from 'node:fs/promises';
import type JSZip from 'jszip';
import type { OperationName } from '../operations';
import { loadOfficeZip } from '../shared/docxZip';
import { pad, writeZip, type ZipEntry } from '../shared/zip';
import {
  ProcessorError,
  type Processor,
  type ProcessorInput,
  type ProcessorResult,
  type ValidateInput,
} from '../types';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|tiff?|webp)$/i;
const MAX_IMAGES = 1000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Plain text of word/document.xml: paragraphs, tabs, line breaks and table cells. */
export function docxXmlToText(xml: string): string {
  const paragraphs = xml.split(/<\/w:p>/);
  const lines: string[] = [];
  for (const p of paragraphs) {
    const tokens = p.match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<\/w:tc>/g) ?? [];
    let line = '';
    for (const tok of tokens) {
      if (tok.startsWith('<w:tab')) line += '\t';
      else if (tok.startsWith('<w:br')) line += '\n';
      else if (tok === '</w:tc>') line += '\t';
      else line += decodeEntities(tok.replace(/<[^>]+>/g, ''));
    }
    lines.push(line.replace(/\t+$/, ''));
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const EPOCH = '1970-01-01T00:00:00Z';

export class DocxToolsProcessor implements Processor {
  readonly operations: readonly OperationName[] = ['DOCX_STRIP_METADATA', 'DOCX_TO_TEXT', 'DOCX_EXTRACT_IMAGES'];

  async validate(input: ValidateInput): Promise<void> {
    await loadOfficeZip(input.inputPath);
  }

  outputExtensionFor(operation: OperationName): string {
    return operation === 'DOCX_STRIP_METADATA' ? 'docx' : operation === 'DOCX_TO_TEXT' ? 'txt' : 'zip';
  }

  async process(input: ProcessorInput): Promise<ProcessorResult> {
    const zip = await loadOfficeZip(input.inputPath);
    input.reportProgress(10);
    switch (input.operation) {
      case 'DOCX_STRIP_METADATA':
        return this.strip(zip, input);
      case 'DOCX_TO_TEXT':
        return this.toText(zip, input);
      default:
        return this.extractImages(zip, input);
    }
  }

  private async toText(zip: JSZip, input: ProcessorInput): Promise<ProcessorResult> {
    const xml = await zip.file('word/document.xml')!.async('string');
    const text = docxXmlToText(xml);
    if (!text) throw new ProcessorError('This document has no text.', 'BAD_REQUEST');
    await fs.writeFile(input.outputPath, text + '\n', 'utf8');
    return { outputMime: 'text/plain; charset=utf-8', outputExt: 'txt', info: { characters: text.length } };
  }

  private async extractImages(zip: JSZip, input: ProcessorInput): Promise<ProcessorResult> {
    const names = Object.keys(zip.files).filter((n) => /^word\/media\/[^/]+$/.test(n) && IMAGE_EXT.test(n));
    if (names.length === 0) throw new ProcessorError('This document has no pictures.', 'BAD_REQUEST');
    if (names.length > MAX_IMAGES)
      throw new ProcessorError('This document has too many pictures to extract at once.', 'BAD_REQUEST');
    const entries: ZipEntry[] = [];
    for (const [i, name] of names.entries()) {
      if (input.signal.aborted) throw new ProcessorError('Cancelled', 'CANCELLED');
      const ext = /\.([a-z0-9]+)$/i.exec(name)![1]!.toLowerCase().replace('jpeg', 'jpg');
      // names inside the archive are generated, never copied from the document
      entries.push({ name: `image-${pad(i + 1)}.${ext}`, data: await zip.file(name)!.async('nodebuffer') });
      input.reportProgress(10 + Math.round(((i + 1) / names.length) * 80));
    }
    await writeZip(input.outputPath, entries, false);
    return { outputMime: 'application/zip', outputExt: 'zip', info: { images: entries.length } };
  }

  /**
   * Remove who/when/where-from details: author and company, comments, tracked-change authors,
   * editing-session ids and custom properties. Text, formatting and pictures are untouched.
   */
  private async strip(zip: JSZip, input: ProcessorInput): Promise<ProcessorResult> {
    const removed = new Set<string>();
    const edit = async (name: string, fn: (xml: string) => string, label: string) => {
      const f = zip.file(name);
      if (!f) return;
      const before = await f.async('string');
      const after = fn(before);
      if (after !== before) {
        zip.file(name, after);
        removed.add(label);
      }
    };
    const blank = (tag: string) => (xml: string) =>
      xml.replace(new RegExp(`(<${tag}(?:\\s[^>]*)?>)[\\s\\S]*?(</${tag}>)`, 'g'), '$1$2');

    await edit(
      'docProps/core.xml',
      (xml) =>
        [
          'dc:creator',
          'cp:lastModifiedBy',
          'dc:title',
          'dc:subject',
          'cp:keywords',
          'dc:description',
          'cp:category',
          'cp:contentStatus',
        ]
          .reduce((acc, tag) => blank(tag)(acc), xml)
          .replace(/(<dcterms:(?:created|modified)[^>]*>)[^<]*(<\/dcterms:(?:created|modified)>)/g, `$1${EPOCH}$2`)
          .replace(/(<cp:lastPrinted>)[^<]*(<\/cp:lastPrinted>)/g, `$1${EPOCH}$2`),
      'author and document properties',
    );
    await edit(
      'docProps/app.xml',
      (xml) =>
        ['Company', 'Manager', 'Application', 'AppVersion', 'Template', 'HyperlinkBase']
          .reduce((acc, tag) => blank(tag)(acc), xml)
          .replace(/(<TotalTime>)\d+(<\/TotalTime>)/, '$10$2'),
      'company and software details',
    );
    if (zip.file('docProps/custom.xml')) {
      zip.file(
        'docProps/custom.xml',
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"/>',
      );
      removed.add('custom properties');
    }
    for (const name of Object.keys(zip.files).filter((n) =>
      /^word\/comments(Extended|Ids|Extensible)?\.xml$/.test(n),
    )) {
      await edit(
        name,
        (xml) =>
          xml
            .replace(/<w:comment\b[\s\S]*?<\/w:comment>/g, '')
            .replace(/<w15:commentEx\b[^>]*\/>/g, '')
            .replace(/<w16cid:commentId\b[^>]*\/>/g, ''),
        'comments',
      );
    }
    for (const name of Object.keys(zip.files).filter((n) =>
      /^word\/(document|footnotes|endnotes|header\d*|footer\d*)\.xml$/.test(n),
    )) {
      await edit(
        name,
        (xml) =>
          xml
            .replace(/<w:commentRangeStart\b[^>]*\/>|<w:commentRangeEnd\b[^>]*\/>/g, '')
            .replace(/<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:commentReference\b[^>]*\/>[\s\S]*?<\/w:r>/g, '')
            // accept tracked changes: drop deleted text, keep inserted text (self-closing markers go first, so
            // a paragraph-mark <w:del/> can never swallow the content that follows it)
            .replace(/<w:(?:del|ins)\b[^>]*\/>/g, '')
            .replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, '')
            .replace(/<w:ins\b[^>]*>|<\/w:ins>/g, '')
            // editing-session fingerprints
            .replace(/\sw:rsid\w*="[^"]*"/g, ''),
        'comments, tracked changes and editing history',
      );
    }
    input.reportProgress(70);
    const out = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    await fs.writeFile(input.outputPath, out);
    return {
      outputMime: DOCX_MIME,
      outputExt: 'docx',
      info: {
        removed: [...removed],
        ...(removed.size === 0 ? { note: 'No personal details were found in this document.' } : {}),
      },
    };
  }

  async cleanup(input: Pick<ProcessorInput, 'outputPath'>): Promise<void> {
    await fs.rm(input.outputPath, { force: true });
  }
}
