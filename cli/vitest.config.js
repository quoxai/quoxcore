import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    // fleet #426: this used to be test/** only, so any test file living beside
    // the code it tests was invisible to `npm test` and to CI. Four had
    // accumulated under lib/commands (doctor, open, status, fleet-provision:
    // 58 tests) and none of them had ever run in a gate. That is a silent
    // coverage cap, not a gap someone would notice: the suite goes green
    // either way, and the missing files never appear in the summary count.
    // Both layouts are now collected, so a test placed next to its module is
    // picked up automatically rather than depending on someone remembering
    // this glob.
    include: ['test/**/*.test.js', 'test/**/*.test.jsx', 'lib/**/*.test.js', 'lib/**/*.test.jsx'],
    // Strip QUOX_* from the environment before anything loads. A suite whose
    // result depends on whose shell it runs in is a coin flip, not a gate.
    // See test/setup-quox-env.js for the four phantom failures that prompted
    // this. (Named setup-quox-env, not setup.env: the pre-commit secrets hook
    // treats anything matching .env as a credentials file, correctly.)
    setupFiles: ['./test/setup-quox-env.js'],
    globals: false,
    // Timing-driven UI tests poll the frame (see test/quoxon/r2helpers.js waitForFrame); this is the
    // ceiling for a slow real render on a loaded box (load 30-60), not an expected duration.
    testTimeout: 30000,
  }
});
