import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEST_DATABASE_URL } from './testEnv';

// Runs before each test file imports application code, so configuration is test-specific.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tero-test-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL,
  SESSION_SECRET: 'test-session-secret-0123456789abcdefghij',
  STORAGE_DRIVER: 'local', // most suites assert on-disk files; mysqlStorage.test.ts exercises the MySQL driver directly
  FILE_STORAGE_PATH: dir,
  MAX_UPLOAD_SIZE_MB: '5',
  VAULT_MAX_SIZE_MB: '5',
  FILE_RETENTION_DAYS: '7',
  RATE_LIMIT_ENABLED: 'false',
  LOG_LEVEL: 'silent',
  APP_ORIGIN: 'http://localhost:3000',
});
