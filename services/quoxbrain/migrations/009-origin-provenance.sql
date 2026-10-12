-- 009-origin-provenance.sql — ONE-BRAIN coherence Phase A1 (QuoxPlan #493)
--
-- Additive only — nothing dropped, nothing in 000-baseline.sql /
-- 001-chunks.sql / 002-vault-roots.sql / 003-scope.sql / 004-language.sql /
-- 005-dream.sql / 006-usage-events.sql / 008-citation-events.sql touched.
--
-- Every note in Brain2 today is identified only by (vault_id, rel_path) —
-- there is no link back to the canonical row it was distilled from (a
-- memories.id row, an execution_wisdom.id row, ...), so recall has no way
-- to tell "this note IS that memory" from "this note is coincidentally
-- similar to that memory". origin_store/origin_id give every note an
-- optional pointer back to its canonical source: origin_store names WHICH
-- store ('memory', 'wisdom', 'files', ...), origin_id is that store's own
-- id (or, for file-corpus readers with no canonical DB id, a stable key
-- such as the rel_path itself). Both nullable — most existing notes (local
-- Obsidian-style vaults, non-canonical push docs) have no canonical origin
-- and stay NULL rather than guess one.
--
-- Recall-side dedup (the point of this migration) can then group results by
-- (origin_store, origin_id) instead of by rel_path/content alone.

ALTER TABLE notes ADD COLUMN origin_store TEXT;
ALTER TABLE notes ADD COLUMN origin_id TEXT;

CREATE INDEX IF NOT EXISTS idx_notes_origin ON notes(origin_store, origin_id);
