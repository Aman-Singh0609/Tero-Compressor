import { createHmac, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getEnv } from '../config/env';
import { AppError } from '../lib/errors';
import { adminRepository } from '../repositories/adminRepository';

export const SESSION_COOKIE = 'tero_admin';
export const BCRYPT_ROUNDS = 12;

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;

interface Attempts {
  count: number;
  firstAt: number;
}
const failures = new Map<string, Attempts>();

// Compared against when the email is unknown so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('tero-timing-equaliser', BCRYPT_ROUNDS);

export function resetLoginThrottleForTests(): void {
  failures.clear();
}

function hashToken(token: string): string {
  return createHmac('sha256', getEnv().SESSION_SECRET).update(token).digest('hex');
}

function throttleKey(ip: string, email: string): string {
  return `${ip}|${email.toLowerCase()}`;
}

function assertNotLocked(key: string): void {
  const entry = failures.get(key);
  if (!entry) return;
  if (Date.now() - entry.firstAt > LOCKOUT_MS) {
    failures.delete(key);
    return;
  }
  if (entry.count >= MAX_FAILURES) {
    throw new AppError(
      'TOO_MANY_REQUESTS',
      'Too many failed sign-in attempts. Please wait a few minutes and try again.',
    );
  }
}

function recordFailure(key: string): void {
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.firstAt > LOCKOUT_MS) failures.set(key, { count: 1, firstAt: Date.now() });
  else entry.count++;
}

export interface AdminIdentity {
  id: string;
  email: string;
  name: string;
}

/**
 * Verify credentials and open a brand-new server-side session. A fresh random token is issued on every
 * login (no session fixation); only its HMAC is stored.
 */
export async function login(email: string, password: string, ip: string) {
  const key = throttleKey(ip, email);
  assertNotLocked(key);

  const admin = await adminRepository.findByEmail(email);
  const valid = await bcrypt.compare(password, admin?.passwordHash ?? DUMMY_HASH);
  if (!admin || !admin.isActive || !valid) {
    recordFailure(key);
    throw new AppError('INVALID_CREDENTIALS', 'Incorrect email or password.');
  }
  failures.delete(key);

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + getEnv().SESSION_TTL_HOURS * 3_600_000);
  await adminRepository.createSession({ adminId: admin.id, tokenHash: hashToken(token), expiresAt, ipAddress: ip });
  await adminRepository.touchLogin(admin.id);
  const identity: AdminIdentity = { id: admin.id, email: admin.email, name: admin.name };
  return { token, expiresAt, admin: identity };
}

export async function resolveSession(token: string | undefined): Promise<AdminIdentity | null> {
  if (!token || token.length > 128) return null;
  const session = await adminRepository.findSession(hashToken(token), new Date());
  return session?.admin ?? null;
}

export async function logout(token: string): Promise<void> {
  await adminRepository.deleteSession(hashToken(token));
}
