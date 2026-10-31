import { Prisma } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import { getEnv } from '../../config/env';
import { AppError } from '../../lib/errors';

export function notFound(_req: Request, _res: Response, next: NextFunction): void {
  next(new AppError('NOT_FOUND', 'That route does not exist.'));
}

function send(res: Response, status: number, code: string, message: string, details?: unknown): void {
  res.status(status).json({ success: false, error: { code, message, ...(details ? { details } : {}) } });
}

/** One place that turns every failure into the documented error envelope. Stack traces never leave the server. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof AppError) {
    if (err.status >= 500) req.log.error({ code: err.code, err: err.message, details: err.details }, 'request failed');
    return send(res, err.status, err.code, err.message, err.details);
  }
  if (err instanceof ZodError) {
    return send(
      res,
      400,
      'VALIDATION_ERROR',
      'The request was not valid.',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return send(res, 413, 'FILE_TOO_LARGE', `This file is larger than the ${getEnv().MAX_UPLOAD_SIZE_MB} MB limit.`);
    }
    return send(res, 400, 'INVALID_FILE', 'The upload could not be read.');
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return send(res, 400, 'VALIDATION_ERROR', 'The request body is not valid JSON.');
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError || err instanceof Prisma.PrismaClientInitializationError) {
    req.log.error({ err: err.message }, 'database error');
    return send(res, 500, 'DATABASE_ERROR', 'A database error occurred. Please try again.');
  }
  req.log.error({ err: err instanceof Error ? err.stack : String(err) }, 'unhandled error');
  send(res, 500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
}
