'use client';

import { useEffect, useState } from 'react';
import { filesApi, type Formats, type ToolInfo } from './api';

/**
 * The tool catalog (names, forms, limits) comes from the backend, so the UI can never offer a tool the
 * server cannot run. It is fetched once per page load and shared.
 */
let cached: Promise<Formats> | undefined;

export function loadFormats(): Promise<Formats> {
  if (!cached) {
    cached = filesApi.formats().catch((err) => {
      cached = undefined; // allow a retry after a network failure
      throw err;
    });
  }
  return cached;
}

export interface ToolsState {
  formats: Formats | undefined;
  tools: ToolInfo[];
  loading: boolean;
  failed: boolean;
  /** Human label for an operation id; falls back to a tidied id for unknown ones. */
  label: (operation: string) => string;
}

function tidy(operation: string): string {
  const words = operation.toLowerCase().split('_');
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

export function useTools(): ToolsState {
  const [formats, setFormats] = useState<Formats>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadFormats()
      .then((f) => !cancelled && setFormats(f))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);
  const tools = formats?.operations ?? [];
  const byOp = new Map(tools.map((t) => [t.operation, t.label]));
  return {
    formats,
    tools,
    loading: !formats && !failed,
    failed,
    label: (op) => byOp.get(op) ?? tidy(op),
  };
}
