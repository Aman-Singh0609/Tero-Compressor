import { describe, expect, it } from 'vitest';
import { ENDPOINTS, openApiDocument } from '../src/openapi';
import { app, request } from './helpers/harness';

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  name: string;
  handle: { stack?: Layer[] };
  matchers?: unknown;
  path?: string;
}

/** Walk the Express 5 router tree and list every registered `METHOD /path`. */
function collect(): string[] {
  const out: string[] = [];
  const walk = (stack: Layer[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods))
          out.push(`${method.toLowerCase()} ${prefix}${layer.route.path}`);
      } else if (layer.name === 'router' && layer.handle.stack) {
        const mount = (layer as unknown as { matchers: Array<(p: string) => { path: string } | false> }).matchers;
        const probe = (p: string) => (mount[0] ? mount[0](p) : false);
        const sub = prefixOf(layer, probe);
        walk(layer.handle.stack, prefix + sub);
      }
    }
  };
  const router = (app as unknown as { router: { stack: Layer[] } }).router;
  walk(router.stack, '');
  return out;
}

function prefixOf(_layer: Layer, probe: (p: string) => { path: string } | false): string {
  for (const candidate of ['/api/v1/admin', '/api/v1']) {
    const m = probe(`${candidate}/x`);
    if (m && m.path === candidate) return candidate;
  }
  return '';
}

describe('OpenAPI documentation', () => {
  it('documents exactly the routes Express registers', () => {
    const registered = new Set(
      collect()
        .filter((r) => r.includes('/api/v1/'))
        .map((r) => r.replace(/:(\w+)/g, '{$1}')),
    );
    const documented = new Set(ENDPOINTS.map((e) => `${e.method} /api/v1${e.path}`));
    registered.delete('get /api/v1/openapi.json');
    expect([...registered].sort()).toEqual([...documented].sort());
  });

  it('is served as JSON and lists every path', async () => {
    const res = await request().get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.0.3');
    expect(Object.keys(res.body.paths).length).toBe(Object.keys(openApiDocument.paths).length);
    expect(res.body.paths['/api/v1/jobs'].post.responses['202']).toBeDefined();
  });
});
