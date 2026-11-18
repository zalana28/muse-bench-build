# taskflow — muse-bench-build

Task-management API (Node 24 + TypeScript + Express), dibangun sesuai desain
arsitektur `taskflow` (Stage B2): modular monolith, SQLite di sandbox,
Postgres sebagai target Docker, JWT + refresh token berotasi, RBAC workspace.

## Cara menjalankan (sandbox / lokal)

```bash
npm install
cp .env.example .env        # isi JWT_SECRET dengan string acak yang panjang
npm run seed                # data demo (idempotent)
npm run dev                 # http://localhost:3000
```

Akun demo dari seed (**demo saja — ganti di deployment nyata**):

| Akun | Password | Role |
|---|---|---|
| `admin@taskflow.local` | `Admin123!` | admin global (user pertama = admin) |
| `user@taskflow.local` | `User123!` | user biasa |

```bash
npm test        # vitest (17 test)
npm run build   # tsc -> dist/
npm start       # node dist/server.js
```

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
| `vitest run` (17 test) | ✅ Diuji | 17/17 lolos (13 integrasi + 4 unit) |
| `npm run build` | ✅ Diuji | `dist/` ter-generate |
| Seed + boot server + `curl` login/health/metrics | ✅ Diuji | Login mengembalikan JWT, health `{"status":"ok","db":"ok"}` |
| RBAC (user biasa → 403 di `/admin/users`) | ✅ Diuji | Test `RBAC admin endpoint` |
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
  config.ts      # env
  db.ts          # interface Db + driver SQLite/Postgres + skema portabel
  db/migrations/001_init.postgres.sql   # skema kanonis Postgres (docker init)
  auth.ts        # bcrypt, JWT, refresh token
  validate.ts    # skema zod semua endpoint
  middleware.ts  # auth, RBAC global, validasi, error handler, rate limit
  services.ts    # logika bisnis + SEMUA cek ownership (auth, workspace,
                 # project, task, comment, activity, admin)
  routes.ts      # route tipis -> service
  app.ts         # wiring Express (+ /health, /metrics)
  server.ts      # listen + graceful shutdown
  seed.ts        # data demo
tests/
  app.test.ts    # 13 test integrasi (supertest)
  db.test.ts     # 4 test unit (terjemah placeholder Postgres)
```
