/**
 * OpenAPI 3.0 description of the v1 API, served at GET /api/v1/openapi.json.
 * tests/openapi.test.ts compares this table with the routes Express actually registers,
 * so an undocumented or removed endpoint fails the build instead of silently drifting.
 */
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface EndpointDoc {
  method: Method;
  path: string;
  summary: string;
  admin?: boolean;
  body?: string;
  multipart?: boolean;
  query?: string[];
  success: number;
  returns: string;
  errors: string[];
}

const P = '/api/v1';

export const ENDPOINTS: EndpointDoc[] = [
  {
    method: 'get',
    path: '/formats',
    summary: 'Supported file types, operations and limits',
    success: 200,
    returns: '{ maxUploadBytes, retentionDays, types[], presets[], operations[] }',
    errors: [],
  },
  {
    method: 'post',
    path: '/files/upload',
    summary: 'Upload a file (multipart field "file")',
    multipart: true,
    success: 201,
    returns: '{ file, suggestedOperations[] }',
    errors: ['INVALID_FILE', 'FILE_TOO_LARGE', 'UNSUPPORTED_FILE_TYPE', 'TOO_MANY_REQUESTS'],
  },
  {
    method: 'get',
    path: '/files/{id}',
    summary: 'File metadata and suggested operations',
    success: 200,
    returns: '{ file, suggestedOperations[] }',
    errors: ['FILE_NOT_FOUND', 'FILE_EXPIRED', 'VALIDATION_ERROR'],
  },
  {
    method: 'get',
    path: '/files/{id}/thumbnail',
    summary: 'WebP preview of an uploaded image',
    success: 200,
    returns: 'image/webp',
    errors: ['FILE_NOT_FOUND', 'FILE_EXPIRED', 'INVALID_OPERATION'],
  },
  {
    method: 'delete',
    path: '/files/{id}',
    summary: 'Delete a file and everything generated from it',
    success: 200,
    returns: '{ id, status: "DELETED" }',
    errors: ['FILE_NOT_FOUND', 'STORAGE_ERROR'],
  },
  {
    method: 'post',
    path: '/jobs',
    summary: 'Create a processing job',
    body: '{ fileId, operation, options? }',
    success: 202,
    returns: '{ jobId, status: "QUEUED" }',
    errors: ['FILE_NOT_FOUND', 'FILE_EXPIRED', 'INVALID_OPERATION', 'INVALID_OPTIONS', 'VALIDATION_ERROR'],
  },
  {
    method: 'get',
    path: '/jobs/{id}',
    summary: 'Job status, progress and result statistics',
    success: 200,
    returns:
      '{ id, status, progress, originalSizeBytes, outputSizeBytes, savingPercent, processingDurationMs, downloadUrl, result, error }',
    errors: ['JOB_NOT_FOUND'],
  },
  {
    method: 'post',
    path: '/jobs/{id}/cancel',
    summary: 'Cancel a queued or running job',
    success: 200,
    returns: 'job',
    errors: ['JOB_NOT_FOUND', 'JOB_NOT_CANCELLABLE'],
  },
  {
    method: 'get',
    path: '/jobs/{id}/download',
    summary: 'Download the output of a completed job',
    success: 200,
    returns: 'file bytes (attachment)',
    errors: ['JOB_NOT_FOUND', 'JOB_NOT_READY', 'FILE_EXPIRED', 'FILE_NOT_FOUND'],
  },

  {
    method: 'post',
    path: '/admin/auth/login',
    summary: 'Sign in; sets the HttpOnly session cookie',
    body: '{ email, password }',
    success: 200,
    returns: '{ admin, expiresAt }',
    errors: ['INVALID_CREDENTIALS', 'TOO_MANY_REQUESTS', 'VALIDATION_ERROR'],
  },
  {
    method: 'post',
    path: '/admin/auth/logout',
    summary: 'Sign out and invalidate the session',
    admin: true,
    success: 200,
    returns: '{ loggedOut: true }',
    errors: ['UNAUTHORIZED'],
  },
  {
    method: 'get',
    path: '/admin/auth/me',
    summary: 'Current administrator',
    admin: true,
    success: 200,
    returns: '{ admin }',
    errors: ['UNAUTHORIZED'],
  },
  {
    method: 'get',
    path: '/admin/dashboard',
    summary: 'Aggregated operational statistics',
    admin: true,
    success: 200,
    returns: '{ uploads, jobs, operations[], filesByCategory[], uploadsByDay[], recentUploads[], recentFailures[] }',
    errors: ['UNAUTHORIZED'],
  },
  {
    method: 'get',
    path: '/admin/storage',
    summary: 'Storage usage per area and database totals',
    admin: true,
    success: 200,
    returns: '{ disk, database, retentionDays }',
    errors: ['UNAUTHORIZED'],
  },
  {
    method: 'post',
    path: '/admin/storage/cleanup',
    summary: 'Run the retention cleanup now',
    admin: true,
    success: 200,
    returns: 'cleanup report',
    errors: ['UNAUTHORIZED'],
  },
  {
    method: 'get',
    path: '/admin/metrics',
    summary: 'Request latency, data-layer timings, queue state',
    admin: true,
    success: 200,
    returns: '{ requests[], dataOperations[], queue, process }',
    errors: ['UNAUTHORIZED'],
  },
  {
    method: 'get',
    path: '/admin/settings',
    summary: 'Effective (read-only) configuration',
    admin: true,
    success: 200,
    returns: 'settings object',
    errors: ['UNAUTHORIZED'],
  },
  {
    method: 'get',
    path: '/admin/files',
    summary: 'Paginated, filterable file list',
    admin: true,
    query: ['page', 'limit', 'q', 'type', 'status', 'role', 'sort', 'order'],
    success: 200,
    returns: 'file[] + meta.pagination',
    errors: ['UNAUTHORIZED', 'VALIDATION_ERROR'],
  },
  {
    method: 'get',
    path: '/admin/files/{id}',
    summary: 'File detail with job history',
    admin: true,
    success: 200,
    returns: 'file',
    errors: ['UNAUTHORIZED', 'FILE_NOT_FOUND'],
  },
  {
    method: 'get',
    path: '/admin/files/{id}/download',
    summary: 'Download a stored file',
    admin: true,
    success: 200,
    returns: 'file bytes (attachment)',
    errors: ['UNAUTHORIZED', 'FILE_NOT_FOUND', 'FILE_EXPIRED'],
  },
  {
    method: 'delete',
    path: '/admin/files/{id}',
    summary: 'Delete a file',
    admin: true,
    success: 200,
    returns: '{ id, status: "DELETED" }',
    errors: ['UNAUTHORIZED', 'FILE_NOT_FOUND'],
  },
  {
    method: 'get',
    path: '/admin/jobs',
    summary: 'Paginated job list',
    admin: true,
    query: ['page', 'limit', 'status', 'operation', 'fileId'],
    success: 200,
    returns: 'job[] + meta.pagination',
    errors: ['UNAUTHORIZED'],
  },
  {
    method: 'get',
    path: '/admin/jobs/{id}',
    summary: 'Job detail',
    admin: true,
    success: 200,
    returns: 'job',
    errors: ['UNAUTHORIZED', 'JOB_NOT_FOUND'],
  },
  {
    method: 'get',
    path: '/admin/audit-logs',
    summary: 'Paginated audit log',
    admin: true,
    query: ['page', 'limit', 'action', 'entityType', 'entityId'],
    success: 200,
    returns: 'audit entry[] + meta.pagination',
    errors: ['UNAUTHORIZED'],
  },
  {
    method: 'post',
    path: '/admin/vault',
    summary: 'Add a file to the vault (multipart "file", optional description/displayName)',
    admin: true,
    multipart: true,
    success: 201,
    returns: 'vault file',
    errors: ['UNAUTHORIZED', 'FILE_TOO_LARGE', 'UNSUPPORTED_FILE_TYPE', 'INVALID_FILE'],
  },
  {
    method: 'get',
    path: '/admin/vault',
    summary: 'Paginated vault list',
    admin: true,
    query: ['page', 'limit', 'q', 'type', 'sort', 'order'],
    success: 200,
    returns: 'vault file[] + meta.pagination',
    errors: ['UNAUTHORIZED'],
  },
  {
    method: 'get',
    path: '/admin/vault/{id}',
    summary: 'Vault file metadata',
    admin: true,
    success: 200,
    returns: 'vault file',
    errors: ['UNAUTHORIZED', 'VAULT_FILE_NOT_FOUND'],
  },
  {
    method: 'get',
    path: '/admin/vault/{id}/download',
    summary: 'Download a vault file (increments download count)',
    admin: true,
    success: 200,
    returns: 'file bytes (attachment)',
    errors: ['UNAUTHORIZED', 'VAULT_FILE_NOT_FOUND'],
  },
  {
    method: 'patch',
    path: '/admin/vault/{id}',
    summary: 'Rename display name / edit description',
    admin: true,
    body: '{ displayName?, description? }',
    success: 200,
    returns: 'vault file',
    errors: ['UNAUTHORIZED', 'VAULT_FILE_NOT_FOUND', 'VALIDATION_ERROR'],
  },
  {
    method: 'put',
    path: '/admin/vault/{id}/file',
    summary: 'Replace the stored bytes of a vault file',
    admin: true,
    multipart: true,
    success: 200,
    returns: 'vault file',
    errors: ['UNAUTHORIZED', 'VAULT_FILE_NOT_FOUND', 'FILE_TOO_LARGE'],
  },
  {
    method: 'delete',
    path: '/admin/vault/{id}',
    summary: 'Delete a vault file',
    admin: true,
    success: 200,
    returns: '{ id, deleted: true }',
    errors: ['UNAUTHORIZED', 'VAULT_FILE_NOT_FOUND'],
  },
];

const envelope = {
  success: {
    type: 'object',
    properties: { success: { type: 'boolean', enum: [true] }, data: {}, meta: { type: 'object' } },
  },
  failure: {
    type: 'object',
    properties: {
      success: { type: 'boolean', enum: [false] },
      error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } },
    },
  },
};

function buildPaths() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of ENDPOINTS) {
    const params = [
      ...(e.path.match(/\{(\w+)\}/g) ?? []).map((p) => ({
        name: p.slice(1, -1),
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      })),
      ...(e.query ?? []).map((q) => ({ name: q, in: 'query', required: false, schema: { type: 'string' } })),
    ];
    const op: Record<string, unknown> = {
      summary: e.summary,
      tags: [e.admin || e.path.startsWith('/admin') ? 'admin' : 'public'],
      security: e.admin ? [{ adminSession: [] }] : [],
      parameters: params,
      responses: {
        [String(e.success)]: {
          description: e.returns,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } },
        },
        ...Object.fromEntries(
          e.errors.map((code) => [
            code,
            {
              description: `Error code ${code}`,
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Failure' } } },
            },
          ]),
        ),
      },
    };
    if (e.body)
      op.requestBody = { content: { 'application/json': { schema: { type: 'object', description: e.body } } } };
    if (e.multipart)
      op.requestBody = {
        content: {
          'multipart/form-data': {
            schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] },
          },
        },
      };
    (paths[P + e.path] ??= {})[e.method] = op;
  }
  return paths;
}

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'TERO API',
    version: '2.0.0',
    description:
      'Private family file tools. All responses use { success, data, meta } or { success: false, error: { code, message } }.',
  },
  servers: [{ url: '/' }],
  paths: buildPaths(),
  components: {
    securitySchemes: { adminSession: { type: 'apiKey', in: 'cookie', name: 'tero_admin' } },
    schemas: { Success: envelope.success, Failure: envelope.failure },
  },
};
