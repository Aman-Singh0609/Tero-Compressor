import { pipeline } from 'node:stream';
import type { NextFunction, Response } from 'express';
import { contentDisposition } from '../lib/http';
import { storage, type StorageArea } from '../storage';

/** Stream a stored object as a download. The location comes from a database row, never from the client. */
export async function sendStored(
  res: Response,
  next: NextFunction,
  area: StorageArea,
  storedName: string,
  downloadName: string,
  mimeType: string,
): Promise<void> {
  const meta = await storage().getMetadata(area, storedName);
  if (!meta) return next(new Error('stored object disappeared'));
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', meta.sizeBytes);
  res.setHeader('Content-Disposition', contentDisposition(downloadName));
  res.setHeader('Cache-Control', 'private, no-store');
  res.locals.longRunning = true;
  const stream = storage().createReadStream(area, storedName);
  // pipeline() destroys the source (closing file handles / DB cursors) when the client disconnects early
  pipeline(stream, res, (err) => {
    if (!err || (err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    if (res.headersSent) res.destroy();
    else next(err);
  });
}
