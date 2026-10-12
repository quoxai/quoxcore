-- QUOXHAT P4 — progressive disclosure state. A conversation binding now
-- carries which of the hat's bundles have been loaded (JSON array of bundle
-- keys). The initial manifest exposes the hat's explicit tools; bundle
-- tools join the manifest only after a governed hat_load_bundle call, at
-- the next model-request boundary (QUOXHAT_STUDY.md §8).
ALTER TABLE quoxhat_bindings ADD COLUMN loaded_bundles TEXT NOT NULL DEFAULT '[]';
