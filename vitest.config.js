import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import frameDepsPlugin from './scripts/vite-plugin-frame-deps.mjs'

export default defineConfig({
  plugins: [react(), frameDepsPlugin()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    // Vitest's 5000ms default is a hang detector, not a performance assertion, and on this
    // suite it was acting as a coin toss instead. A full run forks ~12 workers over 670+
    // files; heavy files (dynamic `await import()` of service graphs, jsdom renders of full
    // views) routinely take 5-12s of wall clock purely from CPU contention between workers,
    // and that number moves with whatever else the box is doing. Tests that happened to carry
    // an explicit per-test `{ timeout: 15000 }` survived; their neighbours in the same file,
    // doing identical work on the 5000ms default, died at exactly 5005/5029/5094ms with
    // STACK_TRACE_ERROR. That is the entire source of quoxai/quox#407's non-determinism:
    // two runs of identical code gave different failing sets because the timeout, not the
    // assertion, decided the result. Raising the floor keeps hang detection (nothing
    // legitimate here approaches 20s) while taking wall-clock luck out of the failing set.
    testTimeout: 20000,
    hookTimeout: 30000,
    exclude: [
      '**/node_modules/**',
      // Agent worktrees are full checkouts of this repo, so without this every test file
      // gets collected twice: once from source and once from a stale copy pinned to an old
      // commit. That produces phantom failures for code already fixed on main, and inflates
      // pass counts so a green run stops meaning anything. Excluded at the config rather
      // than pruned by hand, because the worktrees come back every time an agent runs.
      '**/.claude/worktrees/**',
      '**/tests/**',
      '**/e2e/**',
      // The whole CLI package has its own vitest config, deps and CI job ('cli' in
      // test.yml). cli/lib/**/*.test.js was being collected by this jsdom/vite-node run
      // too, where dynamic file:// imports (lazyCommands) fail and the sibling-repo
      // lockstep check (quoxglyph) is environment-dependent; they pass in their own job.
      '**/cli/**',
      '**/services/memory/test/**',
      '**/services/collector/test/**',
      // quoxbrain uses node:test suites too, run via `npm run test:quoxbrain`
      // (mirrors memory/collector above), not vitest.
      '**/services/quoxbrain/test/**',
      '**/services/auth/**',
      '**/services/screencap/test/**',
      '**/services/ward/test/**',
    ],
  },
})
