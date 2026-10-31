import { getEnv } from '../config/env';
import { logger } from '../lib/logger';
import { fileRepository } from '../repositories/fileRepository';
import { jobRepository } from '../repositories/jobRepository';
import { runJob } from '../services/jobRunner';

/**
 * In-process FIFO queue with bounded concurrency. Job state of record lives in MySQL, so the
 * queue itself holds only ids and can be rebuilt after a restart (see `recover`).
 */
class JobQueue {
  private pending: string[] = [];
  private active = 0;
  private idleWaiters: Array<() => void> = [];

  enqueue(jobId: string): void {
    this.pending.push(jobId);
    this.pump();
  }

  stats() {
    return { pending: this.pending.length, active: this.active, concurrency: getEnv().JOB_CONCURRENCY };
  }

  private pump(): void {
    while (this.active < getEnv().JOB_CONCURRENCY && this.pending.length > 0) {
      const id = this.pending.shift() as string;
      this.active++;
      runJob(id)
        .catch((err) => logger().error({ jobId: id, err: String(err) }, 'job runner crashed'))
        .finally(() => {
          this.active--;
          this.pump();
          if (this.active === 0 && this.pending.length === 0) {
            this.idleWaiters.splice(0).forEach((resolve) => resolve());
          }
        });
    }
  }

  /** Resolves when nothing is queued or running (used by tests and graceful shutdown). */
  onIdle(): Promise<void> {
    if (this.active === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * After a restart: jobs left PROCESSING were interrupted and are marked failed (their partial
   * output was in scratch space and is swept), jobs left QUEUED are put back in line.
   */
  async recover(): Promise<{ requeued: number; interrupted: number }> {
    const jobs = await jobRepository.findByStatus(['QUEUED', 'PROCESSING']);
    let requeued = 0;
    let interrupted = 0;
    for (const job of jobs) {
      if (job.status === 'QUEUED') {
        this.enqueue(job.id);
        requeued++;
      } else {
        await jobRepository.fail(job.id, {
          errorCode: 'SERVER_RESTART',
          errorMessage: 'Processing was interrupted. Please try again.',
        });
        // the file was left in PROCESSING by the crashed run; make it usable again
        await fileRepository.setStatus(job.fileId, 'UPLOADED');
        interrupted++;
      }
    }
    return { requeued, interrupted };
  }
}

export const jobQueue = new JobQueue();
