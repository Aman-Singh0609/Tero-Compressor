import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getEnv } from '../config/env';
import { db, disconnectDb } from '../db/prisma';
import { MysqlStorageService } from '../storage/mysqlStorage';
import { parseStoragePath } from '../storage/storage';

const DIRS = { TEMPORARY: 'temporary', ORIGINAL: 'originals', PROCESSED: 'processed', VAULT: 'vault' } as const;

/**
 * `npm run storage:to-mysql` — copies files that were stored on disk (STORAGE_DRIVER=local) into
 * MySQL under the same stored names. Originals on disk are left untouched; re-running skips files
 * that are already in the database.
 */
async function main(): Promise<void> {
  const env = getEnv();
  const mysql = new MysqlStorageService(env.storageRoot);
  await mysql.ensureReady();

  const targets: Array<{ storagePath: string; label: string }> = [
    ...(
      await db().file.findMany({
        where: { status: { not: 'DELETED' } },
        select: { storagePath: true, originalName: true },
      })
    ).map((f) => ({ storagePath: f.storagePath, label: f.originalName })),
    ...(await db().vaultFile.findMany({ select: { storagePath: true, displayName: true } })).map((f) => ({
      storagePath: f.storagePath,
      label: f.displayName,
    })),
  ];

  let copied = 0;
  let skipped = 0;
  let missing = 0;
  for (const t of targets) {
    const parsed = parseStoragePath(t.storagePath);
    if (!parsed) continue;
    if (await mysql.exists(parsed.area, parsed.storedName)) {
      skipped++;
      continue;
    }
    const source = path.join(env.storageRoot, DIRS[parsed.area], parsed.storedName);
    try {
      await fs.access(source);
    } catch {
      missing++;
      console.warn(`missing on disk: ${t.storagePath} (${t.label})`);
      continue;
    }
    // importFile() keeps the given stored name only via the object table, so insert under the original name
    await storeUnderName(parsed.area, parsed.storedName, source);
    copied++;
    console.log(`copied ${t.storagePath}  ←  ${t.label}`);
  }
  console.log(`Done: ${copied} copied, ${skipped} already in MySQL, ${missing} missing on disk.`);
  await disconnectDb();
}

async function storeUnderName(area: keyof typeof DIRS, storedName: string, source: string): Promise<void> {
  const CHUNK = 4 * 1024 * 1024;
  const object = await db().storageObject.create({ data: { area, storedName }, select: { id: true } });
  let seq = 0;
  let size = 0;
  for await (const piece of createReadStream(source, { highWaterMark: CHUNK })) {
    const data = Buffer.from(piece as Buffer);
    size += data.length;
    await db().storageChunk.create({ data: { objectId: object.id, seq: seq++, data }, select: { seq: true } });
  }
  await db().storageObject.update({
    where: { id: object.id },
    data: { sizeBytes: size, complete: true },
    select: { id: true },
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
