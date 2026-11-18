import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app';
import { loadConfig } from './config';
import { createDb, initSchema } from './db';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.dbDriver === 'sqlite') {
    fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true });
  }
  const db = await createDb(config);
  await initSchema(db);
  const { app } = createApp(db, config);
  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `taskflow listening on :${config.port} (db=${config.dbDriver}, env=${config.nodeEnv})`,
    );
  });

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`received ${signal}, shutting down...`);
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('fatal startup error:', err);
  process.exit(1);
});
