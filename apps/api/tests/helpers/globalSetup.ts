import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { TEST_DATABASE_URL } from './testEnv';

/** Create the test database if needed and bring it to the latest schema using real migrations. */
export default async function setup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  if (!/^[\w]+$/.test(dbName) || !dbName.includes('test')) {
    throw new Error(`Refusing to run tests against database "${dbName}" (name must contain "test")`);
  }
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/mysql';
  const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
  } finally {
    await admin.$disconnect();
  }
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['prisma', 'migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
}
