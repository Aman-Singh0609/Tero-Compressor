import { PrismaClient } from '@prisma/client';
import { getEnv } from '../config/env';
import { recordTiming } from '../lib/timing';

function create() {
  const base = new PrismaClient({ datasourceUrl: getEnv().DATABASE_URL });
  // Per-query timing surfaces slow operations and N+1 patterns in development diagnostics.
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const start = performance.now();
          try {
            return await query(args);
          } finally {
            recordTiming(`prisma.${model}.${operation}`, Math.round(performance.now() - start));
          }
        },
      },
    },
  });
}

export type Db = ReturnType<typeof create>;
export type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];

let client: Db | undefined;

export function db(): Db {
  if (!client) client = create();
  return client;
}

export async function disconnectDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
