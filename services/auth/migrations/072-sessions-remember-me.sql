-- AUTH-REMEMBER-ME: track whether a session was created with "remember me"
-- opted in, so enforceSessionPolicy can extend max_session_sec for this
-- session only (idle timeout is unaffected — it still applies per org policy).
ALTER TABLE sessions ADD COLUMN remember_me INTEGER NOT NULL DEFAULT 0;
