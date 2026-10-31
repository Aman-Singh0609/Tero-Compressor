import { getEnv } from '../config/env';
import { logger } from './logger';

export interface TimingSample {
  name: string;
  durationMs: number;
}

const recent: TimingSample[] = [];

export function recentTimings(): TimingSample[] {
  return recent.slice();
}

export function recordTiming(name: string, durationMs: number): void {
  recent.push({ name, durationMs });
  if (recent.length > 500) recent.shift();
  const env = getEnv();
  if (durationMs >= env.SLOW_QUERY_MS) logger().warn({ op: name, durationMs }, 'slow data operation');
  else if (env.LOG_LEVEL === 'debug') logger().debug({ op: name, durationMs }, 'data operation');
}

/**
 * Wrap every function on a repository so each call is timed as `Name.method`.
 * Keeps repository code free of timing boilerplate.
 */
export function instrument<T extends object>(name: string, repo: T): T {
  const wrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(repo)) {
    if (typeof value === 'function') {
      wrapped[key] = async (...args: unknown[]) => {
        const start = performance.now();
        try {
          return await (value as (...a: unknown[]) => unknown)(...args);
        } finally {
          recordTiming(`${name}.${key}`, Math.round(performance.now() - start));
        }
      };
    } else wrapped[key] = value;
  }
  return wrapped as T;
}
