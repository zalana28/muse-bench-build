import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { z } from 'zod';
import { verifyAccessToken } from './auth';
import type { Config } from './config';
import type { Db } from './db';
import { AppError, unauthorized } from './errors';

export interface AuthUser {
  id: string;
  email: string;
  role: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      requestId?: string;
    }
  }
}

export function requestId(_req: Request, res: Response, next: NextFunction): void {
  const id = crypto.randomUUID();
  res.setHeader('X-Request-Id', id);
  next();
}

/** Membaca `Authorization: Bearer <jwt>`; gagal -> 401. */
/** Auth JWT + cek versi sesi (Challenge D).
 *
 * Selain memverifikasi signature & expiry, middleware memeriksa klaim
 * `sv` token terhadap `users.token_version` di DB. Token yang diterbitkan
 * SEBELUM password terakhir diubah langsung ditolak (401) — tanpa
 * menunggu masa 15 menitnya habis. Ini yang membuat R2 ("semua sesi
 * invalidate saat password berubah") benar-benar berlaku untuk access
 * token stateless, bukan hanya refresh token.
 *
 * Biaya: 1 lookup PK per request terautentikasi (better-sqlite3, <0,1 ms
 * pada skala sandbox) — dibayar demi invalidasi instan. Token lama yang
 * dibuat sebelum klaim `sv` ada (sv = undefined) juga ditolak: deploy
 * perubahan ini menginvalidasi semua sesi lama satu kali, by design.
 */
export function requireAuth(db: Db, config: Config) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/.exec(header);
    if (!match) return next(unauthorized('Header Authorization Bearer wajib ada'));
    let payload;
    try {
      payload = verifyAccessToken(match[1], config.jwtSecret);
    } catch {
      return next(unauthorized());
    }
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    db.get<{ token_version: number }>('SELECT token_version FROM users WHERE id = ?', [payload.sub])
      .then((row) => {
        if (!row) return next(unauthorized());
        if (payload.sv !== row.token_version) {
          return next(unauthorized('Sesi sudah tidak berlaku — silakan login kembali'));
        }
        return next();
      })
      .catch(() => next(unauthorized()));
  };
}

/** Role global `admin` (bukan role workspace). */
export function requireGlobalAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    return next(new AppError(403, 'FORBIDDEN', 'Endpoint ini hanya untuk admin'));
  }
  return next();
}

/** Validasi body dengan zod; gagal -> 422 dengan detail per field. */
export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return next(
        new AppError(422, 'VALIDATION_ERROR', 'Input tidak valid', parsed.error.issues),
      );
    }
    req.body = parsed.data;
    return next();
  };
}

/** Validasi query string dengan zod; gagal -> 422. */
export function validateQuery<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      return next(
        new AppError(422, 'VALIDATION_ERROR', 'Query tidak valid', parsed.error.issues),
      );
    }
    req.query = parsed.data as Record<string, string>;
    return next();
  };
}

/** Bungkus handler async agar error masuk ke errorHandler Express. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

/** Rate limit login/register: 5/menit/IP. Nonaktif saat NODE_ENV=test. */
export function authRateLimit(config: Config) {
  return rateLimit({
    windowMs: 60_000,
    max: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => config.nodeEnv === 'test',
    handler: (_req, res) => {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Terlalu banyak percobaan, coba lagi sebentar' },
      });
    },
  });
}

/** Error handler pusat: AppError -> envelope; selain itu -> 500 + log. */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details ?? undefined },
    });
    return;
  }
  // body-parser (express.json) melempar error dengan `type`, bukan AppError.
  // Tanpa pemetaan ini, JSON rusak / body > limit jadi 500 — padahal itu
  // kesalahan client (temuan B5-F2/F3: harus 400 / 413).
  if (err instanceof Error) {
    const type = (err as { type?: string }).type;
    if (type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Body JSON tidak valid' } });
      return;
    }
    if (type === 'entity.too.large') {
      res.status(413).json({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Body terlalu besar (maks 1 MB)' },
      });
      return;
    }
  }
  // eslint-disable-next-line no-console
  console.error(`[${req.requestId ?? '-'}] unexpected error:`, err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Terjadi kesalahan server' } });
}
