// Backup online database SQLite taskflow (Challenge C).
// Usage: node scripts/backup.js [dest]
//   dest default: backups/taskflow-YYYYMMDD-HHmmss.db (relatif repo root)
// Memakai API backup bawaan SQLite (better-sqlite3 .backup) — snapshot
// konsisten WAL walau server sedang jalan. Backup lalu diverifikasi
// (integrity_check + hitung baris) sebelum dilaporkan sukses.
// Exit 0 bila backup + verifikasi lolos, 1 bila tidak.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { check, dbPath } = require('./integrity');

const ROOT = path.resolve(__dirname, '..');

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  const source = dbPath();
  if (!fs.existsSync(source)) {
    console.error(`database tidak ada: ${source}`);
    process.exit(1);
  }
  const destArg = process.argv[2];
  const dest = destArg
    ? path.resolve(destArg)
    : path.join(ROOT, 'backups', `taskflow-${timestamp()}.db`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // Backup API SQLite: snapshot konsisten, aman saat server jalan.
  const db = new Database(source, { readonly: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }

  const result = check(dest);
  const size = fs.statSync(dest).size;
  console.log(JSON.stringify({ source, dest, size_bytes: size, ...result }, null, 2));
  if (!result.ok) {
    console.error('VERIFIKASI BACKUP GAGAL — file backup dihapus agar tidak dipakai.');
    fs.unlinkSync(dest);
    process.exit(1);
  }
  console.log('Backup OK dan terverifikasi.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
