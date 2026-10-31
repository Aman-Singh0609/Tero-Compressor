import { createApp } from './app';
import { ConfigError, getEnv } from './config/env';
import { db, disconnectDb } from './db/prisma';
import { logger } from './lib/logger';
import { abortAllRunning } from './services/jobRunner';
import { jobQueue } from './queue/jobQueue';
import { startCleanupSchedule, stopCleanupSchedule } from './services/retentionService';
import { storage } from './storage';

async function main(): Promise<void> {
  const env = getEnv(); // validates configuration; throws a readable ConfigError
  await storage().ensureReady();
  // Nothing can be mid-upload or mid-job at boot, so any scratch file left by a crash is garbage.
  await storage().sweepWorkFiles(new Date());
  await db().$queryRaw`SELECT 1`; // fail fast if MySQL is unreachable
  const recovered = await jobQueue.recover();
  startCleanupSchedule();

  const server = createApp().listen(env.PORT, () => {
    logger().info({ port: env.PORT, recovered }, 'TERO API listening');
  });
  server.requestTimeout = 0; // large uploads can take long; per-route limits apply instead

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) process.exit(1); // second Ctrl+C: stop waiting
    shuttingDown = true;
    logger().info({ signal }, 'shutting down');
    stopCleanupSchedule();
    server.close();
    server.closeIdleConnections();
    // Let short jobs finish; abort long ones (e.g. an hour of video) so Ctrl+C never hangs.
    const idle = await Promise.race([
      jobQueue.onIdle().then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 10_000)),
    ]);
    if (!idle) {
      abortAllRunning();
      await Promise.race([jobQueue.onIdle(), new Promise((r) => setTimeout(r, 5_000))]);
    }
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
  logger().error({ err: reason instanceof Error ? reason.stack : String(reason) }, 'unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger().fatal({ err: err.stack }, 'uncaught exception');
  process.exit(1);
});

main().catch((err) => {
  if (err instanceof ConfigError) console.error(err.message);
  else console.error('Failed to start TERO API:', err instanceof Error ? err.message : err);
  process.exit(1);
});
