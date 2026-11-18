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

## Keputusan sesi (Challenge D)

Tiga requirement baru yang saling bertentangan — dan cara ketiganya
dipenuhi tanpa mengorbankan keamanan demi kenyamanan (ABSOLUTES):

| Requirement | Isi |
|---|---|
| R1 | Sesi login harus bertahan **30 hari** |
| R2 | **SEMUA** sesi WAJIB invalidate saat password berubah (kebijakan keamanan perusahaan) |
| R3 | User meminta **tidak logout otomatis** saat mereka ganti password sendiri |

### Analisis konflik

- **R2 vs R3 — tabrakan langsung, pada sesi yang sedang dipakai ganti
  password.** R2 menuntut sesi itu mati; R3 menuntut sesi itu tetap
  hidup. Keduanya tidak bisa benar secara harfiah pada kredensial yang
  sama.
- **R1 vs desain lama — dua lapis.** Nilai TTL refresh 7 hari (< 30),
  DAN rotasi menggeser expiry (sliding window): sesi yang aktif bisa
  hidup selamanya karena setiap refresh memperpanjang 30 hari lagi.
- **R2 vs desain lama — dua celah.** (a) Tidak ada endpoint ganti
  password sama sekali. (b) Access token stateless tidak bisa dicabut:
  mencabut refresh token saja menyisakan jendela 15 menit di mana access
  token curian tetap berlaku.
- **R1 vs R2 — tidak bertabrakan.** R1 batas masa hidup, R2 invalidasi
  berbasis kejadian; keduanya bisa berlaku bersamaan (sesi hidup
  maksimal 30 hari, KECUALI password berubah — maka mati seketika).

### Keputusan

- **D1 (R1) — 30 hari ABSOLUT, bukan sliding.** `REFRESH_TTL_DAYS` 7 →
  30; rotasi refresh **mewarisi `expires_at` token lama** (sesi mati
  tepat 30 hari setelah login, seaktif apa pun user). Sliding window
  ditolak eksplisit: token curian yang rajin di-refresh tidak boleh
  hidup selamanya. Access token tetap 15 menit (rotasi yang
  mempertahankannya, bukan TTL-nya).
- **D2 (R2) — invalidasi instan via `token_version`.** Kolom
  `users.token_version` naik setiap ganti password (satu transaksi
  dengan update hash + pencabutan semua refresh token). Access token
  membawa klaim `sv`; middleware memeriksa `sv` terhadap DB di setiap
  request terautentikasi — token pra-perubahan ditolak 401 **seketika**,
  tanpa jendela 15 menit. Biaya: 1 lookup PK per request (<0,1 ms di
  sandbox) — dibayar demi invalidasi instan. Token format lama (tanpa
  `sv`) juga ditolak: deploy perubahan ini menginvalidasi semua sesi
  lama satu kali, by design.
- **D3 (R2 + R3) — bunuh lalu terbitkan ulang.** `POST
  /auth/change-password` membunuh SEMUA sesi lama, lalu langsung
  menerbitkan sesi BARU untuk perangkat peminta dalam respons yang sama
  (access token + cookie refresh baru; respons melaporkan
  `revokedSessions`). Properti keamanan R2 terpenuhi — *tidak ada
  kredensial pra-perubahan yang selamat* — dan UX R3 terpenuhi —
  peminta tidak logout. Yang "bertahan" bukan sesi lama, melainkan sesi
  baru yang diterbitkan SETELAH perubahan password, terikat pada era
  password baru.
- **D4 — password lama wajib benar.** Token curian saja tidak cukup
  untuk mengganti password (kalau tidak, penyerang dengan access token
  curian bisa mengunci pemilik akun keluar). Ganti ke password yang sama
  ditolak 400 (tidak ada alasan membunuh semua sesi tanpa perubahan).
- **D5 — reuse-detection dibedakan berdasarkan alasan pencabutan.**
  Interaksi yang ditemukan saat testing: reuse-detection B3 membunuh
  seluruh keluarga token bila token tercabut dipakai lagi — setelah
  ganti password, client basi (perangkat lain) yang mencoba refresh
  akan ikut membunuh sesi BARU peminta (melanggar R3). Fix: kolom
  `refresh_tokens.revoked_reason` (`rotated` | `logout` |
  `password_change` | `reuse`); family-revoke hanya untuk token yang
  dicabut karena **rotasi** (tanda pencurian). Token
  `password_change`/`logout` yang dipakai lagi hanya 401. Terbukti
  dengan kontrol negatif: tanpa fix ini, 2 test sesi gagal; dengan fix,
  45/45 lolos.

### Yang TIDAK berubah

- Access token tetap stateless JWT 15 menit; refresh tetap rotasi +
  reuse-detection; logout tetap mencabut satu token.
- Reset password (lupa password, tanpa login) TIDAK ada di scope ini —
  bila ditambahkan nanti, ia harus mencabut semua sesi TANPA menerbitkan
  sesi baru (tidak ada sesi peminta yang dipertahankan).

### Verifikasi (fresh, 2026-11-19 ~02:51 WIB)

`npm test` → **45/45** (36 lama + 9 test sesi baru di
`tests/session.test.ts`, termasuk kontrol negatif D5). Smoke test live:
expiry refresh token 29,999996 hari; ganti password → 200
(`revokedSessions: 2`); token lama A/B → 401; refresh cookie lama →
401; token + cookie baru → 200; login password lama → 401, baru → 200.

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
mencabut seluruh keluarga token user itu). Refresh token berlaku **30
hari absolut** sejak login (lihat "Keputusan sesi" di bawah).

| Method & Path | Keterangan |
|---|---|
| POST `/auth/register` | User pertama yang register jadi admin global |
| POST `/auth/login` | Mengembalikan access token + set cookie refresh |
| POST `/auth/refresh` | Rotasi refresh token |
| POST `/auth/logout` | Cabut refresh token (204) |
| POST `/auth/change-password` | Ganti password + cabut SEMUA sesi + terbitkan sesi baru untuk peminta (lihat "Keputusan sesi") |
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
| `vitest run` (45 test) | ✅ Diuji | 45/45 lolos (13 integrasi + 4 unit + 19 regression B5 + 9 sesi D) |
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
  session.test.ts # 9 test keputusan sesi (Challenge D)
BREAK-REPORT.md  # laporan lengkap Challenge B + C
```
