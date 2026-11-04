'use client';

import { LayoutDashboard, Wrench } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/cn';

/**
 * Two-way switch shown only to a signed-in administrator: "Use TERO" (the tools everyone uses) and
 * "Admin" (the management area). It is plain navigation between two areas — the admin session cookie is the
 * same for both, and every admin API route still checks the session on the server, so this switch grants nothing.
 */
export function ModeSwitch({ current, className }: { current: 'tero' | 'admin'; className?: string }) {
  const item = (active: boolean) =>
    cn(
      'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition-colors',
      active ? 'bg-ink text-bg' : 'text-muted hover:text-ink',
    );
  return (
    <div
      role="group"
      aria-label="Switch between using TERO and the admin area"
      className={cn('inline-flex items-center gap-0.5 rounded-full border border-line-strong bg-surface p-0.5', className)}
    >
      <Link href="/" aria-current={current === 'tero' ? 'page' : undefined} className={item(current === 'tero')}>
        <Wrench className="size-3.5" aria-hidden />
        Use TERO
      </Link>
      <Link href="/admin" aria-current={current === 'admin' ? 'page' : undefined} className={item(current === 'admin')}>
        <LayoutDashboard className="size-3.5" aria-hidden />
        Admin
      </Link>
    </div>
  );
}
