'use client';

import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import type { Pagination } from '@/lib/api';
import { Button, Card, Input, Skeleton } from '@/components/ui/primitives';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 border-b border-line p-3 sm:p-4">{children}</div>;
}

export function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative min-w-0 flex-1 basis-56">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
      <Input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pl-9"
      />
    </div>
  );
}

export function Pager({
  pagination,
  onPage,
  loading,
}: {
  pagination: Pagination | undefined;
  onPage: (p: number) => void;
  loading?: boolean;
}) {
  if (!pagination) return null;
  const { page, totalPages, total, limit } = pagination;
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm"
    >
      <p className="text-muted" aria-live="polite">
        {total === 0 ? 'No results' : `${formatNumber(from)}–${formatNumber(to)} of ${formatNumber(total)}`}
      </p>
      <div className="flex items-center gap-1">
        <Button
          variant="secondary"
          size="sm"
          disabled={page <= 1 || loading}
          onClick={() => onPage(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        <span className="min-w-20 px-2 text-center text-muted tabular-nums">
          {page} / {totalPages}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={page >= totalPages || loading}
          onClick={() => onPage(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>
    </nav>
  );
}

export function Th({
  children,
  sortKey,
  sort,
  order,
  onSort,
  className,
}: {
  children: ReactNode;
  sortKey?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  onSort?: (key: string) => void;
  className?: string;
}) {
  const active = sortKey && sort === sortKey;
  const Icon = !active ? ChevronsUpDown : order === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : undefined}
      className={cn('px-4 py-2.5 text-left text-xs font-semibold tracking-wide text-muted uppercase', className)}
    >
      {sortKey && onSort ? (
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          className="inline-flex items-center gap-1 uppercase hover:text-ink"
        >
          {children}
          <Icon className={cn('size-3.5', !active && 'opacity-50')} aria-hidden />
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-3 p-4" aria-hidden>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={cn('h-5', c === 0 ? 'flex-[2]' : 'flex-1')} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  loading,
}: {
  label: string;
  value: string;
  hint?: string;
  loading?: boolean;
}) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-muted">{label}</p>
      {loading ? (
        <Skeleton className="mt-2 h-8 w-24" />
      ) : (
        <p className="mt-1 text-2xl font-semibold text-ink tabular-nums">{value}</p>
      )}
      {hint && !loading && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </Card>
  );
}

export function Section({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <div className="border-b border-line px-4 py-3 sm:px-5">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {description && <p className="text-xs text-muted">{description}</p>}
      </div>
      {children}
    </Card>
  );
}

/** Horizontal bar list; values are always printed, so colour is never the only signal. */
export function BarList({
  rows,
  format = formatNumber,
}: {
  rows: Array<{ label: string; value: number }>;
  format?: (n: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="px-5 py-8 text-center text-sm text-muted">Nothing here yet.</p>;
  return (
    <ul className="space-y-3 p-4 sm:p-5">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="mb-1 flex justify-between gap-3 text-sm">
            <span className="truncate text-ink">{r.label}</span>
            <span className="shrink-0 text-muted tabular-nums">{format(r.value)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            <div className="h-full rounded-full bg-accent" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Vertical bars for a daily series; missing days are filled with zero. */
export function DayBars({ series, days = 14 }: { series: Array<{ day: string; count: number }>; days?: number }) {
  const byDay = new Map(series.map((s) => [s.day, s.count]));
  const points = Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    const key = d.toLocaleDateString('en-CA'); // local YYYY-MM-DD, the same day the server groups by
    return {
      key,
      label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      count: byDay.get(key) ?? 0,
    };
  });
  const max = Math.max(1, ...points.map((p) => p.count));
  const total = points.reduce((a, p) => a + p.count, 0);
  return (
    <div className="p-4 sm:p-5">
      <div
        className="flex h-36 items-end gap-1.5"
        role="img"
        aria-label={`Uploads per day for the last ${days} days, ${total} in total`}
      >
        {points.map((p) => (
          <div key={p.key} className="group relative flex h-full flex-1 flex-col justify-end">
            <div
              className="w-full rounded-t bg-accent/80 transition-colors group-hover:bg-accent"
              style={{
                height: `${p.count === 0 ? 2 : Math.max(6, (p.count / max) * 100)}%`,
                opacity: p.count === 0 ? 0.25 : 1,
              }}
              title={`${p.label}: ${p.count}`}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-muted">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </div>
  );
}

export function SelectFilter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-11 rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink focus-visible:border-accent"
    >
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

export function DetailList({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="divide-y divide-line text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 py-2.5">
          <dt className="shrink-0 text-muted">{k}</dt>
          <dd className="min-w-0 text-right break-words text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
