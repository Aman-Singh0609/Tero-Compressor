import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getEnv } from '../../config/env';
import { logger } from '../../lib/logger';

interface RouteStats {
  durations: number[];
  count: number;
  errors: number;
}

const stats = new Map<string, RouteStats>();
const MAX_SAMPLES = 500;

export function resetRequestMetrics(): void {
  stats.clear();
}

export function requestMetrics() {
  return [...stats.entries()]
    .map(([route, s]) => {
      const sorted = [...s.durations].sort((a, b) => a - b);
      const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
      return {
        route,
        count: s.count,
        errors: s.errors,
        avgMs: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0,
        p95Ms: at(0.95),
        maxMs: sorted[sorted.length - 1] ?? 0,
      };
    })
    .sort((a, b) => b.count - a.count);
}

/** Mark a request as intentionally long-running so it never triggers the slow-request warning. */
export function longRunning(_req: Request, res: Response, next: NextFunction): void {
  res.locals.longRunning = true;
  next();
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  req.log = logger().child({ requestId: req.id });
  res.setHeader('X-Request-Id', req.id);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const start = performance.now();

  res.on('finish', () => {
    const durationMs = Math.round(performance.now() - start);
    const route = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path.replace(/[0-9a-f-]{36}/g, ':id')}`;
    const s = stats.get(route) ?? { durations: [], count: 0, errors: 0 };
    s.count++;
    if (res.statusCode >= 500) s.errors++;
    if (!res.locals.longRunning) {
      s.durations.push(durationMs);
      if (s.durations.length > MAX_SAMPLES) s.durations.shift();
    }
    stats.set(route, s);

    const entry = {
      method: req.method,
      path: req.baseUrl + (req.route?.path ?? req.path),
      status: res.statusCode,
      durationMs,
    };
    const slow = !res.locals.longRunning && durationMs >= getEnv().SLOW_REQUEST_MS;
    if (slow) req.log.warn(entry, 'slow request');
    else req.log.info(entry, 'request');
  });
  next();
}
