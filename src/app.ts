import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import pino from 'pino';
import type { Config } from './config';
import type { Db } from './db';
import { errorHandler, requestId } from './middleware';
import { createRouter } from './routes';

export interface AppMetrics {
  requests: number;
  errors: number;
  startedAt: number;
}

/** Merakit aplikasi Express. `db` di-inject agar test bisa memakai DB in-memory. */
export function createApp(db: Db, config: Config): { app: Express; metrics: AppMetrics } {
  const logger = pino({ level: config.nodeEnv === 'test' ? 'silent' : config.logLevel });
  const metrics: AppMetrics = { requests: 0, errors: 0, startedAt: Date.now() };
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(requestId);
  app.use((req, _res, next) => {
    metrics.requests += 1;
    logger.info({ method: req.method, path: req.path, requestId: req.headers['x-request-id'] }, 'request');
    next();
  });

  app.get('/health', async (_req, res) => {
    try {
      await db.get('SELECT 1 AS ok');
      res.json({ status: 'ok', db: 'ok' });
    } catch {
      res.status(503).json({ status: 'error', db: 'down' });
    }
  });

  // Metrik minimal format Prometheus (tanpa dependensi tambahan).
  app.get('/metrics', (_req, res) => {
    const uptimeSec = Math.floor((Date.now() - metrics.startedAt) / 1000);
    res.type('text/plain; version=0.0.4').send(
      [
        '# HELP taskflow_http_requests_total Total HTTP requests',
        '# TYPE taskflow_http_requests_total counter',
        `taskflow_http_requests_total ${metrics.requests}`,
        '# HELP taskflow_http_errors_total Total 5xx responses',
        '# TYPE taskflow_http_errors_total counter',
        `taskflow_http_errors_total ${metrics.errors}`,
        '# HELP taskflow_uptime_seconds Uptime aplikasi',
        '# TYPE taskflow_uptime_seconds gauge',
        `taskflow_uptime_seconds ${uptimeSec}`,
      ].join('\n') + '\n',
    );
  });

  app.use('/api/v1', createRouter(db, config));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route tidak ditemukan' } });
  });

  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof Error && 'status' in err && typeof (err as { status: number }).status === 'number') {
      const status = (err as { status: number }).status;
      if (status >= 500) metrics.errors += 1;
    }
    errorHandler(err, req, res, next);
  });

  return { app, metrics };
}
