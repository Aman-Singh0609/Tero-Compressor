import { Lock, WifiOff } from 'lucide-react';
import { SiteFooter, SiteHeader } from '@/components/SiteHeader';
import { ToolGrid } from '@/components/tools/ToolGrid';

export default function HomePage() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 sm:px-6">
      <SiteHeader />
      <main className="flex-1 pb-16">
        <section className="py-8 text-center sm:py-12">
          <h1 className="text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            Private tools for everyday files.
          </h1>
          <p className="mx-auto mt-3 max-w-2xl text-base text-muted sm:text-lg">
            Compress, merge, split, convert and protect PDFs, Word files and photos — all on your own computer, no
            account, no cloud.
          </p>
          <ul className="mt-5 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted">
            <li className="flex items-center gap-2">
              <Lock className="size-4" aria-hidden /> Files never leave your network
            </li>
            <li className="flex items-center gap-2">
              <WifiOff className="size-4" aria-hidden /> Works without internet
            </li>
          </ul>
        </section>
        <ToolGrid />
      </main>
      <SiteFooter />
    </div>
  );
}
