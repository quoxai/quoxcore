-- OPGOV quox#573 phase 3: witnessed inventory drift snapshots.
-- Full inventory.v1 payload per row; lib/reach/inventoryDrift.js keeps only
-- the newest 30 rows per org (volt.db lesson: no unbounded evidence tables).
CREATE TABLE IF NOT EXISTS inventory_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  agents INTEGER NOT NULL DEFAULT 0,
  tool_grants INTEGER NOT NULL DEFAULT 0,
  credential_grants INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_org_id_desc
  ON inventory_snapshots (org_id, id DESC);
