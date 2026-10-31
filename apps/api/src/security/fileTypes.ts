import fs from 'node:fs/promises';
import JSZip from 'jszip';

export type FileCategory = 'image' | 'pdf' | 'video' | 'audio' | 'document';

export interface DetectedType {
  /** Canonical extension for stored/downloaded names. */
  ext: string;
  mime: string;
  category: FileCategory;
  /** Extensions a client may legitimately use for this content. */
  allowedExtensions: string[];
}

const IMAGE_JPEG: DetectedType = {
  ext: 'jpg',
  mime: 'image/jpeg',
  category: 'image',
  allowedExtensions: ['jpg', 'jpeg', 'jpe'],
};
const IMAGE_PNG: DetectedType = { ext: 'png', mime: 'image/png', category: 'image', allowedExtensions: ['png'] };
const IMAGE_WEBP: DetectedType = { ext: 'webp', mime: 'image/webp', category: 'image', allowedExtensions: ['webp'] };
const PDF: DetectedType = { ext: 'pdf', mime: 'application/pdf', category: 'pdf', allowedExtensions: ['pdf'] };
const DOCX: DetectedType = {
  ext: 'docx',
  mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  category: 'document',
  allowedExtensions: ['docx'],
};
const MP4: DetectedType = { ext: 'mp4', mime: 'video/mp4', category: 'video', allowedExtensions: ['mp4', 'm4v'] };
const MOV: DetectedType = { ext: 'mov', mime: 'video/quicktime', category: 'video', allowedExtensions: ['mov'] };
const WEBM: DetectedType = { ext: 'webm', mime: 'video/webm', category: 'video', allowedExtensions: ['webm'] };
const MKV: DetectedType = { ext: 'mkv', mime: 'video/x-matroska', category: 'video', allowedExtensions: ['mkv'] };
const AVI: DetectedType = { ext: 'avi', mime: 'video/x-msvideo', category: 'video', allowedExtensions: ['avi'] };

/** Every type TERO accepts today. The UI "supported formats" text is generated from this list. */
export const SUPPORTED_TYPES: DetectedType[] = [IMAGE_JPEG, IMAGE_PNG, IMAGE_WEBP, PDF, DOCX, MP4, MOV, WEBM, MKV, AVI];

const NON_VIDEO_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'mif1',
  'msf1',
  'avif',
  'avis',
  'M4A ',
  'M4B ',
  'M4P ',
  'crx ',
]);

const DOCX_MAX_INSPECT_BYTES = 200 * 1024 * 1024;

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  return bytes.every((b, i) => buf[offset + i] === b);
}

/** Identify a file from its magic bytes. Content-Type and file extension are never consulted here. */
export async function detectType(filePath: string): Promise<DetectedType | null> {
  const handle = await fs.open(filePath, 'r');
  let head: Buffer;
  let size: number;
  try {
    size = (await handle.stat()).size;
    head = Buffer.alloc(Math.min(32, size));
    await handle.read(head, 0, head.length, 0);
  } finally {
    await handle.close();
  }
  if (head.length < 4) return null;

  if (startsWith(head, [0xff, 0xd8, 0xff])) return IMAGE_JPEG;
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return IMAGE_PNG;
  if (head.toString('ascii', 0, 4) === 'RIFF' && head.length >= 12) {
    const form = head.toString('ascii', 8, 12);
    if (form === 'WEBP') return IMAGE_WEBP;
    if (form === 'AVI ') return AVI;
    return null;
  }
  if (head.toString('ascii', 0, 5) === '%PDF-') return PDF;
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return isWebm(await readHead(filePath, 4096)) ? WEBM : MKV;
  if (head.length >= 12 && head.toString('ascii', 4, 8) === 'ftyp') {
    const brand = head.toString('ascii', 8, 12);
    // HEIC/AVIF photos and M4A audio share the ISO container: recognise them so they are refused as
    // unsupported (a clear message) instead of being mistaken for MP4 video.
    if (NON_VIDEO_BRANDS.has(brand)) return null;
    return brand === 'qt  ' ? MOV : MP4;
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return (await isDocx(filePath, size)) ? DOCX : null;
  return null;
}

async function readHead(filePath: string, n: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await handle.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isWebm(head: Buffer): boolean {
  return head.includes(Buffer.from('webm', 'ascii'));
}

async function isDocx(filePath: string, size: number): Promise<boolean> {
  if (size > DOCX_MAX_INSPECT_BYTES) return false;
  try {
    const zip = await JSZip.loadAsync(await fs.readFile(filePath));
    return zip.file('word/document.xml') !== null && zip.file('[Content_Types].xml') !== null;
  } catch {
    return false;
  }
}

export function supportedExtensions(): string[] {
  return SUPPORTED_TYPES.flatMap((t) => t.allowedExtensions);
}
