/**
 * CLI version + drift resolution — shared so `quox --version` (bin/quox.js)
 * and `quox doctor` (commands/doctor.js) report the SAME facts and can never
 * disagree about which build is running. Closes quoxai/quox#610.
 *
 * Every git call is fully guarded (stderr discarded, failure swallowed) so
 * version/drift resolution can never break a command: a plain-package install
 * with no .git, a missing git binary, or a detached worktree all degrade to a
 * sensible fallback rather than throwing.
 *
 * Note on cost: bin/quox.js keeps its argv guard at the CALL SITE (it only
 * calls resolveCliVersion() when --version/-V is actually present) so normal
 * commands stay zero-cost. doctor calls both freely — the user explicitly ran
 * a diagnostic, so spawning git is expected there.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const BASE_VERSION = '0.1.0';

// The CLI source root (…/cli). version.js lives at cli/lib/core/, so two
// levels up is the tree whose HEAD identifies the running build.
const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function git(args) {
  return execFileSync('git', ['-C', CLI_ROOT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Human version string: "0.1.0 (7bac4f67, session/vulcan)" — or bare
 * "0.1.0" when git facts are unavailable. Unlike the drift check this never
 * needs origin/main, so it works on a shallow or rem-less clone.
 */
export function resolveCliVersion() {
  try {
    const sha = git(['rev-parse', '--short', 'HEAD']);
    if (!sha) return BASE_VERSION;
    let ref = '';
    try { ref = git(['rev-parse', '--abbrev-ref', 'HEAD']); } catch { /* detached HEAD / no ref */ }
    const label = ref && ref !== 'HEAD' ? ref : 'detached';
    return `${BASE_VERSION} (${sha}, ${label})`;
  } catch {
    return BASE_VERSION;
  }
}

/**
 * Drift of the running worktree vs the LAST-FETCHED origin/main.
 *
 * Deliberately does NOT fetch: a health check must not hang on a slow remote
 * or block on credentials. The count therefore reflects the last fetch, which
 * the detail line states plainly. This mirrors scripts/quox-cli-refresh.sh's
 * `git rev-list --count HEAD..origin/main` so doctor and the refresh tool agree
 * (#607 shipped the refresh side).
 *
 * @returns {{status:'ok'|'stale'|'unknown'|'skip', detail:string}}
 *   ok      — HEAD == origin/main
 *   stale   — behind origin/main; nudge quox-cli-refresh
 *   unknown — no origin/main ref locally (never fetched here)
 *   skip    — not a git worktree (plain-package install)
 */
export function checkCliDrift() {
  let head;
  try {
    head = git(['rev-parse', 'HEAD']);
  } catch {
    return { status: 'skip', detail: 'not a git worktree' };
  }
  let remote;
  try {
    remote = git(['rev-parse', 'origin/main']);
  } catch {
    return { status: 'unknown', detail: 'no origin/main ref (never fetched here)' };
  }
  if (head === remote) return { status: 'ok', detail: 'up to date with origin/main' };
  let behind = '?';
  try { behind = git(['rev-list', '--count', 'HEAD..origin/main']); } catch { /* keep ? */ }
  return {
    status: 'stale',
    detail: `${behind} commit(s) behind origin/main (run quox-cli-refresh) — reflects last fetch`,
  };
}
