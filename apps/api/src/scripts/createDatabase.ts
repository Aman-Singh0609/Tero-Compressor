import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

/**
 * `npm run db:create` — creates the database named in DATABASE_URL if it does not exist yet
 * (utf8mb4), so a brand-new MySQL server only needs `db:create` then `db:migrate`/`db:deploy`.
 */
async function main(): Promise<void> {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is not set (apps/api/.env).');
  const url = new URL(raw);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^\w+$/.test(name)) throw new Error(`Unsafe database name "${name}": use letters, digits and underscores only.`);
  url.pathname = '/mysql';
  const prisma = new PrismaClient({ datasourceUrl: url.toString() });
  try {
    await prisma.$executeRawUnsafe(
      `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    console.log(`Database "${name}" is ready on ${url.hostname}:${url.port || 3306}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
