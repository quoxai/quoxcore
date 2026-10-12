// services/shared/testEnvScrub.cjs — VAULT-INTEG P18 test-env scrubber.
//
// INCIDENT (2026-09-06): a quox-signal test read the ambient OPENAI_API_KEY
// via a config file fallback, the assertion failed, and the failing
// assertion diff printed the live key into the transcript. An assertion
// diff echoes BOTH sides of a comparison verbatim; if a real credential
// exists anywhere in process.env when a test process boots, any assertion
// that happens to touch it (directly, via a fallback chain, via a logged
// object) can leak it. The only reliable fix is: the credential must not
// exist in the test process's env in the first place.
//
// This module has one job: delete every credential-shaped env var at test
// bootstrap, before any test file or app code runs. Require it FIRST in
// every test entry point.
//
// Two removal passes:
//   1. Registry-driven: every services/shared/envRegistry.cjs entry
//      classified 'secret' is deleted by name. This is the precise list.
//   2. Name-pattern sweep (belt-and-braces): any env var whose NAME matches
//      /(_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS)$/ is deleted too, because the
//      registry can lag reality (a new secret env var landing without a
//      registry entry yet is exactly the gap envRegistryCompleteness.test.js
//      polices, but this scrubber does not depend on that ratchet holding).
//
// Escape hatch: set QUOX_ALLOW_REAL_CREDS=1 for a deliberate live-integration
// run that needs real credentials present. One line is logged naming the
// override so it is never silent. Never set this for a normal test run.
'use strict';

const SECRET_NAME_PATTERN = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS)$/;

function scrub() {
  if (process.env.QUOX_ALLOW_REAL_CREDS === '1') {
    // stderr, not stdout: keeps this diagnostic out of any script that
    // parses a test process's stdout as data.
    // eslint-disable-next-line no-console
    console.error('[testEnvScrub] QUOX_ALLOW_REAL_CREDS=1 set - real credentials left in process.env for this run.');
    return;
  }

  let registrySecretNames = [];
  try {
    // eslint-disable-next-line global-require
    const { ENV_REGISTRY } = require('./envRegistry.cjs');
    registrySecretNames = ENV_REGISTRY
      .filter((entry) => entry.classification === 'secret')
      .map((entry) => entry.name);
  } catch {
    // Registry not present/loadable (e.g. this module used outside this
    // repo's layout) — the name-pattern sweep below still runs.
  }

  for (const name of registrySecretNames) {
    delete process.env[name];
  }

  for (const name of Object.keys(process.env)) {
    if (SECRET_NAME_PATTERN.test(name)) {
      delete process.env[name];
    }
  }
}

scrub();

module.exports = { scrub, SECRET_NAME_PATTERN };
