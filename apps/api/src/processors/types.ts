import type { OperationName } from './operations';

export interface ProcessorInput {
  /** Local readable path of the uploaded file. */
  inputPath: string;
  inputExt: string;
  inputMime: string;
  inputSizeBytes: number;
  operation: OperationName;
  options: Record<string, unknown>;
  /** Local path the processor must write its output to (extension already chosen by `outputExtensionFor`). */
  outputPath: string;
  signal: AbortSignal;
  reportProgress(percent: number): void;
}

export interface ProcessorResult {
  outputMime: string;
  outputExt: string;
  /** Honest facts about the result, shown to the user, e.g. { keptOriginal: true }. */
  info?: Record<string, unknown>;
}

export class ProcessorError extends Error {
  constructor(
    readonly userMessage: string,
    readonly code: 'PROCESSING_FAILED' | 'INVALID_FILE' | 'CANCELLED' | 'TIMEOUT' = 'PROCESSING_FAILED',
    options?: { cause?: unknown },
  ) {
    super(userMessage, options);
  }
}

/** Contract implemented by every processor. */
export interface Processor {
  readonly operations: readonly OperationName[];
  /** Cheap pre-flight check before work is queued/started. Throws ProcessorError. */
  validate(
    input: Pick<ProcessorInput, 'inputPath' | 'inputExt' | 'inputMime' | 'operation' | 'options'>,
  ): Promise<void>;
  /** Extension of the file this operation will produce (decides the work path). */
  outputExtensionFor(operation: OperationName, options: Record<string, unknown>, inputExt: string): string;
  process(input: ProcessorInput): Promise<ProcessorResult>;
  /** Release anything process() may have left behind (called after success, failure and cancellation). */
  cleanup(input: Pick<ProcessorInput, 'outputPath'>): Promise<void>;
}
