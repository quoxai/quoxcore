-- 004-language.sql — QUOXBRAIN P2.5b-1 LANGUAGE FACET (roadmap QUOXBRAIN #163)
--
-- Additive only — nothing dropped, nothing in 000-baseline.sql /
-- 001-chunks.sql / 002-vault-roots.sql / 003-scope.sql touched.
--
-- Adds a `language` column to notes and note_chunks (denormalized onto both,
-- mirroring the scope/owner_user_id pattern from 003-scope.sql) so the P2.5b-1
-- brain-level graph/sources/search facet filters can group and filter by
-- language. NULL means "unspecified" — nothing populates this column yet in
-- P2.5b-1; a future translation reader stamps it per document. Existing rows
-- default to NULL (not 'en') so "unspecified" stays honestly distinguishable
-- from "known English" once the reader lands.

ALTER TABLE notes ADD COLUMN language TEXT;
ALTER TABLE note_chunks ADD COLUMN language TEXT;

CREATE INDEX IF NOT EXISTS idx_notes_language ON notes(language);
CREATE INDEX IF NOT EXISTS idx_chunks_language ON note_chunks(language);
