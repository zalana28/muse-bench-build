// Regression suite untuk temuan Challenge B5 (BREAK).
// Tiap test menyebut nomor temuan yang dijaganya (lihat BREAK-REPORT.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { createDb, initSchema, type Db } from '../src/db';

const testConfig: Config = {
  port: 0,
  nodeEnv: 'test',
  dbDriver: 'sqlite',
  sqlitePath: ':memory:',
  databaseUrl: '',
  jwtSecret: 'test-secret-yang-cukup-panjang-untuk-hs256',
  jwtAccessTtl: '15m',
  refreshTtlDays: 7,
  logLevel: 'silent',
  uploadDir: './uploads',
  maxUploadMb: 10,
};

let db: Db;
let app: ReturnType<typeof createApp>['app'];
let adminToken = '';
let projectId = '';
let taskId = '';

const H = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  db = await createDb(testConfig);
  await initSchema(db);
  app = createApp(db, testConfig).app;
  const reg = await request(app)
    .post('/api/v1/auth/register')
    .send({ email: 'admin@taskflow.local', password: 'Password123', name: 'Admin' });
  expect(reg.status).toBe(201);
  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: 'admin@taskflow.local', password: 'Password123' });
  adminToken = (login.body as { data: { accessToken: string } }).data.accessToken;
  const ws = await request(app)
    .post('/api/v1/workspaces')
    .set(H(adminToken))
    .send({ name: 'WS Break' });
  const proj = await request(app)
    .post(`/api/v1/workspaces/${(ws.body as { data: { id: string } }).data.id}/projects`)
    .set(H(adminToken))
    .send({ name: 'Project Break' });
  projectId = (proj.body as { data: { id: string } }).data.id;
  const t = await request(app)
    .post(`/api/v1/projects/${projectId}/tasks`)
    .set(H(adminToken))
    .send({ title: 'Task komentar' });
  taskId = (t.body as { data: { id: string } }).data.id;
});

afterAll(async () => {
  await db.close();
});

describe('B5-F1 whitespace-only ditolak, email dinormalisasi', () => {
  it('title spasi saja -> 422', async () => {
    const r = await request(app)
      .post(`/api/v1/projects/${projectId}/tasks`)
      .set(H(adminToken))
      .send({ title: '   ' });
    expect(r.status).toBe(422);
  });
  it('nama spasi saja -> 422', async () => {
    const r = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'ws2@x.test', password: 'Password123', name: '   ' });
    expect(r.status).toBe(422);
  });
  it('comment spasi saja -> 422', async () => {
    const r = await request(app)
      .post(`/api/v1/tasks/${taskId}/comments`)
      .set(H(adminToken))
      .send({ body: '   ' });
    expect(r.status).toBe(422);
  });
  it('email kapital+spasi dinormalisasi; duplikat beda case -> 409', async () => {
    const r = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: '  Case@Example.Test ', password: 'Password123', name: 'Case' });
    expect(r.status).toBe(201);
    expect((r.body as { data: { email: string } }).data.email).toBe('case@example.test');
    const dup = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'CASE@example.test', password: 'Password123', name: 'Case2' });
    expect(dup.status).toBe(409);
  });
  it('title dengan spasi di ujung disimpan ter-trim', async () => {
    const r = await request(app)
      .post(`/api/v1/projects/${projectId}/tasks`)
      .set(H(adminToken))
      .send({ title: '  hello  ' });
    expect(r.status).toBe(201);
    expect((r.body as { data: { title: string } }).data.title).toBe('hello');
  });
});

describe('B5-F2/F3 body JSON rusak / terlalu besar', () => {
  it('malformed JSON -> 400 (bukan 500)', async () => {
    const r = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{json rusak');
    expect(r.status).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
  });
  it('body > 1 MB -> 413 (bukan 500)', async () => {
    const r = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'x'.repeat(2 * 1024 * 1024), password: 'x' }));
    expect(r.status).toBe(413);
    expect((r.body as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('B5-F6 refresh tanpa cookie -> 401', () => {
  it('POST /auth/refresh tanpa cookie mengembalikan 401, bukan 404', async () => {
    const r = await request(app).post('/api/v1/auth/refresh');
    expect(r.status).toBe(401);
    expect((r.body as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });
});

describe('B5-F4/F5 idempotency', () => {
  it('kunci sama 2x sekuensial -> id task sama, 1 baris di DB', async () => {
    const key = 'b5-seq-key-1';
    const body = { title: 'Task idempotent sekuensial' };
    const r1 = await request(app)
      .post(`/api/v1/projects/${projectId}/tasks`)
      .set(H(adminToken))
      .set('Idempotency-Key', key)
      .send(body);
    const r2 = await request(app)
      .post(`/api/v1/projects/${projectId}/tasks`)
      .set(H(adminToken))
      .set('Idempotency-Key', key)
      .send(body);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect((r2.body as { data: { id: string } }).data.id).toBe(
      (r1.body as { data: { id: string } }).data.id,
    );
    const row = await db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM tasks WHERE title = ?',
      ['Task idempotent sekuensial'],
    );
    expect(row?.n).toBe(1);
  });
  it('kunci sama 5x paralel -> 1 task, semua respons id sama', async () => {
    const key = 'b5-par-key-1';
    const body = { title: 'Task idempotent paralel' };
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .post(`/api/v1/projects/${projectId}/tasks`)
          .set(H(adminToken))
          .set('Idempotency-Key', key)
          .send(body),
      ),
    );
    for (const r of results) expect(r.status).toBe(201);
    const ids = new Set(results.map((r) => (r.body as { data: { id: string } }).data.id));
    expect(ids.size).toBe(1);
    const row = await db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM tasks WHERE title = ?',
      ['Task idempotent paralel'],
    );
    expect(row?.n).toBe(1);
  });
  it('kunci sama + payload berbeda -> 409', async () => {
    const key = 'b5-conflict-key-1';
    const r1 = await request(app)
      .post(`/api/v1/projects/${projectId}/tasks`)
      .set(H(adminToken))
      .set('Idempotency-Key', key)
      .send({ title: 'Judul A' });
    expect(r1.status).toBe(201);
    const r2 = await request(app)
      .post(`/api/v1/projects/${projectId}/tasks`)
      .set(H(adminToken))
      .set('Idempotency-Key', key)
      .send({ title: 'Judul B (beda)' });
    expect(r2.status).toBe(409);
  });
  it('tanpa kunci, 2x kirim sama -> tetap 2 task (by design)', async () => {
    const body = { title: 'Task tanpa kunci' };
    const r1 = await request(app)
      .post(`/api/v1/projects/${projectId}/tasks`)
      .set(H(adminToken))
      .send(body);
    const r2 = await request(app)
      .post(`/api/v1/projects/${projectId}/tasks`)
      .set(H(adminToken))
      .send(body);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect((r1.body as { data: { id: string } }).data.id).not.toBe(
      (r2.body as { data: { id: string } }).data.id,
    );
  });
});

describe('B5-F7 JWT_SECRET wajib', () => {
  it('tanpa JWT_SECRET di development -> loadConfig throw', () => {
    expect(() => loadConfig({ NODE_ENV: 'development' })).toThrow(/JWT_SECRET/);
  });
  it('tanpa JWT_SECRET di production -> loadConfig throw', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
  });
  it('di test: secret acak per proses, bukan nilai default yang bisa ditebak', () => {
    const a = loadConfig({ NODE_ENV: 'test' });
    const b = loadConfig({ NODE_ENV: 'test' });
    expect(a.jwtSecret.length).toBeGreaterThanOrEqual(32);
    expect(a.jwtSecret).not.toBe('dev-only-secret-change-me');
    expect(a.jwtSecret).not.toBe(b.jwtSecret);
  });
});

describe('B5-F8/F9 kesehatan DB', () => {
  it('/health -> 503 bila file DB tidak ada di path yang dikonfigurasi', async () => {
    const badConfig: Config = {
      ...testConfig,
      sqlitePath: path.join(os.tmpdir(), 'taskflow-tidak-ada-b5.db'),
    };
    const { app: app2 } = createApp(db, badConfig);
    const r = await request(app2).get('/health');
    expect(r.status).toBe(503);
    expect((r.body as { db: string }).db).toBe('down');
  });
  it('request API -> 503 DB_UNAVAILABLE bila file DB tidak ada', async () => {
    const badConfig: Config = {
      ...testConfig,
      sqlitePath: path.join(os.tmpdir(), 'taskflow-tidak-ada-b5.db'),
    };
    const { app: app2 } = createApp(db, badConfig);
    const r = await request(app2).get('/api/v1/users/me').set(H(adminToken));
    expect(r.status).toBe(503);
    expect((r.body as { error: { code: string } }).error.code).toBe('DB_UNAVAILABLE');
  });
  it('/health -> 200 bila DB sehat', async () => {
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
    expect((r.body as { db: string }).db).toBe('ok');
  });
  it('createDb pada file korup -> throw dengan petunjuk restore', async () => {
    const tmp = path.join(os.tmpdir(), `taskflow-korup-b5-${Date.now()}.db`);
    fs.writeFileSync(tmp, 'GARBAGE-NOT-A-SQLITE-FILE');
    try {
      await expect(
        createDb({ ...testConfig, sqlitePath: tmp }),
      ).rejects.toThrow(/korup|restore/i);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
