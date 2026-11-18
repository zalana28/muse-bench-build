import { Router, type Request, type Response } from 'express';
import type { Config } from './config';
import type { Db } from './db';
import { unauthorized } from './errors';
import { readIdempotencyKey } from './idempotency';
import {
  asyncHandler,
  authRateLimit,
  requireAuth,
  requireGlobalAdmin,
  validateBody,
  validateQuery,
} from './middleware';
import * as svc from './services';
import {
  commentSchema,
  labelSchema,
  loginSchema,
  memberSchema,
  moveSchema,
  paginationSchema,
  projectSchema,
  projectUpdateSchema,
  registerSchema,
  taskCreateSchema,
  taskListQuerySchema,
  taskUpdateSchema,
  workspaceSchema,
} from './validate';

const REFRESH_COOKIE = 'refreshToken';

function readRefreshCookie(req: Request): string | undefined {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === REFRESH_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function setRefreshCookie(res: Response, config: Config, token: string | null): void {
  if (token === null) {
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    return;
  }
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    path: '/api/v1/auth',
    maxAge: config.refreshTtlDays * 24 * 60 * 60 * 1000,
  });
}

function requireUser(req: Request): { id: string; email: string; role: string } {
  if (!req.user) throw new Error('requireAuth belum dipasang di route ini');
  return req.user;
}

export function createRouter(db: Db, config: Config): Router {
  const r = Router();
  const auth = requireAuth(config);
  const authLimiter = authRateLimit(config);

  /* ---------------- Auth ---------------- */
  r.post(
    '/auth/register',
    authLimiter,
    validateBody(registerSchema),
    asyncHandler(async (req, res) => {
      const user = await svc.registerUser(db, req.body as { email: string; password: string; name: string });
      res.status(201).json({ data: user });
    }),
  );
  r.post(
    '/auth/login',
    authLimiter,
    validateBody(loginSchema),
    asyncHandler(async (req, res) => {
      const session = await svc.loginUser(db, config, req.body as { email: string; password: string });
      setRefreshCookie(res, config, session.refreshToken);
      res.json({ data: { user: session.user, accessToken: session.accessToken } });
    }),
  );
  r.post(
    '/auth/refresh',
    asyncHandler(async (req, res) => {
      const token = readRefreshCookie(req);
      // Cookie hilang = sesi tidak ada -> 401, bukan 404 (temuan B5-F6).
      if (!token) throw unauthorized('Refresh token wajib ada');
      const session = await svc.refreshSession(db, config, token);
      setRefreshCookie(res, config, session.refreshToken);
      res.json({ data: { user: session.user, accessToken: session.accessToken } });
    }),
  );
  r.post(
    '/auth/logout',
    asyncHandler(async (req, res) => {
      const token = readRefreshCookie(req);
      if (token) await svc.logoutSession(db, token);
      setRefreshCookie(res, config, null);
      res.status(204).send();
    }),
  );

  /* ---------------- Users & admin ---------------- */
  r.get(
    '/users/me',
    auth,
    asyncHandler(async (req, res) => {
      res.json({ data: requireUser(req) });
    }),
  );
  r.get(
    '/admin/users',
    auth,
    requireGlobalAdmin,
    asyncHandler(async (_req, res) => {
      res.json({ data: await svc.listUsers(db) });
    }),
  );

  /* ---------------- Workspaces ---------------- */
  r.post(
    '/workspaces',
    auth,
    validateBody(workspaceSchema),
    asyncHandler(async (req, res) => {
      const ws = await svc.createWorkspace(db, requireUser(req).id, req.body as { name: string });
      res.status(201).json({ data: ws });
    }),
  );
  r.get(
    '/workspaces',
    auth,
    asyncHandler(async (req, res) => {
      res.json({ data: await svc.listWorkspaces(db, requireUser(req).id) });
    }),
  );
  r.get(
    '/workspaces/:workspaceId',
    auth,
    asyncHandler(async (req, res) => {
      res.json({
        data: await svc.getWorkspace(db, requireUser(req).id, req.params.workspaceId),
      });
    }),
  );
  r.get(
    '/workspaces/:workspaceId/members',
    auth,
    asyncHandler(async (req, res) => {
      res.json({
        data: await svc.listMembers(db, requireUser(req).id, req.params.workspaceId),
      });
    }),
  );
  r.post(
    '/workspaces/:workspaceId/members',
    auth,
    validateBody(memberSchema),
    asyncHandler(async (req, res) => {
      const member = await svc.addMember(
        db,
        requireUser(req).id,
        req.params.workspaceId,
        req.body as { userId: string; role: 'admin' | 'member' | 'viewer' },
      );
      res.status(201).json({ data: member });
    }),
  );
  r.delete(
    '/workspaces/:workspaceId/members/:userId',
    auth,
    asyncHandler(async (req, res) => {
      await svc.removeMember(db, requireUser(req).id, req.params.workspaceId, req.params.userId);
      res.status(204).send();
    }),
  );
  r.get(
    '/workspaces/:workspaceId/activity',
    auth,
    validateQuery(paginationSchema),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as { cursor?: string; limit: number };
      const result = await svc.listActivity(db, requireUser(req).id, req.params.workspaceId, q);
      res.json(result);
    }),
  );

  /* ---------------- Labels ---------------- */
  r.post(
    '/workspaces/:workspaceId/labels',
    auth,
    validateBody(labelSchema),
    asyncHandler(async (req, res) => {
      const label = await svc.createLabel(
        db,
        requireUser(req).id,
        req.params.workspaceId,
        req.body as { name: string; color?: string },
      );
      res.status(201).json({ data: label });
    }),
  );
  r.get(
    '/workspaces/:workspaceId/labels',
    auth,
    asyncHandler(async (req, res) => {
      res.json({ data: await svc.listLabels(db, requireUser(req).id, req.params.workspaceId) });
    }),
  );

  /* ---------------- Projects ---------------- */
  r.post(
    '/workspaces/:workspaceId/projects',
    auth,
    validateBody(projectSchema),
    asyncHandler(async (req, res) => {
      const project = await svc.createProject(
        db,
        requireUser(req).id,
        req.params.workspaceId,
        req.body as { name: string; description?: string },
      );
      res.status(201).json({ data: project });
    }),
  );
  r.get(
    '/workspaces/:workspaceId/projects',
    auth,
    asyncHandler(async (req, res) => {
      res.json({ data: await svc.listProjects(db, requireUser(req).id, req.params.workspaceId) });
    }),
  );
  r.get(
    '/projects/:projectId',
    auth,
    asyncHandler(async (req, res) => {
      res.json({ data: await svc.getProject(db, requireUser(req).id, req.params.projectId) });
    }),
  );
  r.patch(
    '/projects/:projectId',
    auth,
    validateBody(projectUpdateSchema),
    asyncHandler(async (req, res) => {
      res.json({
        data: await svc.updateProject(
          db,
          requireUser(req).id,
          req.params.projectId,
          req.body as { name?: string; description?: string },
        ),
      });
    }),
  );
  r.post(
    '/projects/:projectId/archive',
    auth,
    asyncHandler(async (req, res) => {
      res.json({
        data: await svc.archiveProject(db, requireUser(req).id, req.params.projectId),
      });
    }),
  );

  /* ---------------- Tasks ---------------- */
  r.post(
    '/projects/:projectId/tasks',
    auth,
    validateBody(taskCreateSchema),
    asyncHandler(async (req, res) => {
      const userId = requireUser(req).id;
      const key = readIdempotencyKey(req);
      if (!key) {
        const task = await svc.createTask(
          db,
          userId,
          req.params.projectId,
          req.body as Parameters<typeof svc.createTask>[3],
        );
        res.status(201).json({ data: task });
        return;
      }
      // Dengan Idempotency-Key: retry (paralel / sekuensial / restart)
      // mengembalikan respons tersimpan tanpa membuat duplikat (B5-F4/F5).
      const result = await svc.createTaskIdempotent(
        db,
        userId,
        req.params.projectId,
        req.body as Parameters<typeof svc.createTask>[3],
        key,
      );
      res.status(result.status).json(result.body);
    }),
  );
  r.get(
    '/projects/:projectId/tasks',
    auth,
    validateQuery(taskListQuerySchema),
    asyncHandler(async (req, res) => {
      const q = req.query as unknown as svc.TaskFilters;
      res.json(await svc.listTasks(db, requireUser(req).id, req.params.projectId, q));
    }),
  );
  r.get(
    '/tasks/:taskId',
    auth,
    asyncHandler(async (req, res) => {
      res.json({ data: await svc.getTask(db, requireUser(req).id, req.params.taskId) });
    }),
  );
  r.patch(
    '/tasks/:taskId',
    auth,
    validateBody(taskUpdateSchema),
    asyncHandler(async (req, res) => {
      res.json({
        data: await svc.updateTask(
          db,
          requireUser(req).id,
          req.params.taskId,
          req.body as Parameters<typeof svc.updateTask>[3],
        ),
      });
    }),
  );
  r.post(
    '/tasks/:taskId/move',
    auth,
    validateBody(moveSchema),
    asyncHandler(async (req, res) => {
      res.json({
        data: await svc.moveTask(
          db,
          requireUser(req).id,
          req.params.taskId,
          req.body as { status: string; position: number },
        ),
      });
    }),
  );
  r.delete(
    '/tasks/:taskId',
    auth,
    asyncHandler(async (req, res) => {
      await svc.deleteTask(db, requireUser(req).id, req.params.taskId);
      res.status(204).send();
    }),
  );

  /* ---------------- Comments ---------------- */
  r.post(
    '/tasks/:taskId/comments',
    auth,
    validateBody(commentSchema),
    asyncHandler(async (req, res) => {
      const comment = await svc.createComment(
        db,
        requireUser(req).id,
        req.params.taskId,
        req.body as { body: string },
      );
      res.status(201).json({ data: comment });
    }),
  );
  r.get(
    '/tasks/:taskId/comments',
    auth,
    asyncHandler(async (req, res) => {
      res.json({ data: await svc.listComments(db, requireUser(req).id, req.params.taskId) });
    }),
  );
  r.delete(
    '/comments/:commentId',
    auth,
    asyncHandler(async (req, res) => {
      await svc.deleteComment(db, requireUser(req).id, req.params.commentId);
      res.status(204).send();
    }),
  );

  return r;
}
