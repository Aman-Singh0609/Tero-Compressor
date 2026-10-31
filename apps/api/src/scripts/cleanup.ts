import { disconnectDb } from '../db/prisma';
import { storage } from '../storage';
import { runCleanup } from '../services/retentionService';

/** `npm run cleanup` — one retention pass, suitable for cron / Task Scheduler. */
async function main(): Promise<void> {
  await storage().ensureReady();
  const report = await runCleanup();
  console.log(JSON.stringify(report, null, 2));
  await disconnectDb();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
