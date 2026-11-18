import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { z } from 'zod';
import { verifyAccessToken } from './auth';
import type { Config } from './config';
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
export function requireAuth(config: Config) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/.exec(header);
    if (!match) return next(unauthorized('Header Authorization Bearer wajib ada'));
    try {
      const payload = verifyAccessToken(match[1], config.jwtSecret);
      req.user = { id: payload.sub, email: payload.email, role: payload.role };
      return next();
    } catch {
      return next(unauthorized());
    }
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
  // eslint-disable-next-line no-console
  console.error(`[${req.requestId ?? '-'}] unexpected error:`, err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Terjadi kesalahan server' } });
}
