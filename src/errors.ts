/** Error aplikasi: selalu membawa status HTTP + kode mesin + pesan manusia. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Token tidak valid atau kedaluwarsa') =>
  new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Tidak punya akses ke resource ini') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Resource') =>
  new AppError(404, 'NOT_FOUND', `${what} tidak ditemukan`);
export const conflict = (message: string) =>
  new AppError(409, 'CONFLICT', message);
