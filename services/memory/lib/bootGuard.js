/**
 * TRUST-GATE-OPS boot guard (ESM twin of services/collector/lib/bootGuard.js).
 * Test-only env flags must not appear in production: TEST_LLM_STUB / MOCK_LLM /
 * SKIP_AUTH / BYPASS_RATE_LIMIT are never allowed without ALLOW_TEST_FLAGS=true.
 * Per feedback_test_env_flags_in_prod.md.
 *
 * Exported for unit testing. The guard is called during server startup; the
 * caller decides whether to process.exit so this stays unit-testable.
 */

export const TEST_FLAGS = ['TEST_LLM_STUB', 'MOCK_LLM', 'SKIP_AUTH', 'BYPASS_RATE_LIMIT'];

/**
 * @param {Object} env - environment object (defaults to process.env)
 * @returns {{ presentFlags: string[], allowed: boolean, shouldAbort: boolean }}
 */
export function guardTestEnvFlags(env = process.env) {
  const presentFlags = TEST_FLAGS.filter(k => env[k] && env[k] !== '');
  const allowed = env.ALLOW_TEST_FLAGS === 'true';
  const shouldAbort = presentFlags.length > 0 && !allowed;
  return { presentFlags, allowed, shouldAbort };
}
