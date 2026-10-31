import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { db } from './db/prisma';
import { jsonReplacer } from './lib/http';
import { errorHandler, notFound } from './http/middleware/errorHandler';
import { requestContext } from './http/middleware/requestContext';
import { adminRouter } from './http/routes/adminRoutes';
import { publicRouter } from './http/routes/publicRoutes';
import { openApiDocument } from './openapi';

/** Build the Express app. No listening, no timers: servers and tests decide how to run it. */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('json replacer', jsonReplacer);
  app.set('trust proxy', 'loopback'); // behind the Next.js proxy / a local reverse proxy
  app.use(requestContext);
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.get('/health', async (_req, res) => {
    try {
      await db().$queryRaw`SELECT 1`;
      res.json({ success: true, data: { status: 'ok', database: 'up' } });
    } catch {
      res.status(503).json({ success: false, error: { code: 'DATABASE_ERROR', message: 'Database unavailable.' } });
    }
  });
  app.get('/api/v1/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1', publicRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
