/**
 * Regression test Challenge D — keputusan sesi.
 *
 * R1: sesi bertahan 30 hari (refresh TTL 30, expiry ABSOLUT dipertahankan
 *     saat rotasi — bukan sliding).
 * R2: SEMUA sesi invalidate saat password berubah (token_version + klaim
 *     `sv` di access token + cabut semua refresh token, satu transaksi).
 * R3: peminta ganti password TIDAK logout — sesi baru diterbitkan dalam
 *     respons yang sama.
 */
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { hashToken } from '../src/auth';
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
  refreshTtlDays: 30,
  logLevel: 'silent',
  uploadDir: './uploads',
  maxUploadMb: 10,
};

let db: Db;
let app: ReturnType<typeof createApp>['app'];

async function register(email: string, password = 'Password123', name = 'Sesi User') {
  const res = await request(app).post('/api/v1/auth/register').send({ email, password, name });
  return { status: res.status, id: (res.body as { data?: { id?: string } }).data?.id ?? '' };
}

async function login(email: string, password = 'Password123') {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return {
    status: res.status,
    token: (res.body as { data?: { accessToken?: string } }).data?.accessToken ?? '',
    cookies: (res.headers['set-cookie'] as string[] | undefined) ?? [],
  };
}

function refreshCookie(cookies: string[]): string {
  // Nama cookie di routes.ts: REFRESH_COOKIE = 'refreshToken'.
  const entry = cookies.find((c) => c.startsWith('refreshToken='));
  return entry ? entry.split(';')[0] : '';
}

function refreshTokenValue(cookies: string[]): string {
  return refreshCookie(cookies).replace('refreshToken=', '');
}

async function refreshRow(token: string) {
  return db.get<{ expires_at: string }>('SELECT expires_at FROM refresh_tokens WHERE token_hash = ?', [
    hashToken(token),
  ]);
}

const me = (token: string) => request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${token}`);
const doRefresh = (cookie: string) => request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
const changePw = (token: string, currentPassword: string, newPassword: string) =>
  request(app)
    .post('/api/v1/auth/change-password')
    .set('Authorization', `Bearer ${token}`)
    .send({ currentPassword, newPassword });

beforeAll(async () => {
  db = await createDb(testConfig);
  await initSchema(db);
  app = createApp(db, testConfig).app;
});

afterAll(async () => {
  await db.close();
});

describe('Challenge D — keputusan sesi', () => {
  it('D-R1: default konfigurasi refreshTtlDays = 30 hari', () => {
    const cfg = loadConfig({ NODE_ENV: 'test' });
    expect(cfg.refreshTtlDays).toBe(30);
  });

  it('D-R1: refresh token login berlaku ~30 hari', async () => {
    await register('d-r1@taskflow.local');
    const s = await login('d-r1@taskflow.local');
    expect(s.status).toBe(200);
    const row = await refreshRow(refreshTokenValue(s.cookies));
    expect(row).toBeDefined();
    const ttlMs = new Date(row!.expires_at).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000 + 60_000);
  });

  it('D-R1: refresh MEMPERTAHANKAN expiry absolut (bukan diperpanjang 30 hari lagi)', async () => {
    await register('d-r1b@taskflow.local');
    const s = await login('d-r1b@taskflow.local');
    const before = await refreshRow(refreshTokenValue(s.cookies));
    const r = await doRefresh(refreshCookie(s.cookies));
    expect(r.status).toBe(200);
    const newCookies = (r.headers['set-cookie'] as string[] | undefined) ?? [];
    const after = await refreshRow(refreshTokenValue(newCookies));
    // Token baru mewarisi expiry token lama — sesi mati 30 hari setelah
    // LOGIN, bukan 30 hari setelah refresh terakhir.
    expect(after!.expires_at).toBe(before!.expires_at);
  });

  it('D-R2/R3: password lama salah -> 401, sesi lama tetap hidup', async () => {
    await register('d-r2a@taskflow.local');
    const s = await login('d-r2a@taskflow.local');
    const bad = await changePw(s.token, 'PasswordSALAH', 'PasswordBaru123');
    expect(bad.status).toBe(401);
    expect((await me(s.token)).status).toBe(200);
  });

  it('D-R2/R3: password baru sama dengan lama -> 400', async () => {
    await register('d-r2b@taskflow.local');
    const s = await login('d-r2b@taskflow.local');
    const res = await changePw(s.token, 'Password123', 'Password123');
    expect(res.status).toBe(400);
    expect((await me(s.token)).status).toBe(200);
  });

  it('D-R2/R3: ganti password -> sesi peminta tetap hidup (token baru), SEMUA sesi lain mati', async () => {
    await register('d-r2c@taskflow.local');
    const a = await login('d-r2c@taskflow.local'); // sesi peminta
    const b = await login('d-r2c@taskflow.local'); // sesi lain (perangkat kedua)
    const oldVersion = await db.get<{ token_version: number }>(
      'SELECT token_version FROM users WHERE email = ?',
      ['d-r2c@taskflow.local'],
    );
    expect(oldVersion!.token_version).toBe(0);

    const res = await changePw(a.token, 'Password123', 'PasswordBaru123');
    expect(res.status).toBe(200);
    const body = res.body as { data: { accessToken: string; revokedSessions: number } };
    expect(body.data.accessToken).toBeTruthy();
    // 2 refresh token aktif dicabut: sesi A + sesi B.
    expect(body.data.revokedSessions).toBe(2);

    // token_version naik.
    const newVersion = await db.get<{ token_version: number }>(
      'SELECT token_version FROM users WHERE email = ?',
      ['d-r2c@taskflow.local'],
    );
    expect(newVersion!.token_version).toBe(1);

    // R2: access token LAMA mati seketika (bukan setelah 15 menit).
    expect((await me(a.token)).status).toBe(401);
    expect((await me(b.token)).status).toBe(401);
    // R2: refresh token lama mati.
    expect((await doRefresh(refreshCookie(a.cookies))).status).toBe(401);
    expect((await doRefresh(refreshCookie(b.cookies))).status).toBe(401);
    // R3: token BARU dari respons ganti password langsung jalan.
    const newToken = body.data.accessToken;
    expect((await me(newToken)).status).toBe(200);
    // Cookie refresh BARU dari respons juga jalan.
    const newCookies = (res.headers['set-cookie'] as string[] | undefined) ?? [];
    const r = await doRefresh(refreshCookie(newCookies));
    expect(r.status).toBe(200);
    // Password lama tidak bisa login; password baru bisa.
    expect((await login('d-r2c@taskflow.local', 'Password123')).status).toBe(401);
    expect((await login('d-r2c@taskflow.local', 'PasswordBaru123')).status).toBe(200);
  });

  it('D-R2/R3: client basi yang refresh pakai token lama setelah ganti password TIDAK membunuh sesi baru', async () => {
    // Regresi nyata yang ditemukan saat menulis test ini: reuse-detection
    // B3 membunuh SELURUH keluarga token bila token lama yang tercabut
    // dipakai lagi — termasuk sesi baru change-password. Setelah fix
    // (revoked_reason), token 'password_change' hanya 401 tanpa
    // membunuh keluarga.
    await register('d-r2e@taskflow.local');
    const a = await login('d-r2e@taskflow.local');
    const b = await login('d-r2e@taskflow.local');
    const res = await changePw(a.token, 'Password123', 'PasswordBaru123');
    expect(res.status).toBe(200);
    const newCookies = (res.headers['set-cookie'] as string[] | undefined) ?? [];
    // Client basi (perangkat B) mencoba refresh dengan token lamanya.
    expect((await doRefresh(refreshCookie(b.cookies))).status).toBe(401);
    // Sesi baru peminta harus tetap hidup setelah percobaan basi itu.
    const newToken = (res.body as { data: { accessToken: string } }).data.accessToken;
    expect((await me(newToken)).status).toBe(200);
    expect((await doRefresh(refreshCookie(newCookies))).status).toBe(200);
  });

  it('D-R2: access token tanpa klaim sv (format lama, pra-perubahan) -> 401', async () => {
    const u = await register('d-r2d@taskflow.local');
    const legacy = jwt.sign(
      { sub: u.id, email: 'd-r2d@taskflow.local', role: 'user' },
      testConfig.jwtSecret,
      { expiresIn: '15m' },
    );
    expect((await me(legacy)).status).toBe(401);
  });

  it('D-R3: ganti password tanpa login -> 401', async () => {
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: 'Password123', newPassword: 'PasswordBaru123' });
    expect(res.status).toBe(401);
  });
});
