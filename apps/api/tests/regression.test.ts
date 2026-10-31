import sharp from 'sharp';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';
import { db } from '../src/db/prisma';
import { app, adminAgent, closeAll, createAdmin, processFile, request, resetAll, upload } from './helpers/harness';
import { makeJpeg } from './helpers/fixtures';
import { TEST_ADMIN } from './helpers/testEnv';

beforeEach(resetAll);
afterAll(closeAll);

/** Bugs found while testing the running stack; each has a failing-first test here. */

describe('admin access from a LAN address / other host name', () => {
  it('accepts the Origin the browser actually used (X-Forwarded-Host set by the web proxy)', async () => {
    await createAdmin();
    const res = await request()
      .post('/api/v1/admin/auth/login')
      .set('Origin', 'http://192.168.1.6:3000')
      .set('X-Forwarded-Host', '192.168.1.6:3000')
      .send(TEST_ADMIN);
    expect(res.status).toBe(200);
  });

  it('still rejects a foreign origin, even if it lies about the forwarded host of another site', async () => {
    await createAdmin();
    const res = await request()
      .post('/api/v1/admin/auth/login')
      .set('Origin', 'https://evil.example')
      .set('X-Forwarded-Host', '192.168.1.6:3000')
      .send(TEST_ADMIN);
    expect(res.status).toBe(403);
    const noHeader = await request()
      .post('/api/v1/admin/auth/login')
      .set('Origin', 'https://evil.example')
      .send(TEST_ADMIN);
    expect(noHeader.status).toBe(403);
  });

  it('APP_ORIGIN accepts several comma-separated origins and rejects junk', () => {
    const base = { DATABASE_URL: 'mysql://u@h/d', SESSION_SECRET: 'x'.repeat(32) };
    const env = parseEnv({ ...base, APP_ORIGIN: 'http://localhost:3000, https://tero.example.com' });
    expect(env.appOrigins).toEqual(['http://localhost:3000', 'https://tero.example.com']);
    expect(() => parseEnv({ ...base, APP_ORIGIN: 'not a url' })).toThrow();
  });

  it('cookie Secure flag follows NODE_ENV but can be overridden for plain-HTTP home networks', () => {
    const base = { DATABASE_URL: 'mysql://u@h/d', SESSION_SECRET: 'x'.repeat(32) };
    expect(parseEnv({ ...base, NODE_ENV: 'production' }).cookieSecure).toBe(true);
    expect(parseEnv({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
    expect(parseEnv({ ...base, NODE_ENV: 'development' }).cookieSecure).toBe(false);
  });
});

describe('files that look like video but are not', () => {
  const ftyp = (brand: string) =>
    Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(40, 1)]);

  it.each([
    ['photo.heic', 'heic'],
    ['photo.heif', 'mif1'],
    ['photo.avif', 'avif'],
    ['song.m4a', 'M4A '],
  ])('%s (brand %s) is refused as unsupported, not mistaken for MP4', async (name, brand) => {
    const res = await upload(ftyp(brand), name);
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it('real MP4 brands are still accepted by detection (isom)', async () => {
    // header-only buffer: detection passes, so the failure (if any) must not be UNSUPPORTED_FILE_TYPE
    const res = await upload(ftyp('isom'), 'clip.mp4');
    expect(res.status).toBe(201);
  });
});

describe('animated images', () => {
  it('are refused with a clear message instead of silently dropping frames', async () => {
    const frame = (c: string) =>
      sharp({ create: { width: 20, height: 20, channels: 3, background: c } })
        .png()
        .toBuffer();
    const animated = await sharp([await frame('#f00'), await frame('#0f0')], { join: { animated: true } })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect((await sharp(animated, { pages: -1 }).metadata()).pages).toBe(2);
    const up = await upload(animated, 'anim.webp');
    expect(up.status).toBe(201);
    const { job } = await processFile(up.body.data.file.id, 'IMAGE_COMPRESS');
    expect(job.status).toBe('FAILED');
    expect(job.error.message).toBe('Animated images are not supported yet.');
  });
});

describe('health and dashboard', () => {
  it('/health reports database status', async () => {
    const res = await request().get('/health');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: 'ok', database: 'up' });
  });

  it('uploads-by-day uses the server local calendar day, matching "uploads today"', async () => {
    const { agent } = await adminAgent();
    const up = await upload(await makeJpeg(100, 100), 'a.jpg');
    expect(up.status).toBe(201);
    const dash = (await agent.get('/api/v1/admin/dashboard')).body.data;
    const localToday = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
    expect(dash.uploads.today).toBe(1);
    expect(dash.uploadsByDay).toEqual([{ day: localToday, count: 1 }]);

    // a row created just after local midnight must land on that local day, whatever the UTC date is
    const startOfLocalDay = new Date();
    startOfLocalDay.setHours(0, 30, 0, 0);
    await db().file.updateMany({ data: { createdAt: startOfLocalDay } });
    const again = (await agent.get('/api/v1/admin/dashboard')).body.data;
    expect(again.uploadsByDay).toEqual([{ day: localToday, count: 1 }]);
    expect(again.uploads.today).toBe(1);
  });
});

describe('downloads', () => {
  it('a client that disconnects mid-download does not break later downloads or leak the stream', async () => {
    const jpeg = await makeJpeg(1600, 1200);
    const up = await upload(jpeg, 'a.jpg');
    const { job } = await processFile(up.body.data.file.id, 'IMAGE_STRIP_METADATA');
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      for (let i = 0; i < 3; i++) {
        await new Promise<void>((resolve) => {
          const req = http.get({ port, path: job.downloadUrl }, (res) => {
            res.once('data', () => {
              req.destroy(); // abandon the download after the first bytes
              resolve();
            });
          });
          req.on('error', () => undefined);
        });
      }
      const ok = await fetch(`http://127.0.0.1:${port}${job.downloadUrl}`);
      expect(ok.status).toBe(200);
      expect((await ok.arrayBuffer()).byteLength).toBe(job.outputSizeBytes);
    } finally {
      server.close();
    }
  });
});

describe('input handling found by probing', () => {
  it('malformed multipart bodies are a 400, not a 500', async () => {
    const broken = await request()
      .post('/api/v1/files/upload')
      .set('Content-Type', 'multipart/form-data; boundary=XX')
      .send('--XX\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\n\r\nabc');
    expect(broken.status).toBe(400);
    expect(broken.body.error.code).toBe('INVALID_FILE');
    const noBoundary = await request()
      .post('/api/v1/files/upload')
      .set('Content-Type', 'multipart/form-data')
      .send('x');
    expect(noBoundary.status).toBe(400);
  });

  it('search treats % and _ literally instead of as SQL wildcards', async () => {
    const { agent } = await adminAgent();
    const base = {
      extension: 'jpg',
      mimeType: 'image/jpeg',
      category: 'image',
      sizeBytes: 1,
      storageArea: 'ORIGINAL',
      storagePath: 'ORIGINAL/x',
      checksum: 'a'.repeat(64),
    };
    const names = ['a_b.jpg', 'axb.jpg', '50%.jpg', 'plain.jpg'];
    for (const [i, originalName] of names.entries()) {
      await db().file.create({
        data: { ...base, originalName, storedName: `00000000-0000-4000-8000-00000000000${i}` },
      });
    }
    const search = async (q: string) =>
      (await agent.get(`/api/v1/admin/files?q=${encodeURIComponent(q)}`)).body.data.map(
        (f: { originalName: string }) => f.originalName,
      );
    expect(await search('a_b')).toEqual(['a_b.jpg']);
    expect(await search('%')).toEqual(['50%.jpg']);
    expect(await search('_')).toEqual(['a_b.jpg']);
    expect(await search('plain')).toEqual(['plain.jpg']);

    const created = await agent
      .post('/api/v1/admin/vault')
      .field('description', '100% sure')
      .attach('file', Buffer.from('x'), 'n_1.txt');
    expect(created.status).toBe(201);
    await agent.post('/api/v1/admin/vault').attach('file', Buffer.from('y'), 'nx1.txt');
    expect((await agent.get('/api/v1/admin/vault?q=n_1')).body.data).toHaveLength(1);
    expect((await agent.get('/api/v1/admin/vault?q=%25')).body.data).toHaveLength(1);
  });

  it('absurd page numbers are rejected', async () => {
    const { agent } = await adminAgent();
    expect((await agent.get('/api/v1/admin/files?page=99999999999')).status).toBe(400);
  });
});

describe('job lifecycle races', () => {
  it('two simultaneous jobs on one file both complete and the file ends AVAILABLE', async () => {
    const up = await upload(await makeJpeg(800, 600), 'a.jpg');
    const id = up.body.data.file.id as string;
    const [a, b] = await Promise.all([processFile(id, 'IMAGE_COMPRESS'), processFile(id, 'IMAGE_STRIP_METADATA')]);
    expect(a.job.status).toBe('COMPLETED');
    expect(b.job.status).toBe('COMPLETED');
    expect((await db().file.findUniqueOrThrow({ where: { id } })).status).toBe('AVAILABLE');
    expect(await db().file.count({ where: { role: 'OUTPUT' } })).toBe(2);
  });

  it('deleting a file while its job is queued leaves no orphan output or stuck job', async () => {
    const up = await upload(await makeJpeg(800, 600), 'a.jpg');
    const id = up.body.data.file.id as string;
    const created = await request().post('/api/v1/jobs').send({ fileId: id, operation: 'IMAGE_COMPRESS' });
    await request().delete(`/api/v1/files/${id}`);
    await new Promise((r) => setTimeout(r, 800));
    const job = (await request().get(`/api/v1/jobs/${created.body.data.jobId}`)).body.data;
    expect(['CANCELLED', 'COMPLETED', 'FAILED']).toContain(job.status);
    expect((await db().file.findUniqueOrThrow({ where: { id } })).status).toBe('DELETED');
    // whatever the race outcome, nothing active may remain pointing at deleted bytes
    expect(await db().file.count({ where: { role: 'OUTPUT', status: { not: 'DELETED' } } })).toBe(0);
  });
});

describe('restart recovery', () => {
  it('an interrupted job is failed and its file becomes usable again; a queued job resumes', async () => {
    const a = await upload(await makeJpeg(400, 300), 'a.jpg');
    const b = await upload(await makeJpeg(410, 310), 'b.jpg');
    const aId = a.body.data.file.id as string;
    const bId = b.body.data.file.id as string;
    await db().file.update({ where: { id: aId }, data: { status: 'PROCESSING' } });
    const stuck = await db().processingJob.create({
      data: {
        fileId: aId,
        operation: 'IMAGE_COMPRESS',
        originalSizeBytes: 1,
        status: 'PROCESSING',
        startedAt: new Date(),
      },
    });
    const queued = await db().processingJob.create({
      data: { fileId: bId, operation: 'IMAGE_COMPRESS', originalSizeBytes: 1, status: 'QUEUED' },
    });
    const { jobQueue } = await import('../src/queue/jobQueue');
    expect(await jobQueue.recover()).toEqual({ requeued: 1, interrupted: 1 });
    await jobQueue.onIdle();
    const failed = await db().processingJob.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'SERVER_RESTART' });
    expect((await db().file.findUniqueOrThrow({ where: { id: aId } })).status).toBe('UPLOADED');
    expect((await db().processingJob.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe('COMPLETED');
  });
});
