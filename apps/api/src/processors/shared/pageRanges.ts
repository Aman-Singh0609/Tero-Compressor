import { ProcessorError } from '../types';

const MAX_TOKENS = 500;

function bad(message: string): never {
  throw new ProcessorError(message, 'BAD_REQUEST');
}

interface Token {
  from: number;
  to: number;
}

function tokens(spec: string, pageCount: number): Token[] {
  const parts = spec
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) bad('Enter at least one page number.');
  if (parts.length > MAX_TOKENS) bad('That list of pages is too long.');
  return parts.map((part) => {
    const m = /^(\d{1,6})(?:\s*-\s*(\d{1,6}))?$/.exec(part);
    if (!m) bad(`"${part}" is not a page or a page range. Use numbers like 1-3, 5.`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    for (const n of [from, to]) {
      if (n < 1 || n > pageCount)
        bad(`Page ${n} does not exist: this file has ${pageCount} page${pageCount === 1 ? '' : 's'}.`);
    }
    return { from, to };
  });
}

/** Pages as a set, ascending, no duplicates ("5-3" is treated as 3-5). */
export function parsePageSet(spec: string, pageCount: number): number[] {
  const set = new Set<number>();
  for (const { from, to } of tokens(spec, pageCount)) {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    for (let n = lo; n <= hi; n++) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/** Pages in the order written; descending ranges count backwards ("5-3" = 5, 4, 3). */
export function parsePageSequence(spec: string, pageCount: number): number[] {
  const out: number[] = [];
  for (const { from, to } of tokens(spec, pageCount)) {
    const step = from <= to ? 1 : -1;
    for (let n = from; n !== to + step; n += step) out.push(n);
  }
  return out;
}

/** Separate ranges, each becoming its own file when splitting ("1-3, 4, 7-9"). */
export function parseRanges(spec: string, pageCount: number): Array<{ from: number; to: number }> {
  return tokens(spec, pageCount).map(({ from, to }) => ({ from: Math.min(from, to), to: Math.max(from, to) }));
}
