import crypto from 'node:crypto';

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
  // Temuan B5-F7: secret default 'dev-only-secret-change-me' yang tertulis
  // di repo ini berarti SIAPA PUN bisa menempa token admin di deployment
  // yang lupa set JWT_SECRET (dibuktikan: token palsu -> 200 /admin/users).
  // Tidak ada lagi nilai default: tanpa JWT_SECRET server gagal start,
  // kecuali di test (secret acak per proses, tidak bisa ditebak).
  let effectiveSecret = jwtSecret;
  if (!effectiveSecret) {
    if (env.NODE_ENV === 'test') {
      effectiveSecret = crypto.randomBytes(32).toString('hex');
    } else {
      throw new Error(
        'JWT_SECRET wajib diisi (set di .env / environment). Tidak ada nilai default.',
      );
    }
  }
  return {
    port: Number(env.PORT ?? 3000),
    nodeEnv: env.NODE_ENV ?? 'development',
    dbDriver,
    sqlitePath: env.SQLITE_PATH ?? './data/taskflow.db',
    databaseUrl: env.DATABASE_URL ?? 'postgres://taskflow:taskflow@localhost:5432/taskflow',
    jwtSecret: effectiveSecret,
    jwtAccessTtl: env.JWT_ACCESS_TTL ?? '15m',
    refreshTtlDays: Number(env.REFRESH_TTL_DAYS ?? 30),
    logLevel: env.LOG_LEVEL ?? 'info',
    uploadDir: env.UPLOAD_DIR ?? './uploads',
    maxUploadMb: Number(env.MAX_UPLOAD_MB ?? 10),
  };
}
