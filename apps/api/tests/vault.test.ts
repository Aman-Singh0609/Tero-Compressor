import fs from 'node:fs/promises';
import path from 'node:path';
import type { Response } from 'superagent';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getEnv } from '../src/config/env';
import { db } from '../src/db/prisma';
import { EXE_BYTES, makeJpeg } from './helpers/fixtures';
import { adminAgent, closeAll, request, resetAll } from './helpers/harness';

beforeEach(resetAll);
afterAll(closeAll);

const binary = (res: Response, cb: (e: Error | null, b: Buffer) => void) => {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function vaultDir() {
  return fs.readdir(path.join(getEnv().storageRoot, 'vault'));
}

describe('vault', () => {
  it('requires an admin session for every operation', async () => {
    const res = await request().post('/api/v1/admin/vault').attach('file', Buffer.from('hello'), 'a.txt');
    expect(res.status).toBe(401);
    expect(await vaultDir()).toEqual([]);
  });

  it('uploads, lists, inspects, downloads (counting), updates, replaces and deletes', async () => {
    const { agent, admin } = await adminAgent();
    const content = Buffer.from('grandma recipe collection\n');

    const created = await agent
      .post('/api/v1/admin/vault')
      .field('description', 'Family recipes')
      .attach('file', content, { filename: 'recipes.txt', contentType: 'text/plain' });
    expect(created.status).toBe(201);
    const v = created.body.data;
    expect(v).toMatchObject({
      displayName: 'recipes.txt',
      description: 'Family recipes',
      mimeType: 'text/plain',
      category: 'document',
      downloadCount: 0,
      isAvailable: true,
    });
    expect(v.sizeBytes).toBe(content.length);
    expect(v.uploadedBy.id).toBe(admin.id);
    expect(await vaultDir()).toHaveLength(1);

    const row = await db().vaultFile.findUniqueOrThrow({ where: { id: v.id } });
    expect(row.storagePath).toBe(`VAULT/${row.storedName}`);
    expect(row.storedName).toMatch(/^[0-9a-f-]{36}\.txt$/);

    const list = await agent.get('/api/v1/admin/vault');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.meta.pagination.total).toBe(1);
    expect((await agent.get(`/api/v1/admin/vault/${v.id}`)).body.data.checksum).toMatch(/^[0-9a-f]{64}$/);

    const dl = await agent.get(`/api/v1/admin/vault/${v.id}/download`).buffer(true).parse(binary);
    expect(dl.status).toBe(200);
    expect((dl.body as Buffer).equals(content)).toBe(true);
    expect(dl.headers['content-disposition']).toContain('recipes.txt');
    await agent.get(`/api/v1/admin/vault/${v.id}/download`).buffer(true).parse(binary);
    const after = (await agent.get(`/api/v1/admin/vault/${v.id}`)).body.data;
    expect(after.downloadCount).toBe(2);
    expect(after.lastDownloadedAt).not.toBeNull();

    const patched = await agent
      .patch(`/api/v1/admin/vault/${v.id}`)
      .send({ displayName: 'Recipes 2024.txt', description: null });
    expect(patched.body.data).toMatchObject({ displayName: 'Recipes 2024.txt', description: null });
    expect((await agent.patch(`/api/v1/admin/vault/${v.id}`).send({})).status).toBe(400);

    const replaced = await agent
      .put(`/api/v1/admin/vault/${v.id}/file`)
      .attach('file', Buffer.from('new content here'), 'new.txt');
    expect(replaced.status).toBe(200);
    expect(replaced.body.data.sizeBytes).toBe(16);
    expect(replaced.body.data.downloadCount).toBe(0);
    expect(await vaultDir()).toHaveLength(1); // old bytes removed

    const del = await agent.delete(`/api/v1/admin/vault/${v.id}`);
    expect(del.body.data).toEqual({ id: v.id, deleted: true });
    expect(await vaultDir()).toEqual([]);
    expect(await db().vaultFile.count()).toBe(0);
    expect((await agent.get(`/api/v1/admin/vault/${v.id}`)).body.error.code).toBe('VAULT_FILE_NOT_FOUND');
  });

  it('searches, filters by type and sorts in SQL', async () => {
    const { agent } = await adminAgent();
    await agent.post('/api/v1/admin/vault').attach('file', await makeJpeg(100, 80), 'beach.jpg');
    await agent
      .post('/api/v1/admin/vault')
      .field('description', 'tax papers 2023')
      .attach('file', Buffer.from('abc'), 'notes.txt');
    await agent.post('/api/v1/admin/vault').attach('file', Buffer.from('archive'), 'old.zip');
    expect(
      (await agent.get('/api/v1/admin/vault?type=image')).body.data.map((f: { displayName: string }) => f.displayName),
    ).toEqual(['beach.jpg']);
    expect((await agent.get('/api/v1/admin/vault?q=tax')).body.data[0].displayName).toBe('notes.txt');
    expect((await agent.get('/api/v1/admin/vault?type=archive')).body.data).toHaveLength(1);
    const sorted = await agent.get('/api/v1/admin/vault?sort=displayName&order=asc');
    expect(sorted.body.data.map((f: { displayName: string }) => f.displayName)).toEqual([
      'beach.jpg',
      'notes.txt',
      'old.zip',
    ]);
    expect((await agent.get('/api/v1/admin/vault?limit=2&page=2')).body.data).toHaveLength(1);
  });

  it('blocks executables and oversized files, leaving nothing behind', async () => {
    const { agent } = await adminAgent();
    const exe = await agent.post('/api/v1/admin/vault').attach('file', EXE_BYTES, 'setup.exe');
    expect(exe.status).toBe(415);
    const big = await agent.post('/api/v1/admin/vault').attach('file', Buffer.alloc(6 * 1024 * 1024, 1), 'big.bin');
    expect(big.status).toBe(413);
    expect(await db().vaultFile.count()).toBe(0);
    expect(await vaultDir()).toEqual([]);
    expect(await fs.readdir(path.join(getEnv().storageRoot, 'temporary'))).toEqual([]);
  });

  it('serves unknown content as an opaque download, with a sanitised name', async () => {
    const { agent } = await adminAgent();
    const res = await agent
      .post('/api/v1/admin/vault')
      .attach('file', Buffer.from('<script>alert(1)</script>'), { filename: '..\\..\\page"<>.html' });
    expect(res.status).toBe(201);
    expect(res.body.data.mimeType).toBe('application/octet-stream');
    expect(res.body.data.displayName).not.toMatch(/[\\/"<>]/);
    const dl = await agent.get(`/api/v1/admin/vault/${res.body.data.id}/download`).buffer(true).parse(binary);
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);
  });

  it('reports a missing physical file as not found instead of crashing', async () => {
    const { agent } = await adminAgent();
    const res = await agent.post('/api/v1/admin/vault').attach('file', Buffer.from('data'), 'a.txt');
    const row = await db().vaultFile.findFirstOrThrow();
    await fs.rm(path.join(getEnv().storageRoot, 'vault', row.storedName));
    const dl = await agent.get(`/api/v1/admin/vault/${res.body.data.id}/download`);
    expect(dl.status).toBe(404);
    expect(dl.body.error.code).toBe('VAULT_FILE_NOT_FOUND');
  });
});
