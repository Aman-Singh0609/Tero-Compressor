'use client';

import {
  Activity,
  FolderLock,
  HardDrive,
  LayoutDashboard,
  Files,
  LogOut,
  Menu,
  ScrollText,
  Settings,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, authApi, type AdminIdentity } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ModeSwitch } from '@/components/ModeSwitch';
import { Wordmark } from '@/components/Wordmark';
import { Button, ErrorState, Skeleton } from '@/components/ui/primitives';

const NAV = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { href: '/admin/files', label: 'Files', icon: Files },
  { href: '/admin/jobs', label: 'Jobs', icon: Activity },
  { href: '/admin/vault', label: 'Vault', icon: FolderLock },
  { href: '/admin/storage', label: 'Storage', icon: HardDrive },
  { href: '/admin/audit', label: 'Audit logs', icon: ScrollText },
  { href: '/admin/settings', label: 'Settings', icon: Settings },
];

type Auth = { state: 'loading' } | { state: 'ready'; admin: AdminIdentity } | { state: 'error'; message: string };

export function AdminShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [auth, setAuth] = useState<Auth>({ state: 'loading' });
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authApi
      .me()
      .then(({ admin }) => !cancelled && setAuth({ state: 'ready', admin }))
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) router.replace('/admin/login');
        else setAuth({ state: 'error', message: 'Can’t reach the server right now.' });
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  const logout = async () => {
    await authApi.logout().catch(() => undefined);
    router.replace('/admin/login');
  };

  if (auth.state === 'error')
    return (
      <div className="grid min-h-dvh place-items-center">
        <ErrorState message={auth.message} onRetry={() => location.reload()} />
      </div>
    );
  if (auth.state === 'loading') {
    return (
      <div className="grid min-h-dvh place-items-center" aria-busy>
        <div className="w-64 space-y-3">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    );
  }

  const nav = (
    <nav aria-label="Admin" className="flex flex-col gap-1 p-3">
      {NAV.map(({ href, label, icon: Icon, exact }) => {
        const active = exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            onClick={() => setNavOpen(false)}
            className={cn(
              'flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
              active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink',
            )}
          >
            <Icon className="size-4.5" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-line bg-surface lg:flex">
        <div className="flex h-16 items-center px-5">
          <Link href="/admin" aria-label="TERO admin home">
            <Wordmark />
          </Link>
        </div>
        {nav}
        <div className="mt-auto border-t border-line p-4 text-xs text-muted">
          <Link href="/" className="hover:text-ink">
            ← Back to TERO
          </Link>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur sm:px-6">
          <Button
            variant="ghost"
            size="sm"
            className="lg:hidden"
            aria-label={navOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={navOpen}
            aria-controls="mobile-nav"
            onClick={() => setNavOpen((o) => !o)}
          >
            {navOpen ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
          </Button>
          <Link href="/admin" className="lg:hidden" aria-label="TERO admin home">
            <Wordmark />
          </Link>
          <div className="ml-auto flex items-center gap-3">
            <ModeSwitch current="admin" />
            <div className="hidden text-right md:block">
              <p className="text-sm font-medium text-ink">{auth.admin.name}</p>
              <p className="text-xs text-muted">{auth.admin.email}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={logout}>
              <LogOut className="size-4" aria-hidden />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </header>
        {navOpen && (
          <div id="mobile-nav" className="border-b border-line bg-surface lg:hidden">
            {nav}
          </div>
        )}
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}
