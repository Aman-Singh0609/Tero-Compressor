import fs from 'node:fs';
import path from 'node:path';
import { ENDPOINTS } from '../openapi';

/** `npm run docs:api -w apps/api` — regenerates docs/API.md from the same table that feeds OpenAPI. */
const lines: string[] = [
  '# TERO API v1',
  '',
  '> Generated from `apps/api/src/openapi.ts` — do not edit by hand. Live OpenAPI JSON: `GET /api/v1/openapi.json`.',
  '',
  'All responses use one envelope:',
  '',
  '```json',
  '{ "success": true, "data": {}, "meta": {} }',
  '{ "success": false, "error": { "code": "INVALID_FILE_TYPE", "message": "Human readable text" } }',
  '```',
  '',
  'Admin endpoints require the `tero_admin` HttpOnly session cookie obtained from `POST /api/v1/admin/auth/login`.',
  'Unauthenticated calls return `401 UNAUTHORIZED`. File and job ids are random UUIDs; no client-supplied path is ever read.',
  '',
];
for (const [title, admin] of [
  ['Public endpoints', false],
  ['Admin endpoints', true],
] as const) {
  lines.push(`## ${title}`, '');
  for (const e of ENDPOINTS.filter((x) => x.path.startsWith('/admin') === admin)) {
    lines.push(`### \`${e.method.toUpperCase()} /api/v1${e.path}\``, '', e.summary + '.', '');
    lines.push(`- **Auth:** ${admin && e.path !== '/admin/auth/login' ? 'admin session' : 'none'}`);
    if (e.query) lines.push(`- **Query:** ${e.query.map((q) => `\`${q}\``).join(', ')}`);
    if (e.body) lines.push(`- **Body (JSON):** \`${e.body}\``);
    if (e.multipart) lines.push('- **Body (multipart/form-data):** `file` (required)');
    lines.push(`- **Success:** \`${e.success}\` → ${e.returns}`);
    if (e.errors.length) lines.push(`- **Errors:** ${e.errors.map((c) => `\`${c}\``).join(', ')}`);
    lines.push('');
  }
}
const out = path.resolve(__dirname, '../../../../docs/API.md');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n'));
console.log(`wrote ${out}`);
