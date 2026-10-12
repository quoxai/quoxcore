-- CW-10.1 — Widget Simulation Scenarios
-- A scenario = a test the widget runs against its own assistant. Admin defines
-- the visitor turn(s) + expectations; the simulation runner invokes the chat
-- endpoint and scores the response against the rubric.
--
-- Seeded security scenarios (CW-10.3) ship with is_seed=1 so admins can tell
-- the library's baseline apart from their own additions. Seeded rows are
-- re-upserted at startup if their content hash changes.

CREATE TABLE IF NOT EXISTS widget_scenarios (
    id TEXT PRIMARY KEY,
    widget_id TEXT NOT NULL REFERENCES website_widgets(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,

    -- Identity
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general', -- 'faq' | 'security' | 'tool_use' | 'off_topic' | 'edge_case' | 'general'

    -- Test definition
    user_message TEXT NOT NULL,
    -- JSON: { must_include?: [string], must_not_include?: [string], expected_topic?: string,
    --         expected_tool?: string, expected_handoff?: boolean, max_response_length?: int }
    rubric_json TEXT NOT NULL DEFAULT '{}',

    -- Classification
    is_seed INTEGER NOT NULL DEFAULT 0,
    severity TEXT NOT NULL DEFAULT 'low', -- 'low' | 'medium' | 'high' (security only)

    -- Last result (for quick widget summary without re-running)
    last_run_at TEXT,
    last_score REAL,
    last_passed INTEGER,
    last_notes TEXT,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    UNIQUE(widget_id, name)
);

CREATE INDEX IF NOT EXISTS idx_scenarios_widget ON widget_scenarios(widget_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_category ON widget_scenarios(widget_id, category);
CREATE INDEX IF NOT EXISTS idx_scenarios_seed ON widget_scenarios(widget_id, is_seed);

-- CW-10.2 — Simulation run summary (aggregate over a batch of scenario runs)
-- One row per "Run all" / "Run category" / "Run single" invocation. Used to
-- drive the publish-gate check: latest run security_score must be >=70 before
-- a widget can publish to a production domain.

CREATE TABLE IF NOT EXISTS widget_simulation_runs (
    id TEXT PRIMARY KEY,
    widget_id TEXT NOT NULL REFERENCES website_widgets(id) ON DELETE CASCADE,
    org_id TEXT NOT NULL,

    triggered_by TEXT REFERENCES users(id),
    scope TEXT NOT NULL DEFAULT 'all', -- 'all' | 'category:<name>' | 'single:<scenario_id>'

    total INTEGER NOT NULL DEFAULT 0,
    passed INTEGER NOT NULL DEFAULT 0,
    warned INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    security_score REAL, -- 0-100, null when no security scenarios ran

    duration_ms INTEGER,
    error_message TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sim_runs_widget ON widget_simulation_runs(widget_id);
CREATE INDEX IF NOT EXISTS idx_sim_runs_finished ON widget_simulation_runs(widget_id, finished_at);
