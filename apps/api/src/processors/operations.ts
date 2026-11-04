import { z } from 'zod';
import type { FileCategory } from '../security/fileTypes';

/**
 * Single source of truth for every tool: what it accepts, how many files, which options it takes
 * (zod = validation, `fields` = the form the UI renders) and how its result is named.
 * Adding a tool = one entry here + one processor method; the API, UI forms and docs follow.
 */

export const OPERATION_NAMES = [
  // PDF
  'PDF_COMPRESS',
  'PDF_MERGE',
  'PDF_SPLIT',
  'PDF_EXTRACT_PAGES',
  'PDF_REMOVE_PAGES',
  'PDF_REORDER_PAGES',
  'PDF_ROTATE',
  'PDF_CROP',
  'PDF_WATERMARK',
  'PDF_PAGE_NUMBERS',
  'PDF_PROTECT',
  'PDF_UNLOCK',
  'PDF_STRIP_METADATA',
  'PDF_TO_IMAGES',
  'PDF_TO_TEXT',
  'PDF_TO_WORD',
  // Word
  'DOCX_COMPRESS',
  'DOCX_STRIP_METADATA',
  'DOCX_TO_TEXT',
  'DOCX_EXTRACT_IMAGES',
  // Images
  'IMAGE_COMPRESS',
  'IMAGE_RESIZE',
  'IMAGE_CONVERT',
  'IMAGE_CROP',
  'IMAGE_ROTATE',
  'IMAGE_WATERMARK',
  'IMAGE_ADJUST',
  'IMAGE_STRIP_METADATA',
  'IMAGE_TO_PDF',
  // Video
  'VIDEO_COMPRESS',
  'VIDEO_EXTRACT_AUDIO',
] as const;
export type OperationName = (typeof OPERATION_NAMES)[number];

export const PRESETS = ['HIGH_QUALITY', 'BALANCED', 'SMALLEST'] as const;
export type Preset = (typeof PRESETS)[number];
const preset = z.enum(PRESETS).default('BALANCED');

export type ToolCategory = 'pdf' | 'word' | 'image' | 'video';
export type ToolGroup = 'optimize' | 'organize' | 'convert' | 'edit' | 'security' | 'privacy';

export interface FieldDef {
  key: string;
  type: 'select' | 'number' | 'text' | 'password' | 'checkbox' | 'pages';
  label: string;
  hint?: string;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  /** Select values are strings in the DOM; `number` makes the UI send them as numbers. */
  valueType?: 'number';
  min?: number;
  max?: number;
  unit?: string;
  placeholder?: string;
  maxLength?: number;
  required?: boolean;
  /** Only show (and send) this field when another field has this value. */
  showIf?: { key: string; equals: string | number | boolean };
}

export interface ToolDef {
  label: string;
  description: string;
  slug: string;
  category: ToolCategory;
  group: ToolGroup;
  /** Lucide icon name used by the UI. */
  icon: string;
  accepts: FileCategory[];
  minFiles: number;
  maxFiles: number;
  fields: FieldDef[];
  /** Option keys that hold passwords: kept in memory only, never stored, logged or shown. */
  secretFields: string[];
  /** Whether the resulting file is expected to be smaller (used for the "saved" messaging). */
  reducesSize: boolean;
  outputKind: 'file' | 'zip';
  /** Appended to the input's base name for the download name, e.g. "-merged". */
  outputSuffix: string;
}

// ---------------------------------------------------------------------------
// Option schemas (zod is the validation of record)

const PAGE_SPEC = /^[\d\s,-]+$/;
const pagesRequired = z
  .string()
  .trim()
  .min(1, 'Enter page numbers')
  .max(200)
  .regex(PAGE_SPEC, 'Use page numbers like 1-3, 5');
const pagesOptional = z.union([z.literal(''), pagesRequired]).optional();
const text = (max: number) => z.string().trim().min(1, 'Enter some text').max(max);

const angle = z.union([z.literal(90), z.literal(180), z.literal(270)]);
const noOptions = z.object({}).strict();

export const OPTION_SCHEMAS = {
  PDF_COMPRESS: z.object({ preset }).strict(),
  PDF_MERGE: noOptions,
  PDF_SPLIT: z
    .object({
      mode: z.enum(['ranges', 'every', 'each']).default('ranges'),
      ranges: pagesOptional,
      every: z.number().int().min(1).max(500).optional(),
    })
    .strict()
    .superRefine((o, ctx) => {
      if (o.mode === 'ranges' && !o.ranges)
        ctx.addIssue({ code: 'custom', path: ['ranges'], message: 'Enter the page ranges to split at' });
      if (o.mode === 'every' && !o.every)
        ctx.addIssue({ code: 'custom', path: ['every'], message: 'Enter how many pages per file' });
    }),
  PDF_EXTRACT_PAGES: z.object({ pages: pagesRequired }).strict(),
  PDF_REMOVE_PAGES: z.object({ pages: pagesRequired }).strict(),
  PDF_REORDER_PAGES: z.object({ order: pagesRequired }).strict(),
  PDF_ROTATE: z.object({ angle, pages: pagesOptional }).strict(),
  PDF_CROP: z
    .object({
      top: z.number().min(0).max(45).default(0),
      bottom: z.number().min(0).max(45).default(0),
      left: z.number().min(0).max(45).default(0),
      right: z.number().min(0).max(45).default(0),
    })
    .strict()
    .refine((o) => o.top + o.bottom < 90 && o.left + o.right < 90, { message: 'Crop margins are too large' })
    .refine((o) => o.top + o.bottom + o.left + o.right > 0, { message: 'Enter at least one margin to crop' }),
  PDF_WATERMARK: z
    .object({
      text: text(60),
      position: z.enum(['diagonal', 'center', 'top', 'bottom']).default('diagonal'),
      opacity: z.number().int().min(5).max(100).default(30),
      fontSize: z.number().int().min(10).max(200).default(60),
      color: z.enum(['gray', 'red', 'blue', 'black']).default('gray'),
      pages: pagesOptional,
    })
    .strict(),
  PDF_PAGE_NUMBERS: z
    .object({
      position: z
        .enum(['bottom-center', 'bottom-right', 'bottom-left', 'top-center', 'top-right', 'top-left'])
        .default('bottom-center'),
      format: z.enum(['n', 'page-n', 'n-of-total']).default('n'),
      start: z.number().int().min(1).max(9999).default(1),
      fontSize: z.number().int().min(8).max(28).default(11),
      skipFirst: z.boolean().default(false),
    })
    .strict(),
  PDF_PROTECT: z
    .object({
      password: z.string().min(4, 'Use at least 4 characters').max(64),
      allowPrinting: z.boolean().default(true),
      allowCopying: z.boolean().default(true),
    })
    .strict(),
  PDF_UNLOCK: z.object({ password: z.string().min(1, 'Enter the password').max(128) }).strict(),
  PDF_STRIP_METADATA: noOptions,
  PDF_TO_IMAGES: z
    .object({
      format: z.enum(['jpg', 'png']).default('jpg'),
      dpi: z.number().int().min(72).max(300).default(150),
      pages: pagesOptional,
    })
    .strict(),
  PDF_TO_TEXT: noOptions,
  PDF_TO_WORD: noOptions,
  DOCX_COMPRESS: z.object({ preset }).strict(),
  DOCX_STRIP_METADATA: noOptions,
  DOCX_TO_TEXT: noOptions,
  DOCX_EXTRACT_IMAGES: noOptions,
  IMAGE_COMPRESS: z.object({ preset, targetKb: z.number().int().min(10).max(50_000).optional() }).strict(),
  IMAGE_RESIZE: z
    .object({
      mode: z.enum(['pixels', 'percent']).default('pixels'),
      width: z.number().int().min(1).max(20000).optional(),
      height: z.number().int().min(1).max(20000).optional(),
      percent: z.number().int().min(1).max(400).optional(),
      allowUpscale: z.boolean().default(false),
    })
    .strict()
    .superRefine((o, ctx) => {
      if (o.mode === 'percent') {
        if (!o.percent) ctx.addIssue({ code: 'custom', path: ['percent'], message: 'Enter a percentage' });
      } else if (o.width === undefined && o.height === undefined) {
        ctx.addIssue({ code: 'custom', path: ['width'], message: 'Provide a width, a height, or both' });
      }
    }),
  IMAGE_CONVERT: z.object({ format: z.enum(['jpeg', 'png', 'webp', 'avif', 'tiff', 'gif']), preset }).strict(),
  IMAGE_CROP: z
    .object({
      mode: z.enum(['aspect', 'trim']).default('aspect'),
      aspect: z.enum(['1:1', '4:3', '3:2', '16:9', '9:16', '3:4', '2:3']).default('1:1'),
      focus: z.enum(['center', 'top', 'bottom', 'left', 'right']).default('center'),
      top: z.number().min(0).max(90).default(0),
      bottom: z.number().min(0).max(90).default(0),
      left: z.number().min(0).max(90).default(0),
      right: z.number().min(0).max(90).default(0),
    })
    .strict()
    .superRefine((o, ctx) => {
      if (o.mode !== 'trim') return;
      if (o.top + o.bottom >= 95 || o.left + o.right >= 95)
        ctx.addIssue({ code: 'custom', path: ['top'], message: 'Crop margins are too large' });
      if (o.top + o.bottom + o.left + o.right <= 0)
        ctx.addIssue({ code: 'custom', path: ['top'], message: 'Enter at least one margin to crop' });
    }),
  IMAGE_ROTATE: z
    .object({
      angle: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(90),
      flipHorizontal: z.boolean().default(false),
      flipVertical: z.boolean().default(false),
    })
    .strict()
    .refine((o) => o.angle !== 0 || o.flipHorizontal || o.flipVertical, { message: 'Choose a rotation or a flip' }),
  IMAGE_WATERMARK: z
    .object({
      text: text(60),
      position: z
        .enum(['center', 'bottom-right', 'bottom-left', 'top-right', 'top-left', 'tile'])
        .default('bottom-right'),
      opacity: z.number().int().min(5).max(100).default(50),
      sizePercent: z.number().int().min(2).max(40).default(6),
      color: z.enum(['white', 'black', 'red', 'blue']).default('white'),
    })
    .strict(),
  IMAGE_ADJUST: z
    .object({
      grayscale: z.boolean().default(false),
      brightness: z.number().int().min(-50).max(50).default(0),
      contrast: z.number().int().min(-50).max(50).default(0),
      saturation: z.number().int().min(-100).max(100).default(0),
      blur: z.number().min(0).max(20).default(0),
      sharpen: z.boolean().default(false),
    })
    .strict()
    .refine(
      (o) => o.grayscale || o.sharpen || o.brightness !== 0 || o.contrast !== 0 || o.saturation !== 0 || o.blur > 0,
      {
        message: 'Change at least one setting',
      },
    ),
  IMAGE_STRIP_METADATA: noOptions,
  IMAGE_TO_PDF: z
    .object({
      pageSize: z.enum(['fit', 'a4', 'letter']).default('a4'),
      orientation: z.enum(['auto', 'portrait', 'landscape']).default('auto'),
      margin: z.number().int().min(0).max(40).default(8),
    })
    .strict(),
  VIDEO_COMPRESS: z.object({ preset }).strict(),
  VIDEO_EXTRACT_AUDIO: noOptions,
} satisfies Record<OperationName, z.ZodTypeAny>;

// ---------------------------------------------------------------------------
// Catalog

const PRESET_FIELD: FieldDef = {
  key: 'preset',
  type: 'select',
  label: 'Quality',
  default: 'BALANCED',
  options: [
    { value: 'HIGH_QUALITY', label: 'High quality (bigger file)' },
    { value: 'BALANCED', label: 'Recommended' },
    { value: 'SMALLEST', label: 'Smallest file' },
  ],
};
const PAGES_ROTATE_HINT = 'Leave empty for every page';
const color = (values: Array<[string, string]>): FieldDef => ({
  key: 'color',
  type: 'select',
  label: 'Colour',
  default: values[0]![0],
  options: values.map(([value, label]) => ({ value, label })),
});

type ToolInit = Omit<
  ToolDef,
  'secretFields' | 'outputKind' | 'outputSuffix' | 'reducesSize' | 'minFiles' | 'maxFiles' | 'fields'
> &
  Partial<
    Pick<ToolDef, 'secretFields' | 'outputKind' | 'outputSuffix' | 'reducesSize' | 'minFiles' | 'maxFiles' | 'fields'>
  >;

function tool(init: ToolInit): ToolDef {
  return {
    secretFields: [],
    outputKind: 'file',
    outputSuffix: '-tero',
    reducesSize: false,
    minFiles: 1,
    maxFiles: 1,
    fields: [],
    ...init,
  };
}

export const OPERATIONS: Record<OperationName, ToolDef> = {
  // ---- PDF -----------------------------------------------------------------
  PDF_COMPRESS: tool({
    label: 'Compress PDF',
    slug: 'compress-pdf',
    description: 'Reduce the file size of scans and photo-heavy PDFs.',
    category: 'pdf',
    group: 'optimize',
    icon: 'Minimize2',
    accepts: ['pdf'],
    reducesSize: true,
    fields: [PRESET_FIELD],
  }),
  PDF_MERGE: tool({
    label: 'Merge PDF',
    slug: 'merge-pdf',
    description: 'Combine several PDFs into one, in the order you choose.',
    category: 'pdf',
    group: 'organize',
    icon: 'Combine',
    accepts: ['pdf'],
    minFiles: 2,
    maxFiles: 20,
    outputSuffix: '-merged',
  }),
  PDF_SPLIT: tool({
    label: 'Split PDF',
    slug: 'split-pdf',
    description: 'Cut a PDF into several files (downloaded as a ZIP).',
    category: 'pdf',
    group: 'organize',
    icon: 'Scissors',
    accepts: ['pdf'],
    outputKind: 'zip',
    outputSuffix: '-split',
    fields: [
      {
        key: 'mode',
        type: 'select',
        label: 'Split by',
        default: 'ranges',
        options: [
          { value: 'ranges', label: 'Page ranges' },
          { value: 'every', label: 'Every N pages' },
          { value: 'each', label: 'Every page' },
        ],
      },
      {
        key: 'ranges',
        type: 'pages',
        label: 'Split into these ranges',
        hint: 'Each comma-separated range becomes its own file, e.g. 1-3, 4-6, 7',
        showIf: { key: 'mode', equals: 'ranges' },
      },
      {
        key: 'every',
        type: 'number',
        label: 'Pages per file',
        min: 1,
        max: 500,
        default: 1,
        showIf: { key: 'mode', equals: 'every' },
      },
    ],
  }),
  PDF_EXTRACT_PAGES: tool({
    label: 'Extract pages',
    slug: 'extract-pdf-pages',
    description: 'Keep only the pages you pick.',
    category: 'pdf',
    group: 'organize',
    icon: 'FileOutput',
    accepts: ['pdf'],
    outputSuffix: '-extracted',
    fields: [{ key: 'pages', type: 'pages', label: 'Pages to keep', hint: 'e.g. 1-3, 5, 8', required: true }],
  }),
  PDF_REMOVE_PAGES: tool({
    label: 'Remove pages',
    slug: 'remove-pdf-pages',
    description: 'Delete the pages you do not need.',
    category: 'pdf',
    group: 'organize',
    icon: 'Trash2',
    accepts: ['pdf'],
    outputSuffix: '-trimmed',
    reducesSize: true,
    fields: [{ key: 'pages', type: 'pages', label: 'Pages to remove', hint: 'e.g. 2, 4-6', required: true }],
  }),
  PDF_REORDER_PAGES: tool({
    label: 'Reorder pages',
    slug: 'reorder-pdf-pages',
    description: 'Put the pages in a new order.',
    category: 'pdf',
    group: 'organize',
    icon: 'ArrowDownUp',
    accepts: ['pdf'],
    outputSuffix: '-reordered',
    fields: [
      {
        key: 'order',
        type: 'pages',
        label: 'New page order',
        hint: 'List every page once, e.g. 3, 1, 2, 4-6',
        required: true,
      },
    ],
  }),
  PDF_ROTATE: tool({
    label: 'Rotate PDF',
    slug: 'rotate-pdf',
    description: 'Turn pages clockwise by 90, 180 or 270 degrees.',
    category: 'pdf',
    group: 'edit',
    icon: 'RotateCw',
    accepts: ['pdf'],
    outputSuffix: '-rotated',
    fields: [
      {
        key: 'angle',
        type: 'select',
        valueType: 'number',
        label: 'Rotate clockwise',
        default: '90',
        options: [
          { value: '90', label: '90°' },
          { value: '180', label: '180°' },
          { value: '270', label: '270° (90° anticlockwise)' },
        ],
      },
      { key: 'pages', type: 'pages', label: 'Pages', hint: PAGES_ROTATE_HINT },
    ],
  }),
  PDF_CROP: tool({
    label: 'Crop PDF',
    slug: 'crop-pdf',
    description: 'Trim margins from every page.',
    category: 'pdf',
    group: 'edit',
    icon: 'Crop',
    accepts: ['pdf'],
    outputSuffix: '-cropped',
    fields: (['top', 'bottom', 'left', 'right'] as const).map((key) => ({
      key,
      type: 'number' as const,
      label: `Trim ${key}`,
      min: 0,
      max: 45,
      default: 0,
      unit: '%',
    })),
  }),
  PDF_WATERMARK: tool({
    label: 'Add watermark',
    slug: 'watermark-pdf',
    description: 'Stamp text across your pages.',
    category: 'pdf',
    group: 'edit',
    icon: 'Stamp',
    accepts: ['pdf'],
    outputSuffix: '-watermarked',
    fields: [
      {
        key: 'text',
        type: 'text',
        label: 'Watermark text',
        placeholder: 'CONFIDENTIAL',
        maxLength: 60,
        required: true,
      },
      {
        key: 'position',
        type: 'select',
        label: 'Position',
        default: 'diagonal',
        options: [
          { value: 'diagonal', label: 'Diagonal across the page' },
          { value: 'center', label: 'Centre' },
          { value: 'top', label: 'Top' },
          { value: 'bottom', label: 'Bottom' },
        ],
      },
      { key: 'fontSize', type: 'number', label: 'Size', min: 10, max: 200, default: 60, unit: 'pt' },
      { key: 'opacity', type: 'number', label: 'Strength', min: 5, max: 100, default: 30, unit: '%' },
      color([
        ['gray', 'Grey'],
        ['red', 'Red'],
        ['blue', 'Blue'],
        ['black', 'Black'],
      ]),
      { key: 'pages', type: 'pages', label: 'Pages', hint: 'Leave empty for every page' },
    ],
  }),
  PDF_PAGE_NUMBERS: tool({
    label: 'Add page numbers',
    slug: 'page-numbers-pdf',
    description: 'Number the pages of your PDF.',
    category: 'pdf',
    group: 'edit',
    icon: 'Hash',
    accepts: ['pdf'],
    outputSuffix: '-numbered',
    fields: [
      {
        key: 'position',
        type: 'select',
        label: 'Position',
        default: 'bottom-center',
        options: [
          { value: 'bottom-center', label: 'Bottom centre' },
          { value: 'bottom-right', label: 'Bottom right' },
          { value: 'bottom-left', label: 'Bottom left' },
          { value: 'top-center', label: 'Top centre' },
          { value: 'top-right', label: 'Top right' },
          { value: 'top-left', label: 'Top left' },
        ],
      },
      {
        key: 'format',
        type: 'select',
        label: 'Style',
        default: 'n',
        options: [
          { value: 'n', label: '1, 2, 3' },
          { value: 'page-n', label: 'Page 1, Page 2' },
          { value: 'n-of-total', label: '1 of 10, 2 of 10' },
        ],
      },
      { key: 'start', type: 'number', label: 'Start at', min: 1, max: 9999, default: 1 },
      { key: 'fontSize', type: 'number', label: 'Size', min: 8, max: 28, default: 11, unit: 'pt' },
      { key: 'skipFirst', type: 'checkbox', label: 'Do not number the first page', default: false },
    ],
  }),
  PDF_PROTECT: tool({
    label: 'Protect PDF',
    slug: 'protect-pdf',
    description: 'Lock your PDF with a password (AES-256).',
    category: 'pdf',
    group: 'security',
    icon: 'Lock',
    accepts: ['pdf'],
    outputSuffix: '-protected',
    secretFields: ['password'],
    fields: [
      {
        key: 'password',
        type: 'password',
        label: 'Password',
        hint: 'Anyone opening the PDF will need it. We never store it.',
        maxLength: 64,
        required: true,
      },
      { key: 'allowPrinting', type: 'checkbox', label: 'Allow printing', default: true },
      { key: 'allowCopying', type: 'checkbox', label: 'Allow copying text', default: true },
    ],
  }),
  PDF_UNLOCK: tool({
    label: 'Unlock PDF',
    slug: 'unlock-pdf',
    description: 'Remove the password from a PDF you own.',
    category: 'pdf',
    group: 'security',
    icon: 'LockOpen',
    accepts: ['pdf'],
    outputSuffix: '-unlocked',
    secretFields: ['password'],
    fields: [
      {
        key: 'password',
        type: 'password',
        label: 'Current password',
        hint: 'Needed to open the file. We never store it.',
        maxLength: 128,
        required: true,
      },
    ],
  }),
  PDF_STRIP_METADATA: tool({
    label: 'Remove PDF metadata',
    slug: 'clean-pdf-metadata',
    description: 'Erase author, title, software and other hidden details.',
    category: 'pdf',
    group: 'privacy',
    icon: 'EyeOff',
    accepts: ['pdf'],
    outputSuffix: '-clean',
  }),
  PDF_TO_IMAGES: tool({
    label: 'PDF to images',
    slug: 'pdf-to-jpg',
    description: 'Turn each page into a JPG or PNG (downloaded as a ZIP).',
    category: 'pdf',
    group: 'convert',
    icon: 'Images',
    accepts: ['pdf'],
    outputKind: 'zip',
    outputSuffix: '-pages',
    fields: [
      {
        key: 'format',
        type: 'select',
        label: 'Format',
        default: 'jpg',
        options: [
          { value: 'jpg', label: 'JPG (smaller)' },
          { value: 'png', label: 'PNG (sharper text)' },
        ],
      },
      {
        key: 'dpi',
        type: 'select',
        valueType: 'number',
        label: 'Quality',
        default: '150',
        options: [
          { value: '96', label: 'Screen (96 dpi)' },
          { value: '150', label: 'Good (150 dpi)' },
          { value: '300', label: 'Print (300 dpi)' },
        ],
      },
      { key: 'pages', type: 'pages', label: 'Pages', hint: 'Leave empty for every page' },
    ],
  }),
  PDF_TO_TEXT: tool({
    label: 'PDF to text',
    slug: 'pdf-to-text',
    description: 'Copy all the text out of a PDF into a .txt file.',
    category: 'pdf',
    group: 'convert',
    icon: 'FileText',
    accepts: ['pdf'],
    outputSuffix: '',
  }),
  PDF_TO_WORD: tool({
    label: 'PDF to Word',
    slug: 'pdf-to-word',
    description: 'Get the text of a PDF as an editable Word file (layout and pictures are not kept).',
    category: 'pdf',
    group: 'convert',
    icon: 'FileType2',
    accepts: ['pdf'],
    outputSuffix: '',
  }),
  // ---- Word ----------------------------------------------------------------
  DOCX_COMPRESS: tool({
    label: 'Compress Word file',
    slug: 'compress-word',
    description: 'Shrink the pictures inside a Word document.',
    category: 'word',
    group: 'optimize',
    icon: 'Minimize2',
    accepts: ['document'],
    reducesSize: true,
    fields: [PRESET_FIELD],
  }),
  DOCX_STRIP_METADATA: tool({
    label: 'Remove Word metadata',
    slug: 'clean-word-metadata',
    description: 'Erase author, company, comments and tracked changes before sharing.',
    category: 'word',
    group: 'privacy',
    icon: 'EyeOff',
    accepts: ['document'],
    outputSuffix: '-clean',
  }),
  DOCX_TO_TEXT: tool({
    label: 'Word to text',
    slug: 'word-to-text',
    description: 'Get the plain text of a Word document.',
    category: 'word',
    group: 'convert',
    icon: 'FileText',
    accepts: ['document'],
    outputSuffix: '',
  }),
  DOCX_EXTRACT_IMAGES: tool({
    label: 'Extract Word images',
    slug: 'extract-word-images',
    description: 'Save every picture from a Word document (downloaded as a ZIP).',
    category: 'word',
    group: 'convert',
    icon: 'Images',
    accepts: ['document'],
    outputKind: 'zip',
    outputSuffix: '-images',
  }),
  // ---- Images --------------------------------------------------------------
  IMAGE_COMPRESS: tool({
    label: 'Compress image',
    slug: 'compress-image',
    description: 'Make photos smaller, or hit a target size in KB.',
    category: 'image',
    group: 'optimize',
    icon: 'Minimize2',
    accepts: ['image'],
    reducesSize: true,
    fields: [
      PRESET_FIELD,
      {
        key: 'targetKb',
        type: 'number',
        label: 'Target size (optional)',
        hint: 'We will get as close as possible without going over',
        min: 10,
        max: 50000,
        unit: 'KB',
      },
    ],
  }),
  IMAGE_RESIZE: tool({
    label: 'Resize image',
    slug: 'resize-image',
    description: 'Change the width and height, or scale by a percentage.',
    category: 'image',
    group: 'edit',
    icon: 'Scaling',
    accepts: ['image'],
    reducesSize: true,
    outputSuffix: '-resized',
    fields: [
      {
        key: 'mode',
        type: 'select',
        label: 'Resize by',
        default: 'pixels',
        options: [
          { value: 'pixels', label: 'Pixels' },
          { value: 'percent', label: 'Percentage' },
        ],
      },
      {
        key: 'width',
        type: 'number',
        label: 'Width',
        min: 1,
        max: 20000,
        unit: 'px',
        showIf: { key: 'mode', equals: 'pixels' },
      },
      {
        key: 'height',
        type: 'number',
        label: 'Height',
        hint: 'Leave one empty to keep the shape',
        min: 1,
        max: 20000,
        unit: 'px',
        showIf: { key: 'mode', equals: 'pixels' },
      },
      {
        key: 'percent',
        type: 'number',
        label: 'Scale',
        min: 1,
        max: 400,
        default: 50,
        unit: '%',
        showIf: { key: 'mode', equals: 'percent' },
      },
      { key: 'allowUpscale', type: 'checkbox', label: 'Allow making the image bigger', default: false },
    ],
  }),
  IMAGE_CONVERT: tool({
    label: 'Convert image',
    slug: 'convert-image',
    description: 'Change between JPG, PNG, WebP, AVIF, TIFF and GIF.',
    category: 'image',
    group: 'convert',
    icon: 'Repeat',
    accepts: ['image'],
    outputSuffix: '',
    fields: [
      {
        key: 'format',
        type: 'select',
        label: 'Convert to',
        default: 'jpeg',
        options: [
          { value: 'jpeg', label: 'JPG (works everywhere)' },
          { value: 'png', label: 'PNG (keeps transparency)' },
          { value: 'webp', label: 'WebP (small)' },
          { value: 'avif', label: 'AVIF (smallest)' },
          { value: 'tiff', label: 'TIFF (print / archive)' },
          { value: 'gif', label: 'GIF' },
        ],
      },
      PRESET_FIELD,
    ],
  }),
  IMAGE_CROP: tool({
    label: 'Crop image',
    slug: 'crop-image',
    description: 'Crop to a shape like 1:1 or 16:9, or trim the edges.',
    category: 'image',
    group: 'edit',
    icon: 'Crop',
    accepts: ['image'],
    outputSuffix: '-cropped',
    fields: [
      {
        key: 'mode',
        type: 'select',
        label: 'Crop by',
        default: 'aspect',
        options: [
          { value: 'aspect', label: 'Shape (aspect ratio)' },
          { value: 'trim', label: 'Trim the edges' },
        ],
      },
      {
        key: 'aspect',
        type: 'select',
        label: 'Shape',
        default: '1:1',
        options: ['1:1', '4:3', '3:2', '16:9', '9:16', '3:4', '2:3'].map((v) => ({ value: v, label: v })),
        showIf: { key: 'mode', equals: 'aspect' },
      },
      {
        key: 'focus',
        type: 'select',
        label: 'Keep',
        default: 'center',
        options: [
          { value: 'center', label: 'The centre' },
          { value: 'top', label: 'The top' },
          { value: 'bottom', label: 'The bottom' },
          { value: 'left', label: 'The left' },
          { value: 'right', label: 'The right' },
        ],
        showIf: { key: 'mode', equals: 'aspect' },
      },
      ...(['top', 'bottom', 'left', 'right'] as const).map((key) => ({
        key,
        type: 'number' as const,
        label: `Trim ${key}`,
        min: 0,
        max: 90,
        default: 0,
        unit: '%',
        showIf: { key: 'mode', equals: 'trim' },
      })),
    ],
  }),
  IMAGE_ROTATE: tool({
    label: 'Rotate or flip image',
    slug: 'rotate-image',
    description: 'Turn a photo the right way up, or mirror it.',
    category: 'image',
    group: 'edit',
    icon: 'RotateCw',
    accepts: ['image'],
    outputSuffix: '-rotated',
    fields: [
      {
        key: 'angle',
        type: 'select',
        valueType: 'number',
        label: 'Rotate clockwise',
        default: '90',
        options: [
          { value: '0', label: 'Do not rotate' },
          { value: '90', label: '90°' },
          { value: '180', label: '180°' },
          { value: '270', label: '270° (90° anticlockwise)' },
        ],
      },
      { key: 'flipHorizontal', type: 'checkbox', label: 'Mirror left-right', default: false },
      { key: 'flipVertical', type: 'checkbox', label: 'Mirror top-bottom', default: false },
    ],
  }),
  IMAGE_WATERMARK: tool({
    label: 'Add watermark',
    slug: 'watermark-image',
    description: 'Put your name or a note on a photo.',
    category: 'image',
    group: 'edit',
    icon: 'Stamp',
    accepts: ['image'],
    outputSuffix: '-watermarked',
    fields: [
      {
        key: 'text',
        type: 'text',
        label: 'Watermark text',
        placeholder: '© Our family',
        maxLength: 60,
        required: true,
      },
      {
        key: 'position',
        type: 'select',
        label: 'Position',
        default: 'bottom-right',
        options: [
          { value: 'bottom-right', label: 'Bottom right' },
          { value: 'bottom-left', label: 'Bottom left' },
          { value: 'top-right', label: 'Top right' },
          { value: 'top-left', label: 'Top left' },
          { value: 'center', label: 'Centre' },
          { value: 'tile', label: 'Repeated across the photo' },
        ],
      },
      { key: 'sizePercent', type: 'number', label: 'Size', min: 2, max: 40, default: 6, unit: '% of width' },
      { key: 'opacity', type: 'number', label: 'Strength', min: 5, max: 100, default: 50, unit: '%' },
      color([
        ['white', 'White'],
        ['black', 'Black'],
        ['red', 'Red'],
        ['blue', 'Blue'],
      ]),
    ],
  }),
  IMAGE_ADJUST: tool({
    label: 'Adjust image',
    slug: 'adjust-image',
    description: 'Black & white, brightness, contrast, colour, blur and sharpen.',
    category: 'image',
    group: 'edit',
    icon: 'SlidersHorizontal',
    accepts: ['image'],
    outputSuffix: '-adjusted',
    fields: [
      { key: 'grayscale', type: 'checkbox', label: 'Black and white', default: false },
      { key: 'brightness', type: 'number', label: 'Brightness', min: -50, max: 50, default: 0 },
      { key: 'contrast', type: 'number', label: 'Contrast', min: -50, max: 50, default: 0 },
      { key: 'saturation', type: 'number', label: 'Colour strength', min: -100, max: 50, default: 0 },
      { key: 'blur', type: 'number', label: 'Blur', min: 0, max: 20, default: 0 },
      { key: 'sharpen', type: 'checkbox', label: 'Sharpen', default: false },
    ],
  }),
  IMAGE_STRIP_METADATA: tool({
    label: 'Remove photo metadata',
    slug: 'clean-image-metadata',
    description: 'Erase location, camera and other hidden data.',
    category: 'image',
    group: 'privacy',
    icon: 'EyeOff',
    accepts: ['image'],
    outputSuffix: '-clean',
  }),
  IMAGE_TO_PDF: tool({
    label: 'Images to PDF',
    slug: 'images-to-pdf',
    description: 'Put one or many photos into a single PDF.',
    category: 'image',
    group: 'convert',
    icon: 'FileImage',
    accepts: ['image'],
    minFiles: 1,
    maxFiles: 30,
    outputSuffix: '',
    fields: [
      {
        key: 'pageSize',
        type: 'select',
        label: 'Page size',
        default: 'a4',
        options: [
          { value: 'a4', label: 'A4' },
          { value: 'letter', label: 'US Letter' },
          { value: 'fit', label: 'Same size as the image' },
        ],
      },
      {
        key: 'orientation',
        type: 'select',
        label: 'Orientation',
        default: 'auto',
        options: [
          { value: 'auto', label: 'Automatic' },
          { value: 'portrait', label: 'Portrait' },
          { value: 'landscape', label: 'Landscape' },
        ],
        showIf: { key: 'pageSize', equals: 'a4' },
      },
      { key: 'margin', type: 'number', label: 'Margin', min: 0, max: 40, default: 8, unit: 'mm' },
    ],
  }),
  // ---- Video ---------------------------------------------------------------
  VIDEO_COMPRESS: tool({
    label: 'Compress video',
    slug: 'compress-video',
    description: 'Make videos much smaller.',
    category: 'video',
    group: 'optimize',
    icon: 'Film',
    accepts: ['video'],
    reducesSize: true,
    fields: [PRESET_FIELD],
  }),
  VIDEO_EXTRACT_AUDIO: tool({
    label: 'Extract audio',
    slug: 'video-to-mp3',
    description: 'Save the sound of a video as an MP3.',
    category: 'video',
    group: 'convert',
    icon: 'Music',
    accepts: ['video'],
    outputSuffix: '',
  }),
};

// ---------------------------------------------------------------------------

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

/**
 * Separate password fields from the rest. The public part is what gets stored and shown
 * (secrets replaced by a marker); the secret part lives in memory for the duration of the job only.
 */
export function splitSecrets(
  operation: OperationName,
  options: Record<string, unknown>,
): { publicOptions: Record<string, unknown>; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {};
  const publicOptions: Record<string, unknown> = { ...options };
  for (const key of OPERATIONS[operation].secretFields) {
    if (typeof options[key] === 'string') {
      secrets[key] = options[key] as string;
      publicOptions[key] = '[hidden]';
    }
  }
  return { publicOptions, secrets };
}
