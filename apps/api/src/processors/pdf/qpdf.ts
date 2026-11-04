import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { ProcessorError } from '../types';

/**
 * qpdf compiled to WebAssembly (no installation, fully offline). `callMain` is synchronous and would
 * freeze the whole server for large files, so it runs in a worker thread that can also be terminated
 * on timeout or cancellation.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const createModule = require(workerData.modulePath);
  const errors = [];
  const mod = await (createModule.default || createModule)({
    locateFile: (f) => require('node:path').join(workerData.wasmDir, f),
    print: () => {},
    printErr: (line) => errors.push(String(line)),
    noInitialRun: true,
  });
  for (const [name, bytes] of Object.entries(workerData.files)) mod.FS.writeFile('/' + name, bytes);
  let code = 0;
  try { code = mod.callMain(workerData.args); } catch (e) { code = typeof e === 'number' ? e : (e && e.status) || 1; }
  let out = null;
  if (code === 0 && workerData.outputName) out = mod.FS.readFile('/' + workerData.outputName);
  parentPort.postMessage({ code, errors, out }, out ? [out.buffer] : []);
})().catch((e) => parentPort.postMessage({ code: 99, errors: [String(e && e.message || e)], out: null }));
`;

export interface QpdfRun {
  args: string[];
  files: Record<string, Uint8Array>;
  outputName?: string;
  signal: AbortSignal;
  timeoutMs?: number;
}

export interface QpdfResult {
  code: number;
  errors: string[];
  out: Buffer | null;
}

export function runQpdf(run: QpdfRun): Promise<QpdfResult> {
  const modulePath = require.resolve('@neslinesli93/qpdf-wasm');
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      stderr: true,
      workerData: {
        modulePath,
        wasmDir: path.dirname(modulePath),
        args: run.args,
        files: run.files,
        outputName: run.outputName,
      },
    });
    let settled = false;
    let stderr = '';
    worker.stderr.on('data', (c: Buffer) => (stderr = (stderr + c.toString()).slice(-4000)));
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal.removeEventListener('abort', onAbort);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new ProcessorError('Processing took too long and was stopped.', 'TIMEOUT'))),
      run.timeoutMs ?? 5 * 60_000,
    );
    const onAbort = () => done(() => reject(new ProcessorError('Cancelled', 'CANCELLED')));
    if (run.signal.aborted) return onAbort();
    run.signal.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (m: { code: number; errors: string[]; out: Uint8Array | null }) =>
      done(() =>
        resolve({
          code: m.code,
          errors: [...m.errors, ...stderr.split(/\r?\n/).filter(Boolean)],
          out: m.out ? Buffer.from(m.out) : null,
        }),
      ),
    );
    worker.on('error', (err) =>
      done(() => reject(new ProcessorError('The PDF could not be processed.', 'PROCESSING_FAILED', { cause: err }))),
    );
  });
}
