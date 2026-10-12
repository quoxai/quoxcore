import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.js'],
    globals: false,
    environment: 'node',
    testTimeout: 10000,
  }
});
