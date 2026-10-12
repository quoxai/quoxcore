-- QUOXPERTICUS P3: the org the resident agent operates under on this
-- instance. The wake seam (tasks POST /api/internal/quoxperticus/wake)
-- resolves EVERYTHING server-side per DEC-5 (the supervisor on the box can
-- trigger a wake but chooses nothing), and an unbound instance refuses to
-- wake. Empty = unbound. Human-admin-writable only, same path as the mode,
-- sandbox and lease keys (PATCH /admin/config/:key behind
-- requireInstanceAdmin). Seeded '' so the admin PATCH can write it (it 404s
-- unknown keys).
INSERT OR IGNORE INTO instance_config (key, value, value_type, description) VALUES
    ('instance.quoxperticus.org_id', '', 'string', 'Org id the QUOXPERTICUS resident agent operates under on this instance. Empty = unbound; the wake seam refuses to create patrol objectives until an instance admin binds one. Human-admin-writable only.');
