import supertest from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/prisma';
import { adminAgent, app, closeAll, createAdmin, request, resetAll } from './helpers/harness';
import { TEST_ADMIN } from './helpers/testEnv';

beforeEach(resetAll);
afterAll(closeAll);

const PROTECTED_GETS = [
  '/api/v1/admin/auth/me',
  '/api/v1/admin/dashboard',
  '/api/v1/admin/files',
  '/api/v1/admin/jobs',
  '/api/v1/admin/audit-logs',
  '/api/v1/admin/storage',
  '/api/v1/admin/metrics',
  '/api/v1/admin/settings',
  '/api/v1/admin/vault',
];

describe('admin authentication', () => {
  it('logs in with correct credentials and sets a hardened session cookie', async () => {
    await createAdmin();
    const res = await request().post('/api/v1/admin/auth/login').send(TEST_ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.data.admin).toMatchObject({ email: TEST_ADMIN.email });
    expect(res.body.data.admin).not.toHaveProperty('passwordHash');
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/^tero_admin=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Expires=/i);
    const admin = await db().admin.findFirstOrThrow();
    expect(admin.lastLoginAt).not.toBeNull();
    expect(admin.passwordHash).not.toContain(TEST_ADMIN.password);
    expect(admin.passwordHash).toMatch(/^\$2[aby]\$/);
  });

  it('stores only a hash of the session token', async () => {
    const { agent } = await adminAgent();
    const session = await db().adminSession.findFirstOrThrow();
    expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await agent.get('/api/v1/admin/auth/me')).status).toBe(200);
  });

  it('rejects wrong password and unknown email identically, and sets no cookie', async () => {
    await createAdmin();
    const wrong = await request()
      .post('/api/v1/admin/auth/login')
      .send({ email: TEST_ADMIN.email, password: 'nope-nope-nope' });
    const unknown = await request()
      .post('/api/v1/admin/auth/login')
      .send({ email: 'ghost@test.local', password: 'nope-nope-nope' });
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('rejects inactive admins', async () => {
    await createAdmin({ isActive: false });
    const res = await request().post('/api/v1/admin/auth/login').send(TEST_ADMIN);
    expect(res.status).toBe(401);
  });

  it('locks out repeated failures from the same client/email', async () => {
    await createAdmin();
    for (let i = 0; i < 5; i++) {
      expect(
        (await request().post('/api/v1/admin/auth/login').send({ email: TEST_ADMIN.email, password: 'bad-bad-bad' }))
          .status,
      ).toBe(401);
    }
    const locked = await request().post('/api/v1/admin/auth/login').send(TEST_ADMIN);
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('validates the login body', async () => {
    const res = await request().post('/api/v1/admin/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it.each(PROTECTED_GETS)('GET %s without a session is 401', async (url) => {
    const res = await request().get(url);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
  });

  it('every admin mutation and download is protected too', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const calls = [
      request().post('/api/v1/admin/vault'),
      request().patch(`/api/v1/admin/vault/${id}`).send({ displayName: 'x' }),
      request().delete(`/api/v1/admin/vault/${id}`),
      request().get(`/api/v1/admin/vault/${id}/download`),
      request().delete(`/api/v1/admin/files/${id}`),
      request().get(`/api/v1/admin/files/${id}/download`),
      request().post('/api/v1/admin/storage/cleanup'),
      request().post('/api/v1/admin/auth/logout'),
    ];
    for (const c of calls) expect((await c).status).toBe(401);
  });

  it('rejects a forged or malformed session cookie', async () => {
    await createAdmin();
    for (const cookie of ['tero_admin=forged', `tero_admin=${'a'.repeat(500)}`, 'tero_admin=']) {
      const res = await request().get('/api/v1/admin/dashboard').set('Cookie', cookie);
      expect(res.status).toBe(401);
    }
  });

  it('issues a new session token on each login (no fixation) and logout invalidates it server-side', async () => {
    await createAdmin();
    const agent = supertest.agent(app);
    const loginRes = await agent.post('/api/v1/admin/auth/login').send(TEST_ADMIN);
    const first = await db().adminSession.findFirstOrThrow();
    const stolen = (loginRes.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;

    const second = supertest.agent(app);
    await second.post('/api/v1/admin/auth/login').send(TEST_ADMIN);
    const hashes = (await db().adminSession.findMany()).map((s) => s.tokenHash);
    expect(new Set(hashes).size).toBe(2);
    expect(hashes).toContain(first.tokenHash);

    const out = await agent.post('/api/v1/admin/auth/logout');
    expect(out.status).toBe(200);
    expect((await agent.get('/api/v1/admin/auth/me')).status).toBe(401);
    expect((await request().get('/api/v1/admin/auth/me').set('Cookie', stolen)).status).toBe(401);
    expect(await db().adminSession.count()).toBe(1);
  });

  it('refuses expired sessions', async () => {
    const { agent } = await adminAgent();
    await db().adminSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await agent.get('/api/v1/admin/auth/me')).status).toBe(401);
  });

  it('refuses state-changing admin requests from a foreign Origin (CSRF guard)', async () => {
    const { agent } = await adminAgent();
    const res = await agent.post('/api/v1/admin/auth/logout').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect((await agent.get('/api/v1/admin/auth/me')).status).toBe(200);
  });
});
