import fs from 'node:fs/promises';
import { getEnv } from '../../config/env';
import type { OperationName, Preset } from '../operations';
import { ProcessorError, type Processor, type ProcessorInput, type ProcessorResult } from '../types';
import { hasStream, probeDuration, runFfmpeg } from './ffmpeg';

interface VideoSettings {
  crf: number;
  x264Preset: string;
  audioBitrate: string;
  /** Longest side cap in pixels, or null to keep the source resolution. */
  maxSide: number | null;
}

// Technical settings stay here; family users only ever see "High quality / Recommended / Smallest file".
const SETTINGS: Record<Preset, VideoSettings> = {
  HIGH_QUALITY: { crf: 20, x264Preset: 'medium', audioBitrate: '160k', maxSide: null },
  BALANCED: { crf: 25, x264Preset: 'medium', audioBitrate: '128k', maxSide: 1920 },
  SMALLEST: { crf: 30, x264Preset: 'medium', audioBitrate: '96k', maxSide: 1280 },
};

export class VideoProcessor implements Processor {
  readonly operations: readonly OperationName[] = ['VIDEO_COMPRESS', 'VIDEO_EXTRACT_AUDIO'];

  async validate(input: Parameters<Processor['validate']>[0]): Promise<void> {
    if (!(await hasStream(input.inputPath, 'v'))) {
      throw new ProcessorError('This video could not be read. It may be damaged.', 'INVALID_FILE');
    }
    if (input.operation === 'VIDEO_EXTRACT_AUDIO' && !(await hasStream(input.inputPath, 'a'))) {
      throw new ProcessorError('This video has no sound to extract.', 'INVALID_FILE');
    }
  }

  outputExtensionFor(operation: OperationName): string {
    return operation === 'VIDEO_EXTRACT_AUDIO' ? 'mp3' : 'mp4';
  }

  async process(input: ProcessorInput): Promise<ProcessorResult> {
    const durationSeconds = await probeDuration(input.inputPath);
    const timeoutMs = getEnv().VIDEO_TIMEOUT_MINUTES * 60_000;
    const base = { durationSeconds, timeoutMs, signal: input.signal, onProgress: input.reportProgress };
    // Without a known duration, progress cannot be computed, so none is reported (UI shows indeterminate).

    if (input.operation === 'VIDEO_EXTRACT_AUDIO') {
      await runFfmpeg({
        ...base,
        args: [
          '-y',
          '-i',
          input.inputPath,
          '-vn',
          '-map',
          '0:a:0',
          '-c:a',
          'libmp3lame',
          '-q:a',
          '2',
          input.outputPath,
        ],
      });
      return { outputMime: 'audio/mpeg', outputExt: 'mp3', info: { durationSeconds } };
    }

    const preset = (input.options.preset as Preset | undefined) ?? 'BALANCED';
    const s = SETTINGS[preset];
    const args = ['-y', '-i', input.inputPath, '-map', '0:v:0', '-map', '0:a:0?'];
    if (s.maxSide) {
      // only ever scale down; keep dimensions even for yuv420p
      args.push('-vf', `scale='if(gt(iw,ih),min(${s.maxSide},iw),-2)':'if(gt(iw,ih),-2,min(${s.maxSide},ih))'`);
    }
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      s.x264Preset,
      '-crf',
      String(s.crf),
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      s.audioBitrate,
      '-movflags',
      '+faststart',
      input.outputPath,
    );
    await runFfmpeg({ ...base, args });

    const info: Record<string, unknown> = { durationSeconds };
    // Only revert to the original when it is already an mp4, so the container matches the output name.
    if (input.inputExt === 'mp4' && (await fs.stat(input.outputPath)).size >= input.inputSizeBytes) {
      await fs.copyFile(input.inputPath, input.outputPath);
      info.keptOriginal = true;
      info.note = 'This video was already small, so it was returned unchanged.';
      return { outputMime: input.inputMime, outputExt: input.inputExt, info };
    }
    return { outputMime: 'video/mp4', outputExt: 'mp4', info };
  }

  async cleanup(input: Pick<ProcessorInput, 'outputPath'>): Promise<void> {
    await fs.rm(input.outputPath, { force: true });
  }
}
