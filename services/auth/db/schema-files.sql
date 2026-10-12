-- FU-1 — file_objects
-- One row per user-uploaded or system-generated file. Physical blob lives
-- on disk at blob_path; virtual_path is the human-readable address scoped
-- to (org_id, namespace). Content-addressed de-dup: two uploads with the
-- same SHA-256 in the same org share one blob (reference-counted by row).

CREATE TABLE IF NOT EXISTS file_objects (
    id              TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    created_by      TEXT NOT NULL REFERENCES users(id),
    namespace       TEXT NOT NULL,
    virtual_path    TEXT NOT NULL,
    filename        TEXT NOT NULL,
    mime            TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL,
    sha256          TEXT NOT NULL,
    blob_path       TEXT NOT NULL,
    source_plugin   TEXT,
    source_ref      TEXT,
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'active', -- 'active' | 'deleted'
    deleted_at      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_file_objects_org_ns ON file_objects(org_id, namespace, status);
CREATE INDEX IF NOT EXISTS idx_file_objects_sha256 ON file_objects(sha256);
CREATE INDEX IF NOT EXISTS idx_file_objects_source ON file_objects(source_plugin, source_ref);
CREATE INDEX IF NOT EXISTS idx_file_objects_virtual_path ON file_objects(virtual_path);
CREATE INDEX IF NOT EXISTS idx_file_objects_org_status ON file_objects(org_id, status, created_at);
