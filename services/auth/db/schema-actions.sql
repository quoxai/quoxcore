-- Action Items schema (Scoped Storage Architecture)
-- Org-scoped action tracker with role-based visibility

CREATE TABLE IF NOT EXISTS action_items (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id),
    scope_id TEXT REFERENCES scopes(id),       -- NULL = org-wide
    created_by TEXT NOT NULL REFERENCES users(id),
    assigned_to TEXT REFERENCES users(id),
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
    category TEXT DEFAULT '',
    status TEXT DEFAULT 'todo' CHECK(status IN ('todo','doing','done')),
    due_date TEXT,                              -- ISO date string
    source TEXT DEFAULT 'user' CHECK(source IN ('user','ai','workflow')),
    source_agent TEXT,                          -- e.g. 'quox' if AI-created
    notes TEXT DEFAULT '',
    "order" INTEGER DEFAULT 0,
    tags TEXT DEFAULT '[]',                     -- JSON array
    -- ACTIONQ-FIX-SPEC 1a: explicit visibility, replacing implicit
    -- "null scope_id == org-wide". 'private' = creator + explicit assignee
    -- only (no admin override); 'org' = all active members; 'scope' = the
    -- pre-existing creator/assignee/admin/visible-scope behavior.
    visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','org','scope')),
    archived_at TEXT,
    completed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT                             -- Soft delete
);

CREATE INDEX IF NOT EXISTS idx_action_items_org ON action_items(org_id);
CREATE INDEX IF NOT EXISTS idx_action_items_scope ON action_items(org_id, scope_id);
CREATE INDEX IF NOT EXISTS idx_action_items_created_by ON action_items(org_id, created_by);
CREATE INDEX IF NOT EXISTS idx_action_items_status ON action_items(org_id, status);
CREATE INDEX IF NOT EXISTS idx_action_items_assigned ON action_items(org_id, assigned_to);

-- Per-(user, org) completion streak. Bumped server-side when an action item
-- transitions to status='done'. Persists across browser/device — replaces the
-- old localStorage-only streak.
CREATE TABLE IF NOT EXISTS user_action_streaks (
    user_id TEXT NOT NULL REFERENCES users(id),
    org_id TEXT NOT NULL REFERENCES orgs(id),
    current_streak INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    last_completion_date TEXT,                 -- ISO date YYYY-MM-DD (UTC)
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, org_id)
);
