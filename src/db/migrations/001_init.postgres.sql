-- Skema kanonis Postgres untuk taskflow (dipakai docker-entrypoint-initdb.d).
-- Versi ini memakai tipe native Postgres (UUID, ENUM, TIMESTAMPTZ, JSONB,
-- tsvector). Aplikasi memakai DDL portabel (src/db.ts) yang tetap jalan
-- di atas skema ini: parameter dikirim tanpa tipe dan Postgres melakukan
-- coerce (TEXT -> UUID/ENUM/TIMESTAMPTZ).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_id);

CREATE TYPE workspace_role AS ENUM ('owner', 'admin', 'member', 'viewer');
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role workspace_role NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON workspace_members(user_id);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by UUID NOT NULL REFERENCES users(id),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_workspace
  ON projects(workspace_id) WHERE archived_at IS NULL;

CREATE TYPE task_status AS ENUM ('todo', 'in_progress', 'review', 'done');
CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high', 'urgent');
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status task_status NOT NULL DEFAULT 'todo',
  priority task_priority NOT NULL DEFAULT 'medium',
  assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reporter_id UUID NOT NULL REFERENCES users(id),
  due_date TIMESTAMPTZ,
  position DOUBLE PRECISION NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(project_id, status, position);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee
  ON tasks(assignee_id, status) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_due
  ON tasks(due_date) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_search
  ON tasks USING gin(to_tsvector('english', title || ' ' || description));

CREATE TABLE IF NOT EXISTS labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6B7280',
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS task_labels (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id UUID NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_task_labels_label ON task_labels(label_id);

CREATE TABLE IF NOT EXISTS comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_comments_task
  ON comments(task_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  uploader_id UUID NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);

CREATE TABLE IF NOT EXISTS activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES users(id),
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  action TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_ws ON activity_log(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_user
  ON refresh_tokens(user_id) WHERE revoked_at IS NULL;

-- Idempotency keys (temuan B5-F4/F5; lihat juga SCHEMA_SQL di src/db.ts).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id UUID NOT NULL,
  endpoint TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, endpoint, idem_key)
);
