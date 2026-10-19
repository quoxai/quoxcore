import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.js'],
    globals: false,
    environment: 'node',
    testTimeout: 10000,
    // #1078: no collector under test; the auth audit witness hop fails fast into the outbox.
    env: { QUOX_WARD_WITNESS_URL: 'http://127.0.0.1:9' },
  }
});
