import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Config } from '../src/config';
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

async function register(email: string, password = 'Password123', name = 'Test User') {
  return request(app).post('/api/v1/auth/register').send({ email, password, name });
}

async function login(email: string, password = 'Password123') {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return {
    status: res.status,
    token: (res.body as { data?: { accessToken?: string } }).data?.accessToken ?? '',
    cookies: (res.headers['set-cookie'] as string[] | undefined) ?? [],
  };
}

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  db = await createDb(testConfig);
  await initSchema(db);
  app = createApp(db, testConfig).app;
});

afterAll(async () => {
  await db.close();
});

describe('auth', () => {
  it('register menyimpan password ter-hash, bukan plaintext; user pertama jadi admin', async () => {
    const res = await register('admin@taskflow.local');
    expect(res.status).toBe(201);
    const body = res.body as { data: { id: string; email: string; role: string; password_hash?: string } };
    expect(body.data.email).toBe('admin@taskflow.local');
    expect(body.data.role).toBe('admin');
    expect(body.data.password_hash).toBeUndefined();
    const row = await db.get<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE email = ?',
      ['admin@taskflow.local'],
    );
    expect(row).toBeDefined();
    expect(row!.password_hash).not.toBe('Password123');
    expect(row!.password_hash.startsWith('$2')).toBe(true);
  });

  it('register kedua jadi user biasa; email duplikat -> 409', async () => {
    const res = await register('user@taskflow.local');
    expect(res.status).toBe(201);
    expect((res.body as { data: { role: string } }).data.role).toBe('user');
    const dup = await register('user@taskflow.local');
    expect(dup.status).toBe(409);
  });

  it('login password salah -> 401', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@taskflow.local', password: 'Salah1234' });
    expect(res.status).toBe(401);
  });

  it('tanpa token, endpoint terproteksi -> 401', async () => {
    const res = await request(app).get('/api/v1/workspaces');
    expect(res.status).toBe(401);
  });

  it('refresh token berotasi; token lama yang dipakai ulang -> 401', async () => {
    const first = await login('user@taskflow.local');
    expect(first.status).toBe(200);
    const cookie = first.cookies.find((c) => c.startsWith('refreshToken='));
    expect(cookie).toBeDefined();
    const refreshed = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie as string);
    expect(refreshed.status).toBe(200);
    const reuse = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookie as string);
    expect(reuse.status).toBe(401);
  });
});

describe('RBAC admin endpoint', () => {
  it('user biasa tidak bisa akses /admin/users -> 403; admin bisa -> 200', async () => {
    const user = await login('user@taskflow.local');
    const denied = await request(app)
      .get('/api/v1/admin/users')
      .set(authHeader(user.token));
    expect(denied.status).toBe(403);

    const admin = await login('admin@taskflow.local');
    const allowed = await request(app)
      .get('/api/v1/admin/users')
      .set(authHeader(admin.token));
    expect(allowed.status).toBe(200);
    const emails = (allowed.body as { data: { email: string }[] }).data.map((u) => u.email);
    expect(emails).toContain('admin@taskflow.local');
    expect(emails).toContain('user@taskflow.local');
  });
});

describe('workspaces, projects, tasks', () => {
  let adminToken = '';
  let userToken = '';
  let workspaceId = '';
  let projectId = '';
  let taskId = '';

  it('setup: admin buat workspace + project, tambah user sebagai member', async () => {
    adminToken = (await login('admin@taskflow.local')).token;
    userToken = (await login('user@taskflow.local')).token;
    const ws = await request(app)
      .post('/api/v1/workspaces')
      .set(authHeader(adminToken))
      .send({ name: 'WS Test' });
    expect(ws.status).toBe(201);
    workspaceId = (ws.body as { data: { id: string } }).data.id;

    const userRow = await db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [
      'user@taskflow.local',
    ]);
    const add = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/members`)
      .set(authHeader(adminToken))
      .send({ userId: userRow!.id, role: 'member' });
    expect(add.status).toBe(201);

    const project = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/projects`)
      .set(authHeader(adminToken))
      .send({ name: 'Project Test' });
    expect(project.status).toBe(201);
    projectId = (project.body as { data: { id: string } }).data.id;
  });

  it('task CRUD penuh: create -> get -> patch -> move -> delete -> 404', async () => {
    const created = await request(app)
      .post(`/api/v1/projects/${projectId}/tasks`)
      .set(authHeader(userToken))
      .send({ title: 'Audit endpoint login', priority: 'high' });
    expect(created.status).toBe(201);
    taskId = (created.body as { data: { id: string } }).data.id;
    expect((created.body as { data: { status: string } }).data.status).toBe('todo');

    const got = await request(app).get(`/api/v1/tasks/${taskId}`).set(authHeader(userToken));
    expect(got.status).toBe(200);
    expect((got.body as { data: { title: string } }).data.title).toBe('Audit endpoint login');

    const patched = await request(app)
      .patch(`/api/v1/tasks/${taskId}`)
      .set(authHeader(userToken))
      .send({ status: 'in_progress' });
    expect(patched.status).toBe(200);
    expect((patched.body as { data: { status: string } }).data.status).toBe('in_progress');

    const moved = await request(app)
      .post(`/api/v1/tasks/${taskId}/move`)
      .set(authHeader(userToken))
      .send({ status: 'review', position: 2048 });
    expect(moved.status).toBe(200);
    expect((moved.body as { data: { status: string; position: number } }).data).toMatchObject({
      status: 'review',
      position: 2048,
    });

    const deleted = await request(app)
      .delete(`/api/v1/tasks/${taskId}`)
      .set(authHeader(userToken));
    expect(deleted.status).toBe(204);
    const gone = await request(app).get(`/api/v1/tasks/${taskId}`).set(authHeader(userToken));
    expect(gone.status).toBe(404);
  });

  it('search & filter: status dan q bekerja', async () => {
    await request(app)
      .post(`/api/v1/projects/${projectId}/tasks`)
      .set(authHeader(userToken))
      .send({ title: 'Audit endpoint login' });
    await request(app)
      .post(`/api/v1/projects/${projectId}/tasks`)
      .set(authHeader(userToken))
      .send({ title: 'Tulis dokumentasi API' });
    const done = await request(app)
      .post(`/api/v1/projects/${projectId}/tasks`)
      .set(authHeader(userToken))
      .send({ title: 'Bersihkan data lama' });
    const doneId = (done.body as { data: { id: string } }).data.id;
    await request(app)
      .patch(`/api/v1/tasks/${doneId}`)
      .set(authHeader(userToken))
      .send({ status: 'done' });

    const byStatus = await request(app)
      .get(`/api/v1/projects/${projectId}/tasks?status=todo`)
      .set(authHeader(userToken));
    expect(byStatus.status).toBe(200);
    const todos = (byStatus.body as { data: { status: string }[] }).data;
    expect(todos.length).toBe(2);
    expect(todos.every((t) => t.status === 'todo')).toBe(true);

    const byQuery = await request(app)
      .get(`/api/v1/projects/${projectId}/tasks?q=audit`)
      .set(authHeader(userToken));
    const found = (byQuery.body as { data: { title: string }[] }).data;
    expect(found.length).toBe(1);
    expect(found[0].title).toBe('Audit endpoint login');
  });

  it('ownership: non-member tidak bisa baca task; member bukan reporter tidak bisa update', async () => {
    await register('outsider@taskflow.local');
    const outsider = await login('outsider@taskflow.local');
    const anyTask = await request(app)
      .get(`/api/v1/projects/${projectId}/tasks?limit=1`)
      .set(authHeader(userToken));
    const someId = (anyTask.body as { data: { id: string }[] }).data[0].id;
    const denied = await request(app)
      .get(`/api/v1/tasks/${someId}`)
      .set(authHeader(outsider.token));
    expect(denied.status).toBe(403);

    await register('member2@taskflow.local');
    const member2 = await login('member2@taskflow.local');
    const member2Row = await db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [
      'member2@taskflow.local',
    ]);
    await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/members`)
      .set(authHeader(adminToken))
      .send({ userId: member2Row!.id, role: 'member' });
    const forbiddenUpdate = await request(app)
      .patch(`/api/v1/tasks/${someId}`)
      .set(authHeader(member2.token))
      .send({ title: 'Diubah orang lain' });
    expect(forbiddenUpdate.status).toBe(403);
  });

  it('validasi: buat task tanpa title -> 422; register email jelek -> 422', async () => {
    const noTitle = await request(app)
      .post(`/api/v1/projects/${projectId}/tasks`)
      .set(authHeader(userToken))
      .send({ description: 'tanpa judul' });
    expect(noTitle.status).toBe(422);
    const badEmail = await register('bukan-email');
    expect(badEmail.status).toBe(422);
  });

  it('viewer tidak bisa membuat task -> 403', async () => {
    await register('viewer@taskflow.local');
    const viewer = await login('viewer@taskflow.local');
    const viewerRow = await db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [
      'viewer@taskflow.local',
    ]);
    await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/members`)
      .set(authHeader(adminToken))
      .send({ userId: viewerRow!.id, role: 'viewer' });
    const attempt = await request(app)
      .post(`/api/v1/projects/${projectId}/tasks`)
      .set(authHeader(viewer.token))
      .send({ title: 'Seharusnya ditolak' });
    expect(attempt.status).toBe(403);
    // Viewer tetap bisa membaca
    const read = await request(app)
      .get(`/api/v1/projects/${projectId}/tasks`)
      .set(authHeader(viewer.token));
    expect(read.status).toBe(200);
  });

  it('health endpoint -> 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe('ok');
  });
});
