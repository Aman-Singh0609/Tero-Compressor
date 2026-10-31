import type { Response } from 'express';

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function ok<T>(res: Response, data: T, meta?: Record<string, unknown>, status = 200): void {
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
}

export function paginate(page: number, limit: number, total: number): Pagination {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

/** Header-safe Content-Disposition (ASCII fallback plus RFC 5987 encoded name). */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? Number(value) : value;
}
