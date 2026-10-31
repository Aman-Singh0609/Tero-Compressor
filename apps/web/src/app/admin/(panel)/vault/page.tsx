'use client';

import {
  Download,
  File as FileIcon,
  FileText,
  Film,
  ImageIcon,
  LayoutGrid,
  List,
  Pencil,
  Replace,
  Trash2,
  Upload,
} from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { ApiError, vaultApi, type VaultFile } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes, formatDate, formatNumber, friendlyError } from '@/lib/format';
import { useDebounced, useResource } from '@/lib/hooks';
import { PageHeader, Pager, SearchBox, SelectFilter, TableSkeleton, Toolbar } from '@/components/admin/common';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  Label,
  LinkButton,
  Modal,
  Notice,
} from '@/components/ui/primitives';

function TypeIcon({ category }: { category: string }) {
  const props = { className: 'size-5', 'aria-hidden': true } as const;
  if (category === 'image') return <ImageIcon {...props} />;
  if (category === 'video') return <Film {...props} />;
  if (category === 'pdf' || category === 'document') return <FileText {...props} />;
  return <FileIcon {...props} />;
}

export default function VaultPage() {
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [page, setPage] = useState(1);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editing, setEditing] = useState<VaultFile | null>(null);
  const [deleting, setDeleting] = useState<VaultFile | null>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const [replaceTarget, setReplaceTarget] = useState<VaultFile | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const dq = useDebounced(q);

  const list = useResource(() => vaultApi.list({ page, limit: 24, q: dq, type }), [page, dq, type]);
  const rows = list.data?.items ?? [];

  const doReplace = async (file: File) => {
    if (!replaceTarget) return;
    try {
      await vaultApi.replace(replaceTarget.id, file);
      setMessage({ tone: 'ok', text: `“${replaceTarget.displayName}” was replaced.` });
      list.refetch();
    } catch (err) {
      setMessage({
        tone: 'danger',
        text: err instanceof ApiError ? friendlyError(err.code, err.message) : friendlyError('INTERNAL_ERROR'),
      });
    }
    setReplaceTarget(null);
  };

  return (
    <>
      <PageHeader
        title="Vault"
        description="Files you keep on purpose. The vault is never touched by automatic cleanup."
        actions={
          <Button onClick={() => setUploadOpen(true)}>
            <Upload className="size-4" aria-hidden /> Add file
          </Button>
        }
      />
      {message && (
        <div className="mb-4">
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      )}
      <input
        ref={replaceInput}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose replacement file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void doReplace(f);
        }}
      />

      <Card>
        <Toolbar>
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              setPage(1);
            }}
            placeholder="Search name or description"
          />
          <SelectFilter
            label="Type"
            value={type}
            onChange={(v) => {
              setType(v);
              setPage(1);
            }}
            options={[
              ['', 'All types'],
              ['image', 'Images'],
              ['pdf', 'PDF'],
              ['video', 'Video'],
              ['document', 'Documents'],
              ['archive', 'Archives'],
              ['other', 'Other'],
            ]}
          />
          <div className="ml-auto flex rounded-lg border border-line-strong p-0.5" role="group" aria-label="View">
            {(
              [
                ['list', List, 'List view'],
                ['grid', LayoutGrid, 'Grid view'],
              ] as const
            ).map(([v, Icon, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                aria-label={label}
                onClick={() => setView(v)}
                className={cn(
                  'grid size-9 place-items-center rounded-md',
                  view === v ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink',
                )}
              >
                <Icon className="size-4" aria-hidden />
              </button>
            ))}
          </div>
        </Toolbar>

        {list.error && !list.data ? (
          <ErrorState message={friendlyError(list.error.code, list.error.message)} onRetry={list.refetch} />
        ) : list.loading && !list.data ? (
          <TableSkeleton rows={5} cols={4} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={dq || type ? 'No vault files match' : 'The vault is empty'}
            hint={
              dq || type ? 'Try clearing the search or filter.' : 'Add a file to keep it until you decide to remove it.'
            }
            action={
              !dq && !type ? (
                <Button variant="secondary" onClick={() => setUploadOpen(true)}>
                  Add a file
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className={list.loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
            {view === 'list' ? (
              <ul className="divide-y divide-line">
                {rows.map((f) => (
                  <VaultRow
                    key={f.id}
                    file={f}
                    onEdit={() => setEditing(f)}
                    onDelete={() => setDeleting(f)}
                    onReplace={() => {
                      setReplaceTarget(f);
                      replaceInput.current?.click();
                    }}
                    onDownloaded={() => setTimeout(list.refetch, 800)}
                  />
                ))}
              </ul>
            ) : (
              <ul className="grid gap-3 p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-3">
                {rows.map((f) => (
                  <VaultCard
                    key={f.id}
                    file={f}
                    onEdit={() => setEditing(f)}
                    onDelete={() => setDeleting(f)}
                    onReplace={() => {
                      setReplaceTarget(f);
                      replaceInput.current?.click();
                    }}
                    onDownloaded={() => setTimeout(list.refetch, 800)}
                  />
                ))}
              </ul>
            )}
            <Pager pagination={list.data?.pagination} onPage={setPage} loading={list.loading} />
          </div>
        )}
      </Card>

      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onDone={() => {
          setMessage(null);
          list.refetch();
        }}
      />
      <EditDialog file={editing} onClose={() => setEditing(null)} onDone={list.refetch} />
      <DeleteDialog file={deleting} onClose={() => setDeleting(null)} onDone={list.refetch} />
    </>
  );
}

interface ItemProps {
  file: VaultFile;
  onEdit: () => void;
  onDelete: () => void;
  onReplace: () => void;
  onDownloaded: () => void;
}

function Actions({ file, onEdit, onDelete, onReplace, onDownloaded }: ItemProps) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <LinkButton
        size="sm"
        variant="secondary"
        href={vaultApi.downloadUrl(file.id)}
        download
        onClick={onDownloaded}
        aria-label={`Download ${file.displayName}`}
      >
        <Download className="size-4" aria-hidden /> <span className="hidden sm:inline">Download</span>
      </LinkButton>
      <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Rename or describe ${file.displayName}`}>
        <Pencil className="size-4" aria-hidden />
      </Button>
      <Button size="sm" variant="ghost" onClick={onReplace} aria-label={`Replace the file for ${file.displayName}`}>
        <Replace className="size-4" aria-hidden />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={onDelete}
        aria-label={`Delete ${file.displayName}`}
        className="text-danger"
      >
        <Trash2 className="size-4" aria-hidden />
      </Button>
    </div>
  );
}

function VaultRow(props: ItemProps) {
  const { file } = props;
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap">
      <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted">
        <TypeIcon category={file.category} />
      </span>
      <div className="min-w-0 flex-1 basis-40">
        <p className="truncate font-medium text-ink" title={file.displayName}>
          {file.displayName}
        </p>
        <p className="truncate text-xs text-muted">{file.description || 'No description'}</p>
      </div>
      <div className="hidden text-right text-xs text-muted md:block">
        <p>
          {formatBytes(file.sizeBytes)} · {formatDate(file.createdAt)}
        </p>
        <p>
          {formatNumber(file.downloadCount)} download{file.downloadCount === 1 ? '' : 's'}
        </p>
      </div>
      <Actions {...props} />
    </li>
  );
}

function VaultCard(props: ItemProps) {
  const { file } = props;
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-line p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted">
          <TypeIcon category={file.category} />
        </span>
        <div className="min-w-0">
          <p className="truncate font-medium text-ink" title={file.displayName}>
            {file.displayName}
          </p>
          <p className="line-clamp-2 text-xs text-muted">{file.description || 'No description'}</p>
        </div>
      </div>
      <p className="text-xs text-muted">
        {formatBytes(file.sizeBytes)} · {formatNumber(file.downloadCount)} downloads · {formatDate(file.createdAt)}
      </p>
      <Actions {...props} />
    </li>
  );
}

function UploadDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setFile(null);
    setDescription('');
    setError(null);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await vaultApi.upload(file, description.trim() || undefined);
      reset();
      onOpenChange(false);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? friendlyError(err.code, err.message) : friendlyError('INTERNAL_ERROR'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Add to vault"
      description="Kept until you delete it."
    >
      <form id="vault-upload" onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="vault-file">File</Label>
          <Input
            id="vault-file"
            type="file"
            required
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="h-auto py-2.5"
          />
          {file && <p className="mt-1 text-xs text-muted">{formatBytes(file.size)}</p>}
        </div>
        <div>
          <Label htmlFor="vault-desc">Description (optional)</Label>
          <Input
            id="vault-desc"
            maxLength={1000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Passport scan for Mum"
          />
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!file}>
            Upload
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function EditDialog({ file, onClose, onDone }: { file: VaultFile | null; onClose: () => void; onDone: () => void }) {
  return (
    <Modal
      open={file !== null}
      onOpenChange={(o) => !o && onClose()}
      title="Rename or describe"
      description="Only the label changes — the stored file stays the same."
    >
      {file && <EditForm key={file.id} file={file} onClose={onClose} onDone={onDone} />}
    </Modal>
  );
}

function EditForm({ file, onClose, onDone }: { file: VaultFile; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(file.displayName);
  const [description, setDescription] = useState(file.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await vaultApi.update(file.id, { displayName: name.trim(), description: description.trim() || null });
      onClose();
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? friendlyError(err.code, err.message) : friendlyError('INTERNAL_ERROR'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <Label htmlFor="edit-name">Name</Label>
        <Input id="edit-name" required maxLength={255} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="edit-desc">Description</Label>
        <Input id="edit-desc" maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" loading={busy} disabled={!name.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}

function DeleteDialog({ file, onClose, onDone }: { file: VaultFile | null; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await vaultApi.remove(file.id);
      onClose();
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? friendlyError(err.code, err.message) : friendlyError('INTERNAL_ERROR'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      open={file !== null}
      onOpenChange={(o) => {
        if (!o) {
          setError(null);
          onClose();
        }
      }}
      title={`Delete “${file?.displayName ?? ''}”?`}
      description="This permanently removes the file from the vault. It can’t be recovered."
      confirmLabel="Delete permanently"
      onConfirm={run}
      busy={busy}
      error={error}
    />
  );
}
