import { cn } from '@/lib/cn';

/** TERO mark: a folded sheet — one corner turned down to suggest "made smaller". */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5 font-semibold tracking-[0.18em] text-ink', className)}>
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
        <rect x="2" y="2" width="22" height="22" rx="6" fill="var(--accent)" />
        <path d="M8 9h10M13 9v9" stroke="var(--accent-fg)" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M24 17v3a4 4 0 0 1-4 4h-3z" fill="var(--accent-fg)" opacity="0.35" />
      </svg>
      TERO
    </span>
  );
}
