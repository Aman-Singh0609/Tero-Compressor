import fs from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/prisma';
import {
  OPERATION_NAMES,
  OPERATIONS,
  OPTION_SCHEMAS,
  parseOptions,
  type OperationName,
} from '../src/processors/operations';
import { overrideProcessor, processorFor } from '../src/processors/registry';
import { ProcessorError } from '../src/processors/types';
import { runCleanup } from '../src/services/retentionService';
import { adminAgent, closeAll, request, resetAll } from './helpers/harness';
import { makeNumberedPdf } from './helpers/toolFixtures';
import { processFiles, uploadId } from './helpers/toolHarness';

beforeEach(resetAll);
afterEach(() => overrideProcessor('PDF_MERGE', undefined));
afterAll(closeAll);

/** Values for the fields a form cannot default (the user must type them). */
const REQUIRED_SAMPLES: Partial<Record<OperationName, Record<string, unknown>>> = {
  PDF_SPLIT: { ranges: '1-2' },
  PDF_EXTRACT_PAGES: { pages: '1' },
  PDF_REMOVE_PAGES: { pages: '1' },
  PDF_REORDER_PAGES: { order: '1' },
  PDF_CROP: { top: 5 },
  PDF_WATERMARK: { text: 'x' },
  PDF_PROTECT: { password: 'abcd' },
  PDF_UNLOCK: { password: 'a' },
  IMAGE_RESIZE: { width: 100 },
  IMAGE_CROP: {},
  IMAGE_ROTATE: {},
  IMAGE_WATERMARK: { text: 'x' },
  IMAGE_ADJUST: { grayscale: true },
};

describe('tool catalog consistency', () => {
  it('every operation has a processor, a unique slug and a schema', () => {
    const slugs = new Set<string>();
    for (const op of OPERATION_NAMES) {
      const tool = OPERATIONS[op];
      expect(processorFor(op), op).toBeDefined();
      expect(processorFor(op)!.operations, op).toContain(op);
      expect(OPTION_SCHEMAS[op], op).toBeDefined();
      expect(slugs.has(tool.slug), `duplicate slug ${tool.slug}`).toBe(false);
      slugs.add(tool.slug);
      expect(tool.slug).toMatch(/^[a-z0-9-]+$/);
      expect(tool.minFiles).toBeGreaterThanOrEqual(1);
      expect(tool.maxFiles).toBeGreaterThanOrEqual(tool.minFiles);
      expect(tool.accepts.length).toBeGreaterThan(0);
    }
  });

  it('the form fields describe options the schema accepts, and defaults are valid', () => {
    for (const op of OPERATION_NAMES) {
      const tool = OPERATIONS[op];
      const keys = new Set(tool.fields.map((f) => f.key));
      expect(keys.size, `${op} has duplicate field keys`).toBe(tool.fields.length);
      for (const f of tool.fields) {
        if (f.showIf) expect(keys.has(f.showIf.key), `${op}.${f.key} showIf`).toBe(true);
        if (f.type === 'select') {
          expect(f.options?.length, `${op}.${f.key}`).toBeGreaterThan(1);
          expect(
            f.options!.map((o) => o.value),
            `${op}.${f.key} default`,
          ).toContain(String(f.default));
        }
        if (f.type === 'password') expect(f.default, `${op}.${f.key}: passwords never have defaults`).toBeUndefined();
      }
      // what the UI would send for an untouched form (defaults only, hidden fields omitted) + required samples
      const sent: Record<string, unknown> = {};
      for (const f of tool.fields) {
        if (f.showIf) {
          const controller = tool.fields.find((x) => x.key === f.showIf!.key)!;
          if (String(controller.default) !== String(f.showIf.equals)) continue;
        }
        if (f.default === undefined) continue;
        sent[f.key] = f.valueType === 'number' ? Number(f.default) : f.default;
      }
      expect(
        () => parseOptions(op, { ...sent, ...REQUIRED_SAMPLES[op] }),
        `${op} with ${JSON.stringify(sent)}`,
      ).not.toThrow();
    }
  });

  it('secret fields are real password fields and nothing else is secret', () => {
    for (const op of OPERATION_NAMES) {
      const tool = OPERATIONS[op];
      for (const key of tool.secretFields)
        expect(tool.fields.find((f) => f.key === key)?.type, `${op}.${key}`).toBe('password');
      for (const f of tool.fields.filter((x) => x.type === 'password'))
        expect(tool.secretFields, `${op}.${f.key}`).toContain(f.key);
    }
  });

  it('GET /formats exposes every tool with its form definition', async () => {
    const res = await request().get('/api/v1/formats');
    const ops = res.body.data.operations as Array<{
      operation: string;
      slug: string;
      fields: unknown[];
      category: string;
      group: string;
    }>;
    expect(ops.map((o) => o.operation).sort()).toEqual([...OPERATION_NAMES].sort());
    expect(ops.find((o) => o.operation === 'PDF_PROTECT')).toMatchObject({
      slug: 'protect-pdf',
      category: 'pdf',
      group: 'security',
      secretFields: ['password'],
    });
    expect(ops.every((o) => Array.isArray(o.fields))).toBe(true);
  });
});

describe('multi-file jobs and the admin view', () => {
  it('stores every input in order, and a job survives retention while it is queued', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    overrideProcessor('PDF_MERGE', {
      operations: ['PDF_MERGE'],
      validate: async () => undefined,
      outputExtensionFor: () => 'pdf',
      process: async (input) => {
        await gate;
        await fs.writeFile(input.outputPath, await makeNumberedPdf(1));
        return { outputMime: 'application/pdf', outputExt: 'pdf', info: { files: input.inputPaths.length } };
      },
      cleanup: async (input) => fs.rm(input.outputPath, { force: true }),
    });
    const ids = [
      await uploadId(await makeNumberedPdf(1), 'a.pdf'),
      await uploadId(await makeNumberedPdf(1), 'b.pdf'),
      await uploadId(await makeNumberedPdf(1), 'c.pdf'),
    ];
    const created = await request()
      .post('/api/v1/jobs')
      .send({ fileIds: [ids[2]!, ids[0]!, ids[1]!], operation: 'PDF_MERGE' });
    expect(created.status).toBe(202);
    await new Promise((r) => setTimeout(r, 200));

    const rows = await db().jobInput.findMany({
      where: { jobId: created.body.data.jobId },
      orderBy: { position: 'asc' },
    });
    expect(rows.map((r) => r.fileId)).toEqual([ids[2], ids[0], ids[1]]);

    // all inputs expire, but the running job still needs the *second* and *third* input
    await db().file.updateMany({ where: { id: { in: ids } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const report = await runCleanup();
    expect(report.deleted).toBe(0);
    expect(await db().file.count({ where: { id: { in: ids }, status: { not: 'DELETED' } } })).toBe(3);

    release();
    const done = await (async () => {
      for (;;) {
        const j = (await request().get(`/api/v1/jobs/${created.body.data.jobId}`)).body.data;
        if (['COMPLETED', 'FAILED'].includes(j.status)) return j;
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    expect(done.status).toBe('COMPLETED');
    expect(done.originalSizeBytes).toBeGreaterThan(0);
    // inputs are released afterwards: a later cleanup may remove them
    expect((await runCleanup()).deleted).toBeGreaterThanOrEqual(3);
  });

  it('deleting any one input of a running multi-file job cancels it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    overrideProcessor('PDF_MERGE', {
      operations: ['PDF_MERGE'],
      validate: async () => undefined,
      outputExtensionFor: () => 'pdf',
      process: async (input) => {
        await gate;
        await fs.writeFile(input.outputPath, 'x');
        return { outputMime: 'application/pdf', outputExt: 'pdf' };
      },
      cleanup: async (input) => fs.rm(input.outputPath, { force: true }),
    });
    const a = await uploadId(await makeNumberedPdf(1), 'a.pdf');
    const b = await uploadId(await makeNumberedPdf(1), 'b.pdf');
    const created = await request()
      .post('/api/v1/jobs')
      .send({ fileIds: [a, b], operation: 'PDF_MERGE' });
    await new Promise((r) => setTimeout(r, 200));
    const del = request().delete(`/api/v1/files/${b}`); // the SECOND input, not the primary one
    setTimeout(release, 300);
    expect((await del).status).toBe(200);
    const job = (await request().get(`/api/v1/jobs/${created.body.data.jobId}`)).body.data;
    expect(job.status).toBe('CANCELLED');
    expect(await db().file.count({ where: { role: 'OUTPUT' } })).toBe(0);
  });

  it('technical failure detail is visible to admins only', async () => {
    const { agent } = await adminAgent();
    overrideProcessor('PDF_MERGE', {
      operations: ['PDF_MERGE'],
      validate: async () => undefined,
      outputExtensionFor: () => 'pdf',
      process: async () => {
        throw new ProcessorError('Friendly message.', 'PROCESSING_FAILED', {
          cause: new Error('engine exploded at 0x7f /internal/path'),
        });
      },
      cleanup: async () => undefined,
    });
    const a = await uploadId(await makeNumberedPdf(1), 'a.pdf');
    const b = await uploadId(await makeNumberedPdf(1), 'b.pdf');
    const { job } = await processFiles([a, b], 'PDF_MERGE');
    expect(job.status).toBe('FAILED');
    expect(JSON.stringify(job)).not.toMatch(/exploded|internal\/path|errorDetail/);
    expect(job.error.message).toBe('Friendly message.');

    const adminView = (await agent.get(`/api/v1/admin/jobs/${job.id}`)).body.data;
    expect(adminView.errorDetail).toMatch(/engine exploded/);
    expect(adminView.inputs.map((i: { name: string }) => i.name)).toEqual(['a.pdf', 'b.pdf']);
    const list = (await agent.get('/api/v1/admin/jobs?operation=PDF_MERGE')).body.data;
    expect(list[0].errorDetail).toMatch(/engine exploded/);
    expect((await agent.get('/api/v1/admin/jobs?operation=NOT_A_TOOL')).status).toBe(400);
  });

  it('every tool writes a per-tool result row visible in MySQL', async () => {
    const a = await uploadId(await makeNumberedPdf(3), 'a.pdf');
    const { job } = await processFiles([a], 'PDF_REMOVE_PAGES', { pages: '2' });
    const row = await db().pdfResult.findUniqueOrThrow({ where: { jobId: job.id } });
    expect(row).toMatchObject({ operation: 'PDF_REMOVE_PAGES', inputPages: 3, outputPages: 2 });
    expect(JSON.stringify(row.details)).toContain('"pages":"2"');
  });
});

describe('resource limits protect the server', () => {
  it('refuses PDFs over MAX_PDF_PAGES and conversions over MAX_RENDER_PAGES', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const make = async (pages: number) => {
      const pdf = await PDFDocument.create();
      for (let i = 0; i < pages; i++) pdf.addPage([50, 50]);
      return Buffer.from(await pdf.save());
    };
    const { runTool } = await import('./helpers/toolHarness');
    const huge = await runTool(await make(1501), 'huge.pdf', 'PDF_ROTATE', { angle: 90 });
    expect(huge.job.status).toBe('FAILED');
    expect(huge.job.error.message).toMatch(/more than 1500 pages/);
    const many = await runTool(await make(201), 'many.pdf', 'PDF_TO_IMAGES', { format: 'jpg', dpi: 72 });
    expect(many.job.error).toEqual({ code: 'INVALID_OPTIONS', message: expect.stringMatching(/at most 200/) });
    const fine = await runTool(await make(5), 'ok.pdf', 'PDF_TO_IMAGES', { format: 'jpg', dpi: 72, pages: '1-3' });
    expect(fine.job.status).toBe('COMPLETED');
  }, 120_000);
});
