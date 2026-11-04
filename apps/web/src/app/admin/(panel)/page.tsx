'use client';

import Link from 'next/link';
import { adminApi } from '@/lib/api';
import { formatBytes, formatDuration, formatNumber, formatRelative, friendlyError } from '@/lib/format';
import { useResource } from '@/lib/hooks';
import { useTools } from '@/lib/tools';
import { BarList, DayBars, PageHeader, Section, StatCard } from '@/components/admin/common';
import { Badge, EmptyState, ErrorState, Skeleton, statusTone } from '@/components/ui/primitives';

export default function DashboardPage() {
  const { data, error, loading, refetch } = useResource(() => adminApi.dashboard(), []);
  const { label: opLabel } = useTools();

  if (error && !data) return <ErrorState message={friendlyError(error.code, error.message)} onRetry={refetch} />;
  const d = data;
  const successRate =
    d && d.jobs.completed + d.jobs.failed > 0
      ? Math.round((d.jobs.completed / (d.jobs.completed + d.jobs.failed)) * 100)
      : null;

  return (
    <>
      <PageHeader title="Dashboard" description="What the family has been processing." />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Uploads today"
          value={formatNumber(d?.uploads.today ?? 0)}
          hint={`${formatNumber(d?.uploads.thisWeek ?? 0)} this week`}
          loading={loading}
        />
        <StatCard
          label="Jobs completed"
          value={formatNumber(d?.jobs.completed ?? 0)}
          hint={`${formatNumber(d?.jobs.failed ?? 0)} failed · ${formatNumber(d?.jobs.active ?? 0)} running`}
          loading={loading}
        />
        <StatCard
          label="Space saved"
          value={formatBytes(d?.jobs.savedBytes ?? 0)}
          hint={`${formatBytes(d?.jobs.inputBytes ?? 0)} in → ${formatBytes(d?.jobs.outputBytes ?? 0)} out`}
          loading={loading}
        />
        <StatCard
          label="Avg. processing"
          value={formatDuration(d?.jobs.avgDurationMs)}
          hint={successRate !== null ? `${successRate}% success rate` : 'No finished jobs yet'}
          loading={loading}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Section title="Uploads, last 14 days" className="lg:col-span-3">
          {loading ? <Skeleton className="m-5 h-40" /> : <DayBars series={d?.uploadsByDay ?? []} />}
        </Section>
        <Section title="Files by type" className="lg:col-span-2">
          {loading ? (
            <Skeleton className="m-5 h-40" />
          ) : (
            <BarList rows={(d?.filesByCategory ?? []).map((c) => ({ label: c.category, value: c.count }))} />
          )}
        </Section>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Operations">
          {loading ? (
            <Skeleton className="m-5 h-32" />
          ) : (
            <BarList
              rows={(d?.operations ?? []).map((o) => ({
                label: opLabel(o.operation),
                value: o.count,
              }))}
            />
          )}
        </Section>
        <Section title="Recent failures" description="Newest first">
          {loading ? (
            <Skeleton className="m-5 h-32" />
          ) : d && d.recentFailures.length > 0 ? (
            <ul className="divide-y divide-line">
              {d.recentFailures.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm sm:px-5">
                  <div className="min-w-0">
                    <Link
                      href={`/admin/files?q=${encodeURIComponent(f.file.originalName)}`}
                      className="block truncate font-medium text-ink hover:underline"
                    >
                      {f.file.originalName}
                    </Link>
                    <span className="text-xs text-muted">
                      {opLabel(f.operation)} · {f.errorMessage ?? f.errorCode}
                    </span>
                  </div>
                  <span className="shrink-0 text-xs text-muted">{formatRelative(f.failedAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No failures" hint="Failed jobs will show up here." />
          )}
        </Section>
      </div>

      <Section title="Recent uploads" className="mt-4">
        {loading ? (
          <Skeleton className="m-5 h-32" />
        ) : d && d.recentUploads.length > 0 ? (
          <ul className="divide-y divide-line">
            {d.recentUploads.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm sm:px-5">
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink">{f.originalName}</p>
                  <p className="text-xs text-muted">
                    {f.category} · {formatBytes(f.sizeBytes)} · {formatRelative(f.createdAt)}
                  </p>
                </div>
                <Badge tone={statusTone(f.status)}>{f.status.toLowerCase()}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No uploads yet" hint="Files uploaded from the home page appear here." />
        )}
      </Section>
    </>
  );
}
