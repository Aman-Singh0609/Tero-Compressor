import type { Operation, Prisma } from '@prisma/client';
import type { Tx } from '../db/prisma';
import { OPERATIONS } from '../processors/operations';

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

/** Options safe to keep in the tool record: passwords are already replaced by "[hidden]" upstream. */
function details(r: ToolResultInput): Prisma.InputJsonValue {
  return { options: r.options, info: r.info } as Prisma.InputJsonValue;
}

/**
 * Writes the tool-specific result row (ImageResult / PdfResult / DocumentResult / VideoResult) in the
 * same transaction that completes the job, so a job is never COMPLETED without its tool record.
 */
export const toolResultRepository = {
  async create(tx: Tx, r: ToolResultInput): Promise<void> {
    const preset = str(r.options.preset);
    const keptOriginal = bool(r.info.keptOriginal);
    switch (OPERATIONS[r.operation].category) {
      case 'image':
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
            details: details(r),
          },
          select: { id: true },
        });
        return;
      case 'pdf':
        await tx.pdfResult.create({
          data: {
            jobId: r.jobId,
            operation: r.operation,
            preset,
            inputPages: num(r.info.inputPages),
            outputPages: num(r.info.outputPages),
            imagesFound: num(r.info.imagesFound) ?? 0,
            imagesRecompressed: num(r.info.imagesRecompressed) ?? 0,
            keptOriginal,
            details: details(r),
          },
          select: { id: true },
        });
        return;
      case 'word':
        await tx.documentResult.create({
          data: {
            jobId: r.jobId,
            operation: r.operation,
            preset,
            imagesFound: num(r.info.imagesFound) ?? num(r.info.images) ?? 0,
            imagesRecompressed: num(r.info.imagesRecompressed) ?? 0,
            keptOriginal,
            details: details(r),
          },
          select: { id: true },
        });
        return;
      case 'video':
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
