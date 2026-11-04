import { request, upload, waitForJob } from './harness';

/** Create a multi-file (or single-file) job through the real API and wait for it to finish. */
export async function processFiles(fileIds: string[], operation: string, options?: Record<string, unknown>) {
  const created = await request().post('/api/v1/jobs').send({ fileIds, operation, options });
  if (created.status !== 202) return { created, job: undefined };
  return { created, job: await waitForJob(created.body.data.jobId) };
}

export async function downloadBytes(url: string): Promise<Buffer> {
  const res = await request()
    .get(url)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  if (res.status !== 200) throw new Error(`download ${url} -> ${res.status}`);
  return res.body as Buffer;
}

export async function uploadId(buf: Buffer, name: string): Promise<string> {
  const res = await upload(buf, name);
  if (res.status !== 201) throw new Error(`upload ${name} -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.file.id as string;
}

/** Upload one file, run one tool, return the finished job and (when it completed) the output bytes. */
export async function runTool(buf: Buffer, name: string, operation: string, options?: Record<string, unknown>) {
  const id = await uploadId(buf, name);
  const { created, job } = await processFiles([id], operation, options);
  const output = job?.status === 'COMPLETED' ? await downloadBytes(job.downloadUrl) : undefined;
  return { id, created, job, output };
}
