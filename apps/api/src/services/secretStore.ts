/**
 * Passwords for Protect/Unlock PDF. They are kept only in this process's memory, keyed by job id,
 * for as long as the job needs them — never written to MySQL, logs or storage. If the server
 * restarts before the job runs they are simply gone and the job fails with a clear message.
 */
const store = new Map<string, Record<string, string>>();

export const secretStore = {
  put(jobId: string, secrets: Record<string, string>): void {
    if (Object.keys(secrets).length > 0) store.set(jobId, secrets);
  },
  /** Returns the secrets and forgets them. */
  take(jobId: string): Record<string, string> {
    const secrets = store.get(jobId) ?? {};
    store.delete(jobId);
    return secrets;
  },
  discard(jobId: string): void {
    store.delete(jobId);
  },
  size(): number {
    return store.size;
  },
};
