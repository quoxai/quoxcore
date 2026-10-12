# auth live-HTTP smoke tests

These tests exercise the **real** auth server over HTTP (`fetch` against a base URL
with real cookies / CSRF / session) and seed their user directly into the DB, then
mint a JWT locally. They are wired into the gate via `smoke-setup.mjs`, an
`--import` preload that runs once per test-file process and:

1. sets shared secrets (`JWT_SECRET`, `MASTER_ENCRYPTION_KEY`, `INTERNAL_SERVICE_KEY`)
   + an isolated temp `AUTH_DB_PATH` / `UPLOAD_DIR`,
2. picks a free port and points `TEST_BASE_URL` at it,
3. spawns `server.js` as an isolated subprocess with those env vars,
4. waits for `/health`, and
5. tears the server + temp dir down on exit (the child is `unref()`'d so
   `node --test` still exits cleanly).

So each file gets its own hermetic server + DB — **no dependency on any externally
running auth service** (the old blocker: locally-minted JWTs 401'd against the
deployed container's real secret). Run with `npm run test:smoke`; also included in
the default `npm test` chain.

Files: `api-integration.test.js`, `org-team-messages.test.js` (40 tests).
