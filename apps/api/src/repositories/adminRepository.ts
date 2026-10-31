import { db } from '../db/prisma';
import { instrument } from '../lib/timing';

const repo = {
  findByEmail(email: string) {
    return db().admin.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true, email: true, name: true, passwordHash: true, isActive: true },
    });
  },

  touchLogin(id: string) {
    return db().admin.update({ where: { id }, data: { lastLoginAt: new Date() }, select: { id: true } });
  },

  createSession(data: { adminId: string; tokenHash: string; expiresAt: Date; ipAddress?: string }) {
    return db().adminSession.create({ data, select: { id: true } });
  },

  /** Joins session → admin in one query; expiry and active flag are checked in SQL. */
  findSession(tokenHash: string, now: Date) {
    return db().adminSession.findFirst({
      where: { tokenHash, expiresAt: { gt: now }, admin: { isActive: true } },
      select: { id: true, admin: { select: { id: true, email: true, name: true } } },
    });
  },

  deleteSession(tokenHash: string) {
    return db().adminSession.deleteMany({ where: { tokenHash } });
  },

  deleteExpiredSessions(now: Date) {
    return db().adminSession.deleteMany({ where: { expiresAt: { lte: now } } });
  },
};

export const adminRepository = instrument('AdminRepository', repo);
