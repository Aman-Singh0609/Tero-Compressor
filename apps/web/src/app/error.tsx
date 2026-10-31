'use client';

import { Wordmark } from '@/components/Wordmark';

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto grid min-h-dvh max-w-md place-items-center px-4 text-center">
      <div className="space-y-4" role="alert">
        <Wordmark />
        <h1 className="text-2xl font-semibold text-ink">Something went wrong</h1>
        <p className="text-sm text-muted">Please try again. Your files are safe.</p>
        <button
          type="button"
          onClick={reset}
          className="inline-flex h-11 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
