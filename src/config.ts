export interface Config {
  port: number;
  nodeEnv: string;
  dbDriver: 'sqlite' | 'postgres';
  sqlitePath: string;
  databaseUrl: string;
  jwtSecret: string;
  jwtAccessTtl: string;
  refreshTtlDays: number;
  logLevel: string;
  uploadDir: string;
  maxUploadMb: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dbDriver = env.DB_DRIVER === 'postgres' ? 'postgres' : 'sqlite';
  const jwtSecret = env.JWT_SECRET ?? '';
  if (!jwtSecret && env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET wajib diisi saat NODE_ENV=production');
  }
  return {
    port: Number(env.PORT ?? 3000),
    nodeEnv: env.NODE_ENV ?? 'development',
    dbDriver,
    sqlitePath: env.SQLITE_PATH ?? './data/taskflow.db',
    databaseUrl: env.DATABASE_URL ?? 'postgres://taskflow:taskflow@localhost:5432/taskflow',
    jwtSecret: jwtSecret || 'dev-only-secret-change-me',
    jwtAccessTtl: env.JWT_ACCESS_TTL ?? '15m',
    refreshTtlDays: Number(env.REFRESH_TTL_DAYS ?? 7),
    logLevel: env.LOG_LEVEL ?? 'info',
    uploadDir: env.UPLOAD_DIR ?? './uploads',
    maxUploadMb: Number(env.MAX_UPLOAD_MB ?? 10),
  };
}
