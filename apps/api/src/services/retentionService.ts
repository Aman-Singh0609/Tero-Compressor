import { getEnv } from '../config/env';
import { logger } from '../lib/logger';
import { adminRepository } from '../repositories/adminRepository';
import { fileRepository } from '../repositories/fileRepository';
import { jobRepository } from '../repositories/jobRepository';
import { storage } from '../storage';
import { purgeFile } from './fileService';
import { isRunning } from './jobRunner';

const BATCH = 200;
const MAX_BATCHES = 50;
const WORK_FILE_MAX_AGE_MS = 24 * 3_600_000;

export interface CleanupReport {
  deleted: number;
  alreadyMissing: number;
  failed: number;
  staleJobsFailed: number;
  workFilesSwept: number;
  expiredSessions: number;
}

/**
 * Remove expired temporary files (uploads and outputs), keeping their metadata for analytics.
 * Only TEMPORARY/ORIGINAL/PROCESSED storage is touched — the vault has its own table and directory
 * and is never visited here. Every physical path goes through the storage service, which cannot
 * resolve outside its configured areas.
 */
export async function runCleanup(now = new Date()): Promise<CleanupReport> {
  const report: CleanupReport = {
    deleted: 0,
    alreadyMissing: 0,
    failed: 0,
    staleJobsFailed: 0,
    workFilesSwept: 0,
    expiredSessions: 0,
  };

  // Jobs stuck in PROCESSING (crashed worker, restart without recovery) would otherwise pin their files forever.
  const staleBefore = now.getTime() - (getEnv().VIDEO_TIMEOUT_MINUTES + 10) * 60_000;
  for (const job of await jobRepository.findByStatus(['PROCESSING'])) {
    if (!isRunning(job.id) && job.startedAt && job.startedAt.getTime() < staleBefore) {
      await jobRepository.fail(job.id, { errorCode: 'STALE_JOB', errorMessage: 'Processing did not finish.' });
      await fileRepository.setStatus(job.fileId, 'UPLOADED');
      report.staleJobsFailed++;
    }
  }

  const failedIds: string[] = []; // retried on the next run, not within this one
  for (let i = 0; i < MAX_BATCHES; i++) {
    const batch = await fileRepository.findExpired(now, BATCH, failedIds);
    if (batch.length === 0) break;
    for (const file of batch) {
      const result = await purgeFile(file);
      if (result === 'deleted') report.deleted++;
      else if (result === 'missing') report.alreadyMissing++;
      else {
        report.failed++;
        failedIds.push(file.id);
      }
    }
  }

  report.workFilesSwept = await storage().sweepWorkFiles(new Date(now.getTime() - WORK_FILE_MAX_AGE_MS));
  report.expiredSessions = (await adminRepository.deleteExpiredSessions(now)).count;
  logger().info(report, 'retention cleanup finished');
  return report;
}

let timer: NodeJS.Timeout | undefined;

export function startCleanupSchedule(): void {
  const intervalMs = getEnv().CLEANUP_INTERVAL_MINUTES * 60_000;
  timer = setInterval(() => {
    runCleanup().catch((err) => logger().error({ err: String(err) }, 'scheduled cleanup failed'));
  }, intervalMs);
  timer.unref();
}

export function stopCleanupSchedule(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
