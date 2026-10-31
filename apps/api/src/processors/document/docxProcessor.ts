import fs from 'node:fs/promises';
import JSZip from 'jszip';
import sharp from 'sharp';
import type { OperationName, Preset } from '../operations';
import { ProcessorError, type Processor, type ProcessorInput, type ProcessorResult } from '../types';

const QUALITY: Record<Preset, number> = { HIGH_QUALITY: 85, BALANCED: 72, SMALLEST: 55 };
const MAX_DIMENSION: Record<Preset, number> = { HIGH_QUALITY: 3000, BALANCED: 1800, SMALLEST: 1200 };
const MEDIA_PATTERN = /^word\/media\/[^/]+\.(jpe?g|png)$/i;

/** Shrinks pictures embedded in a .docx. File names inside the package are preserved so relationships stay valid. */
export class DocxProcessor implements Processor {
  readonly operations: readonly OperationName[] = ['DOCX_COMPRESS'];

  async validate(input: Parameters<Processor['validate']>[0]): Promise<void> {
    await this.load(input.inputPath);
  }

  outputExtensionFor(): string {
    return 'docx';
  }

  private async load(path: string): Promise<JSZip> {
    try {
      return await JSZip.loadAsync(await fs.readFile(path));
    } catch (err) {
      throw new ProcessorError('This document could not be read. It may be damaged.', 'INVALID_FILE', { cause: err });
    }
  }

  async process(input: ProcessorInput): Promise<ProcessorResult> {
    const preset = (input.options.preset as Preset | undefined) ?? 'BALANCED';
    const zip = await this.load(input.inputPath);
    const mediaNames = Object.keys(zip.files).filter((n) => MEDIA_PATTERN.test(n));
    let recompressed = 0;

    for (const [i, name] of mediaNames.entries()) {
      if (input.signal.aborted) throw new ProcessorError('Cancelled', 'CANCELLED');
      const entry = zip.file(name);
      if (!entry) continue;
      try {
        const original = await entry.async('nodebuffer');
        const isPng = /\.png$/i.test(name);
        const base = sharp(original, { failOn: 'none' }).resize({
          width: MAX_DIMENSION[preset],
          height: MAX_DIMENSION[preset],
          fit: 'inside',
          withoutEnlargement: true,
        });
        const out = isPng
          ? await base.png({ compressionLevel: 9, effort: 8 }).toBuffer()
          : await base.jpeg({ quality: QUALITY[preset], mozjpeg: true }).toBuffer();
        if (out.length < original.length) {
          zip.file(name, out);
          recompressed++;
        }
      } catch {
        // leave undecodable media untouched
      }
      input.reportProgress(10 + Math.round(((i + 1) / mediaNames.length) * 75));
    }

    const rebuilt = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });
    const info: Record<string, unknown> = { imagesFound: mediaNames.length, imagesRecompressed: recompressed };
    if (rebuilt.length < input.inputSizeBytes) {
      await fs.writeFile(input.outputPath, rebuilt);
    } else {
      await fs.copyFile(input.inputPath, input.outputPath);
      info.keptOriginal = true;
      info.note =
        mediaNames.length === 0
          ? 'This document has no pictures to shrink, so it was returned unchanged.'
          : 'This document was already compact, so it was returned unchanged.';
    }
    return {
      outputMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      outputExt: 'docx',
      info,
    };
  }

  async cleanup(input: Pick<ProcessorInput, 'outputPath'>): Promise<void> {
    await fs.rm(input.outputPath, { force: true });
  }
}
