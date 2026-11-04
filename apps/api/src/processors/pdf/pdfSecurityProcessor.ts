import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import type { OperationName } from '../operations';
import {
  ProcessorError,
  type Processor,
  type ProcessorInput,
  type ProcessorResult,
  type ValidateInput,
} from '../types';
import { runQpdf } from './qpdf';

/** qpdf holds the file in WebAssembly memory, so very large PDFs are refused up front. */
const MAX_BYTES = 250 * 1024 * 1024;

async function readBounded(path: string): Promise<Buffer> {
  const stat = await fs.stat(path);
  if (stat.size > MAX_BYTES)
    throw new ProcessorError('This PDF is too large to lock or unlock (limit 250 MB).', 'INVALID_FILE');
  return fs.readFile(path);
}

export class PdfSecurityProcessor implements Processor {
  readonly operations: readonly OperationName[] = ['PDF_PROTECT', 'PDF_UNLOCK'];

  async validate(input: ValidateInput): Promise<void> {
    await readBounded(input.inputPath);
    if (!input.secrets.password) throw new ProcessorError('A password is required.', 'BAD_REQUEST');
  }

  outputExtensionFor(): string {
    return 'pdf';
  }

  async process(input: ProcessorInput): Promise<ProcessorResult> {
    const password = input.secrets.password;
    if (!password) {
      // secrets live in memory only; after a server restart the job cannot continue
      throw new ProcessorError('The password was lost because the server restarted. Please try again.', 'BAD_REQUEST');
    }
    const bytes = await readBounded(input.inputPath);
    input.reportProgress(10);
    // qpdf cannot open a user-password file to inspect it, so "invalid password" is also a yes
    const probe = await runQpdf({
      args: ['--is-encrypted', '/in.pdf'],
      files: { 'in.pdf': bytes },
      signal: input.signal,
    });
    const encrypted = probe.code === 0 || probe.errors.some((e) => /invalid password/i.test(e));

    if (input.operation === 'PDF_PROTECT') {
      if (encrypted)
        throw new ProcessorError('This PDF is already password-protected. Unlock it first.', 'BAD_REQUEST');
      // A random owner password means the restrictions cannot be lifted without unlocking via the user password.
      const owner = randomBytes(18).toString('base64url');
      const args = ['--encrypt', password, owner, '256'];
      if (input.options.allowPrinting === false) args.push('--print=none');
      if (input.options.allowCopying === false) args.push('--extract=n');
      args.push('--', '/in.pdf', '/out.pdf');
      const r = await runQpdf({ args, files: { 'in.pdf': bytes }, outputName: 'out.pdf', signal: input.signal });
      if (r.code !== 0 || !r.out)
        throw new ProcessorError('The PDF could not be protected.', 'PROCESSING_FAILED', {
          cause: r.errors.join('\n'),
        });
      await fs.writeFile(input.outputPath, r.out);
      return { outputMime: 'application/pdf', outputExt: 'pdf', info: { encryption: 'AES-256' } };
    }

    // PDF_UNLOCK
    const r = await runQpdf({
      args: [`--password=${password}`, '--decrypt', '/in.pdf', '/out.pdf'],
      files: { 'in.pdf': bytes },
      outputName: 'out.pdf',
      signal: input.signal,
    });
    if (r.code === 2 && r.errors.some((e) => /invalid password/i.test(e))) {
      throw new ProcessorError('That password is not correct.', 'BAD_REQUEST');
    }
    if (r.code !== 0 || !r.out)
      throw new ProcessorError('The PDF could not be unlocked.', 'PROCESSING_FAILED', { cause: r.errors.join('\n') });
    await fs.writeFile(input.outputPath, r.out);
    return {
      outputMime: 'application/pdf',
      outputExt: 'pdf',
      info: encrypted ? {} : { note: 'This PDF was not password-protected, so it was returned unchanged.' },
    };
  }

  async cleanup(input: Pick<ProcessorInput, 'outputPath'>): Promise<void> {
    await fs.rm(input.outputPath, { force: true });
  }
}
