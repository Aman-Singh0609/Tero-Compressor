import fs from 'node:fs/promises';
import { getEnv } from '../config/env';
import { AppError } from '../lib/errors';
import { sha256File } from '../lib/hash';
import { logger } from '../lib/logger';
import { sanitizeFilename } from '../security/filename';
import { classifyVaultFile } from '../security/vaultTypes';
import { vaultRepository, type NewVaultFile } from '../repositories/vaultRepository';
import { storage } from '../storage';

async function importTemp(tempPath: string, clientName: string) {
  const env = getEnv();
  const displayName = sanitizeFilename(clientName);
  const stat = await fs.stat(tempPath);
  if (stat.size === 0) throw new AppError('INVALID_FILE', 'This file is empty.');
  if (stat.size > env.vaultMaxBytes) {
    throw new AppError('FILE_TOO_LARGE', `This file is larger than the ${env.VAULT_MAX_SIZE_MB} MB vault limit.`);
  }
  const kind = await classifyVaultFile(tempPath, displayName);
  if (!kind) throw new AppError('UNSUPPORTED_FILE_TYPE', 'Executable and script files cannot be stored.');
  const checksum = await sha256File(tempPath);
  const stored = await storage().importFile('VAULT', tempPath, kind.extension);
  return { displayName, kind, checksum, stored };
}

export async function createVaultFile(
  adminId: string,
  tempPath: string,
  clientName: string,
  description?: string | null,
) {
  try {
    const { displayName, kind, checksum, stored } = await importTemp(tempPath, clientName);
    const data: NewVaultFile = {
      displayName,
      storedName: stored.storedName,
      description: description ?? null,
      mimeType: kind.mimeType,
      extension: kind.extension,
      category: kind.category,
      sizeBytes: stored.sizeBytes,
      checksum,
      storagePath: stored.storagePath,
      uploadedByAdminId: adminId,
    };
    try {
      return await vaultRepository.create(data);
    } catch (err) {
      await storage()
        .delete('VAULT', stored.storedName)
        .catch(() => undefined);
      throw err;
    }
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

export async function replaceVaultFile(id: string, tempPath: string, clientName: string) {
  try {
    const existing = await vaultRepository.findStorageInfo(id);
    if (!existing) throw new AppError('VAULT_FILE_NOT_FOUND', 'That vault file was not found.');
    const { kind, checksum, stored } = await importTemp(tempPath, clientName);
    let updated;
    try {
      updated = await vaultRepository.replaceFile(id, {
        storedName: stored.storedName,
        storagePath: stored.storagePath,
        mimeType: kind.mimeType,
        extension: kind.extension,
        category: kind.category,
        sizeBytes: stored.sizeBytes,
        checksum,
      });
    } catch (err) {
      await storage()
        .delete('VAULT', stored.storedName)
        .catch(() => undefined);
      throw err;
    }
    await storage()
      .delete('VAULT', existing.storedName)
      .catch((err) => logger().error({ err: String(err), id }, 'old vault bytes not removed'));
    return updated;
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

export async function getVaultFile(id: string) {
  const file = await vaultRepository.findById(id);
  if (!file) throw new AppError('VAULT_FILE_NOT_FOUND', 'That vault file was not found.');
  return file;
}

export async function deleteVaultFile(id: string) {
  const info = await vaultRepository.findStorageInfo(id);
  if (!info) throw new AppError('VAULT_FILE_NOT_FOUND', 'That vault file was not found.');
  await vaultRepository.delete(id);
  try {
    await storage().delete('VAULT', info.storedName);
  } catch (err) {
    logger().error({ err: String(err), id }, 'vault bytes not removed after record deletion');
  }
  return { id, deleted: true as const };
}

export async function openVaultDownload(id: string) {
  const info = await vaultRepository.findStorageInfo(id);
  if (!info) throw new AppError('VAULT_FILE_NOT_FOUND', 'That vault file was not found.');
  if (!info.isAvailable || !(await storage().exists('VAULT', info.storedName))) {
    throw new AppError('VAULT_FILE_NOT_FOUND', 'This file is missing from storage.');
  }
  return info;
}
