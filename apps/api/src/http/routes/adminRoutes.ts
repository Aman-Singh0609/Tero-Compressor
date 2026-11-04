import { Router, type Request } from 'express';
import { z } from 'zod';
import { getEnv } from '../../config/env';
import { AppError } from '../../lib/errors';
import { ok, paginate } from '../../lib/http';
import { recentTimings } from '../../lib/timing';
import { jobQueue } from '../../queue/jobQueue';
import { auditRepository } from '../../repositories/auditRepository';
import { dashboardRepository } from '../../repositories/dashboardRepository';
import { fileRepository } from '../../repositories/fileRepository';
import { jobRepository } from '../../repositories/jobRepository';
import { vaultRepository } from '../../repositories/vaultRepository';
import { OPERATION_NAMES } from '../../processors/operations';
import { audit } from '../../services/auditService';
import { SESSION_COOKIE, login, logout } from '../../services/authService';
import { adminJob } from '../../services/dto';
import { deleteFile, getFileForDownload } from '../../services/fileService';
import { getJob } from '../../services/jobService';
import { runCleanup } from '../../services/retentionService';
import {
  createVaultFile,
  deleteVaultFile,
  getVaultFile,
  openVaultDownload,
  replaceVaultFile,
} from '../../services/vaultService';
import { storage } from '../../storage';
import { longRunning, requestMetrics } from '../middleware/requestContext';
import { originGuard, rateLimit, requireAdmin } from '../middleware/security';
import { singleFileUpload, uploadedFile } from '../middleware/upload';
import { sendStored } from '../sendFile';

const id = z.object({ id: z.string().uuid('Invalid id') });
const page = z.coerce.number().int().min(1).max(100_000).default(1);
const limit = z.coerce.number().int().min(1).max(100).default(25);
const order = z.enum(['asc', 'desc']).default('desc');
const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

const loginBody = z.object({ email: z.string().email().max(255), password: z.string().min(1).max(200) });

const filesQuery = z.object({
  page,
  limit,
  q: optionalText(100),
  type: z.enum(['image', 'pdf', 'video', 'audio', 'document']).optional(),
  status: z.enum(['UPLOADED', 'PROCESSING', 'AVAILABLE', 'FAILED', 'DELETED']).optional(),
  role: z.enum(['UPLOAD', 'OUTPUT']).optional(),
  sort: z.enum(['createdAt', 'sizeBytes', 'originalName', 'status']).default('createdAt'),
  order,
});

const jobsQuery = z.object({
  page,
  limit,
  status: z.enum(['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
  operation: z.enum(OPERATION_NAMES).optional(),
  fileId: z.string().uuid().optional(),
});

const auditQuery = z.object({
  page,
  limit,
  action: z
    .enum([
      'ADMIN_LOGIN',
      'ADMIN_LOGIN_FAILED',
      'ADMIN_LOGOUT',
      'FILE_VIEW',
      'FILE_DOWNLOAD',
      'FILE_DELETE',
      'VAULT_UPLOAD',
      'VAULT_VIEW',
      'VAULT_DOWNLOAD',
      'VAULT_UPDATE',
      'VAULT_REPLACE',
      'VAULT_DELETE',
      'JOB_VIEW',
      'SETTINGS_CHANGE',
    ])
    .optional(),
  entityType: optionalText(32),
  entityId: optionalText(64),
});

const vaultQuery = z.object({
  page,
  limit,
  q: optionalText(100),
  type: optionalText(16),
  sort: z.enum(['createdAt', 'displayName', 'sizeBytes', 'downloadCount']).default('createdAt'),
  order,
});

const vaultPatch = z
  .object({
    displayName: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((v) => v.displayName !== undefined || v.description !== undefined, { message: 'Nothing to update' });

const ctx = (req: Request) => ({ adminId: req.admin?.id ?? null, ip: req.ip });

export const adminRouter = Router();
adminRouter.use(originGuard);

// ---- auth ---------------------------------------------------------------

adminRouter.post('/auth/login', rateLimit('admin-login', 30, 15 * 60_000), async (req, res) => {
  const body = loginBody.parse(req.body);
  const ip = req.ip ?? 'unknown';
  try {
    const session = await login(body.email, body.password, ip);
    res.cookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: getEnv().cookieSecure,
      expires: session.expiresAt,
      path: '/',
    });
    await audit({ adminId: session.admin.id, ip }, 'ADMIN_LOGIN', { type: 'Admin', id: session.admin.id });
    ok(res, { admin: session.admin, expiresAt: session.expiresAt });
  } catch (err) {
    if (err instanceof AppError && err.code === 'INVALID_CREDENTIALS') {
      // the attempted email is deliberately not logged; no password is ever recorded
      await audit({ adminId: null, ip }, 'ADMIN_LOGIN_FAILED');
    }
    throw err;
  }
});

adminRouter.use(requireAdmin);

adminRouter.post('/auth/logout', async (req, res) => {
  await logout(req.sessionToken as string);
  await audit(ctx(req), 'ADMIN_LOGOUT', { type: 'Admin', id: req.admin!.id });
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  ok(res, { loggedOut: true });
});

adminRouter.get('/auth/me', (req, res) => {
  ok(res, { admin: req.admin });
});

// ---- dashboard / diagnostics -------------------------------------------

adminRouter.get('/dashboard', async (_req, res) => {
  ok(res, await dashboardRepository.getStats(new Date()));
});

adminRouter.get('/storage', async (_req, res) => {
  const [disk, fileTotals, vaultTotals] = await Promise.all([
    storage().usage(),
    fileRepository.sizeTotals(),
    vaultRepository.totals(),
  ]);
  ok(res, {
    disk,
    database: {
      temporaryFiles: { count: fileTotals._count, bytes: Number(fileTotals._sum.sizeBytes ?? 0) },
      vault: { count: vaultTotals._count, bytes: Number(vaultTotals._sum.sizeBytes ?? 0) },
    },
    retentionDays: getEnv().FILE_RETENTION_DAYS,
  });
});

adminRouter.post('/storage/cleanup', async (_req, res) => {
  ok(res, await runCleanup());
});

adminRouter.get('/metrics', (_req, res) => {
  const timings = new Map<string, { count: number; total: number; max: number }>();
  for (const t of recentTimings()) {
    const e = timings.get(t.name) ?? { count: 0, total: 0, max: 0 };
    e.count++;
    e.total += t.durationMs;
    e.max = Math.max(e.max, t.durationMs);
    timings.set(t.name, e);
  }
  ok(res, {
    requests: requestMetrics(),
    dataOperations: [...timings.entries()].map(([name, e]) => ({
      name,
      count: e.count,
      avgMs: Math.round(e.total / e.count),
      maxMs: e.max,
    })),
    queue: jobQueue.stats(),
    process: { uptimeSeconds: Math.round(process.uptime()), rssBytes: process.memoryUsage().rss },
  });
});

adminRouter.get('/settings', (_req, res) => {
  const env = getEnv();
  ok(res, {
    retentionDays: env.FILE_RETENTION_DAYS,
    cleanupIntervalMinutes: env.CLEANUP_INTERVAL_MINUTES,
    maxUploadMb: env.MAX_UPLOAD_SIZE_MB,
    vaultMaxMb: env.VAULT_MAX_SIZE_MB,
    jobConcurrency: env.JOB_CONCURRENCY,
    videoTimeoutMinutes: env.VIDEO_TIMEOUT_MINUTES,
    sessionTtlHours: env.SESSION_TTL_HOURS,
    environment: env.NODE_ENV,
    storageDriver: env.STORAGE_DRIVER,
  });
});

// ---- files --------------------------------------------------------------

adminRouter.get('/files', async (req, res) => {
  const q = filesQuery.parse(req.query);
  const { items, total } = await fileRepository.findMany(
    { category: q.type, status: q.status, role: q.role, q: q.q },
    { field: q.sort, order: q.order },
    q.page,
    q.limit,
  );
  ok(res, items, { pagination: paginate(q.page, q.limit, total) });
});

adminRouter.get('/files/:id', async (req, res) => {
  const { id: fileId } = id.parse(req.params);
  const file = await fileRepository.findById(fileId);
  if (!file) throw new AppError('FILE_NOT_FOUND', 'That file was not found.');
  await audit(ctx(req), 'FILE_VIEW', { type: 'File', id: fileId });
  ok(res, file);
});

adminRouter.get('/files/:id/download', longRunning, async (req, res, next) => {
  const { id: fileId } = id.parse(req.params);
  const { file, area, storedName } = await getFileForDownload(fileId);
  await audit(ctx(req), 'FILE_DOWNLOAD', { type: 'File', id: fileId });
  await sendStored(res, next, area, storedName, file.originalName, file.mimeType);
});

adminRouter.delete('/files/:id', async (req, res) => {
  const { id: fileId } = id.parse(req.params);
  const result = await deleteFile(fileId);
  await audit(ctx(req), 'FILE_DELETE', { type: 'File', id: fileId });
  ok(res, result);
});

// ---- jobs ---------------------------------------------------------------

adminRouter.get('/jobs', async (req, res) => {
  const q = jobsQuery.parse(req.query);
  const { items, total } = await jobRepository.findMany(
    { status: q.status, operation: q.operation, fileId: q.fileId },
    q.page,
    q.limit,
  );
  ok(res, items.map(adminJob), { pagination: paginate(q.page, q.limit, total) });
});

adminRouter.get('/jobs/:id', async (req, res) => {
  const { id: jobId } = id.parse(req.params);
  const job = await getJob(jobId);
  await audit(ctx(req), 'JOB_VIEW', { type: 'ProcessingJob', id: jobId });
  ok(res, adminJob(job));
});

// ---- audit --------------------------------------------------------------

adminRouter.get('/audit-logs', async (req, res) => {
  const q = auditQuery.parse(req.query);
  const { items, total } = await auditRepository.findMany(
    { action: q.action, entityType: q.entityType, entityId: q.entityId },
    q.page,
    q.limit,
  );
  ok(res, items, { pagination: paginate(q.page, q.limit, total) });
});

// ---- vault --------------------------------------------------------------

adminRouter.post(
  '/vault',
  longRunning,
  singleFileUpload(() => getEnv().vaultMaxBytes),
  async (req, res) => {
    const { path, originalname } = uploadedFile(req);
    const description = z.string().trim().max(1000).optional().parse(req.body?.description);
    const displayName = z.string().trim().min(1).max(255).optional().parse(req.body?.displayName);
    const file = await createVaultFile(req.admin!.id, path, displayName ?? originalname, description);
    await audit(
      ctx(req),
      'VAULT_UPLOAD',
      { type: 'VaultFile', id: file.id },
      { name: file.displayName, sizeBytes: Number(file.sizeBytes) },
    );
    ok(res, file, undefined, 201);
  },
);

adminRouter.get('/vault', async (req, res) => {
  const q = vaultQuery.parse(req.query);
  const { items, total } = await vaultRepository.findMany(
    { q: q.q, category: q.type },
    { field: q.sort, order: q.order },
    q.page,
    q.limit,
  );
  ok(res, items, { pagination: paginate(q.page, q.limit, total) });
});

adminRouter.get('/vault/:id', async (req, res) => {
  const { id: vaultId } = id.parse(req.params);
  const file = await getVaultFile(vaultId);
  await audit(ctx(req), 'VAULT_VIEW', { type: 'VaultFile', id: vaultId });
  ok(res, file);
});

adminRouter.get('/vault/:id/download', longRunning, async (req, res, next) => {
  const { id: vaultId } = id.parse(req.params);
  const info = await openVaultDownload(vaultId);
  await vaultRepository.recordDownload(vaultId);
  await audit(ctx(req), 'VAULT_DOWNLOAD', { type: 'VaultFile', id: vaultId });
  await sendStored(res, next, 'VAULT', info.storedName, info.displayName, info.mimeType);
});

adminRouter.patch('/vault/:id', async (req, res) => {
  const { id: vaultId } = id.parse(req.params);
  const patch = vaultPatch.parse(req.body);
  await getVaultFile(vaultId);
  const updated = await vaultRepository.update(vaultId, patch);
  await audit(ctx(req), 'VAULT_UPDATE', { type: 'VaultFile', id: vaultId }, { fields: Object.keys(patch) });
  ok(res, updated);
});

adminRouter.put(
  '/vault/:id/file',
  longRunning,
  singleFileUpload(() => getEnv().vaultMaxBytes),
  async (req, res) => {
    const { id: vaultId } = id.parse(req.params);
    const { path, originalname } = uploadedFile(req);
    const updated = await replaceVaultFile(vaultId, path, originalname);
    await audit(ctx(req), 'VAULT_REPLACE', { type: 'VaultFile', id: vaultId });
    ok(res, updated);
  },
);

adminRouter.delete('/vault/:id', async (req, res) => {
  const { id: vaultId } = id.parse(req.params);
  const result = await deleteVaultFile(vaultId);
  await audit(ctx(req), 'VAULT_DELETE', { type: 'VaultFile', id: vaultId });
  ok(res, result);
});
