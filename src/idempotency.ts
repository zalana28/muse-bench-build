import type { Request } from 'express';
import crypto from 'node:crypto';
import type { Db } from './db';
import { badRequest } from './errors';

/**
 * Idempotency untuk POST yang tidak aman diulang (temuan B5-F4/F5).
 *
 * Serangan yang dibuktikan: 2x POST task yang sama — paralel maupun
 * sekuensial — menghasilkan 2 task berbeda. Root cause: tidak ada
 * mekanisme yang mengikat "satu niat kirim" ke "satu efek".
 *
 * Cara pakai (client): kirim header `Idempotency-Key: <uuid>` pada
 * POST /projects/:projectId/tasks. Kirim ulang dengan kunci + payload
 * yang sama -> respons tersimpan dikembalikan tanpa membuat task baru.
 * Kunci sama + payload berbeda -> 409.
 *
 * Jaminan: klaim + pembuatan task + penyimpanan respons terjadi dalam
 * SATU transaksi database (atomic). Request paralel dengan kunci yang
 * sama diserialisasi oleh mutex in-process di services.ts; retry
 * sekuensial (termasuk setelah restart) dilayani dari tabel klaim.
 */

/** Endpoint yang dilindungi idempotency saat ini: pembuatan task. */
export const TASK_CREATE_ENDPOINT = 'POST /projects/:projectId/tasks';

export function hashRequest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Baca header Idempotency-Key: kosong -> null (dianggap tidak ada). */
export function readIdempotencyKey(req: Request): string | null {
  const raw = req.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return null;
  const key = value.trim();
  if (key.length === 0) return null;
  if (key.length > 200) throw badRequest('Idempotency-Key maksimal 200 karakter');
  return key;
}

export interface IdempotencyClaim {
  user_id: string;
  endpoint: string;
  idem_key: string;
  request_hash: string;
  response_status: number | null;
  response_body: string | null;
}

export async function findClaim(
  db: Db,
  userId: string,
  endpoint: string,
  key: string,
): Promise<IdempotencyClaim | undefined> {
  return db.get<IdempotencyClaim>(
    'SELECT * FROM idempotency_keys WHERE user_id = ? AND endpoint = ? AND idem_key = ?',
    [userId, endpoint, key],
  );
}
