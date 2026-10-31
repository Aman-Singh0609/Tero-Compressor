import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('true')
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** Comma-separated list of browser origins allowed to make state-changing admin requests. */
  APP_ORIGIN: z
    .string()
    .default('http://localhost:3000')
    .refine(
      (v) => v.split(',').every((o) => URL.canParse(o.trim())),
      'APP_ORIGIN must be one or more comma-separated URLs',
    ),
  /** Defaults to true in production. Set false only when serving over plain HTTP on a trusted home network. */
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .startsWith('mysql://', 'DATABASE_URL must be a mysql:// URL'),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(12, 'ADMIN_PASSWORD must be at least 12 characters').optional(),
  ADMIN_NAME: z.string().default('Administrator'),
  STORAGE_DRIVER: z.enum(['mysql', 'local']).default('mysql'),
  FILE_STORAGE_PATH: z.string().min(1).default('./storage'),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().positive().default(500),
  VAULT_MAX_SIZE_MB: z.coerce.number().positive().default(2000),
  FILE_RETENTION_DAYS: z.coerce.number().positive().default(7),
  CLEANUP_INTERVAL_MINUTES: z.coerce.number().positive().default(60),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  VIDEO_TIMEOUT_MINUTES: z.coerce.number().positive().default(60),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  SLOW_REQUEST_MS: z.coerce.number().positive().default(500),
  SLOW_QUERY_MS: z.coerce.number().positive().default(100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RATE_LIMIT_ENABLED: bool,
});

export type Env = z.infer<typeof schema> & {
  storageRoot: string;
  appOrigins: string[];
  cookieSecure: boolean;
  maxUploadBytes: number;
  vaultMaxBytes: number;
};

export class ConfigError extends Error {}

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join('\n')}\nSee apps/api/.env.example`);
  }
  const e = result.data;
  return {
    ...e,
    storageRoot: path.resolve(e.FILE_STORAGE_PATH),
    appOrigins: e.APP_ORIGIN.split(',').map((o) => new URL(o.trim()).origin),
    cookieSecure: e.COOKIE_SECURE ? e.COOKIE_SECURE === 'true' : e.NODE_ENV === 'production',
    maxUploadBytes: Math.floor(e.MAX_UPLOAD_SIZE_MB * 1024 * 1024),
    vaultMaxBytes: Math.floor(e.VAULT_MAX_SIZE_MB * 1024 * 1024),
  };
}

let cached: Env | undefined;

/** Validated configuration, parsed once on first use (the server touches it at startup). */
export function getEnv(): Env {
  if (!cached) {
    if (process.env.NODE_ENV !== 'test') dotenv.config();
    cached = parseEnv(process.env);
  }
  return cached;
}

export function resetEnvForTests(): void {
  cached = undefined;
}
