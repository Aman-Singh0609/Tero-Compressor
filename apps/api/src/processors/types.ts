import type { OperationName } from './operations';

export interface ProcessorInput {
  /** Local readable path of the first (or only) input file. */
  inputPath: string;
  /** Every input, in the order the user arranged them (length 1 for single-file tools). */
  inputPaths: string[];
  /** Display names of the inputs (same order); used only for messages, never as paths. */
  inputNames: string[];
  inputExt: string;
  inputMime: string;
  /** Combined size of all inputs. */
  inputSizeBytes: number;
  operation: OperationName;
  options: Record<string, unknown>;
  /** Password-type options, held in memory for this run only (never persisted or logged). */
  secrets: Record<string, string>;
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
    readonly code: 'PROCESSING_FAILED' | 'INVALID_FILE' | 'CANCELLED' | 'TIMEOUT' | 'BAD_REQUEST' = 'PROCESSING_FAILED',
    options?: { cause?: unknown },
  ) {
    super(userMessage, options);
  }
}

export type ValidateInput = Pick<
  ProcessorInput,
  'inputPath' | 'inputPaths' | 'inputNames' | 'inputExt' | 'inputMime' | 'operation' | 'options' | 'secrets'
>;

/** Contract implemented by every processor. */
export interface Processor {
  readonly operations: readonly OperationName[];
  /** Cheap pre-flight check before work starts. Throws ProcessorError. */
  validate(input: ValidateInput): Promise<void>;
  /** Extension of the file this operation will produce (decides the work path). */
  outputExtensionFor(operation: OperationName, options: Record<string, unknown>, inputExt: string): string;
  process(input: ProcessorInput): Promise<ProcessorResult>;
  /** Release anything process() may have left behind (called after success, failure and cancellation). */
  cleanup(input: Pick<ProcessorInput, 'outputPath'>): Promise<void>;
}
