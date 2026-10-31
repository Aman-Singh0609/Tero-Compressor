import { z } from 'zod';
import type { FileCategory } from '../security/fileTypes';

export const OPERATION_NAMES = [
  'IMAGE_COMPRESS',
  'IMAGE_RESIZE',
  'IMAGE_CONVERT',
  'IMAGE_STRIP_METADATA',
  'IMAGE_TO_PDF',
  'PDF_COMPRESS',
  'DOCX_COMPRESS',
  'VIDEO_COMPRESS',
  'VIDEO_EXTRACT_AUDIO',
] as const;
export type OperationName = (typeof OPERATION_NAMES)[number];

export const PRESETS = ['HIGH_QUALITY', 'BALANCED', 'SMALLEST'] as const;
export type Preset = (typeof PRESETS)[number];
const preset = z.enum(PRESETS).default('BALANCED');

const noOptions = z.object({}).strict();

export const OPTION_SCHEMAS = {
  IMAGE_COMPRESS: z.object({ preset }).strict(),
  IMAGE_RESIZE: z
    .object({
      width: z.number().int().min(1).max(20000).optional(),
      height: z.number().int().min(1).max(20000).optional(),
      allowUpscale: z.boolean().default(false),
    })
    .strict()
    .refine((o) => o.width !== undefined || o.height !== undefined, {
      message: 'Provide a width, a height, or both',
    }),
  IMAGE_CONVERT: z.object({ format: z.enum(['jpeg', 'png', 'webp']), preset }).strict(),
  IMAGE_STRIP_METADATA: noOptions,
  IMAGE_TO_PDF: noOptions,
  PDF_COMPRESS: z.object({ preset }).strict(),
  DOCX_COMPRESS: z.object({ preset }).strict(),
  VIDEO_COMPRESS: z.object({ preset }).strict(),
  VIDEO_EXTRACT_AUDIO: noOptions,
} satisfies Record<OperationName, z.ZodTypeAny>;

export interface OperationInfo {
  label: string;
  description: string;
  accepts: FileCategory[];
  /** Whether the resulting file is expected to be smaller (used for the "saved" messaging). */
  reducesSize: boolean;
}

export const OPERATIONS: Record<OperationName, OperationInfo> = {
  IMAGE_COMPRESS: {
    label: 'Compress image',
    description: 'Make the image file smaller.',
    accepts: ['image'],
    reducesSize: true,
  },
  IMAGE_RESIZE: {
    label: 'Resize image',
    description: 'Change the image dimensions.',
    accepts: ['image'],
    reducesSize: true,
  },
  IMAGE_CONVERT: {
    label: 'Convert image',
    description: 'Convert to JPG, PNG or WebP.',
    accepts: ['image'],
    reducesSize: false,
  },
  IMAGE_STRIP_METADATA: {
    label: 'Remove private metadata',
    description: 'Strip location, camera and other hidden data.',
    accepts: ['image'],
    reducesSize: false,
  },
  IMAGE_TO_PDF: {
    label: 'Image to PDF',
    description: 'Put this image into a PDF.',
    accepts: ['image'],
    reducesSize: false,
  },
  PDF_COMPRESS: {
    label: 'Compress PDF',
    description: 'Shrink images inside the PDF.',
    accepts: ['pdf'],
    reducesSize: true,
  },
  DOCX_COMPRESS: {
    label: 'Compress Word file',
    description: 'Shrink pictures inside the document.',
    accepts: ['document'],
    reducesSize: true,
  },
  VIDEO_COMPRESS: {
    label: 'Compress video',
    description: 'Make the video file smaller.',
    accepts: ['video'],
    reducesSize: true,
  },
  VIDEO_EXTRACT_AUDIO: {
    label: 'Extract audio',
    description: 'Save the sound as an MP3.',
    accepts: ['video'],
    reducesSize: false,
  },
};

export function isOperation(value: string): value is OperationName {
  return (OPERATION_NAMES as readonly string[]).includes(value);
}

export function suggestedOperations(category: string): OperationName[] {
  return OPERATION_NAMES.filter((op) => (OPERATIONS[op].accepts as string[]).includes(category));
}

/** Parse and normalise options for an operation (applies defaults). Throws ZodError. */
export function parseOptions(operation: OperationName, options: unknown): Record<string, unknown> {
  return OPTION_SCHEMAS[operation].parse(options ?? {}) as Record<string, unknown>;
}
