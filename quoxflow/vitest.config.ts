import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use forks instead of threads — isolated-vm's native bindings
    // are not compatible with Node.js worker_threads
    pool: 'forks',
  },
});
