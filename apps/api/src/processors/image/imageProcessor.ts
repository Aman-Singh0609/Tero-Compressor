import fs from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import sharp, { type Metadata, type Sharp } from 'sharp';
import type { OperationName, Preset } from '../operations';
import { ProcessorError, type Processor, type ProcessorInput, type ProcessorResult } from '../types';

// libvips keeps files open in its cache, which blocks renaming/deleting outputs on Windows.
sharp.cache(false);

const QUALITY: Record<Preset, number> = { HIGH_QUALITY: 90, BALANCED: 78, SMALLEST: 60 };
const MAX_DIMENSION: Record<Preset, number | null> = { HIGH_QUALITY: null, BALANCED: 4096, SMALLEST: 2048 };

type Format = 'jpeg' | 'png' | 'webp';

export function formatFromExt(ext: string): Format {
  if (ext === 'png') return 'png';
  if (ext === 'webp') return 'webp';
  return 'jpeg';
}

function extFor(format: Format): string {
  return format === 'jpeg' ? 'jpg' : format;
}

const MIME: Record<Format, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function encode(pipeline: Sharp, format: Format, preset: Preset): Sharp {
  const quality = QUALITY[preset];
  switch (format) {
    case 'jpeg':
      return pipeline.jpeg({ quality, mozjpeg: true });
    case 'webp':
      return pipeline.webp({ quality });
    case 'png':
      // PNG is lossless unless palette quantisation is requested; only SMALLEST accepts that trade-off.
      return pipeline.png({ compressionLevel: 9, effort: 8, palette: preset === 'SMALLEST', quality });
  }
}

export class ImageProcessor implements Processor {
  readonly operations: readonly OperationName[] = [
    'IMAGE_COMPRESS',
    'IMAGE_RESIZE',
    'IMAGE_CONVERT',
    'IMAGE_STRIP_METADATA',
    'IMAGE_TO_PDF',
  ];

  async validate(input: Parameters<Processor['validate']>[0]): Promise<void> {
    let meta: Metadata;
    try {
      meta = await sharp(input.inputPath, { limitInputPixels: 268_435_456, pages: -1 }).metadata();
      if (!meta.width || !meta.height) throw new Error('no dimensions');
    } catch (err) {
      throw new ProcessorError('This image could not be read. It may be damaged.', 'INVALID_FILE', { cause: err });
    }
    // Processing would silently keep only the first frame of an animated WebP.
    if ((meta.pages ?? 1) > 1) {
      throw new ProcessorError('Animated images are not supported yet.', 'PROCESSING_FAILED');
    }
  }

  outputExtensionFor(operation: OperationName, options: Record<string, unknown>, inputExt: string): string {
    if (operation === 'IMAGE_TO_PDF') return 'pdf';
    if (operation === 'IMAGE_CONVERT') return extFor(options.format as Format);
    return extFor(formatFromExt(inputExt));
  }

  async process(input: ProcessorInput): Promise<ProcessorResult> {
    input.reportProgress(5);
    try {
      const result = input.operation === 'IMAGE_TO_PDF' ? await this.toPdf(input) : await this.transform(input);
      input.reportProgress(95);
      return result;
    } catch (err) {
      if (err instanceof ProcessorError) throw err;
      throw new ProcessorError('The image could not be processed.', 'PROCESSING_FAILED', { cause: err });
    }
  }

  private async transform(input: ProcessorInput): Promise<ProcessorResult> {
    const sourceFormat = formatFromExt(input.inputExt);
    const preset = (input.options.preset as Preset | undefined) ?? 'BALANCED';
    // rotate() bakes EXIF orientation into pixels so removing metadata never turns the picture sideways.
    let pipeline = sharp(input.inputPath, { limitInputPixels: 268_435_456 }).rotate();
    let format = sourceFormat;
    let encodePreset: Preset = preset;
    const info: Record<string, unknown> = {};
    const inputMeta = await sharp(input.inputPath).metadata();
    info.inputWidth = inputMeta.width;
    info.inputHeight = inputMeta.height;

    switch (input.operation) {
      case 'IMAGE_COMPRESS': {
        const cap = MAX_DIMENSION[preset];
        if (cap) pipeline = pipeline.resize({ width: cap, height: cap, fit: 'inside', withoutEnlargement: true });
        break;
      }
      case 'IMAGE_RESIZE': {
        const { width, height, allowUpscale } = input.options as {
          width?: number;
          height?: number;
          allowUpscale: boolean;
        };
        pipeline = pipeline.resize({ width, height, fit: 'inside', withoutEnlargement: !allowUpscale });
        encodePreset = 'HIGH_QUALITY';
        break;
      }
      case 'IMAGE_CONVERT':
        format = input.options.format as Format;
        break;
      case 'IMAGE_STRIP_METADATA':
        encodePreset = 'HIGH_QUALITY';
        break;
      default:
        throw new ProcessorError('Unsupported image operation.');
    }

    if (format === 'jpeg' && inputMeta.hasAlpha) {
      pipeline = pipeline.flatten({ background: '#ffffff' });
      info.flattenedTransparency = true;
    }
    await encode(pipeline, format, encodePreset).toFile(input.outputPath);
    const outMeta = await sharp(input.outputPath).metadata();
    info.outputWidth = outMeta.width;
    info.outputHeight = outMeta.height;

    // Honest compression: never hand back something bigger than what was uploaded.
    if (input.operation === 'IMAGE_COMPRESS') {
      const outSize = (await fs.stat(input.outputPath)).size;
      if (outSize >= input.inputSizeBytes) {
        await fs.copyFile(input.inputPath, input.outputPath);
        info.keptOriginal = true;
        info.note = 'This image was already well optimised, so it was returned unchanged.';
      }
    }
    return { outputMime: MIME[format], outputExt: extFor(format), info };
  }

  private async toPdf(input: ProcessorInput): Promise<ProcessorResult> {
    const format = formatFromExt(input.inputExt);
    let bytes: Buffer;
    let embedAs: 'jpg' | 'png';
    if (format === 'jpeg') {
      bytes = await fs.readFile(input.inputPath);
      embedAs = 'jpg';
    } else {
      bytes = await sharp(input.inputPath).rotate().png().toBuffer();
      embedAs = 'png';
    }
    const pdf = await PDFDocument.create();
    const image = embedAs === 'jpg' ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
    // Fit onto A4 portrait/landscape with a margin, without enlarging small images.
    const landscape = image.width > image.height;
    const [pw, ph] = landscape ? [841.89, 595.28] : [595.28, 841.89];
    const margin = 24;
    const scale = Math.min((pw - margin * 2) / image.width, (ph - margin * 2) / image.height, 1);
    const w = image.width * scale;
    const h = image.height * scale;
    const page = pdf.addPage([pw, ph]);
    page.drawImage(image, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    await fs.writeFile(input.outputPath, await pdf.save());
    return { outputMime: 'application/pdf', outputExt: 'pdf', info: {} };
  }

  async cleanup(input: Pick<ProcessorInput, 'outputPath'>): Promise<void> {
    await fs.rm(input.outputPath, { force: true });
  }
}
