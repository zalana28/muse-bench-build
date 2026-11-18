import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Pool, type PoolClient } from 'pg';
import type { Config } from './config';

/**
 * Interface database tunggal. Semua SQL ditulis dengan placeholder `?`
 * (gaya SQLite). Driver Postgres menerjemahkannya ke `$1, $2, ...`.
 * Syarat: jangan pernah menulis karakter `?` literal di dalam string SQL.
 */
export interface Db {
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Terjemah `?` -> `$1..$n` untuk Postgres. Fungsi murni — ada unit test-nya. */
export function translatePlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/**
 * Skema portabel: satu DDL yang jalan di SQLite maupun Postgres.
 * - id TEXT (UUID dibuat di JS via crypto.randomUUID)
 * - enum sebagai TEXT + CHECK
 * - timestamp sebagai TEXT ISO-8601 (terurut leksikografis)
 * - JSON sebagai TEXT
 * Versi Postgres yang lebih kaya (tipe UUID/ENUM + index tsvector)
 * ada di src/db/migrations/001_init.postgres.sql untuk docker init.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email));

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_id);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON workspace_members(user_id);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_workspace
  ON projects(workspace_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo', 'in_progress', 'review', 'done')),
  priority TEXT NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reporter_id TEXT NOT NULL REFERENCES users(id),
  due_date TEXT,
  position REAL NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(project_id, status, position);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee
  ON tasks(assignee_id, status) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_due
  ON tasks(due_date) WHERE completed_at IS NULL;

CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6B7280',
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS task_labels (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_task_labels_label ON task_labels(label_id);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_task
  ON comments(task_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  uploader_id TEXT NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_ws ON activity_log(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_user
  ON refresh_tokens(user_id) WHERE revoked_at IS NULL;

-- Idempotency keys (temuan B5-F4/F5): satu kunci + satu user + satu
-- endpoint hanya boleh menghasilkan satu efek. response_status/body
-- NULL saat klaim dibuat (di dalam transaksi yang sama dengan pembuatan
-- task) dan diisi begitu task berhasil dibuat; retry dengan kunci yang
-- sama mengembalikan respons tersimpan tanpa membuat duplikat.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, endpoint, idem_key)
);
`;

class SqliteDb implements Db {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
  }

  /** PRAGMA integrity_check: 'ok' bila file sehat. Dipanggil createDb saat boot. */
  pragmaIntegrityCheck(): string {
    return this.db.pragma('integrity_check', { simple: true }) as string;
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const r = this.db.prepare(sql).run(...(params as never[]));
    return { changes: Number(r.changes) };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try {
      const value = await fn(this);
      this.db.exec('COMMIT');
      return value;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

class PgDb implements Db {
  private pool: Pool;
  private client: PoolClient | null = null;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  private target(): Pool | PoolClient {
    return this.client ?? this.pool;
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const res = await this.target().query(translatePlaceholders(sql), params as never[]);
    return res.rows[0] as T | undefined;
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.target().query(translatePlaceholders(sql), params as never[]);
    return res.rows as T[];
  }

  async run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const res = await this.target().query(translatePlaceholders(sql), params as never[]);
    return { changes: res.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.target().query(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx = new PgDb('');
    tx.pool = this.pool;
    tx.client = client;
    try {
      await client.query('BEGIN');
      const value = await fn(tx);
      await client.query('COMMIT');
      return value;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function createDb(config: Config): Promise<Db> {
  if (config.dbDriver === 'postgres') return new PgDb(config.databaseUrl);
  // better-sqlite3 (bukan node:sqlite): resolver Vite/vitest versi ini tidak
  // mengenali builtin `node:sqlite` dan gagal load di test ("Failed to load
  // url sqlite"). better-sqlite3 adalah package biasa + prebuild, jadi
  // vitest, tsc, dan clone-run semuanya jalan tanpa trik import.
  // better-sqlite3 TIDAK membuat folder parent file DB — buat dulu.
  fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true });
  let sqlite: SqliteDb;
  try {
    sqlite = new SqliteDb(new Database(config.sqlitePath));
  } catch (err) {
    // File ada tapi bukan SQLite (korup / tertimpa file lain): gagal start
    // dengan pesan yang bisa ditindaklanjuti, bukan stack mentah
    // (temuan B5-F9; bukti: 'fatal startup error: SqliteError: file is not
    // a database' tanpa petunjuk recovery).
    throw new Error(
      `Database di ${config.sqlitePath} korup atau bukan file SQLite. ` +
        `Pulihkan dari backup: npm run restore -- <file-backup> (lihat BREAK-REPORT.md). ` +
        `Detail: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Integrity check saat boot (temuan B5-F8): bedakan "DB baru yang kosong"
  // dari "DB yang rusak". PRAGMA ini cepat untuk ukuran DB ini.
  const check = sqlite.pragmaIntegrityCheck();
  if (check !== 'ok') {
    throw new Error(
      `Database di ${config.sqlitePath} gagal integrity check (${check}). ` +
        `Pulihkan dari backup: npm run restore -- <file-backup> (lihat BREAK-REPORT.md).`,
    );
  }
  return sqlite;
}

export async function initSchema(db: Db): Promise<void> {
  await db.exec(SCHEMA_SQL);
}
