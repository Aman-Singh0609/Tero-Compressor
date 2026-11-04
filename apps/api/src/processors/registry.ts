import { DocxProcessor } from './document/docxProcessor';
import { DocxToolsProcessor } from './document/docxToolsProcessor';
import { ImageProcessor } from './image/imageProcessor';
import { isOperation, type OperationName } from './operations';
import { PdfConvertProcessor } from './pdf/pdfConvertProcessor';
import { PdfEditProcessor } from './pdf/pdfEditProcessor';
import { PdfProcessor } from './pdf/pdfProcessor';
import { PdfSecurityProcessor } from './pdf/pdfSecurityProcessor';
import type { Processor } from './types';
import { VideoProcessor } from './video/videoProcessor';

const overrides = new Map<OperationName, Processor>();
const defaults: Processor[] = [
  new ImageProcessor(),
  new PdfProcessor(),
  new PdfEditProcessor(),
  new PdfSecurityProcessor(),
  new PdfConvertProcessor(),
  new DocxProcessor(),
  new DocxToolsProcessor(),
  new VideoProcessor(),
];

export function processorFor(operation: string): Processor | undefined {
  if (!isOperation(operation)) return undefined;
  return overrides.get(operation) ?? defaults.find((p) => p.operations.includes(operation));
}

/** Test seam: replace the processor for an operation (e.g. to simulate a failing processor). */
export function overrideProcessor(operation: OperationName, processor: Processor | undefined): void {
  if (processor) overrides.set(operation, processor);
  else overrides.delete(operation);
}
