import { Router } from 'express';
import sharp from 'sharp';
import { z } from 'zod';
import { getEnv } from '../../config/env';
import { AppError } from '../../lib/errors';
import { ok } from '../../lib/http';
import { OPERATIONS, OPERATION_NAMES, PRESETS } from '../../processors/operations';
import { baseNameOf } from '../../security/filename';
import { SUPPORTED_TYPES } from '../../security/fileTypes';
import { fileRepository } from '../../repositories/fileRepository';
import { storage, type StorageArea } from '../../storage';
import { deleteFile, getFileForDownload, ingestUpload } from '../../services/fileService';
import { cancelJob, createJob, getJob, getJobDownload } from '../../services/jobService';
import { operationCatalog, publicFile, publicJob } from '../../services/dto';
import { rateLimit } from '../middleware/security';
import { longRunning } from '../middleware/requestContext';
import { singleFileUpload, uploadedFile } from '../middleware/upload';
import { sendStored } from '../sendFile';

const idParam = z.object({ id: z.string().uuid('Invalid id') });

const createJobBody = z
  .object({
    fileId: z.string().uuid().optional(),
    fileIds: z.array(z.string().uuid()).min(1).max(30).optional(),
    operation: z.string().min(1).max(64),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((b) => (b.fileId === undefined) !== (b.fileIds === undefined), {
    message: 'Send either fileId or fileIds',
  });

export const publicRouter = Router();

publicRouter.get('/formats', (_req, res) => {
  ok(res, {
    maxUploadBytes: getEnv().maxUploadBytes,
    retentionDays: getEnv().FILE_RETENTION_DAYS,
    types: SUPPORTED_TYPES.map((t) => ({ extension: t.ext, mimeType: t.mime, category: t.category })),
    presets: PRESETS,
    operations: OPERATION_NAMES.map((name) => ({ operation: name, ...OPERATIONS[name] })),
  });
});

publicRouter.post(
  '/files/upload',
  rateLimit('upload', 60, 60_000),
  longRunning,
  singleFileUpload(() => getEnv().maxUploadBytes),
  async (req, res) => {
    const { path, originalname } = uploadedFile(req);
    const file = await ingestUpload(path, originalname);
    ok(res, { file: publicFile(file), suggestedOperations: operationCatalog(file.category) }, undefined, 201);
  },
);

publicRouter.get('/files/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const file = await fileRepository.findById(id);
  if (!file) throw new AppError('FILE_NOT_FOUND', 'That file was not found.');
  if (file.status === 'DELETED') throw new AppError('FILE_EXPIRED', 'This file has been removed.');
  ok(res, { file: publicFile(file), suggestedOperations: operationCatalog(file.category) });
});

/** Small WebP preview, images only (safe: re-encoded by sharp, never the raw upload). */
publicRouter.get('/files/:id/thumbnail', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { file, area, storedName } = await getFileForDownload(id);
  if (file.category !== 'image') throw new AppError('INVALID_OPERATION', 'Previews are only available for images.');
  const copy = await storage().materialize(area as StorageArea, storedName);
  let bytes: Buffer;
  try {
    bytes = await sharp(copy.path, { limitInputPixels: getEnv().MAX_IMAGE_PIXELS })
      .rotate()
      .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 70 })
      .toBuffer();
  } finally {
    await copy.release();
  }
  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(bytes);
});

publicRouter.delete('/files/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  ok(res, await deleteFile(id));
});

publicRouter.post('/jobs', rateLimit('jobs', 60, 60_000), async (req, res) => {
  const body = createJobBody.parse(req.body);
  const job = await createJob(body.fileIds ?? [body.fileId as string], body.operation, body.options);
  ok(res, { jobId: job.id, status: job.status }, undefined, 202);
});

publicRouter.get('/jobs/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  ok(res, publicJob(await getJob(id)));
});

publicRouter.post('/jobs/:id/cancel', async (req, res) => {
  const { id } = idParam.parse(req.params);
  ok(res, publicJob(await cancelJob(id)));
});

publicRouter.get('/jobs/:id/download', async (req, res, next) => {
  const { id } = idParam.parse(req.params);
  const { file, area, storedName } = await getJobDownload(id);
  const name = `${baseNameOf(file.originalName)}.${file.extension}`;
  await sendStored(res, next, area, storedName, name, file.mimeType);
});
