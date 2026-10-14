-- CLI-SESSION-CLASS: which kind of client created the session ('web' default, 'cli' from quox login / the TUI).
-- enforceSessionPolicy gives 'cli' sessions the longer CLI defaults (see utils/sessionPolicy.js). Additive.
ALTER TABLE sessions ADD COLUMN client TEXT NOT NULL DEFAULT 'web';
