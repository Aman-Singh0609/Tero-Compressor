import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '@/components/SiteHeader';
import { SmartStart } from '@/components/tools/SmartStart';

export const metadata: Metadata = { title: 'Start with a file' };

export default function StartPage() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 sm:px-6">
      <SiteHeader />
      <main className="flex-1 pb-16">
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Start with a file</h1>
        <p className="mt-1 mb-6 text-sm text-muted sm:text-base">
          Drop any PDF, Word file, photo or video and we’ll show what you can do with it.
        </p>
        <SmartStart />
      </main>
      <SiteFooter />
    </div>
  );
}
