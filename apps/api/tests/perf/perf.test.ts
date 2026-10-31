import fs from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/prisma';
import { TEST_DATABASE_URL } from '../helpers/testEnv';
import { adminAgent, closeAll, resetAll } from '../helpers/harness';

/**
 * Opt-in (PERF=1): seeds a larger dataset, measures admin API latency and runs EXPLAIN on the
 * important queries. Results are written to docs/performance-measurements.json.
 */
const ROWS = Number(process.env.PERF_ROWS ?? 20_000);
const run = process.env.PERF ? describe : describe.skip;

// Prisma returns EXPLAIN columns positionally: f2=table f4=type f6=key f9=rows f11=Extra
const shape = (p: Record<string, unknown>) => ({
  table: p.f2,
  type: p.f4,
  key: p.f6,
  rows: Number(p.f9),
  extra: p.f11,
});

const results: { api: unknown[]; explain: unknown[]; dataset: Record<string, number> } = {
  api: [],
  explain: [],
  dataset: {},
};

async function seed() {
  const categories = ['image', 'pdf', 'video', 'document'];
  const statuses = ['AVAILABLE', 'UPLOADED', 'FAILED', 'DELETED'] as const;
  const ops = ['IMAGE_COMPRESS', 'PDF_COMPRESS', 'VIDEO_COMPRESS', 'DOCX_COMPRESS'] as const;
  const now = Date.now();
  const CHUNK = 2000;
  for (let start = 0; start < ROWS; start += CHUNK) {
    const idx = Array.from({ length: Math.min(CHUNK, ROWS - start) }, (_, k) => start + k);
    const hex = (n: number) => n.toString(16).padStart(12, '0');
    await db().file.createMany({
      data: idx.map((i) => ({
        id: `00000000-0000-4000-8000-${hex(i)}`,
        originalName: `family-${i}-${['holiday', 'invoice', 'school', 'wedding'][i % 4]}.${['jpg', 'pdf', 'mp4', 'docx'][i % 4]}`,
        storedName: `10000000-0000-4000-8000-${hex(i)}`,
        extension: ['jpg', 'pdf', 'mp4', 'docx'][i % 4]!,
        mimeType: 'application/octet-stream',
        category: categories[i % 4]!,
        sizeBytes: 50_000 + i * 13,
        storageArea: 'ORIGINAL',
        storagePath: `ORIGINAL/${i}`,
        checksum: String(i).padStart(64, '0'),
        status: statuses[i % 4]!,
        expiresAt: new Date(now + ((i % 14) - 7) * 86_400_000),
        createdAt: new Date(now - i * 30_000),
      })),
    });
    await db().processingJob.createMany({
      data: idx.map((i) => ({
        id: `20000000-0000-4000-8000-${hex(i)}`,
        fileId: `00000000-0000-4000-8000-${hex(i)}`,
        operation: ops[i % 4]!,
        status: (['COMPLETED', 'COMPLETED', 'FAILED', 'QUEUED'] as const)[i % 4]!,
        originalSizeBytes: 50_000 + i * 13,
        outputSizeBytes: 30_000 + i * 7,
        processingDurationMs: 500 + (i % 900),
        createdAt: new Date(now - i * 30_000),
      })),
    });
    await db().auditLog.createMany({
      data: idx.map((i) => ({
        action: 'FILE_VIEW' as const,
        entityType: 'File',
        entityId: `00000000-0000-4000-8000-${hex(i)}`,
        createdAt: new Date(now - i * 10_000),
      })),
    });
  }
  results.dataset = { files: ROWS, jobs: ROWS, auditLogs: ROWS };
}

run('performance (PERF=1)', () => {
  let agent: Awaited<ReturnType<typeof adminAgent>>['agent'];

  beforeAll(async () => {
    await resetAll();
    ({ agent } = await adminAgent());
    await seed();
    await db().$executeRawUnsafe('ANALYZE TABLE File, ProcessingJob, AuditLog, VaultFile');
  }, 300_000);
  afterAll(async () => {
    await fs.mkdir(path.resolve(__dirname, '../../../../docs'), { recursive: true });
    await fs.writeFile(
      path.resolve(__dirname, '../../../../docs/performance-measurements.json'),
      JSON.stringify({ measuredAt: new Date().toISOString(), ...results }, null, 2),
    );
    await resetAll();
    await closeAll();
  });

  const targets: Array<[string, string]> = [
    ['file list, default sort', '/api/v1/admin/files?page=1&limit=25'],
    ['file list, deep page', '/api/v1/admin/files?page=400&limit=25'],
    ['file list, filter type+status', '/api/v1/admin/files?type=pdf&status=AVAILABLE&limit=25'],
    ['file list, name search', '/api/v1/admin/files?q=wedding&limit=25'],
    ['file list, sort by size', '/api/v1/admin/files?sort=sizeBytes&order=desc&limit=25'],
    ['job list', '/api/v1/admin/jobs?limit=25'],
    ['job list, filter status', '/api/v1/admin/jobs?status=FAILED&limit=25'],
    ['audit log list', '/api/v1/admin/audit-logs?limit=25'],
    ['dashboard', '/api/v1/admin/dashboard'],
    ['storage', '/api/v1/admin/storage'],
  ];

  it.each(targets)('measures %s', async (label, url) => {
    await agent.get(url); // warm-up (connection pool, prepared statements)
    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t = performance.now();
      const res = await agent.get(url);
      times.push(performance.now() - t);
      expect(res.status).toBe(200);
    }
    times.sort((a, b) => a - b);
    const ms = (x: number) => Math.round(x * 10) / 10;
    results.api.push({
      label,
      url,
      runs: times.length,
      medianMs: ms(times[7]!),
      p95Ms: ms(times[13]!),
      maxMs: ms(times[14]!),
    });
  });

  it('records EXPLAIN plans for the important queries', async () => {
    const logged: Array<{ query: string; params: string; duration: number }> = [];
    const probe = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
    (probe.$on as unknown as (e: string, cb: (x: { query: string; params: string; duration: number }) => void) => void)(
      'query',
      (e) => logged.push(e),
    );
    const explain = async (label: string, fn: () => Promise<unknown>, pick: (q: string) => boolean) => {
      logged.length = 0;
      const t = performance.now();
      await fn();
      const ms = Math.round((performance.now() - t) * 10) / 10;
      const q = logged.find((l) => pick(l.query));
      if (!q) throw new Error(`no captured query for ${label}`);
      const params = JSON.parse(q.params) as unknown[];
      const plan = await probe.$queryRawUnsafe<Array<Record<string, unknown>>>(`EXPLAIN ${q.query}`, ...params);
      results.explain.push({
        label,
        prismaCallMs: ms,
        statementMs: logged.filter((l) => l.query.startsWith('SELECT')).map((l) => l.duration),
        plan: plan.map(shape),
      });
    };
    const w = (name: string) => (q: string) => q.startsWith('SELECT') && q.includes(name);
    await explain(
      'files: list newest (ORDER BY createdAt DESC LIMIT)',
      () =>
        probe.file.findMany({
          where: { role: 'UPLOAD' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 25,
          select: { id: true },
        }),
      w('FROM `tero_test`.`File`'),
    );
    await explain(
      'files: category + status filter',
      () =>
        probe.file.findMany({
          where: { role: 'UPLOAD', category: 'pdf', status: 'AVAILABLE' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 25,
          select: { id: true },
        }),
      w('FROM `tero_test`.`File`'),
    );
    await explain(
      'files: status filter count',
      () => probe.file.count({ where: { role: 'UPLOAD', status: 'FAILED' } }),
      w('COUNT'),
    );
    await explain(
      'files: retention scan (expiresAt, status)',
      () =>
        probe.file.findMany({
          where: {
            expiresAt: { lte: new Date() },
            status: { not: 'DELETED' },
            jobs: { none: { status: { in: ['QUEUED', 'PROCESSING'] } } },
          },
          take: 200,
          orderBy: { expiresAt: 'asc' },
          select: { id: true },
        }),
      w('FROM `tero_test`.`File`'),
    );
    await explain(
      'jobs: list newest',
      () =>
        probe.processingJob.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 25,
          select: { id: true },
        }),
      w('FROM `tero_test`.`ProcessingJob`'),
    );
    await explain(
      'jobs: filter status + newest',
      () =>
        probe.processingJob.findMany({
          where: { status: 'FAILED' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 25,
          select: { id: true },
        }),
      w('FROM `tero_test`.`ProcessingJob`'),
    );
    await explain(
      'jobs: latest job per file (batched IN, no N+1)',
      () =>
        probe.file.findMany({
          take: 25,
          select: { id: true, jobs: { take: 1, orderBy: { createdAt: 'desc' }, select: { id: true } } },
        }),
      w('FROM `tero_test`.`ProcessingJob`'),
    );
    await explain(
      'audit: list newest',
      () =>
        probe.auditLog.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 25, select: { id: true } }),
      w('FROM `tero_test`.`AuditLog`'),
    );
    await explain(
      'audit: by entity',
      () =>
        probe.auditLog.findMany({
          where: { entityType: 'File', entityId: '00000000-0000-4000-8000-000000000001' },
          select: { id: true },
        }),
      w('FROM `tero_test`.`AuditLog`'),
    );
    await probe.$disconnect();

    const dash = await probe.$disconnect().then(() => new PrismaClient({ datasourceUrl: TEST_DATABASE_URL }));
    const rawPlans: Array<[string, string]> = [
      [
        'dashboard: job aggregate (single pass)',
        "SELECT COUNT(*), SUM(status='COMPLETED'), SUM(CASE WHEN status='COMPLETED' THEN originalSizeBytes END), AVG(CASE WHEN status='COMPLETED' THEN processingDurationMs END) FROM ProcessingJob",
      ],
      [
        'dashboard: uploads per day',
        "SELECT DATE(createdAt) AS day, COUNT(*) FROM File WHERE role='UPLOAD' AND createdAt >= NOW() - INTERVAL 14 DAY GROUP BY DATE(createdAt)",
      ],
      ['dashboard: files by category', "SELECT category, COUNT(*) FROM File WHERE role='UPLOAD' GROUP BY category"],
    ];
    for (const [label, sql] of rawPlans) {
      const plan = await dash.$queryRawUnsafe<Array<Record<string, unknown>>>(`EXPLAIN ${sql}`);
      results.explain.push({ label, plan: plan.map(shape) });
    }
    await dash.$disconnect();
    expect(results.explain.length).toBeGreaterThan(8);
  }, 120_000);
});
