'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, createElement, useEffect } from 'react';
import { SiteFooter, SiteHeader } from '@/components/SiteHeader';
import { CATEGORY_LABELS, CATEGORY_TONE, toolIcon } from '@/components/tools/toolIcons';
import { ToolWorkspace } from '@/components/tools/ToolWorkspace';
import { ErrorState, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { useTools } from '@/lib/tools';

export default function ToolPage() {
  return (
    <Suspense>
      <ToolPageInner />
    </Suspense>
  );
}

function ToolPageInner() {
  const { slug } = useParams<{ slug: string }>();
  const fileId = useSearchParams().get('file') ?? undefined;
  const { formats, tools, loading, failed } = useTools();
  const tool = tools.find((t) => t.slug === slug);

  useEffect(() => {
    if (tool) document.title = `${tool.label} · TERO`;
  }, [tool]);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 sm:px-6">
      <SiteHeader />
      <main className="flex-1 pb-16">
        <Link href="/" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
          <ArrowLeft className="size-4" aria-hidden /> All tools
        </Link>
        {failed ? (
          <ErrorState
            message="Can’t reach TERO right now. Check your connection and try again."
            onRetry={() => location.reload()}
          />
        ) : loading ? (
          <div className="space-y-4" aria-hidden>
            <Skeleton className="h-10 w-64" />
            <Skeleton className="h-64" />
          </div>
        ) : !tool || !formats ? (
          <div className="rounded-[var(--radius-card)] border border-line bg-surface px-6 py-14 text-center">
            <h1 className="text-xl font-semibold text-ink">We don’t have that tool</h1>
            <p className="mt-2 text-sm text-muted">It may have been renamed.</p>
            <Link href="/" className="mt-4 inline-block font-medium text-accent underline underline-offset-2">
              See all tools
            </Link>
          </div>
        ) : (
          <>
            <header className="mb-6 flex items-start gap-4">
              <span className={cn('grid size-12 shrink-0 place-items-center rounded-xl', CATEGORY_TONE[tool.category])}>
                {createElement(toolIcon(tool.icon), { className: 'size-6', 'aria-hidden': true })}
              </span>
              <div>
                <p className="text-xs font-medium tracking-wide text-muted uppercase">
                  {CATEGORY_LABELS[tool.category]}
                </p>
                <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{tool.label}</h1>
                <p className="mt-1 text-sm text-muted sm:text-base">{tool.description}</p>
              </div>
            </header>
            {/* key: switching tools resets all workspace state */}
            <ToolWorkspace key={tool.operation} tool={tool} formats={formats} initialFileId={fileId} />
          </>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
