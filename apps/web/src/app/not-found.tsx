import Link from 'next/link';
import { Wordmark } from '@/components/Wordmark';

export default function NotFound() {
  return (
    <main className="mx-auto grid min-h-dvh max-w-md place-items-center px-4 text-center">
      <div className="space-y-4">
        <Wordmark />
        <h1 className="text-2xl font-semibold text-ink">We can’t find that page</h1>
        <p className="text-sm text-muted">The link may be old or mistyped.</p>
        <Link
          href="/"
          className="inline-flex h-11 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg"
        >
          Back to TERO
        </Link>
      </div>
    </main>
  );
}
