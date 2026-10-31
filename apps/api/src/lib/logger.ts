import pino from 'pino';
import { getEnv } from '../config/env';

let instance: pino.Logger | undefined;

/** Structured JSON logger. Credentials and cookies are redacted at the serializer level. */
export function logger(): pino.Logger {
  if (!instance) {
    const env = getEnv();
    instance = pino({
      level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: {
        paths: ['password', '*.password', 'token', '*.token', 'cookie', '*.cookie', 'authorization'],
        censor: '[REDACTED]',
      },
    });
  }
  return instance;
}
