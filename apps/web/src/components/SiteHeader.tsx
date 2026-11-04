'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { authApi } from '@/lib/api';
import { ModeSwitch } from '@/components/ModeSwitch';
import { Wordmark } from '@/components/Wordmark';

export function SiteHeader() {
  // Only the signed-in administrator sees the switch; everyone else sees a plain header with no admin link.
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let cancelled = false;
    authApi
      .session()
      .then((admin) => !cancelled && setIsAdmin(admin !== null))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <header className="flex items-center justify-between gap-3 py-5">
      <Link href="/" aria-label="TERO home">
        <Wordmark />
      </Link>
      <nav aria-label="Main" className="flex items-center gap-2 text-sm">
        <Link href="/" className="rounded-lg px-3 py-2 text-muted transition-colors hover:bg-surface-2 hover:text-ink">
          All tools
        </Link>
        {isAdmin && <ModeSwitch current="tero" />}
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line py-6 text-center text-xs text-muted">
      TERO · a private file toolbox for the family · works without the internet · your files never leave this network
    </footer>
  );
}
