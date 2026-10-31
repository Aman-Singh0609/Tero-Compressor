import type { Operation } from '@prisma/client';
import type { Tx } from '../db/prisma';

export interface ToolResultInput {
  jobId: string;
  operation: Operation;
  options: Record<string, unknown>;
  info: Record<string, unknown>;
  outputExt: string;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const bool = (v: unknown): boolean => v === true;

/**
 * Writes the tool-specific result row (ImageResult / PdfResult / DocumentResult / VideoResult) in the
 * same transaction that completes the job, so a job is never COMPLETED without its tool record.
 */
export const toolResultRepository = {
  async create(tx: Tx, r: ToolResultInput): Promise<void> {
    const preset = str(r.options.preset);
    const keptOriginal = bool(r.info.keptOriginal);
    switch (r.operation) {
      case 'IMAGE_COMPRESS':
      case 'IMAGE_RESIZE':
      case 'IMAGE_CONVERT':
      case 'IMAGE_STRIP_METADATA':
      case 'IMAGE_TO_PDF':
        await tx.imageResult.create({
          data: {
            jobId: r.jobId,
            operation: r.operation,
            preset,
            targetFormat: r.operation === 'IMAGE_CONVERT' ? str(r.options.format) : r.outputExt,
            inputWidth: num(r.info.inputWidth),
            inputHeight: num(r.info.inputHeight),
            outputWidth: num(r.info.outputWidth),
            outputHeight: num(r.info.outputHeight),
            metadataStripped: r.operation === 'IMAGE_STRIP_METADATA',
            keptOriginal,
          },
          select: { id: true },
        });
        return;
      case 'PDF_COMPRESS':
        await tx.pdfResult.create({
          data: {
            jobId: r.jobId,
            preset,
            imagesFound: num(r.info.imagesFound) ?? 0,
            imagesRecompressed: num(r.info.imagesRecompressed) ?? 0,
            keptOriginal,
          },
          select: { id: true },
        });
        return;
      case 'DOCX_COMPRESS':
        await tx.documentResult.create({
          data: {
            jobId: r.jobId,
            preset,
            imagesFound: num(r.info.imagesFound) ?? 0,
            imagesRecompressed: num(r.info.imagesRecompressed) ?? 0,
            keptOriginal,
          },
          select: { id: true },
        });
        return;
      case 'VIDEO_COMPRESS':
      case 'VIDEO_EXTRACT_AUDIO':
        await tx.videoResult.create({
          data: {
            jobId: r.jobId,
            operation: r.operation,
            preset,
            durationSeconds: typeof r.info.durationSeconds === 'number' ? r.info.durationSeconds : null,
            outputFormat: r.outputExt,
            keptOriginal,
          },
          select: { id: true },
        });
        return;
    }
  },
};
