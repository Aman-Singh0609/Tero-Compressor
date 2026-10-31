import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/prisma';
import { makeJpeg } from './helpers/fixtures';
import { adminAgent, closeAll, createAdmin, processFile, request, resetAll, upload } from './helpers/harness';
import { TEST_ADMIN } from './helpers/testEnv';

beforeEach(resetAll);
afterAll(closeAll);

async function actions() {
  return await db().auditLog.findMany({
    orderBy: { createdAt: 'asc' },
    select: { action: true, entityType: true, entityId: true, adminId: true, metadata: true },
  });
}

describe('audit log', () => {
  it('records login, failed login and logout without secrets', async () => {
    await createAdmin();
    await request().post('/api/v1/admin/auth/login').send({ email: TEST_ADMIN.email, password: 'wrong-wrong-wrong' });
    const { agent } = await adminAgent();
    await agent.post('/api/v1/admin/auth/logout');
    const rows = await actions();
    expect(rows.map((r) => r.action)).toEqual(['ADMIN_LOGIN_FAILED', 'ADMIN_LOGIN', 'ADMIN_LOGOUT']);
    expect(JSON.stringify(rows)).not.toContain(TEST_ADMIN.password);
    expect(JSON.stringify(rows)).not.toContain('wrong-wrong');
  });

  it('records file, job and vault actions with the acting admin and entity', async () => {
    const { agent, admin } = await adminAgent();
    const up = await upload(await makeJpeg(200, 150), 'a.jpg');
    const fileId = up.body.data.file.id as string;
    const { job } = await processFile(fileId, 'IMAGE_COMPRESS');

    await agent.get(`/api/v1/admin/files/${fileId}`);
    await agent
      .get(`/api/v1/admin/files/${fileId}/download`)
      .buffer(true)
      .parse((r, cb) => {
        r.on('data', () => undefined);
        r.on('end', () => cb(null, Buffer.alloc(0)));
      });
    await agent.get(`/api/v1/admin/jobs/${job.id}`);
    await agent.delete(`/api/v1/admin/files/${fileId}`);
    const v = await agent.post('/api/v1/admin/vault').attach('file', Buffer.from('hello'), 'n.txt');
    const vid = v.body.data.id as string;
    await agent.get(`/api/v1/admin/vault/${vid}`);
    await agent
      .get(`/api/v1/admin/vault/${vid}/download`)
      .buffer(true)
      .parse((r, cb) => {
        r.on('data', () => undefined);
        r.on('end', () => cb(null, Buffer.alloc(0)));
      });
    await agent.patch(`/api/v1/admin/vault/${vid}`).send({ description: 'x' });
    await agent.put(`/api/v1/admin/vault/${vid}/file`).attach('file', Buffer.from('hello2'), 'n.txt');
    await agent.delete(`/api/v1/admin/vault/${vid}`);

    const rows = await actions();
    const seen = rows.map((r) => r.action);
    for (const expected of [
      'ADMIN_LOGIN',
      'FILE_VIEW',
      'FILE_DOWNLOAD',
      'JOB_VIEW',
      'FILE_DELETE',
      'VAULT_UPLOAD',
      'VAULT_VIEW',
      'VAULT_DOWNLOAD',
      'VAULT_UPDATE',
      'VAULT_REPLACE',
      'VAULT_DELETE',
    ]) {
      expect(seen, expected).toContain(expected);
    }
    const del = rows.find((r) => r.action === 'FILE_DELETE')!;
    expect(del).toMatchObject({ entityType: 'File', entityId: fileId, adminId: admin.id });
    const vaultUpload = rows.find((r) => r.action === 'VAULT_UPLOAD')!;
    expect(vaultUpload.metadata).toMatchObject({ name: 'n.txt', sizeBytes: 5 });
  });

  it('exposes the log through a paginated, filterable admin endpoint', async () => {
    const { agent } = await adminAgent();
    await agent.get('/api/v1/admin/vault');
    const v = await agent.post('/api/v1/admin/vault').attach('file', Buffer.from('hello'), 'n.txt');
    const res = await agent.get('/api/v1/admin/audit-logs?action=VAULT_UPLOAD');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ action: 'VAULT_UPLOAD', entityId: v.body.data.id });
    expect(res.body.data[0].admin).toMatchObject({ email: TEST_ADMIN.email });
    expect(res.body.meta.pagination.total).toBe(1);
    expect((await agent.get('/api/v1/admin/audit-logs?action=BOGUS')).status).toBe(400);
  });
});
