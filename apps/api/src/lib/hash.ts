import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** SHA-256 of a file computed from a stream, so large files are never fully loaded into memory. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      // resolve on 'close' (not 'end') so the file handle is released before callers rename or delete the file (Windows)
      .on('close', () => resolve(hash.digest('hex')));
  });
}
