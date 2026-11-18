# taskflow — muse-bench-build

Task-management API (Node 24 + TypeScript + Express), dibangun sesuai desain
arsitektur `taskflow` (Stage B2): modular monolith, SQLite di sandbox,
Postgres sebagai target Docker, JWT + refresh token berotasi, RBAC workspace.

## Cara menjalankan (sandbox / lokal)

```bash
npm install
cp .env.example .env        # isi JWT_SECRET dengan string acak yang panjang
                            # (WAJIB — server gagal start bila kosong, lihat B5-F7)
npm run seed                # data demo (idempotent)
npm run dev                 # http://localhost:3000
```

Akun demo dari seed (**demo saja — ganti di deployment nyata**):

| Akun | Password | Role |
|---|---|---|
| `admin@taskflow.local` | `Admin123!` | admin global (user pertama = admin) |
| `user@taskflow.local` | `User123!` | user biasa |

```bash
npm test        # vitest (36 test)
npm run build   # tsc -> dist/
npm start       # node dist/server.js
```

## Stage B5 — Break & Recover (temuan + fix, bukti di BREAK-REPORT.md)

Serangan terkendali terhadap aplikasi ini sendiri menemukan 9 temuan
(F1–F9), semuanya diperbaiki + di-regression-test (19 test baru di
`tests/break.test.ts`):

- **F1 — Whitespace-only lolos validasi** (`title: '   '` → 201, tersimpan
  sebagai `''`). Root cause: zod memeriksa panjang sebelum trim, service
  men-trim saat menyimpan. Fix: `.trim()` di semua skema string.
- **F2/F3 — Body JSON rusak / >1 MB → 500.** Fix: error body-parser
  dipetakan ke 400 (`BAD_REQUEST`) / 413 (`PAYLOAD_TOO_LARGE`).
- **F4/F5 — Duplikat task (paralel & sekuensial).** Fix: header
  `Idempotency-Key` pada `POST /projects/:id/tasks` — kunci + payload
  sama mengembalikan respons tersimpan tanpa membuat task baru; kunci
  sama + payload beda → 409. Klaim + pembuatan task dalam satu transaksi.
- **F6 — Refresh tanpa cookie → 404.** Fix: 401 `UNAUTHORIZED`.
- **F7 — JWT_SECRET default = token admin bisa ditempa.** Boot tanpa
  `JWT_SECRET` memakai secret publik dari repo; token palsu → 200
  `/admin/users`. Fix: tidak ada nilai default; server gagal start
  tanpa `JWT_SECRET` (kecuali `NODE_ENV=test`, secret acak per proses).
- **F8 — File DB di-rename/dihapus saat jalan: write tetap 201, `/health`
  tetap `ok` (data hilang diam-diam saat restart).** Fix: `/health`
  memeriksa file ada + query tabel nyata; semua request API gagal keras
  503 `DB_UNAVAILABLE` bila file hilang.
- **F9 — DB korup → crash dengan stack mentah.** Fix: integrity check
  saat boot + pesan yang menunjuk ke prosedur restore.

Pertahanan yang diuji dan TAHAN (bukan temuan): semua batas zod (422),
mass-assignment `role: admin` di-strip, token palsu/kedaluwarsa → 401,
user → `/admin/users` → 403, rotasi + reuse-detection refresh token,
rate limit login 5/menit → 429, cursor sampah → 400.

## Backup & Recovery (Challenge C)

```bash
npm run backup              # snapshot konsisten (API backup SQLite, aman saat server jalan)
                            # -> backups/taskflow-YYYYMMDD-HHmmss.db, lalu diverifikasi
npm run db:integrity        # PRAGMA integrity_check + hitung baris per tabel
npm run restore -- <file>   # verifikasi backup, simpan DB lama sebagai
                            # .pre-restore-<timestamp> (rollback), lalu swap
```

Prosedur lengkap + bukti demo (backup → DB hilang → restore → rollback)
ada di `BREAK-REPORT.md`. Aturan operasional: **matikan server sebelum
restore** (script menolak bila server masih jalan di `$PORT`); rollback =
jalankan restore lagi dengan file `.pre-restore-...`.

## Docker (target Postgres)

```bash
# .env wajib berisi JWT_SECRET
docker compose up --build
```

Compose menjalankan `app` + `db` (postgres:16-alpine). Skema kanonis
Postgres di-mount dari `src/db/migrations/001_init.postgres.sql` dan
dijalankan sekali saat volume `pgdata` masih kosong. Aplikasi memilih
driver lewat `DB_DRIVER` (`sqlite` | `postgres`) dan `DATABASE_URL`.

## API (base `/api/v1`)

Auth: `Authorization: Bearer <access JWT>` (15 menit) + refresh token di
cookie httpOnly (`/auth/refresh` merotasi; pemakaian ulang token lama
mencabut seluruh keluarga token user itu).

| Method & Path | Keterangan |
|---|---|
| POST `/auth/register` | User pertama yang register jadi admin global |
| POST `/auth/login` | Mengembalikan access token + set cookie refresh |
| POST `/auth/refresh` | Rotasi refresh token |
| POST `/auth/logout` | Cabut refresh token (204) |
| GET `/users/me` | Profil sendiri |
| GET `/admin/users` | **Admin global saja** (403 untuk user biasa) |
| POST/GET `/workspaces`, GET `/workspaces/:id` | Workspace milikmu |
| POST/DELETE `/workspaces/:id/members` | Tambah/hapus member (owner/admin) |
| GET `/workspaces/:id/members`, `/workspaces/:id/activity` | Member & feed aktivitas |
| POST/GET `/workspaces/:id/labels` | Label workspace |
| POST/GET `/workspaces/:id/projects` | Project dalam workspace |
| GET/PATCH `/projects/:id`, POST `/projects/:id/archive` | Detail, ubah, arsip |
| POST/GET `/projects/:id/tasks` | Buat task; list dengan `?status=&priority=&assigneeId=&labelId=&q=&cursor=&limit=` |
| GET/PATCH/DELETE `/tasks/:id`, POST `/tasks/:id/move` | Detail, ubah, pindah kolom, hapus |
| POST/GET `/tasks/:id/comments`, DELETE `/comments/:id` | Komentar (soft-delete) |
| GET `/health`, GET `/metrics` | Health + metrik Prometheus minimal |

Semua error memakai envelope `{ "error": { "code", "message", "details"? } }`
(400 / 401 / 403 / 404 / 409 / 422 / 429 / 500). Pagination memakai
cursor (`nextCursor`), `limit` default 20, maks 100.

## RBAC

- **Role global:** `admin` (semua akses admin, mis. `/admin/users`) vs `user`.
- **Role workspace:** `owner > admin > member > viewer`. Viewer hanya baca;
  member bisa membuat task/komentar; admin/owner mengelola member & project.
- **Ownership task:** ubah task hanya boleh reporter, assignee, atau
  admin/owner workspace; hapus hanya reporter atau admin/owner.
- Semua cek ownership ada di **service layer** (`src/services.ts`),
  bukan di route — route hanya memanggil service.

## Keputusan penting (alasan + trade-off)

- **SQLite via `better-sqlite3` di sandbox.** Alasan: nol setup, jalan di
  RAM ketat, tanpa native-build yang berisiko. Trade-off: satu instance
  saja; Postgres adalah database kanonis saat deploy (lihat bawah).
  Catatan: `node:sqlite` (builtin Node 24) sempat dicoba tapi resolver
  Vite/vitest versi ini tidak mengenalinya (`Failed to load url sqlite`),
  jadi diganti `better-sqlite3` (package biasa + prebuild).
- **Satu interface `Db`, dua driver.** Semua SQL memakai placeholder `?`;
  driver Postgres menerjemahkan ke `$1..$n`. Trade-off: SQL harus
  portabel (tidak ada `?` literal; `LOWER(x) LIKE` untuk search).
- **Password `bcryptjs`** (pure JS). Desain awal menargetkan argon2id;
  bcryptjs adalah fallback yang diizinkan desain itu dan membuat
  `npm install` + clone-run anti-gagal (tanpa native build).
- **Activity log ditulis dalam transaksi yang sama** dengan mutasi
  (transactional outbox sederhana). Tanpa queue/broker di v1.
- **Cache LRU in-process** (rencana desain) **belum diimplementasikan**
  di build ini — belum dibutuhkan pada skala sandbox; lihat "Belum ada".
- **File upload belum ada endpoint-nya** — tabel `attachments` ada,
  endpoint upload menyusul di iterasi berikut.

## Yang sudah diuji vs belum (jujur, per ABSOLUTES)

| Item | Status | Bukti |
|---|---|---|
| `tsc --noEmit` | ✅ Diuji | Bersih, 0 error |
| `vitest run` (36 test) | ✅ Diuji | 36/36 lolos (13 integrasi + 4 unit + 19 regression B5) |
| `npm run build` | ✅ Diuji | `dist/` ter-generate |
| Seed + boot server + `curl` login/health/metrics | ✅ Diuji | Login mengembalikan JWT, health `{"status":"ok","db":"ok"}` |
| RBAC (user biasa → 403 di `/admin/users`) | ✅ Diuji | Test `RBAC admin endpoint` |
| Break B5: 9 temuan → fix → retest live | ✅ Diuji | Bukti request/response di `BREAK-REPORT.md`; retest live 02:35 WIB |
| Backup → DB hilang → restore → rollback | ✅ Diuji | Demo lengkap di `BREAK-REPORT.md` (6 task utuh kembali, 36/36 test pass pasca-recovery) |
| Driver Postgres (`pg`) | ⚠️ **Belum diuji live** | Kode lengkap + direview; butuh Postgres sungguhan. Terjemah placeholder `?`→`$n` ada unit test-nya, tapi tidak ada server Postgres di sandbox ini |
| Dockerfile + docker-compose | ⚠️ **Belum dijalankan** | Ditulis lengkap; Docker tidak ada di sandbox ini (`docker: command not found`). Verifikasi dengan `docker compose up --build` di host yang punya Docker |
| Skema Postgres `001_init.postgres.sql` | ⚠️ **Belum dijalankan** | Ditulis dari desain; belum dieksekusi ke server Postgres |

## Belum ada di v1 (dicatat, bukan disembunyikan)

- Endpoint upload file (tabel `attachments` sudah ada).
- Reset password / verifikasi email.
- Hapus akun user & transfer ownership workspace.
- Cache LRU in-process (rencana desain).
- Recycle bin untuk task yang dihapus (saat ini hard-delete).

## Struktur

```
src/
  config.ts      # env (JWT_SECRET wajib — tanpa default sejak B5)
  db.ts          # interface Db + driver SQLite/Postgres + skema portabel
  db/migrations/001_init.postgres.sql   # skema kanonis Postgres (docker init)
  auth.ts        # bcrypt, JWT, refresh token
  idempotency.ts # header Idempotency-Key + hash request + klaim (B5)
  validate.ts    # skema zod semua endpoint (trim sejak B5)
  middleware.ts  # auth, RBAC global, validasi, error handler, rate limit
  services.ts    # logika bisnis + SEMUA cek ownership (auth, workspace,
                 # project, task, comment, activity, admin) + idempotency
  routes.ts      # route tipis -> service
  app.ts         # wiring Express (+ /health, /metrics, fail-closed DB)
  server.ts      # listen + graceful shutdown
  seed.ts        # data demo
scripts/
  backup.js      # backup online SQLite + verifikasi (B5/C)
  restore.js     # restore + rollback copy (B5/C)
  integrity.js   # integrity_check + hitung baris (B5/C)
tests/
  app.test.ts    # 13 test integrasi (supertest)
  db.test.ts     # 4 test unit (terjemah placeholder Postgres)
  break.test.ts  # 19 test regression temuan B5
BREAK-REPORT.md  # laporan lengkap Challenge B + C
```
