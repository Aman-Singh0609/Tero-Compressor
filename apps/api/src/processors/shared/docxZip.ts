import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { ProcessorError } from '../types';

const MAX_PACKAGE_BYTES = 300 * 1024 * 1024;
const MAX_UNCOMPRESSED_TOTAL = 1.5 * 1024 * 1024 * 1024;
const MAX_UNCOMPRESSED_ENTRY = 300 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

/** JSZip keeps the declared uncompressed size on an internal field; this is the only place that reads it. */
export function declaredSize(zip: JSZip, name: string): number {
  const entry = zip.files[name] as unknown as { _data?: { uncompressedSize?: number } } | undefined;
  return entry?._data?.uncompressedSize ?? 0;
}

/**
 * Open an Office package defensively. A ZIP can be a few KB yet expand to gigabytes ("zip bomb"),
 * so declared sizes are checked from the central directory before any entry is inflated.
 */
export async function loadOfficeZip(path: string): Promise<JSZip> {
  const stat = await fs.stat(path);
  if (stat.size > MAX_PACKAGE_BYTES) throw new ProcessorError('This document is too large to process.', 'INVALID_FILE');
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await fs.readFile(path));
  } catch (err) {
    throw new ProcessorError('This document could not be read. It may be damaged.', 'INVALID_FILE', { cause: err });
  }
  const names = Object.keys(zip.files);
  if (names.length > MAX_ENTRIES) throw new ProcessorError('This document looks corrupted or unsafe.', 'INVALID_FILE');
  let total = 0;
  for (const name of names) {
    const size = declaredSize(zip, name);
    if (size > MAX_UNCOMPRESSED_ENTRY)
      throw new ProcessorError('This document contains an unusually large part and was refused.', 'INVALID_FILE');
    total += size;
  }
  if (total > MAX_UNCOMPRESSED_TOTAL)
    throw new ProcessorError('This document would expand to an unsafe size and was refused.', 'INVALID_FILE');
  if (!zip.file('word/document.xml')) throw new ProcessorError('This is not a Word document.', 'INVALID_FILE');
  return zip;
}
