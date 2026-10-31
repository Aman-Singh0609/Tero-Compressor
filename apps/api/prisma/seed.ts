import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

/** Creates (or updates the password of) the initial administrator from environment variables. */
async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME ?? 'Administrator';
  if (!email || !password) {
    throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD in apps/api/.env before seeding.');
  }
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters.');

  const prisma = new PrismaClient();
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const admin = await prisma.admin.upsert({
      where: { email },
      update: { passwordHash, name, isActive: true },
      create: { email, passwordHash, name },
      select: { id: true, email: true },
    });
    console.log(`Admin ready: ${admin.email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
