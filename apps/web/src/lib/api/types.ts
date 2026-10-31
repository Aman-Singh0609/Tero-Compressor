/**
 * Wire types for the TERO API v1. These mirror the response shapes produced by apps/api
 * (services/dto.ts and the admin routes); the OpenAPI document at /api/v1/openapi.json is the reference.
 */

export interface ApiSuccess<T, M = Record<string, unknown>> {
  success: true;
  data: T;
  meta?: M;
}

export interface ApiFailure {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Page<T> {
  items: T[];
  pagination: Pagination;
}

export type FileCategory = 'image' | 'pdf' | 'video' | 'audio' | 'document';
export type FileStatus = 'UPLOADED' | 'PROCESSING' | 'AVAILABLE' | 'FAILED' | 'DELETED';
export type JobStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type Preset = 'HIGH_QUALITY' | 'BALANCED' | 'SMALLEST';

export type OperationName =
  | 'IMAGE_COMPRESS'
  | 'IMAGE_RESIZE'
  | 'IMAGE_CONVERT'
  | 'IMAGE_STRIP_METADATA'
  | 'IMAGE_TO_PDF'
  | 'PDF_COMPRESS'
  | 'DOCX_COMPRESS'
  | 'VIDEO_COMPRESS'
  | 'VIDEO_EXTRACT_AUDIO';

export interface UploadedFile {
  id: string;
  name: string;
  mimeType: string;
  category: FileCategory;
  extension: string;
  sizeBytes: number;
  status: FileStatus;
  createdAt: string;
  expiresAt: string | null;
}

export interface OperationSuggestion {
  operation: OperationName;
  label: string;
  description: string;
}

export interface UploadResult {
  file: UploadedFile;
  suggestedOperations: OperationSuggestion[];
}

export interface Formats {
  maxUploadBytes: number;
  retentionDays: number;
  types: Array<{ extension: string; mimeType: string; category: FileCategory }>;
  presets: Preset[];
  operations: Array<{
    operation: OperationName;
    label: string;
    description: string;
    accepts: FileCategory[];
    reducesSize: boolean;
  }>;
}

export interface JobOptions {
  preset?: Preset;
  width?: number;
  height?: number;
  allowUpscale?: boolean;
  format?: 'jpeg' | 'png' | 'webp';
}

export interface Job {
  id: string;
  fileId: string;
  fileName: string | null;
  operation: OperationName;
  options: JobOptions | null;
  status: JobStatus;
  progress: number;
  originalSizeBytes: number;
  outputSizeBytes: number | null;
  savingPercent: number | null;
  processingDurationMs: number | null;
  downloadUrl: string | null;
  result: { keptOriginal?: boolean; note?: string; [k: string]: unknown } | null;
  error: { code: string | null; message: string | null } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

// ---- admin -------------------------------------------------------------

export interface AdminIdentity {
  id: string;
  email: string;
  name: string;
}

export interface AdminFileRow {
  id: string;
  role: 'UPLOAD' | 'OUTPUT';
  originalName: string;
  extension: string;
  mimeType: string;
  category: FileCategory;
  sizeBytes: number;
  checksum: string;
  status: FileStatus;
  createdAt: string;
  expiresAt: string | null;
  deletedAt: string | null;
  jobs: Array<{
    id: string;
    operation: OperationName;
    status: JobStatus;
    processingDurationMs: number | null;
    outputSizeBytes: number | null;
  }>;
}

export interface AdminFileDetail extends Omit<AdminFileRow, 'jobs'> {
  storedName: string;
  storageArea: string;
  storagePath: string;
  updatedAt: string;
  jobs: Array<{
    id: string;
    operation: OperationName;
    status: JobStatus;
    progress: number;
    outputSizeBytes: number | null;
    processingDurationMs: number | null;
    errorCode: string | null;
    createdAt: string;
  }>;
}

export interface VaultFile {
  id: string;
  displayName: string;
  description: string | null;
  mimeType: string;
  extension: string;
  category: string;
  sizeBytes: number;
  checksum: string;
  createdAt: string;
  updatedAt: string;
  lastDownloadedAt: string | null;
  downloadCount: number;
  isAvailable: boolean;
  uploadedBy: { id: string; name: string } | null;
}

export interface Dashboard {
  uploads: { total: number; today: number; thisWeek: number };
  jobs: {
    total: number;
    completed: number;
    failed: number;
    active: number;
    inputBytes: number;
    outputBytes: number;
    savedBytes: number;
    avgDurationMs: number | null;
  };
  operations: Array<{ operation: OperationName; count: number }>;
  filesByCategory: Array<{ category: string; count: number }>;
  uploadsByDay: Array<{ day: string; count: number }>;
  recentUploads: Array<{
    id: string;
    originalName: string;
    category: string;
    sizeBytes: number;
    status: FileStatus;
    createdAt: string;
  }>;
  recentFailures: Array<{
    id: string;
    operation: OperationName;
    errorCode: string | null;
    errorMessage: string | null;
    failedAt: string | null;
    file: { id: string; originalName: string };
  }>;
}

export type AuditAction =
  | 'ADMIN_LOGIN'
  | 'ADMIN_LOGIN_FAILED'
  | 'ADMIN_LOGOUT'
  | 'FILE_VIEW'
  | 'FILE_DOWNLOAD'
  | 'FILE_DELETE'
  | 'VAULT_UPLOAD'
  | 'VAULT_VIEW'
  | 'VAULT_DOWNLOAD'
  | 'VAULT_UPDATE'
  | 'VAULT_REPLACE'
  | 'VAULT_DELETE'
  | 'JOB_VIEW'
  | 'SETTINGS_CHANGE';

export interface AuditEntry {
  id: string;
  action: AuditAction;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
  admin: { id: string; email: string; name: string } | null;
}

export interface StorageInfo {
  disk: Record<'TEMPORARY' | 'ORIGINAL' | 'PROCESSED' | 'VAULT', { files: number; bytes: number }>;
  database: { temporaryFiles: { count: number; bytes: number }; vault: { count: number; bytes: number } };
  retentionDays: number;
}

export interface CleanupReport {
  deleted: number;
  alreadyMissing: number;
  failed: number;
  staleJobsFailed: number;
  workFilesSwept: number;
  expiredSessions: number;
}

export interface Metrics {
  requests: Array<{ route: string; count: number; errors: number; avgMs: number; p95Ms: number; maxMs: number }>;
  dataOperations: Array<{ name: string; count: number; avgMs: number; maxMs: number }>;
  queue: { pending: number; active: number; concurrency: number };
  process: { uptimeSeconds: number; rssBytes: number };
}

export interface AdminSettings {
  retentionDays: number;
  cleanupIntervalMinutes: number;
  maxUploadMb: number;
  vaultMaxMb: number;
  jobConcurrency: number;
  videoTimeoutMinutes: number;
  sessionTtlHours: number;
  environment: string;
  storageDriver: 'mysql' | 'local';
}
