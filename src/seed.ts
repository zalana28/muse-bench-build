import { hashPassword, newId, nowIso } from './auth';
import { loadConfig } from './config';
import { createDb, initSchema } from './db';
import * as svc from './services';

/**
 * Seed data demo. Idempotent: tidak berbuat apa-apa kalau sudah ada user.
 * Akun demo (GANTI password-nya di deployment nyata):
 *   admin@taskflow.local / Admin123!  (role admin global)
 *   user@taskflow.local  / User123!   (role user)
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = await createDb(config);
  await initSchema(db);
  const existing = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
  if ((existing?.n ?? 0) > 0) {
    // eslint-disable-next-line no-console
    console.log('seed dilewati: sudah ada user');
    await db.close();
    return;
  }
  const now = nowIso();
  const adminId = newId();
  const userId = newId();
  await db.run(
    `INSERT INTO users (id, email, password_hash, role, name, created_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [adminId, 'admin@taskflow.local', hashPassword('Admin123!'), 'admin', 'Admin Demo', now, now],
  );
  await db.run(
    `INSERT INTO users (id, email, password_hash, role, name, created_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [userId, 'user@taskflow.local', hashPassword('User123!'), 'user', 'User Demo', now, now],
  );
  const ws = await svc.createWorkspace(db, adminId, { name: 'Demo Workspace' });
  await svc.addMember(db, adminId, ws.id, { userId, role: 'member' });
  const project = await svc.createProject(db, adminId, ws.id, {
    name: 'Contoh Project',
    description: 'Project demo dari seed',
  });
  await svc.createTask(db, adminId, project.id, {
    title: 'Audit endpoint login',
    description: 'Cek rate limit + validasi input',
    priority: 'high',
    assigneeId: userId,
  });
  await svc.createTask(db, adminId, project.id, {
    title: 'Tulis README',
    description: 'Dokumentasi cara menjalankan',
    priority: 'medium',
  });
  await svc.createTask(db, userId, project.id, {
    title: 'Review desain board',
    description: 'Sudah dicek, tinggal polish',
    priority: 'low',
  });
  // eslint-disable-next-line no-console
  console.log('seed selesai: admin@taskflow.local / Admin123!, user@taskflow.local / User123!');
  await db.close();
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('seed gagal:', err);
  process.exit(1);
});
