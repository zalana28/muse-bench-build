// Integrity check untuk database SQLite taskflow.
// Usage: node scripts/integrity.js [path-ke-db]
//   path default: $SQLITE_PATH atau ./data/taskflow.db (relatif repo root)
// Exit 0 bila integrity_check = ok, 1 bila tidak / file tidak ada.
// Dipakai oleh backup.js, restore.js, dan prosedur recovery (BREAK-REPORT.md).
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const TABLES = [
  'users',
  'workspaces',
  'workspace_members',
  'projects',
  'tasks',
  'labels',
  'task_labels',
  'comments',
  'attachments',
  'activity_log',
  'refresh_tokens',
  'idempotency_keys',
];

function dbPath() {
  // HANYA dari env/default — JANGAN baca process.argv di sini: backup.js
  // dan restore.js memakai argv[2] untuk tujuan lain (dest / file backup),
  // dan dbPath() yang membaca argv pernah membuat backup.js mengira
  // dest-nya adalah source DB (bug nyata, ketangkap saat demo Challenge C).
  if (process.env.SQLITE_PATH) return path.resolve(process.env.SQLITE_PATH);
  return path.join(ROOT, 'data', 'taskflow.db');
}

function check(file) {
  if (!fs.existsSync(file)) return { ok: false, error: `file tidak ada: ${file}` };
  let db;
  try {
    db = new Database(file, { readonly: true });
    const row = db.prepare('PRAGMA integrity_check').get();
    const verdict = row ? Object.values(row)[0] : null;
    if (verdict !== 'ok') return { ok: false, error: `integrity_check = ${verdict}` };
    const counts = {};
    for (const t of TABLES) {
      try {
        counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      } catch {
        counts[t] = 'TABEL HILANG';
      }
    }
    return { ok: true, counts };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (db) db.close();
  }
}

if (require.main === module) {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : dbPath();
  const result = check(file);
  console.log(JSON.stringify({ file, ...result }, null, 2));
  process.exit(result.ok ? 0 : 1);
}

module.exports = { check, dbPath };
