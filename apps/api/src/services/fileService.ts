import fs from 'node:fs/promises';
import { getEnv } from '../config/env';
import { AppError } from '../lib/errors';
import { sha256File } from '../lib/hash';
import { logger } from '../lib/logger';
import { sanitizeFilename, extensionOf } from '../security/filename';
import { detectType } from '../security/fileTypes';
import { fileRepository } from '../repositories/fileRepository';
import { storage, parseStoragePath, type StorageArea } from '../storage';
import { cancelJobsForFile } from './jobRunner';

const DAY_MS = 86_400_000;

export function expiryFromNow(now = new Date()): Date {
  return new Date(now.getTime() + getEnv().FILE_RETENTION_DAYS * DAY_MS);
}

/**
 * Turn a freshly received temp file into a stored, validated File record.
 * The temp file is always consumed (moved into storage or deleted).
 */
export async function ingestUpload(tempPath: string, clientName: string) {
  const env = getEnv();
  try {
    const stat = await fs.stat(tempPath);
    if (stat.size === 0) throw new AppError('INVALID_FILE', 'This file is empty.');
    if (stat.size > env.maxUploadBytes) {
      throw new AppError('FILE_TOO_LARGE', `This file is larger than the ${env.MAX_UPLOAD_SIZE_MB} MB limit.`);
    }

    const originalName = sanitizeFilename(clientName);
    const detected = await detectType(tempPath);
    if (!detected) {
      throw new AppError('UNSUPPORTED_FILE_TYPE', 'This file type is not supported.');
    }
    const claimedExt = extensionOf(originalName);
    if (!detected.allowedExtensions.includes(claimedExt)) {
      throw new AppError('INVALID_FILE', 'The file name does not match what is inside the file.');
    }

    const checksum = await sha256File(tempPath);
    const stored = await storage().importFile('ORIGINAL', tempPath, detected.ext);
    try {
      return await fileRepository.create({
        role: 'UPLOAD',
        originalName,
        storedName: stored.storedName,
        extension: detected.ext,
        mimeType: detected.mime,
        category: detected.category,
        sizeBytes: stored.sizeBytes,
        storageArea: stored.area,
        storagePath: stored.storagePath,
        checksum,
        status: 'UPLOADED',
        expiresAt: expiryFromNow(),
      });
    } catch (err) {
      await storage()
        .delete(stored.area, stored.storedName)
        .catch(() => undefined);
      throw err;
    }
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

export interface PurgeTarget {
  id: string;
  storedName: string;
  storageArea: string;
}

/**
 * Remove bytes for a file and mark it DELETED. An already-missing physical file counts as success;
 * a real deletion failure leaves the record untouched so it can be retried.
 */
export async function purgeFile(target: PurgeTarget): Promise<'deleted' | 'missing' | 'failed'> {
  const area = target.storageArea as StorageArea;
  try {
    const existed = await storage().delete(area, target.storedName);
    await fileRepository.setStatus(target.id, 'DELETED');
    return existed ? 'deleted' : 'missing';
  } catch (err) {
    logger().error({ fileId: target.id, err: String(err) }, 'failed to delete stored file');
    return 'failed';
  }
}

/** Delete a file, everything generated from it, and cancel any work still running on it. */
export async function deleteFile(id: string) {
  const file = await fileRepository.findStorageInfo(id);
  if (!file || file.status === 'DELETED') throw new AppError('FILE_NOT_FOUND', 'That file was not found.');

  await cancelJobsForFile(id);
  const outputs = await fileRepository.findOutputsOf(id);
  for (const out of outputs) {
    if (out.status !== 'DELETED') await purgeFile(out);
  }
  const result = await purgeFile({ id, storedName: file.storedName, storageArea: file.storageArea });
  if (result === 'failed') throw new AppError('STORAGE_ERROR', 'The file could not be deleted. Please try again.');
  return { id, status: 'DELETED' as const };
}

export async function getFileForDownload(id: string) {
  const file = await fileRepository.findStorageInfo(id);
  if (!file) throw new AppError('FILE_NOT_FOUND', 'That file was not found.');
  if (file.status === 'DELETED') throw new AppError('FILE_EXPIRED', 'This file has been removed.');
  const parsed = parseStoragePath(`${file.storageArea}/${file.storedName}`);
  if (!parsed || !(await storage().exists(parsed.area, parsed.storedName))) {
    throw new AppError('FILE_NOT_FOUND', 'The file is no longer available.');
  }
  return { file, area: parsed.area, storedName: parsed.storedName };
}
