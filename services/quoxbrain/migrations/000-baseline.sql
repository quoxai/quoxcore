CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'local', source_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', note_count INTEGER NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0, last_indexed_at TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(org_id, source_path));
CREATE INDEX IF NOT EXISTS idx_vaults_org ON vaults(org_id);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL, rel_path TEXT NOT NULL, title TEXT, frontmatter TEXT, body TEXT,
  word_count INTEGER NOT NULL DEFAULT 0, mtime TEXT, content_hash TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(vault_id, rel_path));
CREATE INDEX IF NOT EXISTS idx_notes_org ON notes(org_id);
CREATE INDEX IF NOT EXISTS idx_notes_vault ON notes(vault_id);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, body, content='notes', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid,title,body) VALUES (new.rowid,new.title,new.body); END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts,rowid,title,body) VALUES('delete',old.rowid,old.title,old.body); END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts,rowid,title,body) VALUES('delete',old.rowid,old.title,old.body);
  INSERT INTO notes_fts(rowid,title,body) VALUES (new.rowid,new.title,new.body); END;
CREATE TABLE IF NOT EXISTS note_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT, vault_id TEXT NOT NULL, org_id TEXT NOT NULL,
  source_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, target_note_id TEXT,
  target_raw TEXT NOT NULL, link_type TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, UNIQUE(source_note_id, target_raw, link_type));
CREATE INDEX IF NOT EXISTS idx_links_org ON note_links(org_id);
CREATE INDEX IF NOT EXISTS idx_links_vault ON note_links(vault_id);
CREATE INDEX IF NOT EXISTS idx_links_source ON note_links(source_note_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON note_links(target_note_id);
CREATE TABLE IF NOT EXISTS note_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT, vault_id TEXT NOT NULL, org_id TEXT NOT NULL,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, tag TEXT NOT NULL,
  source TEXT NOT NULL, UNIQUE(note_id, tag));
CREATE INDEX IF NOT EXISTS idx_tags_org ON note_tags(org_id);
CREATE INDEX IF NOT EXISTS idx_tags_vault ON note_tags(vault_id);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON note_tags(tag);
