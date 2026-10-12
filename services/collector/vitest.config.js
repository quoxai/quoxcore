import { defineConfig, defaultExclude } from 'vitest/config';

// NOTE: test/quoxchat-*.test.js and test/agentToolCatalog.test.js are written
// in node:test style (`import { test } from 'node:test'`), not vitest style.
// vitest's include glob below still matches them by filename, but importing
// node:test's `test`/`describe` under the vitest runner registers zero real
// vitest tests (they show as "(0 test)" and get flagged red) — the actual
// assertions inside those files never execute under vitest. They are run
// separately via `npm run test:node` (see package.json), which wires into
// `npm test` so both suites are required to pass. Do not remove this
// exclude without also converting those 46 files to vitest syntax.
export default defineConfig({
  test: {
    include: ['test/**/*.test.js', 'lib/**/__tests__/**/*.test.js'],
    exclude: [...defaultExclude, 'test/quoxchat-*.test.js', 'test/agentToolCatalog.test.js'],
    globals: false,
    // VAULT-INTEG P18: must run first, before any test module, so no real
    // credential exists in process.env when an assertion diff could echo it.
    setupFiles: ['../shared/testEnvScrub.cjs']
  }
});
