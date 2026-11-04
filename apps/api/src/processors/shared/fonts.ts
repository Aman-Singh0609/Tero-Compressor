import fs from 'node:fs/promises';
import opentype from 'opentype.js';

/**
 * DejaVu Sans (free licence) ships inside node_modules, so watermarks and page numbers render the
 * same on every machine with no system fonts and no network. It covers Latin, Greek, Cyrillic and more.
 */
const FILES = {
  regular: 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf',
  bold: 'dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf',
} as const;

const bytesCache = new Map<string, Buffer>();
const fontCache = new Map<string, opentype.Font>();

export async function fontBytes(weight: keyof typeof FILES = 'regular'): Promise<Buffer> {
  let b = bytesCache.get(weight);
  if (!b) {
    b = await fs.readFile(require.resolve(FILES[weight]));
    bytesCache.set(weight, b);
  }
  return b;
}

export async function openTypeFont(weight: keyof typeof FILES = 'bold'): Promise<opentype.Font> {
  let f = fontCache.get(weight);
  if (!f) {
    const b = await fontBytes(weight);
    f = opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    fontCache.set(weight, f);
  }
  return f;
}
