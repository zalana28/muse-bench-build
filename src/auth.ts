import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

/**
 * Password: bcryptjs (pure JS, tanpa native build — pilihan sandbox).
 * Desain awal menargetkan argon2id; bcryptjs adalah fallback yang
 * diizinkan desain itu dan membuat `npm install` + clone-run anti-gagal.
 * Cost 10 = standar yang aman untuk workload ini.
 */
export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: string;
  /** Versi sesi (Challenge D): sama dengan users.token_version saat token diterbitkan. */
  sv: number;
}

export function signAccessToken(
  user: { id: string; email: string; role: string; token_version: number },
  secret: string,
  ttl: string,
): string {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, sv: user.token_version } satisfies AccessTokenPayload,
    secret,
    { expiresIn: ttl } as jwt.SignOptions,
  );
}

export function verifyAccessToken(token: string, secret: string): AccessTokenPayload {
  return jwt.verify(token, secret) as AccessTokenPayload;
}

/** Refresh token: nilai acak 256-bit; yang disimpan di DB hanya hash SHA-256-nya. */
export function newRefreshToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
