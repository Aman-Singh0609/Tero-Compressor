'use client';

import { useState } from 'react';
import { adminApi, type Job } from '@/lib/api';
import { formatBytes, formatDate, formatDuration, friendlyError } from '@/lib/format';
import { useResource } from '@/lib/hooks';
import { CATEGORY_LABELS } from '@/components/tools/toolIcons';
import { useTools } from '@/lib/tools';
import { DetailList, PageHeader, Pager, SelectFilter, TableSkeleton, Th, Toolbar } from '@/components/admin/common';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Modal,
  ProgressBar,
  Skeleton,
  statusTone,
} from '@/components/ui/primitives';

export default function JobsPage() {
  const { tools, label: opLabel } = useTools();
  const OPS = tools.map((t): [string, string] => [t.operation, `${CATEGORY_LABELS[t.category]} · ${t.label}`]);
  const [status, setStatus] = useState('');
  const [operation, setOperation] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const list = useResource(() => adminApi.jobs({ page, limit: 25, status, operation }), [page, status, operation]);
  const rows = list.data?.items ?? [];

  return (
    <>
      <PageHeader title="Jobs" description="Every processing task, newest first." />
      <Card>
        <Toolbar>
          <SelectFilter
            label="Status"
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            options={[
              ['', 'Any status'],
              ['QUEUED', 'Queued'],
              ['PROCESSING', 'Processing'],
              ['COMPLETED', 'Completed'],
              ['FAILED', 'Failed'],
              ['CANCELLED', 'Cancelled'],
            ]}
          />
          <SelectFilter
            label="Operation"
            value={operation}
            onChange={(v) => {
              setOperation(v);
              setPage(1);
            }}
            options={[['', 'All operations'], ...OPS]}
          />
        </Toolbar>
        {list.error && !list.data ? (
          <ErrorState message={friendlyError(list.error.code, list.error.message)} onRetry={list.refetch} />
        ) : list.loading && !list.data ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState title="No jobs" hint="Jobs appear when someone processes a file." />
        ) : (
          <div className={list.loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px] text-sm">
                <thead className="border-b border-line bg-surface-2/60">
                  <tr>
                    <Th>File</Th>
                    <Th>Operation</Th>
                    <Th>Status</Th>
                    <Th className="hidden md:table-cell">Size</Th>
                    <Th className="hidden lg:table-cell">Time</Th>
                    <Th className="hidden sm:table-cell">Started</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((j) => (
                    <tr key={j.id} className="hover:bg-surface-2/50">
                      <td className="max-w-[14rem] px-4 py-3">
                        <button
                          type="button"
                          className="block max-w-full truncate text-left font-medium text-ink hover:underline"
                          onClick={() => setSelected(j.id)}
                        >
                          {j.fileName ?? j.fileId}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-muted">{opLabel(j.operation)}</td>
                      <td className="px-4 py-3">
                        <Badge tone={statusTone(j.status)}>{j.status.toLowerCase()}</Badge>
                      </td>
                      <td className="hidden px-4 py-3 whitespace-nowrap text-muted tabular-nums md:table-cell">
                        {formatBytes(j.originalSizeBytes)}
                        {j.outputSizeBytes !== null ? ` → ${formatBytes(j.outputSizeBytes)}` : ''}
                      </td>
                      <td className="hidden px-4 py-3 text-muted lg:table-cell">
                        {formatDuration(j.processingDurationMs)}
                      </td>
                      <td className="hidden px-4 py-3 whitespace-nowrap text-muted sm:table-cell">
                        {formatDate(j.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager pagination={list.data?.pagination} onPage={setPage} loading={list.loading} />
          </div>
        )}
      </Card>
      <JobDrawer id={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function JobDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { label: opLabel } = useTools();
  const detail = useResource(() => (id ? adminApi.job(id) : Promise.resolve(undefined)), [id]);
  const j: Job | undefined = id ? detail.data : undefined;
  return (
    <Modal
      side
      open={id !== null}
      onOpenChange={(o) => !o && onClose()}
      title={j ? opLabel(j.operation) : 'Job details'}
      description={j?.fileName ?? undefined}
    >
      {detail.loading && !j ? (
        <Skeleton className="h-40" />
      ) : detail.error ? (
        <ErrorState message={friendlyError(detail.error.code, detail.error.message)} onRetry={detail.refetch} />
      ) : j ? (
        <div className="space-y-5">
          {(j.status === 'PROCESSING' || j.status === 'QUEUED') && (
            <ProgressBar value={j.status === 'PROCESSING' && j.progress > 0 ? j.progress : null} label="Job progress" />
          )}
          <DetailList
            rows={[
              [
                'Status',
                <Badge key="s" tone={statusTone(j.status)}>
                  {j.status.toLowerCase()}
                </Badge>,
              ],
              ['Original', formatBytes(j.originalSizeBytes)],
              ['Result', formatBytes(j.outputSizeBytes)],
              ['Saving', j.savingPercent === null ? '—' : `${j.savingPercent}%`],
              ['Duration', formatDuration(j.processingDurationMs)],
              ['Created', formatDate(j.createdAt)],
              ['Completed', formatDate(j.completedAt)],
              ['Files in', j.inputs.length ? String(j.inputs.length) : '1'],
              [
                'Options',
                <code key="o" className="text-xs break-all">
                  {JSON.stringify(j.options ?? {})}
                </code>,
              ],
              ...(j.error
                ? ([['Error', `${j.error.code ?? ''} ${j.error.message ?? ''}`]] as Array<[string, string]>)
                : []),
              ...(j.result?.note ? ([['Note', String(j.result.note)]] as Array<[string, string]>) : []),
            ]}
          />
          {j.inputs.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">Input files (in order)</h3>
              <ol className="list-inside list-decimal space-y-1 text-sm text-muted">
                {j.inputs.map((i) => (
                  <li key={i.id} className="break-all">
                    <span className="text-ink">{i.name}</span> · {formatBytes(i.sizeBytes)}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {j.result && Object.keys(j.result).length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">What the tool reported</h3>
              <pre className="max-h-48 overflow-auto rounded-lg bg-surface-2 p-3 text-xs break-words whitespace-pre-wrap text-ink">
                {JSON.stringify(j.result, null, 2)}
              </pre>
            </div>
          )}
          {j.errorDetail && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-danger">Technical detail (admins only)</h3>
              <pre className="max-h-64 overflow-auto rounded-lg bg-danger-soft p-3 text-xs break-words whitespace-pre-wrap text-ink">
                {j.errorDetail}
              </pre>
            </div>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
