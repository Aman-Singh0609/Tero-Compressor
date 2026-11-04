import { OPERATIONS, suggestedOperations, type OperationName } from '../processors/operations';

interface FileRow {
  id: string;
  originalName: string;
  mimeType: string;
  category: string;
  extension: string;
  sizeBytes: bigint | number;
  status: string;
  createdAt: Date;
  expiresAt: Date | null;
}

/** Public shape of a file: no checksum, stored name or storage path. */
export function publicFile(f: FileRow) {
  return {
    id: f.id,
    name: f.originalName,
    mimeType: f.mimeType,
    category: f.category,
    extension: f.extension,
    sizeBytes: Number(f.sizeBytes),
    status: f.status,
    createdAt: f.createdAt,
    expiresAt: f.expiresAt,
  };
}

export function operationCatalog(category: string) {
  return suggestedOperations(category).map((op: OperationName) => ({
    operation: op,
    label: OPERATIONS[op].label,
    description: OPERATIONS[op].description,
    slug: OPERATIONS[op].slug,
    group: OPERATIONS[op].group,
    minFiles: OPERATIONS[op].minFiles,
    maxFiles: OPERATIONS[op].maxFiles,
  }));
}

interface JobRow {
  id: string;
  fileId: string;
  operation: string;
  options: unknown;
  status: string;
  progress: number;
  originalSizeBytes: bigint | number;
  outputSizeBytes: bigint | number | null;
  outputFileId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  processingDurationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  resultInfo: unknown;
  errorDetail?: string | null;
  inputs?: Array<{
    position: number;
    file: { id: string; originalName: string; extension: string; category: string; sizeBytes: bigint | number };
  }>;
  createdAt: Date;
  file?: { id: string; originalName: string; extension: string; category: string } | null;
}

export function savingPercent(original: number, output: number | null): number | null {
  if (output === null || original <= 0) return null;
  return Math.round(((original - output) / original) * 1000) / 10;
}

export function publicJob(j: JobRow) {
  const original = Number(j.originalSizeBytes);
  const output = j.outputSizeBytes === null ? null : Number(j.outputSizeBytes);
  const completed = j.status === 'COMPLETED';
  return {
    id: j.id,
    fileId: j.fileId,
    fileName: j.file?.originalName ?? null,
    inputs: (j.inputs ?? []).map((i) => ({
      id: i.file.id,
      name: i.file.originalName,
      sizeBytes: Number(i.file.sizeBytes),
    })),
    operation: j.operation,
    options: j.options,
    status: j.status,
    progress: j.progress,
    originalSizeBytes: original,
    outputSizeBytes: output,
    savingPercent: completed ? savingPercent(original, output) : null,
    processingDurationMs: j.processingDurationMs,
    downloadUrl: completed ? `/api/v1/jobs/${j.id}/download` : null,
    result: completed ? (j.resultInfo ?? {}) : null,
    error: j.status === 'FAILED' || j.status === 'CANCELLED' ? { code: j.errorCode, message: j.errorMessage } : null,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    completedAt: j.completedAt,
  };
}

/** Administrator view of a job: everything public plus the technical failure detail. */
export function adminJob(j: JobRow) {
  return { ...publicJob(j), errorDetail: j.errorDetail ?? null };
}
