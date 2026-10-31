import Link from 'next/link';
import { FileTool } from '@/components/home/FileTool';
import { Wordmark } from '@/components/Wordmark';

export default function HomePage() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col px-4 sm:px-6">
      <header className="flex items-center justify-between py-5">
        <Wordmark />
        <Link
          href="/admin"
          className="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          Admin
        </Link>
      </header>

      <main className="flex-1 pb-16">
        <section className="py-10 text-center sm:py-14">
          <h1 className="text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            Private tools for everyday files.
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-base text-muted sm:text-lg">
            Make PDFs, photos and videos smaller. Drop a file, pick what you need, download the result.
          </p>
        </section>
        <FileTool />
      </main>

      <footer className="border-t border-line py-6 text-center text-xs text-muted">
        TERO · a private file toolbox for the family
      </footer>
    </div>
  );
}
