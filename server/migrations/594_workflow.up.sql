-- Workflows: versioned definitions of the stages work moves through.
--
-- A workflow is a workspace-level definition (agent stages, human approval
-- gates, conditions, end) that a squad leader can be briefed with. It adds no
-- execution engine: nothing here moves an issue. See workflow_version for the
-- definition text itself.
--
--   workflow          the named, workspace-scoped head: key, name, status and
--                     the number of the newest version.
--   workflow_version  one immutable row per saved version. A row is only ever
--                     inserted; there is no UPDATE path, so history cannot be
--                     rewritten. Restoring an old version inserts a new row.
--   workflow_audit    who created, saved, restored or archived a workflow.
--
-- `key` is the definition's own `metadata.id` (lowercase kebab-case, at most 40
-- characters) and is unique per workspace. `revision` is an optimistic
-- concurrency counter for edits to the head, bumped on every change.
-- `definition` is the canonical YAML text and `content_hash` its SHA-256.
-- `layout` holds the designer's node positions and is not part of the
-- definition.
--
-- No foreign keys or cascades, per the database rules: related rows are
-- cleaned up in application code and by workspace_delete.sql.
CREATE TABLE workflow (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    latest_version INTEGER NOT NULL DEFAULT 0 CHECK (latest_version >= 0),
    revision BIGINT NOT NULL DEFAULT 1,
    created_by_type TEXT NOT NULL CHECK (created_by_type IN ('member', 'agent')),
    created_by_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workflow_version (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    workflow_id UUID NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    definition TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    layout JSONB NOT NULL DEFAULT '{}'::jsonb,
    note TEXT NOT NULL DEFAULT '',
    created_by_type TEXT NOT NULL CHECK (created_by_type IN ('member', 'agent')),
    created_by_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workflow_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    workflow_id UUID NOT NULL,
    -- The version the action produced or touched; NULL for head-only changes.
    version INTEGER,
    action TEXT NOT NULL CHECK (action IN ('create', 'save', 'restore', 'archive', 'unarchive', 'rename')),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('member', 'agent')),
    actor_id UUID NOT NULL,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes live in follow-up single-statement migrations: CREATE INDEX
-- CONCURRENTLY cannot share a migration with other statements.
