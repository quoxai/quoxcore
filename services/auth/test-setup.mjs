// Auth test isolation harness.
//
// The auth test suites (tests/, tests-integration/) exercise the real DB layer
// (db/index.js), which defaults to services/auth/data/auth.db. That file is
// held readonly by the running auth service, and a single shared test DB makes
// files interfere with each other. node --test spawns a separate process per
// test file, so this preload — loaded via `node --test --import ./test-setup.mjs`
// — runs once per file BEFORE db/index.js is imported and points AUTH_DB_PATH at
// a unique temp database. getDb() then builds a fresh, fully-migrated, seeded DB
// per file: no cross-file interference, no dependency on the service-locked DB.
//
// Respects an already-set AUTH_DB_PATH (e.g. a test that wants its own path).
// VAULT-INTEG P18: must be the first import, before anything else in this
// file or any test module, so no real credential exists in process.env by
// the time a test assertion can echo it into a diff. See
// services/shared/testEnvScrub.cjs.
import '../shared/testEnvScrub.cjs';

// #727: tests must never reach the real docker daemon on a dev box. Detached
// backup containers are exercised with an injected runner in
// tests/backupDetach.test.js instead.
process.env.BACKUP_DETACHED = process.env.BACKUP_DETACHED || 'false';

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

if (!process.env.AUTH_DB_PATH) {
  const dir = mkdtempSync(join(tmpdir(), 'auth-test-'));
  process.env.AUTH_DB_PATH = join(dir, 'auth.db');
  process.on('exit', () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
}

// LL-4 landed a PRODUCTION-signed data/signed-catalog.json in the repo. Many
// licensing tests inject their own Ed25519 test key (LICENSE_PUBLIC_KEY),
// under which that artifact can never verify, and the loader rightly
// fail-closes the process. Default the suite to "no catalogue installed"
// (the loud legacy fallback) so tests are hermetic regardless of what
// artifact ships in data/; a test that wants a catalogue sets
// SIGNED_CATALOG_PATH (or passes opts.path) to its own signed fixture.
if (!process.env.SIGNED_CATALOG_PATH) {
  process.env.SIGNED_CATALOG_PATH = join(tmpdir(), 'auth-test-no-signed-catalog.json');
}

// #49 S1: POWERS detect/deploy tests spin up a stub MCP server on 127.0.0.1,
// which the SSRF egress guard (lib/egressGuard.js) blocks by default. Allow
// loopback for tests only (real deployments leave POWERS_EGRESS_ALLOWLIST empty
// = fully locked down).
if (!process.env.POWERS_EGRESS_ALLOWLIST) {
  process.env.POWERS_EGRESS_ALLOWLIST = '127.0.0.1';
}
