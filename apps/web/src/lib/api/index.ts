import { del, get, getOrNullIfSignedOut, getPage, patch, post, postForm, qs, uploadWithProgress } from './client';
import type {
  AdminFileDetail,
  AdminFileRow,
  AdminIdentity,
  AdminSettings,
  AuditEntry,
  CleanupReport,
  Dashboard,
  Formats,
  Job,
  JobOptions,
  Metrics,
  OperationName,
  StorageInfo,
  UploadResult,
  VaultFile,
} from './types';

export { ApiError } from './client';
export * from './types';

type ListQuery = { page?: number; limit?: number; q?: string; sort?: string; order?: 'asc' | 'desc' };

/** Public (family) endpoints. */
export const filesApi = {
  formats: () => get<Formats>('/formats'),
  upload: (file: File, onProgress: (f: number) => void, signal?: AbortSignal) =>
    uploadWithProgress<UploadResult>('/files/upload', file, onProgress, signal),
  get: (id: string) => get<UploadResult>(`/files/${id}`),
  remove: (id: string) => del<{ id: string; status: 'DELETED' }>(`/files/${id}`),
  thumbnailUrl: (id: string) => `/api/v1/files/${id}/thumbnail`,
};

export const jobsApi = {
  /** One or several input files (merge and images-to-PDF take several, in the order given). */
  create: (fileIds: string[], operation: OperationName, options?: JobOptions) =>
    post<{ jobId: string; status: string }>('/jobs', { fileIds, operation, options }),
  get: (id: string) => get<Job>(`/jobs/${id}`),
  cancel: (id: string) => post<Job>(`/jobs/${id}/cancel`),
  downloadUrl: (id: string) => `/api/v1/jobs/${id}/download`,
};

export const authApi = {
  login: (email: string, password: string) =>
    post<{ admin: AdminIdentity; expiresAt: string }>('/admin/auth/login', { email, password }),
  logout: () => post<{ loggedOut: true }>('/admin/auth/logout'),
  me: () => get<{ admin: AdminIdentity }>('/admin/auth/me'),
  /** The signed-in admin, or `null` for an ordinary visitor (never redirects). */
  session: async () => (await getOrNullIfSignedOut<{ admin: AdminIdentity }>('/admin/auth/me'))?.admin ?? null,
};

export const adminApi = {
  dashboard: () => get<Dashboard>('/admin/dashboard'),
  files: (q: ListQuery & { type?: string; status?: string; role?: string }) => getPage<AdminFileRow>('/admin/files', q),
  file: (id: string) => get<AdminFileDetail>(`/admin/files/${id}`),
  fileDownloadUrl: (id: string) => `/api/v1/admin/files/${id}/download`,
  deleteFile: (id: string) => del<{ id: string; status: 'DELETED' }>(`/admin/files/${id}`),
  jobs: (q: ListQuery & { status?: string; operation?: string }) => getPage<Job>('/admin/jobs', q),
  job: (id: string) => get<Job>(`/admin/jobs/${id}`),
  audit: (q: ListQuery & { action?: string }) => getPage<AuditEntry>('/admin/audit-logs', q),
  storage: () => get<StorageInfo>('/admin/storage'),
  cleanup: () => post<CleanupReport>('/admin/storage/cleanup'),
  metrics: () => get<Metrics>('/admin/metrics'),
  settings: () => get<AdminSettings>('/admin/settings'),
};

export const vaultApi = {
  list: (q: ListQuery & { type?: string }) => getPage<VaultFile>('/admin/vault', q),
  get: (id: string) => get<VaultFile>(`/admin/vault/${id}`),
  upload: (file: File, description?: string) => {
    const form = new FormData();
    if (description) form.append('description', description);
    form.append('file', file);
    return postForm<VaultFile>('/admin/vault', form);
  },
  update: (id: string, body: { displayName?: string; description?: string | null }) =>
    patch<VaultFile>(`/admin/vault/${id}`, body),
  replace: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return postForm<VaultFile>(`/admin/vault/${id}/file`, form, 'PUT');
  },
  remove: (id: string) => del<{ id: string; deleted: true }>(`/admin/vault/${id}`),
  downloadUrl: (id: string) => `/api/v1/admin/vault/${id}/download`,
};

export { qs };
