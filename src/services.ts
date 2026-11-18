import crypto from 'node:crypto';
import {
  hashPassword,
  hashToken,
  newId,
  newRefreshToken,
  nowIso,
  signAccessToken,
  verifyPassword,
} from './auth';
import type { Config } from './config';
import type { Db } from './db';
import { badRequest, conflict, forbidden, notFound, unauthorized } from './errors';

/* ------------------------------------------------------------------ */
/* Types baris DB (snake_case) -> publik (camelCase)                   */
/* ------------------------------------------------------------------ */

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: string;
  name: string;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}
interface WorkspaceRow {
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
}
interface MemberRow {
  workspace_id: string;
  user_id: string;
  role: string;
  joined_at: string;
}
interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  created_by: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}
interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignee_id: string | null;
  reporter_id: string;
  due_date: string | null;
  position: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}
interface LabelRow {
  id: string;
  workspace_id: string;
  name: string;
  color: string;
}
interface CommentRow {
  id: string;
  task_id: string;
  author_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
interface ActivityRow {
  id: string;
  workspace_id: string;
  actor_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  payload: string;
  created_at: string;
}
interface RefreshRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

const toPublicUser = (r: UserRow): PublicUser => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastLoginAt: r.last_login_at,
});
const toWorkspace = (r: WorkspaceRow) => ({
  id: r.id,
  name: r.name,
  ownerId: r.owner_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toProject = (r: ProjectRow) => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  description: r.description,
  createdBy: r.created_by,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toTask = (r: TaskRow) => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  description: r.description,
  status: r.status,
  priority: r.priority,
  assigneeId: r.assignee_id,
  reporterId: r.reporter_id,
  dueDate: r.due_date,
  position: r.position,
  completedAt: r.completed_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toComment = (r: CommentRow) => ({
  id: r.id,
  taskId: r.task_id,
  authorId: r.author_id,
  body: r.body,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toActivity = (r: ActivityRow) => ({
  id: r.id,
  workspaceId: r.workspace_id,
  actorId: r.actor_id,
  entityType: r.entity_type,
  entityId: r.entity_id,
  action: r.action,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  createdAt: r.created_at,
});

/* ------------------------------------------------------------------ */
/* Helper                                                              */
/* ------------------------------------------------------------------ */

const ROLE_RANK: Record<string, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };

async function getUserOr404(db: Db, userId: string): Promise<UserRow> {
  const row = await db.get<UserRow>('SELECT * FROM users WHERE id = ?', [userId]);
  if (!row) throw notFound('User');
  return row;
}

async function getWorkspaceOr404(db: Db, workspaceId: string): Promise<WorkspaceRow> {
  const row = await db.get<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', [workspaceId]);
  if (!row) throw notFound('Workspace');
  return row;
}

async function getProjectOr404(db: Db, projectId: string): Promise<ProjectRow> {
  const row = await db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [projectId]);
  if (!row) throw notFound('Project');
  return row;
}

async function getTaskOr404(db: Db, taskId: string): Promise<TaskRow> {
  const row = await db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!row) throw notFound('Task');
  return row;
}

/**
 * Cek membership workspace. Urutan: workspace tidak ada -> 404;
 * bukan member -> 403; role di bawah minimum -> 403.
 * SEMUA cek ownership resource melewati fungsi ini (service layer).
 */
async function requireMembership(
  db: Db,
  workspaceId: string,
  userId: string,
  minRole: keyof typeof ROLE_RANK = 'viewer',
): Promise<MemberRow> {
  await getWorkspaceOr404(db, workspaceId);
  const m = await db.get<MemberRow>(
    'SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    [workspaceId, userId],
  );
  if (!m) throw forbidden('Bukan member workspace ini');
  if (ROLE_RANK[m.role] < ROLE_RANK[minRole]) {
    throw forbidden(`Role ${m.role} tidak cukup (butuh ${minRole})`);
  }
  return m;
}

async function logActivity(
  db: Db,
  input: {
    workspaceId: string;
    actorId: string;
    entityType: string;
    entityId: string;
    action: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await db.run(
    `INSERT INTO activity_log
       (id, workspace_id, actor_id, entity_type, entity_id, action, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      input.workspaceId,
      input.actorId,
      input.entityType,
      input.entityId,
      input.action,
      JSON.stringify(input.payload ?? {}),
      nowIso(),
    ],
  );
}

/** Cursor pagination: base64url dari {t: created_at, id}. */
export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt, id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as { t: string; id: string };
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('bad cursor');
    }
    return { createdAt: parsed.t, id: parsed.id };
  } catch {
    throw badRequest('Cursor tidak valid');
  }
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

export async function registerUser(
  db: Db,
  input: { email: string; password: string; name: string },
): Promise<PublicUser> {
  const email = input.email.trim().toLowerCase();
  const existing = await db.get<UserRow>('SELECT id FROM users WHERE LOWER(email) = ?', [email]);
  if (existing) throw conflict('Email sudah terdaftar');
  // Bootstrap: user pertama adalah admin global (tidak ada cara lain
  // membuat admin pertama tanpa seed).
  const count = await db.get<{ n: number | string }>('SELECT COUNT(*) AS n FROM users');
  const role = Number(count?.n ?? 0) === 0 ? 'admin' : 'user';
  const now = nowIso();
  const user: UserRow = {
    id: newId(),
    email,
    password_hash: hashPassword(input.password),
    role,
    name: input.name.trim(),
    created_at: now,
    updated_at: now,
    last_login_at: null,
  };
  await db.run(
    `INSERT INTO users (id, email, password_hash, role, name, created_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [user.id, user.email, user.password_hash, user.role, user.name, user.created_at, user.updated_at, null],
  );
  return toPublicUser(user);
}

export interface Session {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

async function issueSession(
  db: Db,
  config: Config,
  user: UserRow,
): Promise<Session> {
  const accessToken = signAccessToken(user, config.jwtSecret, config.jwtAccessTtl);
  const refreshToken = newRefreshToken();
  const expiresAt = new Date(Date.now() + config.refreshTtlDays * 24 * 60 * 60 * 1000).toISOString();
  await db.run(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
    [newId(), user.id, hashToken(refreshToken), expiresAt, nowIso()],
  );
  return { user: toPublicUser(user), accessToken, refreshToken };
}

export async function loginUser(
  db: Db,
  config: Config,
  input: { email: string; password: string },
): Promise<Session> {
  const email = input.email.trim().toLowerCase();
  const user = await db.get<UserRow>('SELECT * FROM users WHERE LOWER(email) = ?', [email]);
  if (!user || !verifyPassword(input.password, user.password_hash)) {
    throw unauthorized('Email atau password salah');
  }
  await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), user.id]);
  return issueSession(db, config, user);
}

export async function refreshSession(
  db: Db,
  config: Config,
  token: string,
): Promise<Session> {
  const tokenHash = hashToken(token);
  const row = await db.get<RefreshRow>(
    'SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked_at IS NULL',
    [tokenHash],
  );
  if (!row) {
    // Reuse detection: token ini pernah dicabut -> ada yang memakai ulang
    // token lama. Cabut SELURUH keluarga token user itu.
    const revoked = await db.get<RefreshRow>(
      'SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked_at IS NOT NULL',
      [tokenHash],
    );
    if (revoked) {
      await db.run(
        'UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
        [nowIso(), revoked.user_id],
      );
    }
    throw unauthorized('Refresh token tidak valid');
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw unauthorized('Refresh token kedaluwarsa');
  }
  const user = await getUserOr404(db, row.user_id);
  // Rotasi: cabut token lama, terbitkan pasangan baru — dalam 1 transaksi.
  return db.transaction(async (tx) => {
    await tx.run('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?', [nowIso(), row.id]);
    return issueSession(tx, config, user);
  });
}

export async function logoutSession(db: Db, token: string): Promise<void> {
  await db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', [
    nowIso(),
    hashToken(token),
  ]);
}

/* ------------------------------------------------------------------ */
/* Admin (role global)                                                 */
/* ------------------------------------------------------------------ */

export async function listUsers(db: Db): Promise<PublicUser[]> {
  const rows = await db.all<UserRow>('SELECT * FROM users ORDER BY created_at ASC');
  return rows.map(toPublicUser);
}

/* ------------------------------------------------------------------ */
/* Workspaces                                                          */
/* ------------------------------------------------------------------ */

export async function createWorkspace(
  db: Db,
  userId: string,
  input: { name: string },
): Promise<ReturnType<typeof toWorkspace>> {
  const now = nowIso();
  const ws: WorkspaceRow = {
    id: newId(),
    name: input.name.trim(),
    owner_id: userId,
    created_at: now,
    updated_at: now,
  };
  await db.transaction(async (tx) => {
    await tx.run(
      'INSERT INTO workspaces (id, name, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [ws.id, ws.name, ws.owner_id, ws.created_at, ws.updated_at],
    );
    await tx.run(
      'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      [ws.id, userId, 'owner', now],
    );
  });
  return toWorkspace(ws);
}

export async function listWorkspaces(db: Db, userId: string) {
  const rows = await db.all<WorkspaceRow>(
    `SELECT w.* FROM workspaces w
     JOIN workspace_members m ON m.workspace_id = w.id
     WHERE m.user_id = ? ORDER BY w.created_at DESC`,
    [userId],
  );
  return rows.map(toWorkspace);
}

export async function getWorkspace(db: Db, userId: string, workspaceId: string) {
  await requireMembership(db, workspaceId, userId, 'viewer');
  const ws = await getWorkspaceOr404(db, workspaceId);
  return toWorkspace(ws);
}

export async function listMembers(db: Db, userId: string, workspaceId: string) {
  await requireMembership(db, workspaceId, userId, 'viewer');
  const rows = await db.all<MemberRow & { name: string; email: string }>(
    `SELECT m.*, u.name, u.email FROM workspace_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ? ORDER BY m.joined_at ASC`,
    [workspaceId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    email: r.email,
    role: r.role,
    joinedAt: r.joined_at,
  }));
}

export async function addMember(
  db: Db,
  actorId: string,
  workspaceId: string,
  input: { userId: string; role: 'admin' | 'member' | 'viewer' },
) {
  await requireMembership(db, workspaceId, actorId, 'admin');
  await getUserOr404(db, input.userId);
  const existing = await db.get<MemberRow>(
    'SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    [workspaceId, input.userId],
  );
  if (existing) throw conflict('User sudah menjadi member workspace ini');
  await db.transaction(async (tx) => {
    await tx.run(
      'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      [workspaceId, input.userId, input.role, nowIso()],
    );
    await logActivity(tx, {
      workspaceId,
      actorId,
      entityType: 'member',
      entityId: input.userId,
      action: 'added',
      payload: { role: input.role },
    });
  });
  return { userId: input.userId, role: input.role };
}

export async function removeMember(
  db: Db,
  actorId: string,
  workspaceId: string,
  targetUserId: string,
) {
  const actor = await requireMembership(db, workspaceId, actorId, 'admin');
  if (targetUserId === actorId && actor.role === 'owner') {
    throw forbidden('Owner tidak bisa mengeluarkan dirinya sendiri');
  }
  const target = await db.get<MemberRow>(
    'SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    [workspaceId, targetUserId],
  );
  if (!target) throw notFound('Member');
  if (target.role === 'owner') throw forbidden('Owner tidak bisa dikeluarkan');
  await db.run('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [
    workspaceId,
    targetUserId,
  ]);
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

export async function createProject(
  db: Db,
  userId: string,
  workspaceId: string,
  input: { name: string; description?: string },
) {
  await requireMembership(db, workspaceId, userId, 'member');
  const now = nowIso();
  const project: ProjectRow = {
    id: newId(),
    workspace_id: workspaceId,
    name: input.name.trim(),
    description: input.description ?? '',
    created_by: userId,
    archived_at: null,
    created_at: now,
    updated_at: now,
  };
  await db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO projects (id, workspace_id, name, description, created_by, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      [project.id, project.workspace_id, project.name, project.description, project.created_by, now, now],
    );
    await logActivity(tx, {
      workspaceId,
      actorId: userId,
      entityType: 'project',
      entityId: project.id,
      action: 'created',
      payload: { name: project.name },
    });
  });
  return toProject(project);
}

export async function listProjects(db: Db, userId: string, workspaceId: string) {
  await requireMembership(db, workspaceId, userId, 'viewer');
  const rows = await db.all<ProjectRow>(
    'SELECT * FROM projects WHERE workspace_id = ? AND archived_at IS NULL ORDER BY created_at DESC',
    [workspaceId],
  );
  return rows.map(toProject);
}

export async function getProject(db: Db, userId: string, projectId: string) {
  const project = await getProjectOr404(db, projectId);
  await requireMembership(db, project.workspace_id, userId, 'viewer');
  return toProject(project);
}

export async function updateProject(
  db: Db,
  userId: string,
  projectId: string,
  input: { name?: string; description?: string },
) {
  const project = await getProjectOr404(db, projectId);
  await requireMembership(db, project.workspace_id, userId, 'member');
  const name = input.name?.trim() ?? project.name;
  const description = input.description ?? project.description;
  await db.run('UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?', [
    name,
    description,
    nowIso(),
    projectId,
  ]);
  return toProject({ ...project, name, description, updated_at: nowIso() });
}

export async function archiveProject(db: Db, userId: string, projectId: string) {
  const project = await getProjectOr404(db, projectId);
  await requireMembership(db, project.workspace_id, userId, 'admin');
  await db.run('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?', [
    nowIso(),
    nowIso(),
    projectId,
  ]);
  return toProject({ ...project, archived_at: nowIso() });
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

export async function createLabel(
  db: Db,
  userId: string,
  workspaceId: string,
  input: { name: string; color?: string },
) {
  await requireMembership(db, workspaceId, userId, 'member');
  const existing = await db.get<LabelRow>(
    'SELECT * FROM labels WHERE workspace_id = ? AND LOWER(name) = ?',
    [workspaceId, input.name.trim().toLowerCase()],
  );
  if (existing) throw conflict('Label dengan nama itu sudah ada di workspace ini');
  const label: LabelRow = {
    id: newId(),
    workspace_id: workspaceId,
    name: input.name.trim(),
    color: input.color ?? '#6B7280',
  };
  await db.run('INSERT INTO labels (id, workspace_id, name, color) VALUES (?, ?, ?, ?)', [
    label.id,
    label.workspace_id,
    label.name,
    label.color,
  ]);
  return { id: label.id, workspaceId: label.workspace_id, name: label.name, color: label.color };
}

export async function listLabels(db: Db, userId: string, workspaceId: string) {
  await requireMembership(db, workspaceId, userId, 'viewer');
  const rows = await db.all<LabelRow>('SELECT * FROM labels WHERE workspace_id = ? ORDER BY name ASC', [
    workspaceId,
  ]);
  return rows.map((r) => ({ id: r.id, workspaceId: r.workspace_id, name: r.name, color: r.color }));
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

export interface TaskFilters {
  status?: string;
  priority?: string;
  assigneeId?: string;
  labelId?: string;
  q?: string;
  cursor?: string;
  limit: number;
}

async function assertAssigneeIsMember(db: Db, workspaceId: string, assigneeId: string): Promise<void> {
  const m = await db.get<MemberRow>(
    'SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    [workspaceId, assigneeId],
  );
  if (!m) throw badRequest('Assignee harus member workspace ini');
}

async function assertLabelsBelongToWorkspace(
  db: Db,
  workspaceId: string,
  labelIds: string[],
): Promise<void> {
  for (const labelId of labelIds) {
    const label = await db.get<LabelRow>('SELECT * FROM labels WHERE id = ? AND workspace_id = ?', [
      labelId,
      workspaceId,
    ]);
    if (!label) throw badRequest(`Label ${labelId} bukan milik workspace ini`);
  }
}

export async function createTask(
  db: Db,
  userId: string,
  projectId: string,
  input: {
    title: string;
    description?: string;
    assigneeId?: string | null;
    priority?: string;
    dueDate?: string | null;
    labelIds?: string[];
  },
) {
  const project = await getProjectOr404(db, projectId);
  await requireMembership(db, project.workspace_id, userId, 'member');
  if (input.assigneeId) await assertAssigneeIsMember(db, project.workspace_id, input.assigneeId);
  const labelIds = input.labelIds ?? [];
  await assertLabelsBelongToWorkspace(db, project.workspace_id, labelIds);

  const now = nowIso();
  const status = 'todo';
  const posRow = await db.get<{ m: number | null }>(
    'SELECT MAX(position) AS m FROM tasks WHERE project_id = ? AND status = ?',
    [projectId, status],
  );
  const position = (posRow?.m ?? 0) + 1024;
  const task: TaskRow = {
    id: newId(),
    project_id: projectId,
    title: input.title.trim(),
    description: input.description ?? '',
    status,
    priority: input.priority ?? 'medium',
    assignee_id: input.assigneeId ?? null,
    reporter_id: userId,
    due_date: input.dueDate ?? null,
    position,
    completed_at: null,
    created_at: now,
    updated_at: now,
  };
  await db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO tasks
         (id, project_id, title, description, status, priority, assignee_id, reporter_id,
          due_date, position, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        task.id, task.project_id, task.title, task.description, task.status, task.priority,
        task.assignee_id, task.reporter_id, task.due_date, task.position, task.created_at, task.updated_at,
      ],
    );
    for (const labelId of labelIds) {
      await tx.run('INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)', [task.id, labelId]);
    }
    await logActivity(tx, {
      workspaceId: project.workspace_id,
      actorId: userId,
      entityType: 'task',
      entityId: task.id,
      action: 'created',
      payload: { title: task.title },
    });
  });
  return toTask(task);
}

export async function listTasks(db: Db, userId: string, projectId: string, filters: TaskFilters) {
  const project = await getProjectOr404(db, projectId);
  await requireMembership(db, project.workspace_id, userId, 'viewer');

  const where: string[] = ['t.project_id = ?'];
  const params: unknown[] = [projectId];
  if (filters.status) {
    where.push('t.status = ?');
    params.push(filters.status);
  }
  if (filters.priority) {
    where.push('t.priority = ?');
    params.push(filters.priority);
  }
  if (filters.assigneeId) {
    where.push('t.assignee_id = ?');
    params.push(filters.assigneeId);
  }
  if (filters.labelId) {
    where.push('EXISTS (SELECT 1 FROM task_labels tl WHERE tl.task_id = t.id AND tl.label_id = ?)');
    params.push(filters.labelId);
  }
  if (filters.q) {
    const like = `%${filters.q.toLowerCase()}%`;
    where.push('(LOWER(t.title) LIKE ? OR LOWER(t.description) LIKE ?)');
    params.push(like, like);
  }
  if (filters.cursor) {
    const { createdAt, id } = decodeCursor(filters.cursor);
    where.push('(t.created_at, t.id) < (?, ?)');
    params.push(createdAt, id);
  }
  const limit = filters.limit;
  const rows = await db.all<TaskRow>(
    `SELECT t.* FROM tasks t WHERE ${where.join(' AND ')}
     ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
    [...params, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasMore && page.length > 0
      ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id)
      : null;
  return { data: page.map(toTask), nextCursor };
}

export async function getTask(db: Db, userId: string, taskId: string) {
  const task = await getTaskOr404(db, taskId);
  const project = await getProjectOr404(db, task.project_id);
  await requireMembership(db, project.workspace_id, userId, 'viewer');
  const labels = await db.all<LabelRow>(
    `SELECT l.* FROM labels l
     JOIN task_labels tl ON tl.label_id = l.id WHERE tl.task_id = ? ORDER BY l.name ASC`,
    [taskId],
  );
  const count = await db.get<{ n: number | string }>(
    'SELECT COUNT(*) AS n FROM comments WHERE task_id = ? AND deleted_at IS NULL',
    [taskId],
  );
  return {
    ...toTask(task),
    labels: labels.map((r) => ({ id: r.id, name: r.name, color: r.color })),
    commentsCount: Number(count?.n ?? 0),
  };
}

/** Siapa boleh mengubah task: reporter, assignee, atau admin/owner workspace. */
async function canEditTask(
  db: Db,
  workspaceId: string,
  userId: string,
  task: TaskRow,
): Promise<void> {
  const membership = await requireMembership(db, workspaceId, userId, 'member');
  const isReporter = task.reporter_id === userId;
  const isAssignee = task.assignee_id === userId;
  const isWorkspaceAdmin = ROLE_RANK[membership.role] >= ROLE_RANK.admin;
  if (!isReporter && !isAssignee && !isWorkspaceAdmin) {
    throw forbidden('Hanya reporter, assignee, atau admin workspace yang bisa mengubah task ini');
  }
}

export async function updateTask(
  db: Db,
  userId: string,
  taskId: string,
  input: {
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    assigneeId?: string | null;
    dueDate?: string | null;
  },
) {
  const task = await getTaskOr404(db, taskId);
  const project = await getProjectOr404(db, task.project_id);
  await canEditTask(db, project.workspace_id, userId, task);
  if (input.assigneeId) await assertAssigneeIsMember(db, project.workspace_id, input.assigneeId);

  const sets: string[] = ['updated_at = ?'];
  const now = nowIso();
  const params: unknown[] = [now];
  const next: TaskRow = { ...task };
  if (input.title !== undefined) {
    sets.push('title = ?');
    params.push(input.title.trim());
    next.title = input.title.trim();
  }
  if (input.description !== undefined) {
    sets.push('description = ?');
    params.push(input.description);
    next.description = input.description;
  }
  if (input.status !== undefined) {
    sets.push('status = ?');
    params.push(input.status);
    next.status = input.status;
    if (input.status === 'done' && task.status !== 'done') {
      sets.push('completed_at = ?');
      params.push(nowIso());
      next.completed_at = nowIso();
    } else if (input.status !== 'done' && task.status === 'done') {
      sets.push('completed_at = NULL');
      next.completed_at = null;
    }
  }
  if (input.priority !== undefined) {
    sets.push('priority = ?');
    params.push(input.priority);
    next.priority = input.priority;
  }
  if (input.assigneeId !== undefined) {
    sets.push('assignee_id = ?');
    params.push(input.assigneeId);
    next.assignee_id = input.assigneeId;
  }
  if (input.dueDate !== undefined) {
    sets.push('due_date = ?');
    params.push(input.dueDate);
    next.due_date = input.dueDate;
  }
  next.updated_at = now;
  await db.transaction(async (tx) => {
    await tx.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, [...params, taskId]);
    await logActivity(tx, {
      workspaceId: project.workspace_id,
      actorId: userId,
      entityType: 'task',
      entityId: taskId,
      action: 'updated',
      payload: { changed: Object.keys(input) },
    });
  });
  return toTask(next);
}

export async function moveTask(
  db: Db,
  userId: string,
  taskId: string,
  input: { status: string; position: number },
) {
  const task = await getTaskOr404(db, taskId);
  const project = await getProjectOr404(db, task.project_id);
  await canEditTask(db, project.workspace_id, userId, task);
  const now = nowIso();
  const completedAt = input.status === 'done' ? task.completed_at ?? now : null;
  await db.transaction(async (tx) => {
    await tx.run(
      'UPDATE tasks SET status = ?, position = ?, completed_at = ?, updated_at = ? WHERE id = ?',
      [input.status, input.position, completedAt, now, taskId],
    );
    await logActivity(tx, {
      workspaceId: project.workspace_id,
      actorId: userId,
      entityType: 'task',
      entityId: taskId,
      action: 'moved',
      payload: { status: input.status, position: input.position },
    });
  });
  return toTask({ ...task, status: input.status, position: input.position, completed_at: completedAt, updated_at: now });
}

export async function deleteTask(db: Db, userId: string, taskId: string): Promise<void> {
  const task = await getTaskOr404(db, taskId);
  const project = await getProjectOr404(db, task.project_id);
  const membership = await requireMembership(db, project.workspace_id, userId, 'member');
  const isReporter = task.reporter_id === userId;
  const isWorkspaceAdmin = ROLE_RANK[membership.role] >= ROLE_RANK.admin;
  if (!isReporter && !isWorkspaceAdmin) {
    throw forbidden('Hanya reporter atau admin workspace yang bisa menghapus task ini');
  }
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM tasks WHERE id = ?', [taskId]);
    await logActivity(tx, {
      workspaceId: project.workspace_id,
      actorId: userId,
      entityType: 'task',
      entityId: taskId,
      action: 'deleted',
      payload: { title: task.title },
    });
  });
}

/* ------------------------------------------------------------------ */
/* Comments                                                            */
/* ------------------------------------------------------------------ */

export async function createComment(
  db: Db,
  userId: string,
  taskId: string,
  input: { body: string },
) {
  const task = await getTaskOr404(db, taskId);
  const project = await getProjectOr404(db, task.project_id);
  await requireMembership(db, project.workspace_id, userId, 'member');
  const now = nowIso();
  const comment: CommentRow = {
    id: newId(),
    task_id: taskId,
    author_id: userId,
    body: input.body.trim(),
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  await db.transaction(async (tx) => {
    await tx.run(
      'INSERT INTO comments (id, task_id, author_id, body, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      [comment.id, comment.task_id, comment.author_id, comment.body, comment.created_at, comment.updated_at],
    );
    await logActivity(tx, {
      workspaceId: project.workspace_id,
      actorId: userId,
      entityType: 'comment',
      entityId: comment.id,
      action: 'created',
      payload: { taskId },
    });
  });
  return toComment(comment);
}

export async function listComments(db: Db, userId: string, taskId: string) {
  const task = await getTaskOr404(db, taskId);
  const project = await getProjectOr404(db, task.project_id);
  await requireMembership(db, project.workspace_id, userId, 'viewer');
  const rows = await db.all<CommentRow>(
    'SELECT * FROM comments WHERE task_id = ? AND deleted_at IS NULL ORDER BY created_at ASC',
    [taskId],
  );
  return rows.map(toComment);
}

export async function deleteComment(db: Db, userId: string, commentId: string): Promise<void> {
  const comment = await db.get<CommentRow>('SELECT * FROM comments WHERE id = ?', [commentId]);
  if (!comment || comment.deleted_at) throw notFound('Comment');
  const task = await getTaskOr404(db, comment.task_id);
  const project = await getProjectOr404(db, task.project_id);
  const membership = await requireMembership(db, project.workspace_id, userId, 'member');
  const isAuthor = comment.author_id === userId;
  const isWorkspaceAdmin = ROLE_RANK[membership.role] >= ROLE_RANK.admin;
  if (!isAuthor && !isWorkspaceAdmin) {
    throw forbidden('Hanya penulis atau admin workspace yang bisa menghapus komentar ini');
  }
  await db.run('UPDATE comments SET deleted_at = ? WHERE id = ?', [nowIso(), commentId]);
}

/* ------------------------------------------------------------------ */
/* Activity feed                                                       */
/* ------------------------------------------------------------------ */

export async function listActivity(
  db: Db,
  userId: string,
  workspaceId: string,
  input: { cursor?: string; limit: number },
) {
  await requireMembership(db, workspaceId, userId, 'viewer');
  const where = ['workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (input.cursor) {
    const { createdAt, id } = decodeCursor(input.cursor);
    where.push('(created_at, id) < (?, ?)');
    params.push(createdAt, id);
  }
  const rows = await db.all<ActivityRow>(
    `SELECT * FROM activity_log WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...params, input.limit + 1],
  );
  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const nextCursor =
    hasMore && page.length > 0
      ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id)
      : null;
  return { data: page.map(toActivity), nextCursor };
}
