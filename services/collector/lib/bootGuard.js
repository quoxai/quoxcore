'use strict';

/**
 * FIX-11 boot guard: test-only env flags must not appear in production.
 * Per feedback_test_env_flags_in_prod.md: TEST_LLM_STUB / MOCK_LLM / SKIP_AUTH /
 * BYPASS_RATE_LIMIT are never allowed in production without ALLOW_TEST_FLAGS=true.
 *
 * Exported for unit testing. The guard is called during server startup in server.js.
 */

const TEST_FLAGS = ['TEST_LLM_STUB', 'MOCK_LLM', 'SKIP_AUTH', 'BYPASS_RATE_LIMIT'];

/**
 * Check for test-only env flags. Returns an object indicating what was found.
 * Does NOT call process.exit — that is done by the caller (server.js) so this
 * function can be unit-tested without spawning a full server.
 *
 * @param {Object} env - environment object (defaults to process.env)
 * @returns {{ presentFlags: string[], allowed: boolean, shouldAbort: boolean }}
 */
function guardTestEnvFlags(env = process.env) {
  const presentFlags = TEST_FLAGS.filter(k => env[k] && env[k] !== '');
  const allowed = env.ALLOW_TEST_FLAGS === 'true';
  const shouldAbort = presentFlags.length > 0 && !allowed;
  return { presentFlags, allowed, shouldAbort };
}

module.exports = { guardTestEnvFlags, TEST_FLAGS };
