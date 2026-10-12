import { defineConfig } from 'vitest/config';

// Without a service-local config, `npx vitest run --root services/tasks`
// inherits the repo-root vitest.config's setupFiles ('./src/test/setup.js'),
// which doesn't exist under services/tasks — every suite failed to load.
// Mirrors services/collector/vitest.config.js.
export default defineConfig({
  test: {
    include: ['test/**/*.test.js', 'lib/**/__tests__/**/*.test.js'],
    globals: false,
    // VAULT-INTEG P18: must run first, before any test module, so no real
    // credential exists in process.env when an assertion diff could echo it.
    setupFiles: ['../shared/testEnvScrub.cjs']
  }
});
