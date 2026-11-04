'use client';

import { Search, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { useTools } from '@/lib/tools';
import { Button, ErrorState, Input, Skeleton } from '@/components/ui/primitives';
import { CATEGORY_LABELS, CATEGORY_TONE, toolIcon } from './toolIcons';

const TABS = ['all', 'pdf', 'word', 'image', 'video'] as const;

export function ToolGrid() {
  const { tools, loading, failed } = useTools();
  const [tab, setTab] = useState<(typeof TABS)[number]>('all');
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tools.filter(
      (t) =>
        (tab === 'all' || t.category === tab) &&
        (!q || `${t.label} ${t.description} ${CATEGORY_LABELS[t.category]}`.toLowerCase().includes(q)),
    );
  }, [tools, tab, query]);

  return (
    <section aria-labelledby="tools-heading">
      <h2 id="tools-heading" className="sr-only">
        All tools
      </h2>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Filter tools by kind of file" className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                'h-9 rounded-full border px-4 text-sm font-medium transition-colors',
                tab === t ? 'border-ink bg-ink text-bg' : 'border-line-strong bg-surface text-ink hover:bg-surface-2',
              )}
            >
              {t === 'all' ? 'All' : CATEGORY_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-64">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <Input
            type="search"
            aria-label="Search tools"
            placeholder="Search tools"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-10 pl-9"
          />
        </div>
      </div>

      {failed ? (
        <ErrorState
          message="Can’t reach TERO right now. Check your connection and try again."
          onRetry={() => location.reload()}
        />
      ) : loading ? (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
          {Array.from({ length: 9 }, (_, i) => (
            <li key={i}>
              <Skeleton className="h-36" />
            </li>
          ))}
        </ul>
      ) : visible.length === 0 ? (
        <div className="rounded-[var(--radius-card)] border border-line bg-surface px-6 py-14 text-center">
          <p className="font-medium text-ink">No tool matches “{query}”.</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-4"
            onClick={() => {
              setQuery('');
              setTab('all');
            }}
          >
            Show all tools
          </Button>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((t) => {
            const Icon = toolIcon(t.icon);
            return (
              <li key={t.operation}>
                <Link
                  href={`/tools/${t.slug}`}
                  className="group flex h-full flex-col gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-card transition hover:-translate-y-0.5 hover:border-line-strong"
                >
                  <span className="flex items-center justify-between">
                    <span className={cn('grid size-11 place-items-center rounded-xl', CATEGORY_TONE[t.category])}>
                      <Icon className="size-6" aria-hidden />
                    </span>
                    <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[11px] font-medium text-muted">
                      {CATEGORY_LABELS[t.category]}
                    </span>
                  </span>
                  <span>
                    <span className="block font-semibold text-ink">{t.label}</span>
                    <span className="mt-1 block text-sm text-muted">{t.description}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-8 flex flex-wrap items-center justify-center gap-2 text-center text-sm text-muted">
        <Sparkles className="size-4" aria-hidden /> Not sure which tool you need?{' '}
        <Link href="/start" className="font-medium text-accent underline underline-offset-2">
          Drop a file and we’ll suggest some
        </Link>
      </p>
    </section>
  );
}
