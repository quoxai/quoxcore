-- 010-notesq.sql — NotesQ P0 substrate. Additive only.
--
-- NotesQ notes are markdown docs stored in quoxbrain push vaults tagged
-- vaults.app = 'notesq'. note_revisions is the append-only history (create/
-- update/delete/restore); content is kept per revision so a deleted note can
-- be restored. note_id is the deterministic notes.id (sha1 of vault_id+rel_path).

ALTER TABLE vaults ADD COLUMN app TEXT;

CREATE TABLE IF NOT EXISTS note_revisions (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  vault_id       TEXT NOT NULL,
  note_id        TEXT NOT NULL,
  rel_path       TEXT NOT NULL,
  rev            INTEGER NOT NULL,
  action         TEXT NOT NULL CHECK(action IN ('create','update','delete','restore')),
  content        TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  author_user_id TEXT,
  author_kind    TEXT NOT NULL CHECK(author_kind IN ('human','agent')),
  created_at     TEXT NOT NULL,
  UNIQUE(note_id, rev)
);

CREATE INDEX IF NOT EXISTS idx_note_revisions_org_note ON note_revisions(org_id, note_id);
