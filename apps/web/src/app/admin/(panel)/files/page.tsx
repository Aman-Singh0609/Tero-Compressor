'use client';

import { Download, Trash2 } from 'lucide-react';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { adminApi, ApiError, type AdminFileRow } from '@/lib/api';
import { formatBytes, formatDate, formatDuration, friendlyError, OPERATION_LABELS } from '@/lib/format';
import { useDebounced, useResource } from '@/lib/hooks';
import {
  DetailList,
  PageHeader,
  Pager,
  SearchBox,
  SelectFilter,
  TableSkeleton,
  Th,
  Toolbar,
} from '@/components/admin/common';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LinkButton,
  Modal,
  Skeleton,
  statusTone,
} from '@/components/ui/primitives';

export default function FilesPage() {
  return (
    <Suspense>
      <Files />
    </Suspense>
  );
}

function Files() {
  const initialQ = useSearchParams().get('q') ?? '';
  const [q, setQ] = useState(initialQ);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('UPLOAD');
  const [sort, setSort] = useState('createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const dq = useDebounced(q);

  const list = useResource(
    () => adminApi.files({ page, limit: 25, q: dq, type, status, role, sort, order }),
    [page, dq, type, status, role, sort, order],
  );

  const toggleSort = (key: string) => {
    if (sort === key) setOrder(order === 'asc' ? 'desc' : 'asc');
    else {
      setSort(key);
      setOrder(key === 'originalName' ? 'asc' : 'desc');
    }
    setPage(1);
  };
  const filter =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPage(1);
    };

  const rows = list.data?.items ?? [];

  return (
    <>
      <PageHeader title="Files" description="Everything uploaded to TERO, before retention removes it." />
      <Card>
        <Toolbar>
          <SearchBox value={q} onChange={filter(setQ)} placeholder="Search file names" />
          <SelectFilter
            label="File type"
            value={type}
            onChange={filter(setType)}
            options={[
              ['', 'All types'],
              ['pdf', 'PDF'],
              ['image', 'Images'],
              ['video', 'Video'],
              ['document', 'Documents'],
            ]}
          />
          <SelectFilter
            label="Status"
            value={status}
            onChange={filter(setStatus)}
            options={[
              ['', 'Any status'],
              ['UPLOADED', 'Uploaded'],
              ['PROCESSING', 'Processing'],
              ['AVAILABLE', 'Available'],
              ['FAILED', 'Failed'],
              ['DELETED', 'Deleted'],
            ]}
          />
          <SelectFilter
            label="Kind"
            value={role}
            onChange={filter(setRole)}
            options={[
              ['UPLOAD', 'Uploads'],
              ['OUTPUT', 'Results'],
            ]}
          />
        </Toolbar>

        {list.error && !list.data ? (
          <ErrorState message={friendlyError(list.error.code, list.error.message)} onRetry={list.refetch} />
        ) : list.loading && !list.data ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState title="No files match" hint="Try clearing the search or filters." />
        ) : (
          <div className={list.loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="border-b border-line bg-surface-2/60">
                  <tr>
                    <Th sortKey="originalName" sort={sort} order={order} onSort={toggleSort}>
                      File
                    </Th>
                    <Th className="hidden md:table-cell">Type</Th>
                    <Th sortKey="sizeBytes" sort={sort} order={order} onSort={toggleSort}>
                      Size
                    </Th>
                    <Th sortKey="status" sort={sort} order={order} onSort={toggleSort}>
                      Status
                    </Th>
                    <Th className="hidden lg:table-cell">Last operation</Th>
                    <Th
                      sortKey="createdAt"
                      sort={sort}
                      order={order}
                      onSort={toggleSort}
                      className="hidden sm:table-cell"
                    >
                      Uploaded
                    </Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((f) => (
                    <FileRow key={f.id} file={f} onOpen={() => setSelected(f.id)} />
                  ))}
                </tbody>
              </table>
            </div>
            <Pager pagination={list.data?.pagination} onPage={setPage} loading={list.loading} />
          </div>
        )}
      </Card>

      <FileDrawer id={selected} onClose={() => setSelected(null)} onChanged={list.refetch} />
    </>
  );
}

function FileRow({ file, onOpen }: { file: AdminFileRow; onOpen: () => void }) {
  const job = file.jobs[0];
  return (
    <tr className="hover:bg-surface-2/50">
      <td className="max-w-[16rem] px-4 py-3">
        <button
          type="button"
          onClick={onOpen}
          className="block max-w-full truncate text-left font-medium text-ink hover:underline"
          title={file.originalName}
        >
          {file.originalName}
        </button>
      </td>
      <td className="hidden px-4 py-3 text-muted capitalize md:table-cell">{file.category}</td>
      <td className="px-4 py-3 whitespace-nowrap text-muted tabular-nums">{formatBytes(file.sizeBytes)}</td>
      <td className="px-4 py-3">
        <Badge tone={statusTone(file.status)}>{file.status.toLowerCase()}</Badge>
      </td>
      <td className="hidden px-4 py-3 text-muted lg:table-cell">
        {job ? `${OPERATION_LABELS[job.operation]} · ${formatDuration(job.processingDurationMs)}` : '—'}
      </td>
      <td className="hidden px-4 py-3 whitespace-nowrap text-muted sm:table-cell">{formatDate(file.createdAt)}</td>
    </tr>
  );
}

function FileDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const detail = useResource(() => (id ? adminApi.file(id) : Promise.resolve(undefined)), [id]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const f = id ? detail.data : undefined;

  const remove = async () => {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.deleteFile(id);
      setConfirm(false);
      onClose();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? friendlyError(err.code, err.message) : friendlyError('INTERNAL_ERROR'));
    } finally {
      setBusy(false);
    }
  };

  const deleted = f?.status === 'DELETED';
  return (
    <>
      <Modal
        side
        open={id !== null}
        onOpenChange={(o) => !o && onClose()}
        title={f?.originalName ?? 'File details'}
        description={f ? `${f.category} · ${formatBytes(f.sizeBytes)}` : undefined}
        footer={
          f && (
            <>
              <Button variant="danger" size="sm" disabled={deleted} onClick={() => setConfirm(true)}>
                <Trash2 className="size-4" aria-hidden /> Delete
              </Button>
              {!deleted && (
                <LinkButton size="sm" href={adminApi.fileDownloadUrl(f.id)} download>
                  <Download className="size-4" aria-hidden /> Download
                </LinkButton>
              )}
            </>
          )
        }
      >
        {detail.loading && !f ? (
          <div className="space-y-3">
            <Skeleton className="h-5" />
            <Skeleton className="h-5" />
            <Skeleton className="h-5" />
          </div>
        ) : detail.error ? (
          <ErrorState message={friendlyError(detail.error.code, detail.error.message)} onRetry={detail.refetch} />
        ) : f ? (
          <div className="space-y-6">
            <DetailList
              rows={[
                [
                  'Status',
                  <Badge key="s" tone={statusTone(f.status)}>
                    {f.status.toLowerCase()}
                  </Badge>,
                ],
                ['Type', f.mimeType],
                ['Uploaded', formatDate(f.createdAt)],
                ['Expires', formatDate(f.expiresAt)],
                ['Storage', `${f.storageArea} / ${f.storedName}`],
                [
                  'SHA-256',
                  <code key="c" className="text-xs break-all">
                    {f.checksum}
                  </code>,
                ],
              ]}
            />
            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">Processing history</h3>
              {f.jobs.length === 0 ? (
                <p className="text-sm text-muted">No jobs have run on this file.</p>
              ) : (
                <ul className="space-y-2">
                  {f.jobs.map((j) => (
                    <li
                      key={j.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-line p-3 text-sm"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-ink">{OPERATION_LABELS[j.operation]}</p>
                        <p className="text-xs text-muted">
                          {formatDuration(j.processingDurationMs)} ·{' '}
                          {j.outputSizeBytes !== null ? formatBytes(j.outputSizeBytes) : (j.errorCode ?? '—')}
                        </p>
                      </div>
                      <Badge tone={statusTone(j.status)}>{j.status.toLowerCase()}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete this file?"
        description="The uploaded file and any results generated from it are removed from storage. This can’t be undone."
        confirmLabel="Delete file"
        onConfirm={remove}
        busy={busy}
        error={error}
      />
    </>
  );
}
