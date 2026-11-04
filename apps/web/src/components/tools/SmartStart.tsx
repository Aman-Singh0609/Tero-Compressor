'use client';

import { FileText, Film, ImageIcon, Trash2, UploadCloud } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, type DragEvent } from 'react';
import { ApiError, filesApi, type OperationSuggestion, type ToolGroup, type UploadResult } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes, friendlyError } from '@/lib/format';
import { useTools } from '@/lib/tools';
import { Button, Card, Notice, ProgressBar } from '@/components/ui/primitives';
import { toolIcon } from './toolIcons';

const GROUPS: Array<[ToolGroup, string]> = [
  ['optimize', 'Make it smaller'],
  ['convert', 'Convert'],
  ['organize', 'Organize pages'],
  ['edit', 'Edit'],
  ['security', 'Security'],
  ['privacy', 'Privacy'],
];

type State =
  { kind: 'idle' } | { kind: 'uploading'; name: string; progress: number } | { kind: 'ready'; upload: UploadResult };

/** Upload one file, then offer only the tools that can work with it. */
export function SmartStart() {
  const { formats, tools } = useTools();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = formats
    ? [...new Set(formats.types.map((t) => `.${t.extension}`)), '.jpeg', '.tif'].join(',')
    : undefined;

  const upload = async (file: File) => {
    setError(null);
    if (formats && file.size > formats.maxUploadBytes) {
      setError(`This file is ${formatBytes(file.size)}. The limit is ${formatBytes(formats.maxUploadBytes)}.`);
      return;
    }
    setState({ kind: 'uploading', name: file.name, progress: 0 });
    try {
      const res = await filesApi.upload(file, (f) => setState({ kind: 'uploading', name: file.name, progress: f }));
      setState({ kind: 'ready', upload: res });
    } catch (err) {
      setState({ kind: 'idle' });
      setError(err instanceof ApiError ? friendlyError(err.code, err.message) : friendlyError('INTERNAL_ERROR'));
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && state.kind === 'idle') void upload(file);
  };

  return (
    <Card className="overflow-hidden">
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        accept={accept}
        aria-label="Choose a file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void upload(f);
        }}
      />
      {state.kind === 'idle' && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'm-3 flex flex-col items-center gap-4 rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors',
            dragging ? 'border-accent bg-accent-soft' : 'border-line-strong',
          )}
        >
          <span className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent">
            <UploadCloud className="size-7" aria-hidden />
          </span>
          <p className="text-lg font-semibold text-ink">Drop a file here</p>
          <Button size="lg" onClick={() => inputRef.current?.click()}>
            Choose file
          </Button>
          {error && (
            <div className="w-full max-w-md">
              <Notice tone="danger">{error}</Notice>
            </div>
          )}
        </div>
      )}
      {state.kind === 'uploading' && (
        <div className="space-y-4 p-6" aria-live="polite">
          <div className="flex justify-between gap-4 text-sm">
            <span className="truncate font-medium text-ink">{state.name}</span>
            <span className="shrink-0 text-muted">
              {state.progress >= 1 ? 'Checking file…' : `${Math.round(state.progress * 100)}%`}
            </span>
          </div>
          <ProgressBar value={state.progress >= 1 ? null : state.progress * 100} label="Upload progress" />
        </div>
      )}
      {state.kind === 'ready' && (
        <Suggestions
          upload={state.upload}
          tools={tools}
          onDelete={() => {
            filesApi.remove(state.upload.file.id).catch(() => undefined);
            setState({ kind: 'idle' });
          }}
        />
      )}
    </Card>
  );
}

function Suggestions({
  upload,
  tools,
  onDelete,
}: {
  upload: UploadResult;
  tools: Array<{ operation: string; icon: string }>;
  onDelete: () => void;
}) {
  const { file, suggestedOperations } = upload;
  const Icon = file.category === 'video' ? Film : file.category === 'image' ? ImageIcon : FileText;
  const iconFor = (op: OperationSuggestion) => toolIcon(tools.find((t) => t.operation === op.operation)?.icon ?? '');
  return (
    <div className="tero-rise divide-y divide-line">
      <header className="flex items-center gap-4 p-4 sm:p-5">
        <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted">
          <Icon className="size-6" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-ink">{file.name}</p>
          <p className="text-sm text-muted">
            {file.extension.toUpperCase()} · {formatBytes(file.sizeBytes)}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onDelete} aria-label="Delete this file and start over">
          <Trash2 className="size-4" aria-hidden /> <span className="hidden sm:inline">Delete</span>
        </Button>
      </header>
      <div className="space-y-5 p-4 sm:p-5">
        <p className="text-sm font-semibold text-ink">What would you like to do?</p>
        {GROUPS.map(([group, title]) => {
          const ops = suggestedOperations.filter((o) => o.group === group);
          if (ops.length === 0) return null;
          return (
            <div key={group}>
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
              <ul className="grid gap-2 sm:grid-cols-2">
                {ops.map((op) => {
                  const OpIcon = iconFor(op);
                  return (
                    <li key={op.operation}>
                      <Link
                        href={`/tools/${op.slug}?file=${file.id}`}
                        className="flex h-full items-start gap-3 rounded-xl border border-line p-3.5 transition-colors hover:border-line-strong hover:bg-surface-2"
                      >
                        <OpIcon className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
                        <span>
                          <span className="block text-sm font-medium text-ink">{op.label}</span>
                          <span className="block text-xs text-muted">{op.description}</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
