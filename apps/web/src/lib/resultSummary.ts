import type { Job } from './api';

/** Plain-language facts about a finished job, built only from what the backend actually reported. */
export function describeResult(job: Job): string[] {
  const r = job.result ?? {};
  const lines: string[] = [];
  const num = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : undefined);
  const inPages = num('inputPages');
  const outPages = num('outputPages');
  if (inPages !== undefined && outPages !== undefined && inPages !== outPages)
    lines.push(`${inPages} pages → ${outPages} pages`);
  else if (outPages !== undefined) lines.push(`${outPages} page${outPages === 1 ? '' : 's'}`);
  if (num('files') && job.operation === 'PDF_SPLIT') lines.push(`Split into ${num('files')} files (in a ZIP)`);
  if (num('files') && job.operation === 'PDF_MERGE') lines.push(`${num('files')} PDFs combined`);
  if (num('images') && job.operation === 'PDF_TO_IMAGES') lines.push(`${num('images')} images (in a ZIP)`);
  if (num('images') && job.operation === 'DOCX_EXTRACT_IMAGES') lines.push(`${num('images')} pictures (in a ZIP)`);
  if (num('imagesRecompressed') !== undefined && num('imagesFound'))
    lines.push(`${num('imagesRecompressed')} of ${num('imagesFound')} pictures shrunk`);
  if (num('stamped')) lines.push(`Watermark added to ${num('stamped')} page${num('stamped') === 1 ? '' : 's'}`);
  if (num('numbered')) lines.push(`${num('numbered')} pages numbered`);
  if (num('rotated')) lines.push(`${num('rotated')} page${num('rotated') === 1 ? '' : 's'} rotated`);
  if (Array.isArray(r.removed) && r.removed.length) lines.push(`Removed: ${(r.removed as string[]).join(', ')}`);
  if (job.operation === 'PDF_PROTECT') lines.push('Locked with AES-256 encryption. We did not keep the password.');
  if (typeof r.targetKb === 'number' && typeof r.achievedKb === 'number')
    lines.push(`Target ${r.targetKb} KB → result ${r.achievedKb} KB`);
  if (
    num('outputWidth') &&
    num('outputHeight') &&
    num('inputWidth') &&
    (num('outputWidth') !== num('inputWidth') || num('outputHeight') !== num('inputHeight'))
  ) {
    lines.push(`${num('inputWidth')}×${num('inputHeight')} → ${num('outputWidth')}×${num('outputHeight')} pixels`);
  }
  if (r.flattenedTransparency === true)
    lines.push('Transparent areas were filled with white (JPG has no transparency).');
  return lines;
}
