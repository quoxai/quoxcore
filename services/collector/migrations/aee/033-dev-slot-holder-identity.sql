-- quox#584: bind a slot hold to the AUTHENTICATED caller identity, not only
-- the caller-chosen session name. holder_session stays the display/address
-- name; holder_identity is server-derived (deriveCallerIdentity) and is what
-- the resident double-voice gate compares against, so a resident that
-- checked out with --session <name> can still speak as its own slot.
ALTER TABLE dev_slots ADD COLUMN holder_identity TEXT;
