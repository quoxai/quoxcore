-- 030-citation-records-passage-hash.sql: pin citations to the retrieved revision.
-- note_hash (022) now carries the note content_hash AT RETRIEVAL TIME (sent by the
-- collector), not the hash at finalize time. passage_hash is the sha256 of the
-- cited passage text as retrieved. Listing compares note_hash with the note's
-- current content_hash and flags "note changed since cited". Additive.
ALTER TABLE citation_records ADD COLUMN passage_hash TEXT;
