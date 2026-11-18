// Restore database SQLite taskflow dari file backup (Challenge C).
// Usage: node scripts/restore.js <file-backup>
// Langkah:
//   1. Tolak bila server masih jalan (cek GET /health di $PORT, default 3000).
//   2. Verifikasi backup: integrity_check + tabel wajib ada.
//   3. Simpan DB saat ini sebagai <db>.pre-restore-<timestamp> (rollback).
//      File -wal/-shm ikut dipindah agar tidak ada WAL yatim.
//   4. Salin backup ke path database.
//   5. Verifikasi hasil restore.
// Rollback: jalankan lagi restore dengan file .pre-restore-... tadi.
// Exit 0 bila restore + verifikasi lolos, 1 bila tidak.
const fs = require('node:fs');
const path = require('node:path');
const { check, dbPath } = require('./integrity');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT ?? 3000);

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function serverRunning() {
  try {
    const res = await fetch(`http://localhost:${PORT}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.status < 600; // respons apa pun = ada server di port itu
  } catch {
    return false;
  }
}

function moveAside(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = timestamp();
  const target = `${file}.pre-restore-${stamp}`;
  fs.renameSync(file, target);
  return target;
}

async function main() {
  const backup = process.argv[2];
  if (!backup) {
    console.error('Usage: node scripts/restore.js <file-backup>');
    process.exit(1);
  }
  const backupPath = path.resolve(backup);
  if (!fs.existsSync(backupPath)) {
    console.error(`file backup tidak ada: ${backupPath}`);
    process.exit(1);
  }
  if (await serverRunning()) {
    console.error(
      `Server masih jalan di port ${PORT} — matikan dulu sebelum restore ` +
        `(file DB sedang dipakai; swap saat jalan = korupsi).`,
    );
    process.exit(1);
  }

  const result = check(backupPath);
  if (!result.ok) {
    console.error(`Backup TIDAK VALID, restore dibatalkan: ${result.error}`);
    process.exit(1);
  }
  console.log(`Backup valid: ${JSON.stringify(result.counts)}`);

  const target = dbPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const saved = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const moved = moveAside(target + suffix);
    if (moved) saved.push(moved);
  }
  if (saved.length > 0) {
    console.log(`DB lama disimpan untuk rollback: ${saved.join(', ')}`);
  }
  fs.copyFileSync(backupPath, target);

  const after = check(target);
  console.log(JSON.stringify({ restored_to: target, ...after }, null, 2));
  if (!after.ok) {
    console.error('VERIFIKASI SETELAH RESTORE GAGAL.');
    process.exit(1);
  }
  console.log('Restore OK. Nyalakan server lalu verifikasi (login + hitung data).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
