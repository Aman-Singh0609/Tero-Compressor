import fs from 'node:fs/promises';
import { decodePDFRawStream, PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import sharp, { type Sharp } from 'sharp';
import type { OperationName, Preset } from '../operations';
import { ProcessorError, type Processor, type ProcessorInput, type ProcessorResult } from '../types';

const QUALITY: Record<Preset, number> = { HIGH_QUALITY: 85, BALANCED: 70, SMALLEST: 50 };
const MAX_DIMENSION: Record<Preset, number | null> = { HIGH_QUALITY: null, BALANCED: 2400, SMALLEST: 1400 };
/** Re-encoded images must be at least this much smaller to be worth replacing. */
const MIN_IMAGE_GAIN = 0.95;
/** Lossless → JPEG conversions must save at least a quarter to be worth the quality cost. */
const MIN_FLATE_GAIN = 0.75;
const FLATE_QUALITY: Record<Preset, number> = { HIGH_QUALITY: 90, BALANCED: 78, SMALLEST: 60 };

const NAME = {
  subtype: PDFName.of('Subtype'),
  image: PDFName.of('Image'),
  filter: PDFName.of('Filter'),
  dct: PDFName.of('DCTDecode'),
  colorSpace: PDFName.of('ColorSpace'),
  rgb: PDFName.of('DeviceRGB'),
  gray: PDFName.of('DeviceGray'),
  bpc: PDFName.of('BitsPerComponent'),
  width: PDFName.of('Width'),
  height: PDFName.of('Height'),
  decode: PDFName.of('Decode'),
  flate: PDFName.of('FlateDecode'),
  decodeParms: PDFName.of('DecodeParms'),
  smask: PDFName.of('SMask'),
  mask: PDFName.of('Mask'),
};

/**
 * Real PDF size reduction comes from re-encoding the embedded JPEG images, which dominate the size
 * of scanned/photo PDFs. Documents without such images cannot be meaningfully shrunk here, and the
 * result says so rather than claiming a saving.
 */
export class PdfProcessor implements Processor {
  readonly operations: readonly OperationName[] = ['PDF_COMPRESS'];

  async validate(input: Parameters<Processor['validate']>[0]): Promise<void> {
    await this.load(await fs.readFile(input.inputPath));
  }

  outputExtensionFor(): string {
    return 'pdf';
  }

  private async load(bytes: Buffer): Promise<PDFDocument> {
    try {
      return await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (err) {
      const encrypted = /encrypt/i.test(String(err));
      throw new ProcessorError(
        encrypted
          ? 'This PDF is password-protected. Unlock it first, then try again.'
          : 'This PDF could not be read. It may be damaged.',
        'INVALID_FILE',
        { cause: err },
      );
    }
  }

  async process(input: ProcessorInput): Promise<ProcessorResult> {
    const preset = (input.options.preset as Preset | undefined) ?? 'BALANCED';
    const original = await fs.readFile(input.inputPath);
    const doc = await this.load(original);
    input.reportProgress(10);

    const stats = await this.recompressImages(doc, preset, input);
    input.reportProgress(80);
    const saved = Buffer.from(await doc.save({ useObjectStreams: true }));
    const info: Record<string, unknown> = { imagesFound: stats.found, imagesRecompressed: stats.recompressed };

    if (saved.length < original.length) {
      await fs.writeFile(input.outputPath, saved);
    } else {
      await fs.writeFile(input.outputPath, original);
      info.keptOriginal = true;
      info.note =
        stats.found === 0
          ? 'This PDF has no photos or scans to shrink, so it was returned unchanged.'
          : 'This PDF was already compact, so it was returned unchanged.';
    }
    return { outputMime: 'application/pdf', outputExt: 'pdf', info };
  }

  /**
   * Re-encodes images inside the PDF:
   *  - JPEG (DCTDecode) images at every preset (HIGH_QUALITY only lowers the quality a little);
   *  - lossless Flate RGB/Gray images (screenshots, exported slides) to JPEG for BALANCED / SMALLEST only,
   *    and only when that saves at least 25 % — converting a lossless image is a visible trade-off.
   * Images with masks/soft-masks, indexed or CMYK colour, or unusual bit depths are left untouched.
   */
  private async recompressImages(doc: PDFDocument, preset: Preset, input: ProcessorInput) {
    const stats = { found: 0, recompressed: 0 };
    const entries = [...doc.context.enumerateIndirectObjects()];
    let index = 0;
    for (const [ref, obj] of entries) {
      index++;
      if (input.signal.aborted) throw new ProcessorError('Cancelled', 'CANCELLED');
      if (!(obj instanceof PDFRawStream)) continue;
      const dict = obj.dict;
      if (dict.get(NAME.subtype) !== NAME.image) continue;
      const filter = dict.get(NAME.filter);
      const isDct = filter === NAME.dct;
      const isFlate = filter === NAME.flate;
      if (!isDct && !isFlate) continue;
      stats.found++;
      const colorSpace = dict.get(NAME.colorSpace);
      const bpc = dict.get(NAME.bpc);
      if (
        (colorSpace !== NAME.rgb && colorSpace !== NAME.gray) ||
        !(bpc instanceof PDFNumber && bpc.asNumber() === 8) ||
        dict.has(NAME.decode) ||
        dict.has(NAME.mask) ||
        dict.has(NAME.smask) ||
        (isFlate && preset === 'HIGH_QUALITY')
      ) {
        continue;
      }
      const channels = colorSpace === NAME.gray ? 1 : 3;
      try {
        const cap = MAX_DIMENSION[preset];
        let pipeline: Sharp;
        if (isDct) {
          pipeline = sharp(Buffer.from(obj.contents), { failOn: 'none' });
        } else {
          const width = (dict.get(NAME.width) as PDFNumber | undefined)?.asNumber();
          const height = (dict.get(NAME.height) as PDFNumber | undefined)?.asNumber();
          if (!width || !height) continue;
          const pixels = decodePDFRawStream(obj).decode(); // undoes Flate and any PNG/TIFF predictor
          if (pixels.length !== width * height * channels) continue;
          pipeline = sharp(Buffer.from(pixels), { raw: { width, height, channels } });
        }
        if (cap) pipeline = pipeline.resize({ width: cap, height: cap, fit: 'inside', withoutEnlargement: true });
        if (channels === 1) pipeline = pipeline.toColourspace('b-w');
        const { data, info } = await pipeline
          .jpeg({ quality: isFlate ? FLATE_QUALITY[preset] : QUALITY[preset], mozjpeg: true })
          .toBuffer({ resolveWithObject: true });
        const gain = isFlate ? MIN_FLATE_GAIN : MIN_IMAGE_GAIN;
        if (info.channels !== channels || data.length >= obj.contents.length * gain) continue;
        const newDict = dict.clone();
        newDict.set(NAME.width, PDFNumber.of(info.width));
        newDict.set(NAME.height, PDFNumber.of(info.height));
        if (isFlate) {
          newDict.set(NAME.filter, NAME.dct);
          newDict.delete(NAME.decodeParms);
        }
        doc.context.assign(ref, PDFRawStream.of(newDict, data));
        stats.recompressed++;
      } catch {
        // an image we cannot decode is left exactly as it was
      } finally {
        input.reportProgress(10 + Math.round((index / entries.length) * 65));
      }
    }
    return stats;
  }

  async cleanup(input: Pick<ProcessorInput, 'outputPath'>): Promise<void> {
    await fs.rm(input.outputPath, { force: true });
  }
}
