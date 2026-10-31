import { detectType } from './fileTypes';
import { extensionOf } from './filename';

/** Extensions that are never stored, even by an administrator. */
const BLOCKED_EXTENSIONS = new Set([
  'exe',
  'dll',
  'bat',
  'cmd',
  'com',
  'msi',
  'scr',
  'ps1',
  'psm1',
  'vbs',
  'vbe',
  'js',
  'jse',
  'wsf',
  'jar',
  'sh',
  'app',
  'apk',
  'lnk',
  'reg',
  'hta',
]);

const EXT_CATEGORY: Record<string, string> = {
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  flac: 'audio',
  ogg: 'audio',
  aac: 'audio',
  doc: 'document',
  docx: 'document',
  xls: 'document',
  xlsx: 'document',
  ppt: 'document',
  pptx: 'document',
  txt: 'document',
  csv: 'document',
  rtf: 'document',
  odt: 'document',
  md: 'document',
  zip: 'archive',
  '7z': 'archive',
  rar: 'archive',
  tar: 'archive',
  gz: 'archive',
};

const EXT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  rtf: 'application/rtf',
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  gif: 'image/gif',
  svg: 'application/octet-stream', // svg is served as a download, never inline
};

export interface VaultClassification {
  extension: string;
  mimeType: string;
  category: string;
}

/** Null when the extension is blocked. Detected content wins over the claimed extension. */
export async function classifyVaultFile(localPath: string, displayName: string): Promise<VaultClassification | null> {
  const claimed = extensionOf(displayName);
  if (BLOCKED_EXTENSIONS.has(claimed)) return null;
  const detected = await detectType(localPath);
  if (detected) return { extension: detected.ext, mimeType: detected.mime, category: detected.category };
  const extension = /^[a-z0-9]{1,8}$/.test(claimed) ? claimed : '';
  return {
    extension,
    mimeType: EXT_MIME[extension] ?? 'application/octet-stream',
    category: EXT_CATEGORY[extension] ?? 'other',
  };
}
