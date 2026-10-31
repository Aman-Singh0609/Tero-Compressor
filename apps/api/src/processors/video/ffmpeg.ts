import { execFile, spawn } from 'node:child_process';
import { getEnv } from '../../config/env';
import { ProcessorError } from '../types';

export interface FfmpegRun {
  args: string[];
  durationSeconds?: number;
  timeoutMs: number;
  signal: AbortSignal;
  onProgress(percent: number): void;
}

const STDERR_TAIL = 4000;

/** Run ffprobe with an argument array (never a shell string). Resolves trimmed stdout. */
export function probe(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(getEnv().FFPROBE_PATH, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

export async function probeDuration(inputPath: string): Promise<number | undefined> {
  try {
    const out = await probe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inputPath]);
    const seconds = Number.parseFloat(out);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  } catch {
    return undefined;
  }
}

export async function hasStream(inputPath: string, kind: 'a' | 'v'): Promise<boolean> {
  try {
    const out = await probe([
      '-v',
      'error',
      '-select_streams',
      kind,
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      inputPath,
    ]);
    return out.length > 0;
  } catch {
    return false;
  }
}

/**
 * Spawn ffmpeg with an argument array. Handles timeout, cancellation via AbortSignal,
 * non-zero exit, and parses `-progress pipe:1` output into percentages when a duration is known.
 */
export function runFfmpeg(run: FfmpegRun): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...run.args, '-progress', 'pipe:1', '-nostats'];
    const child = spawn(getEnv().FFMPEG_PATH, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let buffered = '';
    let settled = false;

    const finish = (err?: ProcessorError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(() => {
      kill();
      finish(new ProcessorError('Processing took too long and was stopped.', 'TIMEOUT'));
    }, run.timeoutMs);
    const onAbort = () => {
      kill();
      finish(new ProcessorError('Cancelled', 'CANCELLED'));
    };
    if (run.signal.aborted) return onAbort();
    run.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      let nl: number;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        const m = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
        if (m && run.durationSeconds) {
          // both out_time_us and out_time_ms are reported in microseconds by ffmpeg
          const seconds = Number(m[1]) / 1_000_000;
          run.onProgress(Math.min(99, Math.round((seconds / run.durationSeconds) * 100)));
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL);
    });
    child.on('error', (err) => {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      finish(
        new ProcessorError(
          missing ? 'Video tools are not installed on the server.' : 'The video could not be processed.',
          'PROCESSING_FAILED',
          { cause: err },
        ),
      );
    });
    child.on('close', (code) => {
      if (code === 0) finish();
      else
        finish(
          new ProcessorError('The video could not be processed.', 'PROCESSING_FAILED', {
            cause: stderr.trim() || `ffmpeg exited with ${code}`,
          }),
        );
    });
  });
}
