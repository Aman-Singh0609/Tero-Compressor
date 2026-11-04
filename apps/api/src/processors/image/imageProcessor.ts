import fs from 'node:fs/promises';
import { PDFDocument, type PDFImage } from 'pdf-lib';
import sharp, { type Metadata, type Sharp } from 'sharp';
import { getEnv } from '../../config/env';
import type { OperationName, Preset } from '../operations';
import {
  ProcessorError,
  type Processor,
  type ProcessorInput,
  type ProcessorResult,
  type ValidateInput,
} from '../types';
import { buildWatermarkSvg } from './watermarkSvg';

// libvips keeps files open in its cache, which blocks renaming/deleting outputs on Windows.
sharp.cache(false);

const QUALITY: Record<Preset, number> = { HIGH_QUALITY: 90, BALANCED: 78, SMALLEST: 60 };
const MAX_DIMENSION: Record<Preset, number | null> = { HIGH_QUALITY: null, BALANCED: 4096, SMALLEST: 2048 };

export type Format = 'jpeg' | 'png' | 'webp' | 'avif' | 'tiff' | 'gif';

const FROM_EXT: Record<string, Format> = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  tif: 'tiff',
  tiff: 'tiff',
  gif: 'gif',
};
const TO_EXT: Record<Format, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  tiff: 'tiff',
  gif: 'gif',
};
const MIME: Record<Format, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  tiff: 'image/tiff',
  gif: 'image/gif',
};
const LOSSY: ReadonlySet<Format> = new Set(['jpeg', 'webp', 'avif', 'png']); // png = palette quantisation

export function formatFromExt(ext: string): Format {
  return FROM_EXT[ext] ?? 'jpeg';
}

function open(path: string): Sharp {
  return sharp(path, { limitInputPixels: getEnv().MAX_IMAGE_PIXELS });
}

function encodeQ(pipeline: Sharp, format: Format, quality: number, palette = false): Sharp {
  switch (format) {
    case 'jpeg':
      return pipeline.jpeg({ quality, mozjpeg: true });
    case 'webp':
      return pipeline.webp({ quality });
    case 'avif':
      return pipeline.avif({ quality, effort: 4 });
    case 'tiff':
      return pipeline.tiff({ compression: 'lzw' });
    case 'gif':
      return pipeline.gif({ effort: 7 });
    case 'png':
      // PNG is lossless unless palette quantisation is requested
      return pipeline.png({ compressionLevel: 9, effort: 8, palette, quality });
  }
}

function encode(pipeline: Sharp, format: Format, preset: Preset): Sharp {
  return encodeQ(pipeline, format, QUALITY[preset], preset === 'SMALLEST');
}

/** Pixel dimensions as a viewer shows them: EXIF orientations 5–8 swap width and height. */
function orientedSize(meta: Metadata): { width: number; height: number } {
  const swap = (meta.orientation ?? 1) >= 5;
  return { width: (swap ? meta.height : meta.width) ?? 0, height: (swap ? meta.width : meta.height) ?? 0 };
}

const A4 = [595.28, 841.89] as const;
const LETTER = [612, 792] as const;
const MM = 72 / 25.4;
const PX_TO_PT = 0.75; // 96 dpi

export class ImageProcessor implements Processor {
  readonly operations: readonly OperationName[] = [
    'IMAGE_COMPRESS',
    'IMAGE_RESIZE',
    'IMAGE_CONVERT',
    'IMAGE_CROP',
    'IMAGE_ROTATE',
    'IMAGE_WATERMARK',
    'IMAGE_ADJUST',
    'IMAGE_STRIP_METADATA',
    'IMAGE_TO_PDF',
  ];

  async validate(input: ValidateInput): Promise<void> {
    for (const path of input.inputPaths) {
      let meta: Metadata;
      try {
        meta = await open(path).metadata();
        if (!meta.width || !meta.height) throw new Error('no dimensions');
      } catch (err) {
        throw new ProcessorError('This image could not be read. It may be damaged.', 'INVALID_FILE', { cause: err });
      }
      // Processing would silently keep only the first frame of an animated image.
      if ((meta.pages ?? 1) > 1)
        throw new ProcessorError('Animated images are not supported yet.', 'PROCESSING_FAILED');
    }
  }

  outputExtensionFor(operation: OperationName, options: Record<string, unknown>, inputExt: string): string {
    if (operation === 'IMAGE_TO_PDF') return 'pdf';
    if (operation === 'IMAGE_CONVERT') return TO_EXT[options.format as Format];
    return TO_EXT[formatFromExt(inputExt)];
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
    const o = input.options;
    const sourceFormat = formatFromExt(input.inputExt);
    const preset = (o.preset as Preset | undefined) ?? 'BALANCED';
    const inputMeta = await open(input.inputPath).metadata();
    const { width: w, height: h } = orientedSize(inputMeta);
    // autoOrient bakes the EXIF rotation into the pixels so dropping metadata never turns the picture sideways.
    let pipeline = open(input.inputPath).autoOrient();
    let format = sourceFormat;
    let encodePreset: Preset = preset;
    const info: Record<string, unknown> = { inputWidth: w, inputHeight: h };

    switch (input.operation) {
      case 'IMAGE_COMPRESS': {
        const cap = MAX_DIMENSION[preset];
        if (cap) pipeline = pipeline.resize({ width: cap, height: cap, fit: 'inside', withoutEnlargement: true });
        if (typeof o.targetKb === 'number')
          return this.compressToTarget(input, pipeline, format, w, h, o.targetKb, info);
        break;
      }
      case 'IMAGE_RESIZE': {
        const upscale = o.allowUpscale === true;
        if (o.mode === 'percent') {
          const pct = Number(o.percent) / 100;
          const tw = Math.max(1, Math.round(w * pct));
          const th = Math.max(1, Math.round(h * pct));
          if (tw * th > getEnv().MAX_IMAGE_PIXELS) throw new ProcessorError('That size is too large.', 'BAD_REQUEST');
          pipeline = pipeline.resize({ width: tw, height: th, fit: 'fill', withoutEnlargement: !upscale });
        } else {
          const tw = o.width as number | undefined;
          const th = o.height as number | undefined;
          if ((tw ?? w) * (th ?? h) > getEnv().MAX_IMAGE_PIXELS)
            throw new ProcessorError('That size is too large.', 'BAD_REQUEST');
          pipeline = pipeline.resize({ width: tw, height: th, fit: 'inside', withoutEnlargement: !upscale });
        }
        encodePreset = 'HIGH_QUALITY';
        break;
      }
      case 'IMAGE_CONVERT':
        format = o.format as Format;
        break;
      case 'IMAGE_CROP': {
        const rect = this.cropRect(o, w, h);
        pipeline = pipeline.extract(rect);
        info.cropWidth = rect.width;
        info.cropHeight = rect.height;
        encodePreset = 'HIGH_QUALITY';
        break;
      }
      case 'IMAGE_ROTATE': {
        const angle = Number(o.angle ?? 0);
        if (angle) pipeline = pipeline.rotate(angle);
        if (o.flipVertical === true) pipeline = pipeline.flip();
        if (o.flipHorizontal === true) pipeline = pipeline.flop();
        encodePreset = 'HIGH_QUALITY';
        break;
      }
      case 'IMAGE_WATERMARK': {
        const svg = await buildWatermarkSvg({
          text: String(o.text),
          position: String(o.position ?? 'bottom-right') as 'center',
          opacity: Number(o.opacity ?? 50),
          sizePercent: Number(o.sizePercent ?? 6),
          color: String(o.color ?? 'white'),
          width: w,
          height: h,
        });
        // flatten the orientation first: the overlay is sized to the displayed picture
        const { data, info: raw } = await pipeline.raw().toBuffer({ resolveWithObject: true });
        pipeline = sharp(data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } }).composite([
          { input: svg, top: 0, left: 0 },
        ]);
        encodePreset = 'HIGH_QUALITY';
        break;
      }
      case 'IMAGE_ADJUST': {
        if (o.grayscale === true) pipeline = pipeline.grayscale();
        const brightness = 1 + Number(o.brightness ?? 0) / 100;
        const saturation = 1 + Number(o.saturation ?? 0) / 100;
        if (brightness !== 1 || saturation !== 1) pipeline = pipeline.modulate({ brightness, saturation });
        const contrast = 1 + Number(o.contrast ?? 0) / 100;
        if (contrast !== 1) pipeline = pipeline.linear(contrast, 128 * (1 - contrast));
        if (Number(o.blur ?? 0) >= 0.3) pipeline = pipeline.blur(Number(o.blur));
        if (o.sharpen === true) pipeline = pipeline.sharpen();
        encodePreset = 'HIGH_QUALITY';
        break;
      }
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
    const outMeta = await open(input.outputPath).metadata();
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
    return { outputMime: MIME[format], outputExt: TO_EXT[format], info };
  }

  private cropRect(
    o: Record<string, unknown>,
    w: number,
    h: number,
  ): { left: number; top: number; width: number; height: number } {
    if (o.mode === 'trim') {
      const left = Math.round((Number(o.left ?? 0) / 100) * w);
      const top = Math.round((Number(o.top ?? 0) / 100) * h);
      const right = Math.round((Number(o.right ?? 0) / 100) * w);
      const bottom = Math.round((Number(o.bottom ?? 0) / 100) * h);
      const width = w - left - right;
      const height = h - top - bottom;
      if (width < 1 || height < 1) throw new ProcessorError('Those margins leave nothing of the image.', 'BAD_REQUEST');
      return { left, top, width, height };
    }
    const [aw, ah] = String(o.aspect ?? '1:1')
      .split(':')
      .map(Number) as [number, number];
    const ratio = aw / ah;
    let width = w;
    let height = Math.round(w / ratio);
    if (height > h) {
      height = h;
      width = Math.round(h * ratio);
    }
    const focus = String(o.focus ?? 'center');
    const left = focus === 'left' ? 0 : focus === 'right' ? w - width : Math.round((w - width) / 2);
    const top = focus === 'top' ? 0 : focus === 'bottom' ? h - height : Math.round((h - height) / 2);
    return { left, top, width, height };
  }

  /**
   * Find the best quality that stays under the target size, shrinking the picture in steps only when
   * even the lowest quality is still too big. Reports honestly whether the target was met.
   */
  private async compressToTarget(
    input: ProcessorInput,
    base: Sharp,
    format: Format,
    w: number,
    h: number,
    targetKb: number,
    info: Record<string, unknown>,
  ): Promise<ProcessorResult> {
    if (!LOSSY.has(format))
      throw new ProcessorError('A target size works for JPG, PNG, WebP and AVIF pictures.', 'BAD_REQUEST');
    const target = targetKb * 1024;
    const palette = format === 'png';
    const flat = format === 'jpeg' ? base.flatten({ background: '#ffffff' }) : base;
    let best: { buffer: Buffer; quality: number; scale: number } | undefined;
    let smallest: Buffer | undefined;
    const scales = [1, 0.85, 0.7, 0.55, 0.4, 0.3, 0.2];
    outer: for (const [si, scale] of scales.entries()) {
      if (input.signal.aborted) throw new ProcessorError('Cancelled', 'CANCELLED');
      const sized =
        scale < 1
          ? flat.clone().resize({
              width: Math.max(1, Math.round(w * scale)),
              height: Math.max(1, Math.round(h * scale)),
              fit: 'fill',
            })
          : flat.clone();
      const tryQ = async (q: number) => encodeQ(sized.clone(), format, q, palette).toBuffer();
      const top = await tryQ(92);
      if (top.length <= target) {
        best = { buffer: top, quality: 92, scale };
        break;
      }
      const low = await tryQ(25);
      if (!smallest || low.length < smallest.length) smallest = low;
      if (low.length <= target) {
        let lo = 26;
        let hi = 91;
        best = { buffer: low, quality: 25, scale };
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const buf = await tryQ(mid);
          if (buf.length <= target) {
            best = { buffer: buf, quality: mid, scale };
            lo = mid + 1;
          } else hi = mid - 1;
        }
        break outer;
      }
      input.reportProgress(10 + Math.round(((si + 1) / scales.length) * 80));
    }
    const metTarget = Boolean(best);
    const chosen = best?.buffer ?? (smallest as Buffer);
    await fs.writeFile(input.outputPath, chosen);
    const meta = await sharp(chosen).metadata();
    Object.assign(info, {
      targetKb,
      achievedKb: Math.round(chosen.length / 1024),
      metTarget,
      outputWidth: meta.width,
      outputHeight: meta.height,
      ...(best && best.scale < 1
        ? {
            note: `To reach ${targetKb} KB the picture was also made smaller (${Math.round(best.scale * 100)}% of its size).`,
          }
        : {}),
      ...(!metTarget
        ? { note: `${targetKb} KB is smaller than this picture can go. This is the smallest we could make it.` }
        : {}),
    });
    return { outputMime: MIME[format], outputExt: TO_EXT[format], info };
  }

  private async toPdf(input: ProcessorInput): Promise<ProcessorResult> {
    const o = input.options;
    const pageSize = String(o.pageSize ?? 'a4');
    const orientation = String(o.orientation ?? 'auto');
    const margin = Number(o.margin ?? 8) * MM;
    const pdf = await PDFDocument.create({ updateMetadata: false });
    for (const [i, path] of input.inputPaths.entries()) {
      if (input.signal.aborted) throw new ProcessorError('Cancelled', 'CANCELLED');
      const meta = await open(path).metadata();
      const { width: iw, height: ih } = orientedSize(meta);
      const embedded = await this.embed(pdf, path, meta);
      const wpt = iw * PX_TO_PT;
      const hpt = ih * PX_TO_PT;
      let pw: number;
      let ph: number;
      if (pageSize === 'fit') {
        pw = Math.min(wpt + margin * 2, 14400);
        ph = Math.min(hpt + margin * 2, 14400);
      } else {
        const base = pageSize === 'letter' ? LETTER : A4;
        const landscape = orientation === 'landscape' || (orientation === 'auto' && iw > ih);
        [pw, ph] = landscape ? [base[1], base[0]] : [base[0], base[1]];
      }
      const scale = Math.min((pw - margin * 2) / wpt, (ph - margin * 2) / hpt, 1);
      const dw = wpt * scale;
      const dh = hpt * scale;
      pdf.addPage([pw, ph]).drawImage(embedded, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
      input.reportProgress(5 + Math.round(((i + 1) / input.inputPaths.length) * 85));
    }
    await fs.writeFile(input.outputPath, await pdf.save({ useObjectStreams: true }));
    return {
      outputMime: 'application/pdf',
      outputExt: 'pdf',
      info: { images: input.inputPaths.length, outputPages: input.inputPaths.length },
    };
  }

  /** Plain upright JPEGs go in untouched (lossless); everything else is decoded and embedded. */
  private async embed(pdf: PDFDocument, path: string, meta: Metadata): Promise<PDFImage> {
    if (meta.format === 'jpeg' && (meta.orientation ?? 1) === 1 && meta.space !== 'cmyk') {
      return pdf.embedJpg(await fs.readFile(path));
    }
    if (meta.hasAlpha) return pdf.embedPng(await open(path).autoOrient().png().toBuffer());
    return pdf.embedJpg(await open(path).autoOrient().jpeg({ quality: 92, mozjpeg: true }).toBuffer());
  }

  async cleanup(input: Pick<ProcessorInput, 'outputPath'>): Promise<void> {
    await fs.rm(input.outputPath, { force: true });
  }
}
