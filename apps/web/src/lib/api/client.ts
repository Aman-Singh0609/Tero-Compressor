import type { ApiFailure, ApiSuccess, Page, Pagination } from './types';

/** Error thrown for every failed API call; `code` is the stable backend error code. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const BASE = '/api/v1';

type Query = Record<string, string | number | boolean | undefined | null>;

export function qs(query?: Query): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
}

async function parse<T, M>(res: Response): Promise<ApiSuccess<T, M>> {
  let body: ApiSuccess<T, M> | ApiFailure | null = null;
  try {
    body = (await res.json()) as ApiSuccess<T, M> | ApiFailure;
  } catch {
    // non-JSON (proxy error page etc.)
  }
  if (!body) throw new ApiError('NETWORK_ERROR', 'The server could not be reached.', res.status);
  if (!body.success) throw new ApiError(body.error.code, body.error.message, res.status);
  return body;
}

/** An expired admin session anywhere in the admin area sends the user back to the sign-in page. */
function handleUnauthorized(path: string, err: ApiError): void {
  if (
    err.status === 401 &&
    path.startsWith('/admin/') &&
    path !== '/admin/auth/login' &&
    typeof window !== 'undefined'
  ) {
    // Deliberate full-page navigation (this runs outside React): it also discards any stale in-memory admin state.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    if (!window.location.pathname.startsWith('/admin/login')) window.location.href = '/admin/login';
  }
}

async function send<T, M = Record<string, unknown>>(
  method: string,
  path: string,
  init: { query?: Query; json?: unknown; form?: FormData; noRedirect?: boolean } = {},
): Promise<ApiSuccess<T, M>> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}${qs(init.query)}`, {
      method,
      credentials: 'same-origin',
      headers: init.json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.form,
    });
  } catch {
    throw new ApiError('NETWORK_ERROR', 'The server could not be reached.', 0);
  }
  try {
    return await parse<T, M>(res);
  } catch (err) {
    if (err instanceof ApiError && !init.noRedirect) handleUnauthorized(path, err);
    throw err;
  }
}

/**
 * Like `get`, but a 401 ("not signed in") is an ordinary answer, not an error: it returns `null` and never
 * redirects. Used on public pages to find out quietly whether the visitor is the signed-in admin.
 */
export async function getOrNullIfSignedOut<T>(path: string): Promise<T | null> {
  try {
    return (await send<T>('GET', path, { noRedirect: true })).data;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export async function get<T>(path: string, query?: Query): Promise<T> {
  return (await send<T>('GET', path, { query })).data;
}

export async function getPage<T>(path: string, query?: Query): Promise<Page<T>> {
  const res = await send<T[], { pagination: Pagination }>('GET', path, { query });
  return { items: res.data, pagination: res.meta?.pagination as Pagination };
}

export async function post<T>(path: string, json?: unknown): Promise<T> {
  return (await send<T>('POST', path, { json: json ?? {} })).data;
}

export async function patch<T>(path: string, json: unknown): Promise<T> {
  return (await send<T>('PATCH', path, { json })).data;
}

export async function del<T>(path: string): Promise<T> {
  return (await send<T>('DELETE', path)).data;
}

export async function postForm<T>(path: string, form: FormData, method: 'POST' | 'PUT' = 'POST'): Promise<T> {
  return (await send<T>(method, path, { form })).data;
}

/** Upload with real byte-level progress (fetch cannot report upload progress; XHR can). */
export function uploadWithProgress<T>(
  path: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}${path}`);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError('NETWORK_ERROR', 'The server could not be reached.', 0));
    xhr.onabort = () => reject(new ApiError('ABORTED', 'Upload cancelled.', 0));
    xhr.onload = () => {
      const body = xhr.response as ApiSuccess<T> | ApiFailure | null;
      if (!body) return reject(new ApiError('NETWORK_ERROR', 'The server could not be reached.', xhr.status));
      if (!body.success) return reject(new ApiError(body.error.code, body.error.message, xhr.status));
      resolve(body.data);
    };
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}
