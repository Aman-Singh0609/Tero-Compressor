import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorageService } from '../src/storage/localStorage';
import { baseNameOf, extensionOf, sanitizeFilename } from '../src/security/filename';
import { parseStoragePath } from '../src/storage/storage';
import { parseEnv, ConfigError } from '../src/config/env';
import { makeJpeg } from './helpers/fixtures';
import { adminAgent, closeAll, request, resetAll, upload } from './helpers/harness';

beforeEach(resetAll);
afterAll(closeAll);

describe('filename sanitisation', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\windows\\system32\\evil.dll', 'evil.dll'],
    ['normal name (1).jpg', 'normal name (1).jpg'],
    ['nul\0byte.jpg', 'nulbyte.jpg'],
    ['<script>alert(1)</script>.jpg', 'script_.jpg'],
    ['   ', 'file'],
    ['....', 'file'],
    ['.htaccess', 'htaccess'],
    ['trailing dots...', 'trailing dots'],
    ['CON:?*.txt', 'CON___.txt'],
  ])('%j → %j', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it('limits length while preserving the extension, and keeps unicode', () => {
    const long = sanitizeFilename(`${'a'.repeat(400)}.pdf`);
    expect(long.length).toBeLessThanOrEqual(180);
    expect(long.endsWith('.pdf')).toBe(true);
    expect(sanitizeFilename('café-photo.jpg')).toBe('café-photo.jpg');
    expect(sanitizeFilename(Buffer.from('फोटो.jpg', 'utf8').toString('latin1'))).toBe('फोटो.jpg');
  });

  it('extension helpers', () => {
    expect(extensionOf('a.tar.GZ')).toBe('gz');
    expect(extensionOf('noext')).toBe('');
    expect(baseNameOf('a.b.pdf')).toBe('a.b');
  });
});

describe('storage service path safety', () => {
  const root = path.resolve('./.tmp-storage-test');
  const s = new LocalStorageService(root);

  it.each([
    '../secret',
    '..\\secret',
    '/etc/passwd',
    'C:\\x',
    'a/b',
    '',
    'not-a-uuid.jpg',
    '00000000-0000-4000-8000-000000000000/../x',
    '00000000-0000-4000-8000-000000000000.jpg%00',
  ])('refuses stored name %j for every operation', async (name) => {
    await expect(s.read('ORIGINAL', name)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    await expect(s.delete('VAULT', name)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    await expect(s.exists('PROCESSED', name)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    await expect(s.materialize('TEMPORARY', name)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
  });

  it('rejects malicious extensions when generating names', () => {
    expect(() => s.generateStoredName('../x')).toThrow();
    expect(() => s.generateStoredName('a b')).toThrow();
    expect(s.generateStoredName('JPG')).toMatch(/\.jpg$/);
  });

  it('parses storage paths strictly', () => {
    expect(parseStoragePath('VAULT/abc')).toEqual({ area: 'VAULT', storedName: 'abc' });
    expect(parseStoragePath('VAULT/../abc')).toBeNull();
    expect(parseStoragePath('OTHER/abc')).toBeNull();
  });
});

describe('HTTP security behaviour', () => {
  it('error responses never include stack traces or internals', async () => {
    const res = await request().get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'That route does not exist.' } });
    const malformed = await request().post('/api/v1/jobs').set('Content-Type', 'application/json').send('{"broken":');
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(malformed.body)).not.toMatch(/SyntaxError|at |node_modules|\.ts/);
  });

  it('adds a request id and nosniff to every response', async () => {
    const res = await request().get('/api/v1/formats').set('X-Request-Id', 'client-supplied-id-123');
    expect(res.headers['x-request-id']).toBe('client-supplied-id-123');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const bad = await request().get('/api/v1/formats').set('X-Request-Id', 'bad id with spaces & <script>');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('cannot read another file through crafted job or file ids', async () => {
    await upload(await makeJpeg(100, 100), 'a.jpg');
    for (const id of ['../../.env', '%2e%2e%2f', '1 OR 1=1', "' OR '1'='1"]) {
      expect([400, 404]).toContain((await request().get(`/api/v1/jobs/${encodeURIComponent(id)}/download`)).status);
      expect([400, 404]).toContain((await request().get(`/api/v1/files/${encodeURIComponent(id)}`)).status);
    }
  });

  it('a client-supplied path in the JSON body is ignored/rejected', async () => {
    const res = await request().post('/api/v1/jobs').send({ fileId: '../../etc/passwd', operation: 'IMAGE_COMPRESS' });
    expect(res.status).toBe(400);
  });

  it('serves admin downloads as attachments with the stored mime, never inline html', async () => {
    const { agent } = await adminAgent();
    const created = await agent
      .post('/api/v1/admin/vault')
      .attach('file', Buffer.from('<html><script>1</script></html>'), 'x.html');
    const dl = await agent.get(`/api/v1/admin/vault/${created.body.data.id}/download`);
    expect(dl.headers['content-type']).toContain('application/octet-stream');
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);
  });
});

describe('environment validation', () => {
  const valid = { DATABASE_URL: 'mysql://u@localhost/tero', SESSION_SECRET: 'x'.repeat(32) };
  it('accepts a minimal valid config and applies defaults', () => {
    const env = parseEnv(valid);
    expect(env.FILE_RETENTION_DAYS).toBe(7);
    expect(env.maxUploadBytes).toBe(500 * 1024 * 1024);
  });
  it('fails with a readable message listing every problem', () => {
    expect(() => parseEnv({})).toThrow(ConfigError);
    try {
      parseEnv({ DATABASE_URL: 'postgres://x', SESSION_SECRET: 'short' });
    } catch (e) {
      expect((e as Error).message).toMatch(/DATABASE_URL must be a mysql:\/\//);
      expect((e as Error).message).toMatch(/SESSION_SECRET must be at least 32/);
    }
  });
});
