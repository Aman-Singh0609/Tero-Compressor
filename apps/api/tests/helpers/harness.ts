import fs from 'node:fs/promises';
import bcrypt from 'bcryptjs';
import supertest from 'supertest';
import { createApp } from '../../src/app';
import { getEnv } from '../../src/config/env';
import { db, disconnectDb } from '../../src/db/prisma';
import { jobQueue } from '../../src/queue/jobQueue';
import { resetLoginThrottleForTests } from '../../src/services/authService';
import { storage } from '../../src/storage';
import { TEST_ADMIN } from './testEnv';

export const app = createApp();
export const request = () => supertest(app);

/** Empty every table (children first) and wipe the storage directories. */
export async function resetAll(): Promise<void> {
  await jobQueue.onIdle();
  const c = db();
  await c.auditLog.deleteMany();
  await c.processingJob.deleteMany();
  await c.file.deleteMany();
  await c.vaultFile.deleteMany();
  await c.storageObject.deleteMany(); // chunks cascade
  await c.adminSession.deleteMany();
  await c.admin.deleteMany();
  resetLoginThrottleForTests();
  const root = getEnv().storageRoot;
  await fs.rm(root, { recursive: true, force: true });
  await storage().ensureReady();
}

export async function createAdmin(overrides: Partial<{ email: string; password: string; isActive: boolean }> = {}) {
  const email = overrides.email ?? TEST_ADMIN.email;
  const password = overrides.password ?? TEST_ADMIN.password;
  return db().admin.create({
    data: {
      email,
      name: 'Test Admin',
      passwordHash: await bcrypt.hash(password, 4),
      isActive: overrides.isActive ?? true,
    },
    select: { id: true, email: true },
  });
}

/** A supertest agent that holds a real admin session cookie obtained through the login endpoint. */
export async function adminAgent() {
  const admin =
    (await db().admin.findUnique({ where: { email: TEST_ADMIN.email }, select: { id: true, email: true } })) ??
    (await createAdmin());
  const agent = supertest.agent(app);
  const res = await agent.post('/api/v1/admin/auth/login').send(TEST_ADMIN);
  if (res.status !== 200) throw new Error(`test admin login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, admin };
}

export async function upload(buffer: Buffer, filename: string, contentType?: string) {
  const req = request().post('/api/v1/files/upload').attach('file', buffer, { filename, contentType });
  return req;
}

export async function waitForJob(jobId: string, timeoutMs = 60_000) {
  const start = Date.now();
  for (;;) {
    const res = await request().get(`/api/v1/jobs/${jobId}`);
    const status = res.body.data?.status as string;
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) return res.body.data;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} stuck in ${status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function processFile(fileId: string, operation: string, options?: Record<string, unknown>) {
  const created = await request().post('/api/v1/jobs').send({ fileId, operation, options });
  if (created.status !== 202) return { created };
  const job = await waitForJob(created.body.data.jobId);
  return { created, job };
}

export async function closeAll(): Promise<void> {
  await jobQueue.onIdle();
  await disconnectDb();
}
