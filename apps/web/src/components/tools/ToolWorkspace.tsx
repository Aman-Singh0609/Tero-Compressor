'use client';

/* A small same-origin thumbnail re-encoded by our own API: next/image would add nothing here. */
/* eslint-disable @next/next/no-img-element */

import {
  AlertCircle,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  Check,
  FileText,
  Film,
  ImageIcon,
  Lock,
  RotateCcw,
  UploadCloud,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ApiError, filesApi, jobsApi, type Formats, type Job, type ToolInfo, type UploadedFile } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes, formatDuration, friendlyError } from '@/lib/format';
import { describeResult } from '@/lib/resultSummary';
import { buildOptions, initialValues, type FormValues } from '@/lib/toolForm';
import { Button, Card, LinkButton, Notice, ProgressBar } from '@/components/ui/primitives';
import { ToolForm } from './ToolForm';

interface Item {
  key: number;
  name: string;
  size: number;
  state: 'uploading' | 'ready' | 'error';
  progress: number;
  error?: string;
  file?: UploadedFile;
  abort?: AbortController;
}

type Phase =
  | { kind: 'select' }
  | { kind: 'processing'; jobId: string; job?: Job }
  | { kind: 'done'; job: Job }
  | { kind: 'failed'; message: string; code: string | null };

const KIND_WORD: Record<string, string> = { pdf: 'PDF', image: 'image', document: 'Word', video: 'video' };

function extensionsFor(formats: Formats, tool: ToolInfo): string[] {
  const exts = formats.types.filter((t) => tool.accepts.includes(t.category)).map((t) => t.extension);
  if (tool.accepts.includes('image')) exts.push('jpeg', 'tif');
  return [...new Set(exts)];
}

function kindLabel(tool: ToolInfo): string {
  return tool.accepts.map((a) => KIND_WORD[a] ?? a).join(' / ');
}

export function ToolWorkspace({
  tool,
  formats,
  initialFileId,
}: {
  tool: ToolInfo;
  formats: Formats;
  initialFileId?: string;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [values, setValues] = useState<FormValues>(() => initialValues(tool.fields));
  const [phase, setPhase] = useState<Phase>({ kind: 'select' });
  const [formError, setFormError] = useState<{ field: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const counter = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const itemsRef = useRef<Item[]>([]);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const exts = useMemo(() => extensionsFor(formats, tool), [formats, tool]);
  const multi = tool.maxFiles > 1;
  const ready = items.filter((i) => i.state === 'ready');
  const uploading = items.some((i) => i.state === 'uploading');
  const busy = phase.kind === 'processing';

  const patch = useCallback((key: number, change: Partial<Item>) => {
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...change } : i)));
  }, []);

  const startUpload = useCallback(
    (key: number, file: File) => {
      const controller = new AbortController();
      patch(key, { abort: controller });
      // upload one at a time: simpler progress and gentler on the server
      queue.current = queue.current.then(async () => {
        if (controller.signal.aborted) return;
        try {
          const res = await filesApi.upload(file, (f) => patch(key, { progress: f }), controller.signal);
          patch(key, { state: 'ready', progress: 1, file: res.file, abort: undefined });
        } catch (err) {
          if (err instanceof ApiError && err.code === 'ABORTED') return;
          patch(key, {
            state: 'error',
            error: err instanceof ApiError ? friendlyError(err.code, err.message) : friendlyError('INTERNAL_ERROR'),
            abort: undefined,
          });
        }
      });
    },
    [patch],
  );

  const addFiles = useCallback(
    (picked: File[]) => {
      setNotice(null);
      if (phase.kind !== 'select' && phase.kind !== 'failed') return;
      if (phase.kind === 'failed') setPhase({ kind: 'select' });
      const current = itemsRef.current.filter((i) => i.state !== 'error').length;
      const room = tool.maxFiles - current;
      if (room <= 0) {
        setNotice(multi ? `You can add up to ${tool.maxFiles} files.` : 'Remove the current file to choose another.');
        return;
      }
      const accepted = picked.slice(0, room);
      if (picked.length > room)
        setNotice(`Only ${tool.maxFiles} files fit here, so ${picked.length - room} were skipped.`);
      const fresh: Item[] = accepted.map((file) => {
        const key = ++counter.current;
        const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
        let error: string | undefined;
        if (!exts.includes(ext)) error = `Not a ${kindLabel(tool)} file.`;
        else if (file.size > formats.maxUploadBytes)
          error = `This file is ${formatBytes(file.size)}. The limit is ${formatBytes(formats.maxUploadBytes)}.`;
        else if (file.size === 0) error = 'This file is empty.';
        return { key, name: file.name, size: file.size, state: error ? 'error' : 'uploading', progress: 0, error };
      });
      setItems((list) => [...list, ...fresh]);
      fresh.forEach((it, idx) => {
        if (it.state === 'uploading') startUpload(it.key, accepted[idx]!);
      });
    },
    [phase.kind, tool, multi, exts, formats.maxUploadBytes, startUpload],
  );

  // A file chosen on the "Start" page arrives as ?file=<id>
  const loadedInitial = useRef(false);
  useEffect(() => {
    if (!initialFileId || loadedInitial.current) return;
    loadedInitial.current = true;
    filesApi
      .get(initialFileId)
      .then(({ file }) => {
        if (!tool.accepts.includes(file.category)) return;
        setItems([
          { key: ++counter.current, name: file.name, size: file.sizeBytes, state: 'ready', progress: 1, file },
        ]);
      })
      .catch(() => setNotice('That file is no longer available. Please add it again.'));
  }, [initialFileId, tool]);

  const removeItem = (item: Item) => {
    item.abort?.abort();
    if (item.file) filesApi.remove(item.file.id).catch(() => undefined);
    setItems((list) => list.filter((i) => i.key !== item.key));
  };

  const move = (index: number, delta: -1 | 1) => {
    setItems((list) => {
      const next = [...list];
      const target = index + delta;
      if (target < 0 || target >= next.length) return list;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };

  const reset = (deleteInputs: boolean) => {
    if (deleteInputs) itemsRef.current.forEach((i) => i.file && filesApi.remove(i.file.id).catch(() => undefined));
    setItems([]);
    setValues(initialValues(tool.fields));
    setPhase({ kind: 'select' });
    setFormError(null);
    setNotice(null);
  };

  const start = async () => {
    setFormError(null);
    const built = buildOptions(tool.fields, values);
    if (!built.ok) {
      setFormError({ field: built.field, message: built.error });
      document.getElementById(`tool-field-${built.field}`)?.focus();
      return;
    }
    setStarting(true);
    try {
      const { jobId } = await jobsApi.create(
        ready.map((i) => i.file!.id),
        tool.operation,
        built.options,
      );
      setPhase({ kind: 'processing', jobId });
    } catch (err) {
      setPhase({ kind: 'select' });
      setNotice(err instanceof ApiError ? friendlyError(err.code, err.message) : friendlyError('INTERNAL_ERROR'));
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
        if (job.status === 'COMPLETED') setPhase({ kind: 'done', job });
        else if (job.status === 'FAILED')
          setPhase({
            kind: 'failed',
            code: job.error?.code ?? null,
            message: friendlyError(job.error?.code, job.error?.message),
          });
        else if (job.status === 'CANCELLED') setPhase({ kind: 'select' });
        else setPhase({ kind: 'processing', jobId, job });
      } catch (err) {
        if (!stopped && err instanceof ApiError && err.code !== 'NETWORK_ERROR') {
          setPhase({ kind: 'failed', code: err.code, message: friendlyError(err.code, err.message) });
        }
      }
    };
    const timer = setInterval(tick, 700);
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [jobId]);

  // leaving the page stops unfinished uploads
  useEffect(() => () => itemsRef.current.forEach((i) => i.abort?.abort()), []);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    addFiles(Array.from(e.dataTransfer.files));
  };

  const countHint =
    tool.minFiles > 1
      ? `Add at least ${tool.minFiles} files${tool.maxFiles < 100 ? ` (up to ${tool.maxFiles})` : ''}.`
      : multi
        ? `Add up to ${tool.maxFiles} files.`
        : '';
  const canStart = ready.length >= tool.minFiles && !uploading && !busy && !starting;
  const accept = exts.map((e) => `.${e}`).join(',');

  if (phase.kind === 'done') {
    return <ResultView job={phase.job} tool={tool} onAgain={() => reset(true)} />;
  }

  return (
    <Card className="overflow-hidden">
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        multiple={multi}
        accept={accept}
        aria-label={`Choose ${kindLabel(tool)} file${multi ? 's' : ''}`}
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (picked.length) addFiles(picked);
        }}
      />

      {/* 1 — files */}
      <section aria-labelledby="step-files" className="p-4 sm:p-6">
        <h2 id="step-files" className="mb-3 text-sm font-semibold text-ink">
          {multi ? '1. Add your files' : '1. Add your file'}
        </h2>
        {(items.length === 0 || (multi && items.length < tool.maxFiles)) && !busy && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              'flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors',
              dragging ? 'border-accent bg-accent-soft' : 'border-line-strong',
              items.length > 0 && 'py-5',
            )}
          >
            <span className="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent">
              <UploadCloud className="size-6" aria-hidden />
            </span>
            <p className="text-sm text-ink">
              Drop {multi ? 'files' : 'a file'} here, or{' '}
              <button
                type="button"
                className="font-medium text-accent underline underline-offset-2 hover:text-accent-hover"
                onClick={() => inputRef.current?.click()}
              >
                browse
              </button>
            </p>
            <p className="text-xs text-muted">
              {kindLabel(tool)} · up to {formatBytes(formats.maxUploadBytes)} each{countHint && ` · ${countHint}`}
            </p>
          </div>
        )}

        {items.length > 0 && (
          <ul className="mt-4 space-y-2" aria-label="Selected files">
            {items.map((item, index) => (
              <li
                key={item.key}
                className={cn(
                  'flex items-center gap-3 rounded-xl border p-3',
                  item.state === 'error' ? 'border-danger/40 bg-danger-soft' : 'border-line',
                )}
              >
                <Thumb item={item} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink" title={item.name}>
                    {multi && item.state !== 'error' && (
                      <span className="mr-1.5 text-muted tabular-nums">{index + 1}.</span>
                    )}
                    {item.name}
                  </p>
                  {item.state === 'error' ? (
                    <p className="flex items-center gap-1 text-xs text-danger">
                      <AlertCircle className="size-3.5 shrink-0" aria-hidden /> {item.error}
                    </p>
                  ) : item.state === 'uploading' ? (
                    <div className="mt-1.5">
                      <ProgressBar
                        value={item.progress >= 1 ? null : item.progress * 100}
                        label={`Uploading ${item.name}`}
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-muted">{formatBytes(item.size)}</p>
                  )}
                </div>
                {multi && !busy && item.state !== 'error' && (
                  <div className="flex shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Move ${item.name} up`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp className="size-4" aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Move ${item.name} down`}
                      disabled={index === items.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown className="size-4" aria-hidden />
                    </Button>
                  </div>
                )}
                {!busy && (
                  <Button variant="ghost" size="sm" aria-label={`Remove ${item.name}`} onClick={() => removeItem(item)}>
                    <X className="size-4" aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {notice && (
          <div className="mt-3">
            <Notice tone="danger">{notice}</Notice>
          </div>
        )}
        {multi && items.length > 0 && tool.minFiles > 1 && ready.length < tool.minFiles && (
          <p className="mt-3 text-xs text-muted">{countHint}</p>
        )}
      </section>

      {/* 2 — options */}
      {tool.fields.length > 0 && (
        <section aria-labelledby="step-options" className="border-t border-line p-4 sm:p-6">
          <h2 id="step-options" className="mb-3 text-sm font-semibold text-ink">
            2. Choose your settings
          </h2>
          <ToolForm
            fields={tool.fields}
            values={values}
            invalidField={formError?.field}
            disabled={busy}
            onChange={(key, value) => {
              setValues((v) => ({ ...v, [key]: value }));
              if (formError?.field === key) setFormError(null);
            }}
          />
          {formError && (
            <div className="mt-3">
              <Notice tone="danger">{formError.message}</Notice>
            </div>
          )}
          {tool.secretFields.length > 0 && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted">
              <Lock className="size-3.5" aria-hidden /> Passwords are used once and never saved.
            </p>
          )}
        </section>
      )}

      {/* 3 — go */}
      <section className="border-t border-line p-4 sm:p-6" aria-live="polite">
        {phase.kind === 'failed' && (
          <div className="mb-4">
            <Notice tone="danger">{phase.message}</Notice>
          </div>
        )}
        {phase.kind === 'processing' ? (
          <ProcessingView
            job={phase.job}
            label={tool.label}
            onCancel={async () => {
              try {
                await jobsApi.cancel(phase.jobId);
              } catch {
                /* already finished: the poller picks up the final state */
              }
            }}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={start} disabled={!canStart} loading={starting}>
              {tool.label}
            </Button>
            {items.length > 0 && (
              <Button variant="ghost" onClick={() => reset(true)}>
                Start over
              </Button>
            )}
            {uploading && <span className="text-xs text-muted">Waiting for uploads…</span>}
          </div>
        )}
      </section>
    </Card>
  );
}

function Thumb({ item }: { item: Item }) {
  const [failed, setFailed] = useState(false);
  const cat = item.file?.category;
  if (cat === 'image' && item.file && !failed) {
    return (
      <img
        src={filesApi.thumbnailUrl(item.file.id)}
        alt=""
        onError={() => setFailed(true)}
        className="size-11 shrink-0 rounded-lg border border-line object-cover"
      />
    );
  }
  const Icon = cat === 'video' ? Film : cat === 'image' ? ImageIcon : FileText;
  return (
    <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted">
      <Icon className="size-5" aria-hidden />
    </span>
  );
}

function ProcessingView({ job, label, onCancel }: { job?: Job; label: string; onCancel: () => void }) {
  const queued = !job || job.status === 'QUEUED';
  // Only show a percentage when the backend has a real one; otherwise stay honestly indeterminate.
  const value = job && job.status === 'PROCESSING' && job.progress > 0 ? job.progress : null;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium text-ink">{queued ? 'Waiting to start…' : `${label}…`}</span>
        <span className="text-muted tabular-nums">{value !== null ? `${value}%` : ''}</span>
      </div>
      <ProgressBar value={value} label={`${label} progress`} />
      <Button variant="ghost" size="sm" onClick={onCancel}>
        <X className="size-4" aria-hidden /> Cancel
      </Button>
    </div>
  );
}

function ResultView({ job, tool, onAgain }: { job: Job; tool: ToolInfo; onAgain: () => void }) {
  const saved = job.savingPercent ?? 0;
  const unchanged = Boolean(job.result?.keptOriginal);
  const reduced = saved > 0 && !unchanged;
  const facts = describeResult(job);
  const note = typeof job.result?.note === 'string' ? job.result.note : null;
  return (
    <Card className="tero-rise space-y-5 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-full bg-ok-soft text-ok">
          <Check className="size-5" aria-hidden />
        </span>
        <div>
          <p className="font-semibold text-ink">{unchanged ? 'Done — nothing to shrink' : 'All done'}</p>
          <p className="text-sm text-muted">Finished in {formatDuration(job.processingDurationMs)}</p>
        </div>
      </div>
      {note && <Notice tone="info">{note}</Notice>}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat
          label={job.inputs.length > 1 ? `Original (${job.inputs.length} files)` : 'Original'}
          value={formatBytes(job.originalSizeBytes)}
        />
        <Stat label="Result" value={formatBytes(job.outputSizeBytes)} />
        {tool.reducesSize && (
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
      {facts.length > 0 && (
        <ul className="space-y-1 text-sm text-muted">
          {facts.map((f) => (
            <li key={f} className="flex gap-2">
              <Check className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden /> {f}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <LinkButton size="lg" href={jobsApi.downloadUrl(job.id)} download>
          <ArrowDownToLine className="size-5" aria-hidden /> {tool.outputKind === 'zip' ? 'Download ZIP' : 'Download'}
        </LinkButton>
        <Button variant="secondary" onClick={onAgain}>
          <RotateCcw className="size-4" aria-hidden /> Do another
        </Button>
      </div>
      <p className="text-xs text-muted">Your files are removed automatically after a few days.</p>
    </Card>
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
