# BREAK-REPORT — Stage B5: Break Your Own System + Recover

Target: **taskflow** (`muse-bench-build`, branch `b5/break-recover`) — aplikasi
yang sama dengan Stage B3, bukan `muse-bench-fixed`. Semua serangan dilakukan
terkendali terhadap instance lokal sendiri (SQLite di `/tmp`), dengan akun
demo seed. Tidak ada target eksternal yang disentuh.

Metode: boot server → serang via HTTP langsung (curl/fetch) → rekam
request/response mentah → perbaiki root cause → retest live + regression
test (`tests/break.test.ts`, 19 test baru; total suite 36/36).

---

## CHALLENGE B — BREAK

### Ringkasan temuan

| # | Temuan | Bukti (BEFORE) | Severity |
|---|---|---|---|
| F1 | Whitespace-only lolos validasi, tersimpan sebagai string kosong | `title: '   '` → 201, `title: ""` | Medium |
| F2 | Body JSON rusak → 500 | `POST /auth/login '{json rusak'` → 500 `INTERNAL_ERROR` | Medium |
| F3 | Body > 1 MB → 500 | body 2 MB → 500 `INTERNAL_ERROR` | Medium |
| F4 | Duplikat task paralel | 2× POST paralel → 2 task (delta=2) | Medium |
| F5 | Duplikat task sekuensial | 2× POST berurutan → 2 task | Medium |
| F6 | Refresh tanpa cookie → 404 | `POST /auth/refresh` (tanpa cookie) → 404 | Low |
| F7 | JWT_SECRET default = token admin bisa ditempa | Token palsu (secret default) → 200 `/admin/users` | **High** |
| F8 | File DB di-rename/dihapus saat jalan: write tetap 201, `/health` tetap `ok` | POST setelah delete → 201; restart → semua data hilang, server boot tanpa peringatan | **High** |
| F9 | DB korup → crash dengan stack mentah | `fatal startup error: SqliteError: file is not a database` tanpa petunjuk recovery | Low |

### F1 — Whitespace-only lolos validasi

**Bukti (BEFORE):**
```
POST /auth/register {"email":"ws@x.test","password":"Password123","name":"   "}
-> 201 {"data":{"email":"ws@x.test","name":"","role":"user",...}}
POST /projects/:id/tasks {"title":"   "}
-> 201 {"data":{"title":"","status":"todo",...}}
POST /tasks/:id/comments {"body":"   "}
-> 201 {"data":{"body":"",...}}
```
**Root cause:** skema zod memeriksa `min(1)` pada nilai yang BELUM di-trim,
sementara service men-trim saat menyimpan (`input.title.trim()` di
`services.ts`). `'   '` lolos `min(1)`, lalu tersimpan sebagai `''` — DB
punya task berjudul kosong dan user bernama kosong.
**Bonus terkait:** `POST /auth/register {"email":"  ADMIN@Taskflow.Local "}`
→ 422, karena `.email()` zod menolak spasi — padahal service sudah
men-trim + lowercase. Trim tidak pernah sampai ke service.
**Fix:** `.trim()` di semua skema string (`src/validate.ts`): email, name,
title, description, body komentar, nama label, `q` pencarian.
**Retest:** `title: '   '` → 422 `Judul wajib diisi`; `name: '   '` → 422;
`comment: '   '` → 422; `'  Case2@Example.Test '` → 201, tersimpan
`case2@example.test`; duplikat beda case → 409. Test: `break.test.ts`
"B5-F1" (5 test).

### F2 — Body JSON rusak → 500

**Bukti:** `POST /auth/login` dengan body `{json rusak` →
`500 {"error":{"code":"INTERNAL_ERROR","message":"Terjadi kesalahan server"}}`.
**Root cause:** `express.json()` melempar `SyntaxError` dengan
`type: 'entity.parse.failed'` — bukan `AppError` — sehingga `errorHandler`
menjatuhkannya ke 500. Ini kesalahan client, bukan server.
**Fix:** `src/middleware.ts` memetakan `entity.parse.failed` → 400
`BAD_REQUEST` ("Body JSON tidak valid").
**Retest:** → 400. Test: "B5-F2/F3".

### F3 — Body > 1 MB → 500

**Bukti:** body 2 MB → `500 INTERNAL_ERROR` (seharusnya 413).
**Root cause:** sama seperti F2 — `entity.too.large` dari body-parser tidak
dipetakan.
**Fix:** `entity.too.large` → 413 `PAYLOAD_TOO_LARGE` ("Body terlalu besar
(maks 1 MB)"). Test: "B5-F2/F3".

### F4/F5 — Duplikat task (paralel & sekuensial)

**Bukti (BEFORE):**
```
2x POST /projects/:id/tasks {"title":"Task duplikat paralel"} (Promise.all)
-> 201/201, ids a3b5cbc3-...,72e46ceb-... ; jumlah task 5 -> 7 (delta=2)
2x POST sekuensial {"title":"Task duplikat sekuensial"}
-> 201/201, ids berbeda ; total task 9
```
**Root cause:** tidak ada mekanisme yang mengikat "satu niat kirim" ke
"satu efek" — tidak ada idempotency key, tidak ada unique constraint yang
relevan (judul boleh sama).
**Fix:** header `Idempotency-Key` pada `POST /projects/:projectId/tasks`
(`src/idempotency.ts` + `src/services.ts` + `src/routes.ts`):
- kunci + payload sama → respons tersimpan dikembalikan, task TIDAK dibuat
  lagi (paralel, sekuensial, maupun setelah restart — klaim tersimpan di
  tabel `idempotency_keys`);
- kunci sama + payload berbeda → 409;
- klaim + pembuatan task + penyimpanan respons dalam SATU transaksi
  (atomic); request paralel dengan kunci sama diserialisasi mutex
  in-process; race yang lolos mutex ditangkap via PK constraint dan
  di-replay.
- Tanpa kunci, perilaku lama dipertahankan (2 kirim = 2 task, by design).
**Retest (live):** 2× paralel + kunci sama → id SAMA
(`fc7f9807-77ef-4d3f-91e0-45fe631cda05` dua kali); kirim ulang sekuensial →
id sama; kunci sama + judul beda → 409; jumlah task di DB = 1. Test:
"B5-F4/F5" (4 test, termasuk 5× paralel → 1 task).

### F6 — Refresh tanpa cookie → 404

**Bukti:** `POST /auth/refresh` tanpa cookie →
`404 {"error":{"code":"NOT_FOUND","message":"Refresh token tidak ditemukan"}}`.
**Root cause:** route melempar `notFound()` untuk kondisi "tidak ada sesi" —
itu kegagalan autentikasi, bukan resource hilang.
**Fix:** `throw unauthorized('Refresh token wajib ada')` → 401.
**Retest:** → 401 `UNAUTHORIZED`. Test: "B5-F6".

### F7 — JWT_SECRET default = token admin bisa ditempa (High)

**Bukti (BEFORE):** server di-boot TANPA `JWT_SECRET`
(`NODE_ENV=development`, port 18100) → jalan normal. Token ditempa dengan
secret yang tertulis di repo (`dev-only-secret-change-me`):
```js
jwt.sign({sub:'siapapun', email:'attacker@x.test', role:'admin'},
         'dev-only-secret-change-me', {expiresIn:'1h'})
```
`GET /admin/users` dengan token itu → **200 + daftar semua user**.
**Root cause:** `src/config.ts` memakai fallback `jwtSecret ||
'dev-only-secret-change-me'` di semua env kecuali production. Secret
"rahasia" itu ada di repo publik — siapa pun yang membaca kode bisa
menempa token admin di deployment yang lupa set `JWT_SECRET`.
**Fix:** tidak ada nilai default. `loadConfig()` throw bila `JWT_SECRET`
kosong, di semua env kecuali `test` (di test, secret acak 32 byte per
proses — tidak bisa ditebak, tidak tertulis di mana pun). `.env.example`
dan README menandai `JWT_SECRET` sebagai WAJIB.
**Retest:** boot tanpa `JWT_SECRET` → `fatal startup error: Error:
JWT_SECRET wajib diisi (set di .env / environment). Tidak ada nilai
default.` — server tidak jalan. Test: "B5-F7" (3 test).

### F8 — File DB hilang saat jalan: gagal diam-diam (High)

**Bukti (BEFORE)** — server jalan di :18099, DB di `/tmp/break/taskflow.db`:
```
P2 rename taskflow.db -> taskflow.db.renamed (saat jalan)
   POST /projects/:id/tasks {"title":"Task setelah rename"} -> 201
   GET /health -> {"status":"ok","db":"ok"}
   isi file renamed: 3 task (seed) — task baru TIDAK ada di file itu
   (tulisannya masuk ke -wal di path lama; file utama tidak pernah
   di-checkpoint sejak seed)
P6 rm taskflow.db taskflow.db-wal taskflow.db-shm (saat jalan)
   login admin -> 200 (masih bisa!)
   POST task -> 201 ; GET /health -> {"status":"ok","db":"ok"}
   (tulisan masuk ke inode yang sudah di-unlink — tidak tersimpan di mana pun)
P7 restart server
   GET /health -> {"status":"ok","db":"ok"}   (DB baru KOSONG, 4 KB)
   login admin -> 401 "Email atau password salah"  (SEMUA data hilang)
   server boot tanpa satu pun peringatan
```
**Root cause:** dua lapis.
1. `/health` hanya `SELECT 1` pada koneksi yang sudah terbuka — tidak
   menyentuh tabel, tidak memeriksa file. Koneksi SQLite yang terbuka
   tetap bisa baca/tulis walau file-nya sudah di-rename/unlink.
2. Saat restart, `better-sqlite3` membuat file baru yang kosong bila
   path tidak ada — aplikasi tidak membedakan "DB baru" dari "DB yang
   isinya hilang".
**Fix:**
- `/health` (`src/app.ts`): untuk SQLite berbasis file, periksa
  `fs.existsSync(sqlitePath)` DAN query tabel nyata
  (`SELECT COUNT(*) FROM users`) → 503 bila file hilang / query gagal.
- Fail-closed middleware (`src/app.ts`): semua request `/api/v1`
  mengembalikan 503 `DB_UNAVAILABLE` bila file DB tidak ada — write tidak
  lagi pura-pura berhasil. (Tidak berlaku untuk `:memory:` dan Postgres.)
- Catatan yang dipertahankan: boot dengan DB kosong yang sah tetap
  diizinkan (fresh install) — yang diperbaiki adalah kegagalan DIAM-DIAM
  saat file hilang di tengah jalan.
**Retest (live):** rename file → `/health` 503 `{"status":"error",
"db":"down"}`; POST task → 503 `DB_UNAVAILABLE` (bukan 201); file
dikembalikan → `/health` 200. Test: "B5-F8/F9" (3 test).

### F9 — DB korup → crash dengan stack mentah

**Bukti (BEFORE):** file DB ditimpa sampah, restart →
`fatal startup error: SqliteError: file is not a database` (stack trace,
exit 1). Fail-fast-nya benar, pesannya tidak bisa ditindaklanjuti.
**Root cause:** tidak ada integrity check eksplisit; error mentah
better-sqlite3 yang keluar.
**Fix:** `createDb` (`src/db.ts`) menjalankan `PRAGMA integrity_check`
saat boot; file korup/bukan-SQLite → throw dengan pesan jelas:
`Database di <path> korup atau bukan file SQLite. Pulihkan dari backup:
npm run restore -- <file-backup> (lihat BREAK-REPORT.md).`
**Retest:** boot dengan DB korup → pesan di atas (bukan stack mentah).
Test: "B5-F8/F9".

### Pertahanan yang diuji dan TAHAN (bukan temuan)

| Serangan | Hasil | Keterangan |
|---|---|---|
| Register email sampah / password kosong / 7 karakter | 422 semua | zod |
| Task title 10.001 karakter, deskripsi 5.001, komentar 5.001, label 51 karakter, `q` 101 karakter, `limit` 0 / 1000 | 422 semua | batas zod |
| Register + `role: 'admin'` di body | 201, role tetap `user` | zod men-strip field tak dikenal (no mass assignment) |
| dueDate sampah, priority tidak valid, assigneeId bukan uuid | 422 semua | zod |
| Cursor sampah (`?cursor=!!!bukan-cursor!!!`) | 400 `Cursor tidak valid` | sudah ditangani service |
| Token palsu (secret salah) → `/admin/users` | 401 | HMAC diverifikasi |
| Token kedaluwarsa (exp −10s) → `/admin/users` | 401 | exp diverifikasi |
| Tanpa token / `Bearer` kosong / token sampah | 401 semua | `requireAuth` |
| Role user → `/admin/users` | 403 | `requireGlobalAdmin` |
| Refresh token dipakai 2× (reuse) | 401 + keluarga dicabut | rotasi + reuse detection |
| Refresh token kedaluwarsa (disisipkan ke DB) | 401 `Refresh token kedaluwarsa` | dicek di `refreshSession` |
| Refresh setelah logout | 401 | token dicabut |
| Login gagal 6× dalam 1 menit (NODE_ENV=development) | 401 ×5 lalu 429 | rate limit 5/menit/IP; login benar pun 429 selama window |
| Token klaim `role: admin` tapi `sub` user biasa (ditandatangani secret asli) | 200 | **By design**: trust root-nya signature, bukan klaim `sub`; role di JWT adalah snapshot saat login (TTL 15 menit membatasi risiko role basi). Bukan temuan — penyerang tanpa secret tidak bisa membuat token ini (dibuktikan F7: secret salah → 401). |

---

## CHALLENGE C — RECOVER

Tooling baru: `scripts/backup.js`, `scripts/restore.js`,
`scripts/integrity.js` (+ npm script `backup` / `restore` /
`db:integrity`). Backup memakai API backup bawaan SQLite — snapshot
konsisten walau server jalan — lalu diverifikasi (integrity_check +
hitung baris) sebelum dilaporkan sukses. Restore memverifikasi backup,
menolak bila server masih jalan (cek `/health` di `$PORT`), menyimpan DB
lama sebagai `<db>.pre-restore-<timestamp>` (rollback), lalu swap file.

### Demo langkah demi langkah (live, 2026-11-19 ~02:35–02:36 WIB)

**C0 — Keadaan awal.** Seed + 3 task baru via API. Snapshot:
```
integrity: ok
users=2, workspaces=1, workspace_members=2, projects=1, tasks=6,
labels=0, comments=0, activity_log=8, refresh_tokens=1, idempotency_keys=0
```
(6 task = 3 seed: "Review desain board", "Tulis README",
"Audit endpoint login" + 3 baru: "Laporan Q4", "Audit keamanan",
"Rilis v2.1".)

**C1 — Backup saat server JALAN.**
```
$ SQLITE_PATH=/tmp/recover/taskflow.db node scripts/backup.js /tmp/recover/backup-1.db
{"source":"/tmp/recover/taskflow.db","dest":"/tmp/recover/backup-1.db",
 "size_bytes":167936,"ok":true,"counts":{...sama dengan snapshot...}}
Backup OK dan terverifikasi.
```

**C2 — Simulasi kehilangan.** Server dimatikan (port 18098 terverifikasi
bebas), lalu `rm taskflow.db taskflow.db-wal taskflow.db-shm`.

**C3 — Server start tanpa DB (apa yang terjadi).**
```
GET /health -> {"status":"ok","db":"ok"}   (DB baru kosong — perilaku yang
                                            didokumentasikan, bukan bug)
POST /auth/login admin -> 401 "Email atau password salah"  (data hilang)
```

**C4 — Restore.**
```
$ SQLITE_PATH=/tmp/recover/taskflow.db PORT=18098 \
    node scripts/restore.js /tmp/recover/backup-1.db
Backup valid: {users:2, ..., tasks:6, activity_log:8, ...}
DB lama disimpan untuk rollback: /tmp/recover/taskflow.db.pre-restore-20261119-3538
{"restored_to":"/tmp/recover/taskflow.db","ok":true,
 "counts":{users:2, workspaces:1, projects:1, tasks:6, activity_log:8, ...}}
Restore OK.
```

**C5 — Verifikasi pasca-recovery.**
```
integrity: ok (counts identik dengan snapshot C0)
login admin: OK
tasks setelah restore = 6:
  Rilis v2.1 | Audit keamanan | Laporan Q4 |
  Review desain board | Tulis README | Audit endpoint login
```

**C6 — Restore SALAH (skenario "salah pilih backup").** Task baru
"Data baru pasca-restore" dibuat (tasks=7), lalu restore dari
`backup-1.db` (snapshot lama, 6 task):
```
tasks setelah restore SALAH = 6  (task baru HILANG — bukti restore menimpa DB)
```
Restore ini menyimpan DB saat itu sebagai
`taskflow.db.pre-restore-20261119-3553`.

**C7 — ROLLBACK.** Restore dari salinan pre-restore tadi:
```
Backup valid: {tasks:7, activity_log:9, refresh_tokens:2, ...}
tasks setelah ROLLBACK = 7:
  Data baru pasca-restore | Rilis v2.1 | Audit keamanan | Laporan Q4 |
  Review desain board | Tulis README | Audit endpoint login
```

**C8 — Verifikasi akhir.** `integrity: ok` (counts lengkap) dan
`npm test` → **36/36 pass** setelah seluruh siklus recovery.

### Prosedur recovery (ringkas, untuk operator)

```bash
# 1. Backup rutin (boleh saat server jalan)
npm run backup
# 2. Bila DB hilang/korup: MATIKAN server, lalu restore
npm run restore -- backups/taskflow-<tanggal>.db
#    - script menolak bila server masih jalan
#    - script menolak backup yang tidak lolos integrity_check
#    - DB lama disimpan sebagai .pre-restore-<timestamp>
# 3. Nyalakan server, verifikasi
npm run db:integrity        # harus ok
curl localhost:3000/health  # harus {"status":"ok","db":"ok"}
# 4. Bila restore ternyata salah (backup keliru): rollback
npm run restore -- <path>.pre-restore-<timestamp>
```

### Dua insiden selama pengerjaan (dicatat jujur)

1. **Bug `dbPath()` di script backup/restore.** `integrity.js:dbPath()`
   membaca `process.argv[2]` sebagai path DB — padahal `backup.js`
   memakai argv[2] untuk DESTINASI dan `restore.js` untuk FILE BACKUP.
   Akibatnya percobaan backup pertama gagal (`database tidak ada:
   /tmp/recover/backup-1.db` — ia mengira dest adalah source). Fix:
   `dbPath()` hanya membaca `SQLITE_PATH`/default; argumen CLI
   ditangani eksplisit di tiap script. Demo Challenge C diulang dari
   nol setelah fix.
2. **Pid file basi.** Server demo pertama tetap hidup dengan pid berbeda
   dari yang tertulis di pid file (14218 vs 14295), sehingga `kill
   $(cat pid)` gagal dan server lama terus melayani dari inode yang
   sudah di-unlink — membuat satu putaran demo C2/C3 tidak valid
   (login "berhasil" setelah delete adalah perilaku inode, bukan boot
   baru; server baru malah crash `EADDRINUSE`). Pelajaran yang
   diterapkan: verifikasi liveness via port (`ss`), bukan pid file;
   demo diulang bersih. Ini juga alasan kenapa prosedur restore
   memeriksa server lewat `/health`, bukan pid file.

---

## Verifikasi (untuk zalana)

```bash
git clone https://github.com/zalana28/muse-bench-build.git
git checkout b5/break-recover
npm install
cp .env.example .env   # isi JWT_SECRET (wajib — tanpa itu server tidak start)
npm test               # 36/36 (17 lama + 19 regression B5)
npm run build && npm run seed && npm start
```

## File yang berubah (vs `main` @ `1bc80f93`)

- `src/validate.ts` — `.trim()` di semua skema string (F1)
- `src/middleware.ts` — pemetaan error body-parser 400/413 (F2/F3)
- `src/routes.ts` — refresh 401 (F6), wiring Idempotency-Key (F4/F5)
- `src/config.ts` — JWT_SECRET wajib, tanpa default (F7)
- `src/db.ts` — tabel `idempotency_keys`, integrity check saat boot (F4/F5, F9)
- `src/app.ts` — `/health` memeriksa file + tabel nyata; middleware
  fail-closed 503 `DB_UNAVAILABLE` (F8)
- `src/services.ts` — `createTask` + klaim idempotency dalam satu
  transaksi; `createTaskIdempotent` + mutex per kunci (F4/F5)
- `src/idempotency.ts` — baru: header, hash, lookup klaim
- `src/db/migrations/001_init.postgres.sql` — tabel `idempotency_keys`
- `scripts/backup.js`, `scripts/restore.js`, `scripts/integrity.js` — baru
- `tests/break.test.ts` — baru, 19 test
- `package.json` — script `backup` / `restore` / `db:integrity`
- `README.md`, `.env.example` — JWT_SECRET wajib, docs B5 + backup/recovery
