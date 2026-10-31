import type { OperationName, Preset } from './api';

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, secs] of steps) if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
  return 'just now';
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

export const PRESET_LABELS: Record<Preset, { label: string; hint: string }> = {
  HIGH_QUALITY: { label: 'High quality', hint: 'Looks the same, smaller saving' },
  BALANCED: { label: 'Recommended', hint: 'Best balance for most files' },
  SMALLEST: { label: 'Smallest file', hint: 'Biggest saving, some quality loss' },
};

export const OPERATION_LABELS: Record<OperationName, string> = {
  IMAGE_COMPRESS: 'Compress image',
  IMAGE_RESIZE: 'Resize image',
  IMAGE_CONVERT: 'Convert image',
  IMAGE_STRIP_METADATA: 'Remove metadata',
  IMAGE_TO_PDF: 'Image to PDF',
  PDF_COMPRESS: 'Compress PDF',
  DOCX_COMPRESS: 'Compress Word file',
  VIDEO_COMPRESS: 'Compress video',
  VIDEO_EXTRACT_AUDIO: 'Extract audio',
};

/** Friendly copy for backend error codes; family users never see raw codes or technical text. */
const FRIENDLY: Record<string, string> = {
  INVALID_FILE: 'We couldn’t read this file. It may be damaged or renamed.',
  FILE_TOO_LARGE: 'This file is too large for TERO.',
  UNSUPPORTED_FILE_TYPE: 'TERO can’t work with this kind of file yet.',
  FILE_NOT_FOUND: 'We couldn’t find that file. Please upload it again.',
  FILE_EXPIRED: 'This file was removed. Please upload it again.',
  JOB_NOT_FOUND: 'We couldn’t find that task.',
  JOB_NOT_READY: 'Your file isn’t ready yet.',
  INVALID_OPERATION: 'That tool doesn’t work with this kind of file.',
  INVALID_OPTIONS: 'Those settings aren’t valid. Please check them.',
  PROCESSING_FAILED: 'Something went wrong while working on your file.',
  PROCESSING_TIMEOUT: 'This took too long and was stopped. Try a smaller file.',
  SERVER_RESTART: 'The server restarted while working. Please try again.',
  TOO_MANY_REQUESTS: 'Too many tries — please wait a moment.',
  NETWORK_ERROR: 'Can’t reach TERO right now. Check your connection and try again.',
  UNAUTHORIZED: 'Please sign in again.',
  INVALID_CREDENTIALS: 'That email or password isn’t right.',
  VAULT_FILE_NOT_FOUND: 'That vault file is no longer available.',
  STORAGE_ERROR: 'The file couldn’t be saved. Please try again.',
  DATABASE_ERROR: 'Something went wrong on our side. Please try again.',
  INTERNAL_ERROR: 'Something went wrong. Please try again.',
};

export function friendlyError(code: string | null | undefined, fallback?: string | null): string {
  if (code && FRIENDLY[code]) return FRIENDLY[code];
  return fallback || FRIENDLY.INTERNAL_ERROR!;
}
