import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getEnv } from '../../config/env';
import { AppError } from '../../lib/errors';
import { resolveSession, SESSION_COOKIE } from '../../services/authService';

/** Every /admin route except login goes through this: authentication is enforced by the backend, not by hidden UI. */
export async function requireAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  const admin = await resolveSession(token);
  if (!admin || !token) throw new AppError('UNAUTHORIZED', 'Please sign in to continue.');
  req.admin = admin;
  req.sessionToken = token;
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * An Origin is accepted when it is listed in APP_ORIGIN, or when it is the very host the browser used to
 * reach the web app (X-Forwarded-Host set by the Next.js proxy) — so opening TERO via a LAN address or a
 * new hostname works without reconfiguring. A cross-site page cannot forge this: browsers cannot attach
 * custom headers cross-origin without a CORS preflight, which this API never grants.
 */
function originAllowed(origin: string, req: Request): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (getEnv().appOrigins.includes(parsed.origin)) return true;
  const forwarded = req.header('x-forwarded-host');
  return Boolean(forwarded) && forwarded === parsed.host;
}

/**
 * CSRF defence in depth on top of SameSite cookies: state-changing requests that carry an Origin
 * header must come from the configured application origin.
 */
export function originGuard(req: Request, _res: Response, next: NextFunction): void {
  if (!SAFE_METHODS.has(req.method)) {
    const origin = req.header('origin');
    if (origin && !originAllowed(origin, req)) throw new AppError('FORBIDDEN', 'Request origin not allowed.');
  }
  next();
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** Fixed-window in-memory limiter keyed by client IP. Adequate for a single-instance family deployment. */
export function rateLimit(name: string, max: number, windowMs: number): RequestHandler {
  const buckets = new Map<string, Bucket>();
  return (req, res, next) => {
    if (!getEnv().RATE_LIMIT_ENABLED) return next();
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
      if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    b.count++;
    if (b.count > max) {
      res.setHeader('Retry-After', Math.ceil((b.resetAt - now) / 1000));
      throw new AppError('TOO_MANY_REQUESTS', 'Too many requests. Please slow down and try again shortly.', {
        limiter: name,
      });
    }
    next();
  };
}
