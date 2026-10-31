'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api';

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  refetch: () => void;
}

interface Settled<T> {
  key: string;
  data?: T;
  error?: ApiError;
}

/**
 * Minimal data hook: loads on mount and whenever `deps` change (deps must be primitives).
 * Stale data stays visible while a refetch is in flight; `loading` is derived, not stored.
 */
export function useResource<T>(
  load: () => Promise<T>,
  deps: ReadonlyArray<string | number | boolean | null | undefined>,
): Resource<T> {
  const [tick, setTick] = useState(0);
  const [settled, setSettled] = useState<Settled<T>>();
  const [data, setData] = useState<T>();
  const key = `${JSON.stringify(deps)}#${tick}`;

  useEffect(() => {
    let cancelled = false;
    load()
      .then((value) => {
        if (cancelled) return;
        setData(value);
        setSettled({ key, data: value });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSettled({
          key,
          error: err instanceof ApiError ? err : new ApiError('INTERNAL_ERROR', 'Unexpected error', 0),
        });
      });
    return () => {
      cancelled = true;
    };
    // `load` is a fresh closure every render; `key` already encodes everything it depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, error: settled?.key === key ? settled.error : undefined, loading: settled?.key !== key, refetch };
}

export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
