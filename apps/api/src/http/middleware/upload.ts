import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import type { Request, RequestHandler } from 'express';
import multer, { type StorageEngine } from 'multer';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../../lib/errors';
import { storage } from '../../storage';

/** Streams the upload to a generated scratch path; the client file name never touches the filesystem. */
function scratchEngine(): StorageEngine {
  return {
    _handleFile(_req, file, cb) {
      const target = storage().allocateWorkPath();
      const out = createWriteStream(target, { flags: 'wx' });
      let truncated = false;
      file.stream.on('limit', () => {
        truncated = true;
      });
      pipeline(file.stream, out)
        .then(() => {
          if (truncated) return fs.rm(target, { force: true }).then(() => cb(null, { path: target, size: 0 }));
          cb(null, { path: target, size: out.bytesWritten });
        })
        .catch((err) => fs.rm(target, { force: true }).finally(() => cb(err)));
    },
    _removeFile(_req, file, cb) {
      fs.rm(file.path, { force: true }).then(() => cb(null), cb);
    },
  };
}

/** Parse a single `file` field of a multipart request (plus small text fields) into req.file. */
export function singleFileUpload(maxBytes: () => number): RequestHandler {
  return (req, res, next) => {
    multer({
      storage: scratchEngine(),
      limits: { fileSize: maxBytes(), files: 1, fields: 10, fieldSize: 4096 },
    }).single('file')(req, res, (err) => {
      if (err) {
        // multer/busboy throw plain Errors for malformed bodies (missing boundary, truncated stream): that is a client error
        const known = err instanceof multer.MulterError || err instanceof AppError;
        return next(known ? err : new AppError('INVALID_FILE', 'The upload could not be read.'));
      }
      if (!req.file) return next(new AppError('INVALID_FILE', 'No file was sent. Choose a file and try again.'));
      next();
    });
  };
}

export function uploadedFile(req: Request): { path: string; originalname: string } {
  if (!req.file) throw new AppError('INVALID_FILE', 'No file was sent.');
  return { path: req.file.path, originalname: req.file.originalname };
}
