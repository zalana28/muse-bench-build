import { z } from 'zod';

export const uuid = z.string().uuid();

export const registerSchema = z.object({
  email: z.string().trim().email('Email tidak valid'),
  password: z.string().min(8, 'Password minimal 8 karakter').max(128),
  name: z.string().trim().min(1, 'Nama wajib diisi').max(100),
});

export const loginSchema = z.object({
  email: z.string().trim().email('Email tidak valid'),
  password: z.string().min(1, 'Password wajib diisi'),
});

export const workspaceSchema = z.object({
  name: z.string().trim().min(1, 'Nama workspace wajib diisi').max(100),
});

export const memberSchema = z.object({
  userId: uuid,
  role: z.enum(['admin', 'member', 'viewer']),
});

export const projectSchema = z.object({
  name: z.string().trim().min(1, 'Nama project wajib diisi').max(120),
  description: z.string().trim().max(2000).optional().default(''),
});

export const projectUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Tidak ada field yang diubah' });

export const taskStatus = z.enum(['todo', 'in_progress', 'review', 'done']);
export const taskPriority = z.enum(['low', 'medium', 'high', 'urgent']);

export const taskCreateSchema = z.object({
  title: z.string().trim().min(1, 'Judul wajib diisi').max(200),
  description: z.string().trim().max(5000).optional().default(''),
  assigneeId: uuid.nullable().optional(),
  priority: taskPriority.optional().default('medium'),
  dueDate: z.string().datetime({ offset: true }).nullable().optional(),
  labelIds: z.array(uuid).max(20).optional().default([]),
});

export const taskUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5000).optional(),
    status: taskStatus.optional(),
    priority: taskPriority.optional(),
    assigneeId: uuid.nullable().optional(),
    dueDate: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Tidak ada field yang diubah' });

export const moveSchema = z.object({
  status: taskStatus,
  position: z.number().finite(),
});

export const commentSchema = z.object({
  body: z.string().trim().min(1, 'Komentar tidak boleh kosong').max(5000),
});

export const labelSchema = z.object({
  name: z.string().trim().min(1).max(50),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Warna harus format hex #RRGGBB')
    .optional()
    .default('#6B7280'),
});

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export const taskListQuerySchema = paginationSchema.extend({
  status: taskStatus.optional(),
  priority: taskPriority.optional(),
  assigneeId: uuid.optional(),
  labelId: uuid.optional(),
  q: z.string().trim().max(100).optional(),
});
