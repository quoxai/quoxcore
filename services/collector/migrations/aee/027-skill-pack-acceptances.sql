-- 027-skill-pack-acceptances.sql, collector AEE database (aee.db)
--
-- SKILLRIGHTS #478 Phase 11 — AFFIRMATIVE ACCEPTANCE RECORDING, the answer to
-- the external audit's finding 11 (2026-09-11): distribution recorded that the
-- declared terms ACCOMPANIED a skill, and nothing anywhere recorded that a
-- human ever assented to them. 023 stores what a host received; these two
-- tables store who agreed to what, before it was sent.
--
-- The binding is deliberately narrow and complete: the authenticated person
-- (actor_user_id), the org they represent (org_id), the exact artefact
-- (pack_id + pack_version + content_hash), the exact declared rights
-- (rights_sha256), the exact terms document (terms_sha256 AND its bytes), how
-- it was presented (presentation_version), when the server recorded it
-- (accepted_at), and a SINGLE-USE challenge tying this acceptance to one
-- specific offer (challenge, UNIQUE).
--
-- terms_bytes is NOT NULL on purpose. An acceptance row that points at a terms
-- document by hash alone evidences nothing once that document is edited, and
-- "we think it said this" is not evidence. The bytes presented at the moment
-- of assent are preserved here verbatim, per acceptance, duplication included.
--
-- APPEND-ONLY. Nothing in the codebase may UPDATE or DELETE a row in
-- skill_pack_acceptances: an acceptance that can be rewritten is a claim, not
-- a record. Superseding an acceptance means recording a new one (which a new
-- content_hash or rights_sha256 already forces).
--
-- What a row here proves, exactly, and the sentence every surface prints:
--   "This authenticated actor assented to these identified terms before this
--    download was authorized."
-- It does not prove comprehension, ownership, or universal enforceability.

CREATE TABLE IF NOT EXISTS skill_pack_acceptances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  pack_version TEXT,
  content_hash TEXT NOT NULL,
  rights_sha256 TEXT NOT NULL,
  terms_sha256 TEXT NOT NULL,
  terms_bytes TEXT NOT NULL,
  presentation_version TEXT NOT NULL,
  challenge TEXT NOT NULL UNIQUE,
  envelope_id TEXT,
  accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The enforcement read: "has THIS org accepted THIS pack at THIS exact content
-- and THESE exact declared rights?" A content or rights change invalidates
-- every prior acceptance by construction, because the lookup names both.
CREATE INDEX IF NOT EXISTS idx_skill_pack_acceptances_current
  ON skill_pack_acceptances(org_id, pack_id, content_hash, rights_sha256);

CREATE INDEX IF NOT EXISTS idx_skill_pack_acceptances_org_accepted
  ON skill_pack_acceptances(org_id, accepted_at);

-- The offer side. A challenge is minted when the terms are PRESENTED, carries
-- the hashes they were presented for, and is burned when it is accepted. The
-- acceptance must echo every one of those hashes back unchanged, so the actor
-- can only ever accept exactly what was put in front of them: a substituted
-- artefact, a re-issued terms document, or a relicensed pack all fail the
-- comparison rather than riding an old challenge.
CREATE TABLE IF NOT EXISTS acceptance_challenges (
  challenge TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  terms_sha256 TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  rights_sha256 TEXT NOT NULL,
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_acceptance_challenges_org_issued
  ON acceptance_challenges(org_id, issued_at);
