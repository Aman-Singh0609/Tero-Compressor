'use client';

import {
  ArrowDownToLine,
  Check,
  FileText,
  Film,
  FileType2,
  ImageIcon,
  Lock,
  Music,
  RotateCcw,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  ApiError,
  filesApi,
  jobsApi,
  type FileCategory,
  type Formats,
  type Job,
  type JobOptions,
  type OperationName,
  type Preset,
  type UploadResult,
} from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes, formatDuration, friendlyError, OPERATION_LABELS, PRESET_LABELS } from '@/lib/format';
import { useResource } from '@/lib/hooks';
import {
  Button,
  Card,
  Input,
  Label,
  LinkButton,
  Notice,
  ProgressBar,
  Select,
  Skeleton,
} from '@/components/ui/primitives';

type Phase =
  | { kind: 'idle' }
  | { kind: 'uploading'; fileName: string; progress: number }
  | { kind: 'ready'; upload: UploadResult }
  | { kind: 'processing'; upload: UploadResult; jobId: string; job?: Job }
  | { kind: 'done'; upload: UploadResult; job: Job }
  | { kind: 'failed'; upload: UploadResult; message: string };

const CATEGORY_META: Record<string, { label: string; icon: typeof FileText; blurb: string }> = {
  pdf: { label: 'PDF', icon: FileText, blurb: 'Shrink scans and photo-heavy PDFs' },
  image: { label: 'Images', icon: ImageIcon, blurb: 'Compress, resize, convert, clean metadata' },
  video: { label: 'Video', icon: Film, blurb: 'Make videos smaller or pull out the audio' },
  document: { label: 'Documents', icon: FileType2, blurb: 'Shrink pictures inside Word files' },
};

const PRESET_OPS: OperationName[] = ['IMAGE_COMPRESS', 'PDF_COMPRESS', 'DOCX_COMPRESS', 'VIDEO_COMPRESS'];

export function FileTool() {
  const formats = useResource(() => filesApi.formats(), []);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const [accept, setAccept] = useState<string | undefined>();

  const allAccept = useMemo(() => acceptFor(formats.data), [formats.data]);

  const openPicker = useCallback(
    (category?: FileCategory) => {
      setAccept(category ? acceptFor(formats.data, category) : allAccept);
      // wait a tick so the new `accept` is applied before the dialog opens
      setTimeout(() => inputRef.current?.click(), 0);
    },
    [formats.data, allAccept],
  );

  const startUpload = useCallback(
    async (file: File) => {
      setError(null);
      const limit = formats.data?.maxUploadBytes;
      if (limit && file.size > limit) {
        setError(`This file is ${formatBytes(file.size)}. The limit is ${formatBytes(limit)}.`);
        return;
      }
      setPhase({ kind: 'uploading', fileName: file.name, progress: 0 });
      const controller = new AbortController();
      uploadAbort.current = controller;
      try {
        const upload = await filesApi.upload(
          file,
          (f) => setPhase({ kind: 'uploading', fileName: file.name, progress: f }),
          controller.signal,
        );
        setPhase({ kind: 'ready', upload });
      } catch (err) {
        setPhase({ kind: 'idle' });
        if (err instanceof ApiError && err.code === 'ABORTED') return; // the user pressed Cancel
        setError(err instanceof ApiError ? friendlyError(err.code, err.message) : friendlyError('INTERNAL_ERROR'));
      }
    },
    [formats.data],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && phase.kind === 'idle') void startUpload(file);
  };

  const reset = useCallback((upload?: UploadResult) => {
    if (upload) filesApi.remove(upload.file.id).catch(() => undefined); // best effort: don't leave it sitting there
    setPhase({ kind: 'idle' });
    setError(null);
  }, []);

  return (
    <div className="space-y-12">
      <section aria-label="Upload a file">
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          tabIndex={-1}
          accept={accept ?? allAccept}
          aria-label="Choose a file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void startUpload(file);
          }}
        />
        <Card className="overflow-hidden">
          {phase.kind === 'idle' && (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cn(
                'm-3 flex flex-col items-center gap-4 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors sm:py-16',
                dragging ? 'border-accent bg-accent-soft' : 'border-line-strong',
              )}
            >
              <span className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent">
                <UploadCloud className="size-7" aria-hidden />
              </span>
              <div className="space-y-1">
                <p className="text-lg font-semibold text-ink">Drop a file here</p>
                <p className="text-sm text-muted">or choose one from your device</p>
              </div>
              <Button size="lg" onClick={() => openPicker()}>
                Choose file
              </Button>
              <div className="max-w-md text-xs text-muted">
                {formats.loading ? <Skeleton className="mx-auto h-3 w-64" /> : supportedLine(formats.data)}
              </div>
              {error && (
                <div className="w-full max-w-md">
                  <Notice tone="danger">{error}</Notice>
                </div>
              )}
            </div>
          )}

          {phase.kind === 'uploading' && (
            <div className="space-y-4 p-6 sm:p-8" aria-live="polite">
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="truncate font-medium text-ink">{phase.fileName}</span>
                <span className="shrink-0 text-muted">
                  {phase.progress >= 1 ? 'Checking file…' : `Uploading ${Math.round(phase.progress * 100)}%`}
                </span>
              </div>
              <ProgressBar value={phase.progress >= 1 ? null : phase.progress * 100} label="Upload progress" />
              <Button variant="ghost" size="sm" onClick={() => uploadAbort.current?.abort()}>
                <X className="size-4" aria-hidden /> Cancel upload
              </Button>
            </div>
          )}

          {(phase.kind === 'ready' ||
            phase.kind === 'processing' ||
            phase.kind === 'done' ||
            phase.kind === 'failed') && <Workspace phase={phase} setPhase={setPhase} onReset={reset} />}
        </Card>

        <p className="mt-4 flex items-center justify-center gap-2 text-center text-xs text-muted">
          <Lock className="size-3.5 shrink-0" aria-hidden />
          Private by design. Files are never shared and are deleted automatically
          {formats.data ? ` after ${formats.data.retentionDays} days` : ''} — or right away when you press Delete.
        </p>
      </section>

      <section aria-labelledby="tools-heading">
        <h2 id="tools-heading" className="mb-4 text-sm font-semibold tracking-wide text-muted uppercase">
          Popular tools
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(['pdf', 'image', 'video', 'document'] as const).map((cat) => {
            const meta = CATEGORY_META[cat]!;
            const Icon = meta.icon;
            const ops = formats.data?.operations.filter((o) => o.accepts.includes(cat)) ?? [];
            return (
              <li key={cat}>
                <button
                  type="button"
                  disabled={phase.kind !== 'idle'}
                  onClick={() => openPicker(cat)}
                  className="group h-full w-full rounded-[var(--radius-card)] border border-line bg-surface p-4 text-left shadow-card transition hover:-translate-y-0.5 hover:border-line-strong disabled:opacity-60 disabled:hover:translate-y-0"
                >
                  <span className="mb-3 grid size-10 place-items-center rounded-lg bg-surface-2 text-ink transition-colors group-hover:bg-accent-soft group-hover:text-accent">
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <span className="block font-semibold text-ink">{meta.label}</span>
                  <span className="mt-0.5 block text-sm text-muted">{meta.blurb}</span>
                  {ops.length > 0 && (
                    <span className="mt-3 block text-xs text-muted">{ops.map((o) => o.label).join(' · ')}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 flex items-center gap-2 text-xs text-muted">
          <Music className="size-3.5" aria-hidden /> Audio tools aren’t available yet.
        </p>
      </section>
    </div>
  );
}

function acceptFor(formats: Formats | undefined, category?: FileCategory): string {
  if (!formats) return '.jpg,.jpeg,.png,.webp,.pdf,.docx,.mp4,.mov,.webm,.mkv,.avi';
  const exts = formats.types.filter((t) => !category || t.category === category).map((t) => `.${t.extension}`);
  if (!category || category === 'image') exts.push('.jpeg');
  return [...new Set(exts)].join(',');
}

function supportedLine(formats: Formats | undefined): string {
  if (!formats) return 'PDF, Word, images and videos.';
  const exts = [...new Set(formats.types.map((t) => t.extension.toUpperCase()))].join(', ');
  return `Supported: ${exts}. Up to ${formatBytes(formats.maxUploadBytes)}.`;
}

// ---------------------------------------------------------------------------

function Workspace({
  phase,
  setPhase,
  onReset,
}: {
  phase: Extract<Phase, { kind: 'ready' | 'processing' | 'done' | 'failed' }>;
  setPhase: (p: Phase) => void;
  onReset: (upload?: UploadResult) => void;
}) {
  const { upload } = phase;
  const { file } = upload;
  const [selected, setSelected] = useState<OperationName | null>(
    upload.suggestedOperations.length === 1 ? (upload.suggestedOperations[0]?.operation ?? null) : null,
  );
  const [preset, setPreset] = useState<Preset>('BALANCED');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [format, setFormat] = useState<'jpeg' | 'png' | 'webp'>('webp');
  const [formError, setFormError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const busy = phase.kind === 'processing';

  const buildOptions = (): JobOptions | null => {
    if (!selected) return null;
    if (PRESET_OPS.includes(selected)) return { preset };
    if (selected === 'IMAGE_RESIZE') {
      const w = width ? Number(width) : undefined;
      const h = height ? Number(height) : undefined;
      if (!w && !h) {
        setFormError('Enter a width, a height, or both.');
        return null;
      }
      if (
        (w !== undefined && (!Number.isInteger(w) || w < 1)) ||
        (h !== undefined && (!Number.isInteger(h) || h < 1))
      ) {
        setFormError('Sizes must be whole numbers above zero.');
        return null;
      }
      return { width: w, height: h };
    }
    if (selected === 'IMAGE_CONVERT') return { format, preset: 'BALANCED' };
    return {};
  };

  const start = async () => {
    setFormError(null);
    const options = buildOptions();
    if (!selected || !options) return;
    setStarting(true);
    try {
      const { jobId } = await jobsApi.create(file.id, selected, options);
      setPhase({ kind: 'processing', upload, jobId });
    } catch (err) {
      setFormError(err instanceof ApiError ? friendlyError(err.code, err.message) : friendlyError('INTERNAL_ERROR'));
    } finally {
      setStarting(false);
    }
  };

  // Poll the real job state from the backend.
  const jobId = phase.kind === 'processing' ? phase.jobId : null;
  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const job = await jobsApi.get(jobId);
        if (stopped) return;
        if (job.status === 'COMPLETED') setPhase({ kind: 'done', upload, job });
        else if (job.status === 'FAILED')
          setPhase({ kind: 'failed', upload, message: friendlyError(job.error?.code, job.error?.message) });
        else if (job.status === 'CANCELLED') setPhase({ kind: 'ready', upload });
        else setPhase({ kind: 'processing', upload, jobId, job });
      } catch (err) {
        if (!stopped && err instanceof ApiError && err.code !== 'NETWORK_ERROR') {
          setPhase({ kind: 'failed', upload, message: friendlyError(err.code, err.message) });
        }
      }
    };
    const timer = setInterval(tick, 700);
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const operationLabel = selected ? OPERATION_LABELS[selected] : '';

  return (
    <div className="tero-rise divide-y divide-line">
      <header className="flex items-center gap-4 p-4 sm:p-5">
        <Preview upload={upload} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-ink" title={file.name}>
            {file.name}
          </p>
          <p className="text-sm text-muted">
            {file.extension.toUpperCase()} · {formatBytes(file.sizeBytes)}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onReset(upload)}
          disabled={busy}
          aria-label="Delete this file and start over"
        >
          <Trash2 className="size-4" aria-hidden />
          <span className="hidden sm:inline">Delete</span>
        </Button>
      </header>

      {(phase.kind === 'ready' || phase.kind === 'failed') && (
        <div className="space-y-5 p-4 sm:p-5">
          {phase.kind === 'failed' && <Notice tone="danger">{phase.message}</Notice>}
          <fieldset>
            <legend className="mb-2 text-sm font-semibold text-ink">What would you like to do?</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {upload.suggestedOperations.map((op) => (
                <label
                  key={op.operation}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent',
                    selected === op.operation ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2',
                  )}
                >
                  <input
                    type="radio"
                    name="operation"
                    className="mt-1 accent-[var(--accent)]"
                    checked={selected === op.operation}
                    onChange={() => setSelected(op.operation)}
                  />
                  <span>
                    <span className="block text-sm font-medium text-ink">{op.label}</span>
                    <span className="block text-xs text-muted">{op.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {selected && PRESET_OPS.includes(selected) && (
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-ink">How small?</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {(Object.keys(PRESET_LABELS) as Preset[]).map((p) => (
                  <label
                    key={p}
                    className={cn(
                      'cursor-pointer rounded-xl border p-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent',
                      preset === p ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2',
                    )}
                  >
                    <input
                      type="radio"
                      name="preset"
                      className="sr-only"
                      checked={preset === p}
                      onChange={() => setPreset(p)}
                    />
                    <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                      {preset === p && <Check className="size-3.5 text-accent" aria-hidden />}
                      {PRESET_LABELS[p].label}
                    </span>
                    <span className="block text-xs text-muted">{PRESET_LABELS[p].hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {selected === 'IMAGE_RESIZE' && (
            <div className="grid max-w-md grid-cols-2 gap-3">
              <div>
                <Label htmlFor="resize-width">Width (px)</Label>
                <Input
                  id="resize-width"
                  inputMode="numeric"
                  placeholder="e.g. 1200"
                  value={width}
                  onChange={(e) => setWidth(e.target.value.replace(/\D/g, ''))}
                />
              </div>
              <div>
                <Label htmlFor="resize-height">Height (px)</Label>
                <Input
                  id="resize-height"
                  inputMode="numeric"
                  placeholder="auto"
                  value={height}
                  onChange={(e) => setHeight(e.target.value.replace(/\D/g, ''))}
                />
              </div>
              <p className="col-span-2 -mt-1 text-xs text-muted">
                Small pictures are never stretched. Leave one box empty to keep the shape.
              </p>
            </div>
          )}

          {selected === 'IMAGE_CONVERT' && (
            <div className="max-w-xs">
              <Label htmlFor="convert-format">Convert to</Label>
              <Select id="convert-format" value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
                <option value="webp">WebP (smallest)</option>
                <option value="jpeg">JPG (works everywhere)</option>
                <option value="png">PNG (keeps transparency)</option>
              </Select>
            </div>
          )}

          {formError && <Notice tone="danger">{formError}</Notice>}

          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={start} disabled={!selected} loading={starting}>
              {selected ? operationLabel : 'Choose an option'}
            </Button>
            <Button variant="ghost" onClick={() => onReset(upload)}>
              Start over
            </Button>
          </div>
        </div>
      )}

      {phase.kind === 'processing' && (
        <ProcessingView
          phase={phase}
          label={jobLabel(phase.job)}
          onCancel={async () => {
            try {
              await jobsApi.cancel(phase.jobId);
            } catch {
              /* already finished: the poller will pick up the final state */
            }
          }}
        />
      )}

      {phase.kind === 'done' && (
        <ResultView job={phase.job} upload={upload} onReset={() => onReset()} onDelete={() => onReset(upload)} />
      )}
    </div>
  );
}

function jobLabel(job?: Job): string {
  return job ? OPERATION_LABELS[job.operation] : 'Working';
}

function Preview({ upload }: { upload: UploadResult }) {
  const [failed, setFailed] = useState(false);
  const isImage = upload.file.category === 'image';
  const Icon = upload.file.category === 'video' ? Film : upload.file.category === 'image' ? ImageIcon : FileText;
  if (isImage && !failed) {
    // A re-encoded, same-origin thumbnail from our own API; next/image optimisation adds nothing here.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={filesApi.thumbnailUrl(upload.file.id)}
        alt=""
        onError={() => setFailed(true)}
        className="size-14 shrink-0 rounded-lg border border-line object-cover"
      />
    );
  }
  return (
    <span className="grid size-14 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted">
      <Icon className="size-6" aria-hidden />
    </span>
  );
}

function ProcessingView({
  phase,
  label,
  onCancel,
}: {
  phase: Extract<Phase, { kind: 'processing' }>;
  label: string;
  onCancel: () => void;
}) {
  const job = phase.job;
  const queued = !job || job.status === 'QUEUED';
  // Only show a percentage when the backend has a real one; otherwise stay honestly indeterminate.
  const value = job && job.status === 'PROCESSING' && job.progress > 0 ? job.progress : null;
  return (
    <div className="space-y-4 p-4 sm:p-6" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium text-ink">{queued ? 'Waiting to start…' : `${label}…`}</span>
        <span className="text-muted tabular-nums">{value !== null ? `${value}%` : ''}</span>
      </div>
      <ProgressBar value={value} label={`${label} progress`} />
      <div>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          <X className="size-4" aria-hidden /> Cancel
        </Button>
      </div>
    </div>
  );
}

function ResultView({
  job,
  upload,
  onReset,
  onDelete,
}: {
  job: Job;
  upload: UploadResult;
  onReset: () => void;
  onDelete: () => void;
}) {
  const saved = job.savingPercent ?? 0;
  const unchanged = Boolean(job.result?.keptOriginal);
  const reduced = saved > 0 && !unchanged;
  const sizeOp = job.operation.endsWith('COMPRESS') || job.operation === 'IMAGE_RESIZE';
  return (
    <div className="tero-rise space-y-5 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-full bg-ok-soft text-ok">
          <Check className="size-5" aria-hidden />
        </span>
        <div>
          <p className="font-semibold text-ink">{unchanged ? 'Done — nothing to shrink' : 'All done'}</p>
          <p className="text-sm text-muted">Finished in {formatDuration(job.processingDurationMs)}</p>
        </div>
      </div>

      {job.result?.note && <Notice tone="info">{String(job.result.note)}</Notice>}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Original" value={formatBytes(job.originalSizeBytes)} />
        <Stat label="Result" value={formatBytes(job.outputSizeBytes)} />
        {sizeOp && (
          <Stat
            label={reduced ? 'Saved' : 'Change'}
            value={
              reduced
                ? `${saved.toFixed(1)}%`
                : unchanged
                  ? 'None'
                  : `${saved > 0 ? '-' : '+'}${Math.abs(saved).toFixed(1)}%`
            }
            highlight={reduced}
          />
        )}
      </dl>

      <div className="flex flex-wrap items-center gap-3">
        <LinkButton size="lg" href={jobsApi.downloadUrl(job.id)} download>
          <ArrowDownToLine className="size-5" aria-hidden /> Download
        </LinkButton>
        <Button variant="secondary" onClick={onReset}>
          <RotateCcw className="size-4" aria-hidden /> Another file
        </Button>
        <Button variant="ghost" onClick={onDelete} aria-label={`Delete ${upload.file.name} and the result from TERO`}>
          <Trash2 className="size-4" aria-hidden /> Delete from TERO
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={cn('rounded-xl border p-3.5', highlight ? 'border-ok/30 bg-ok-soft' : 'border-line bg-surface-2')}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cn('mt-0.5 text-lg font-semibold tabular-nums', highlight ? 'text-ok' : 'text-ink')}>{value}</dd>
    </div>
  );
}
