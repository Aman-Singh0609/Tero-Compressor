'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { AlertCircle, Inbox, Loader2, X } from 'lucide-react';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover shadow-card',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-surface-2',
  ghost: 'text-ink hover:bg-surface-2',
  danger: 'bg-danger text-white hover:opacity-90',
};
const SIZES: Record<Size, string> = {
  sm: 'h-10 px-3 text-sm gap-1.5',
  md: 'h-11 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, disabled, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

/** Anchor styled as a button (downloads and links). */
export function LinkButton({
  variant = 'primary',
  size = 'md',
  className,
  ...rest
}: { variant?: Variant; size?: Size } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-muted/70 focus-visible:border-accent',
        className,
      )}
      {...rest}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        'h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink focus-visible:border-accent',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});

export function Label({ htmlFor, children, className }: { htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn('mb-1.5 block text-sm font-medium text-ink', className)}>
      {children}
    </label>
  );
}

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent';
const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  accent: 'bg-accent-soft text-accent',
};

/** Status chip: always shows text (and a dot), never colour alone. */
export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {children}
    </span>
  );
}

export function statusTone(status: string): Tone {
  switch (status) {
    case 'COMPLETED':
    case 'AVAILABLE':
      return 'ok';
    case 'FAILED':
      return 'danger';
    case 'PROCESSING':
    case 'QUEUED':
      return 'info';
    case 'CANCELLED':
    case 'DELETED':
      return 'neutral';
    case 'UPLOADED':
      return 'accent';
    default:
      return 'neutral';
  }
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('tero-skeleton rounded-md', className)} aria-hidden />;
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('min-w-0 rounded-[var(--radius-card)] border border-line bg-surface shadow-card', className)}>
      {children}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-surface-2 text-muted">
        <Inbox className="size-5" aria-hidden />
      </span>
      <p className="font-medium text-ink">{title}</p>
      {hint && <p className="max-w-sm text-sm text-muted">{hint}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-danger-soft text-danger">
        <AlertCircle className="size-5" aria-hidden />
      </span>
      <p className="max-w-md text-sm text-ink">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Notice({ tone, children }: { tone: 'danger' | 'ok' | 'warn' | 'info'; children: ReactNode }) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('rounded-lg px-3.5 py-2.5 text-sm', TONES[tone])}>
      {children}
    </div>
  );
}

/** Accessible modal built on Radix (focus trap, Esc, aria roles). `side` renders a right-hand drawer. */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  side = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  side?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]" />
        <Dialog.Content
          className={cn(
            'fixed z-50 flex flex-col bg-surface shadow-pop focus:outline-none',
            side
              ? 'inset-y-0 right-0 w-full max-w-md border-l border-line'
              : 'top-1/2 left-1/2 max-h-[90dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line',
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-base font-semibold text-ink">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-1 text-sm text-muted">{description}</Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">{title}</Dialog.Description>
              )}
            </div>
            <Dialog.Close
              className="grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2"
              aria-label="Close"
            >
              <X className="size-4" aria-hidden />
            </Dialog.Close>
          </div>
          {children ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          ) : (
            <div className="flex-1" />
          )}
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Confirmation dialog for destructive actions. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  busy,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {error && <Notice tone="danger">{error}</Notice>}
    </Modal>
  );
}

export function ProgressBar({ value, label }: { value: number | null; label: string }) {
  const determinate = value !== null;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? Math.round(value) : undefined}
      className="relative h-2.5 w-full overflow-hidden rounded-full bg-surface-2"
    >
      {determinate ? (
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300"
          style={{ width: `${Math.max(2, Math.min(100, value))}%` }}
        />
      ) : (
        <div
          className="absolute inset-y-0 w-1/3 rounded-full bg-accent"
          style={{ animation: 'tero-indeterminate 1.3s ease-in-out infinite' }}
        />
      )}
    </div>
  );
}
