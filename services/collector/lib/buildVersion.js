/**
 * REL-423: which build is this collector? Read once at load by server.js and served on GET /version.
 *
 * Sources, in order:
 *   1. QUOXCORE_VERSION env (the build arg), unless it is the Dockerfile's '0.0.0' default. That default is
 *      ALWAYS set (ARG QUOXCORE_VERSION=0.0.0 + ENV), so treating it as a stamp made every unstamped image
 *      report "stamped" version 0.0.0 (4.2.3 dry-run: a public-tree install answered 0.0.0).
 *   2. /app/BUILD_COMMIT: the full commit SHA the public export writes at its root (the export has no .git,
 *      so setup.sh cannot `git rev-parse`). Reported as its 9-char short form, the form setup.sh and
 *      `quox server update` use.
 *   3. /app/VERSION (semver), so a deploy is never silently "version zero".
 *   4. '0.0.0', unstamped, and said so.
 * `commit` is the full SHA when one is known (BUILD_COMMIT, or a full-length hex env stamp), else null, so a
 * proof check can match a running instance to the exact commit it was built from.
 */
const fs = require('fs');

const HEX40 = /^[0-9a-f]{40}$/;
const SHORT_LEN = 9;

function readTrim(readFile, p) {
  try { return String(readFile(p, 'utf8')).trim(); } catch { return ''; }
}

function resolveBuildVersion({ env = process.env, readFile = fs.readFileSync, appDir = '/app' } = {}) {
  const envVer = (env.QUOXCORE_VERSION || '').trim();
  const fileCommit = readTrim(readFile, `${appDir}/BUILD_COMMIT`).toLowerCase();
  const commit = HEX40.test(fileCommit) ? fileCommit : (HEX40.test(envVer.toLowerCase()) ? envVer.toLowerCase() : null);
  const fileVer = readTrim(readFile, `${appDir}/VERSION`);
  const release = /^\d+\.\d+\.\d+$/.test(fileVer) ? fileVer : null;

  if (envVer && envVer !== '0.0.0') return { version: envVer, source: 'env:QUOXCORE_VERSION', commit, release };
  if (commit && HEX40.test(fileCommit)) return { version: commit.slice(0, SHORT_LEN), source: `file:${appDir}/BUILD_COMMIT`, commit, release };
  if (fileVer && fileVer !== '0.0.0') return { version: fileVer, source: `file:${appDir}/VERSION`, commit, release };
  return { version: '0.0.0', source: 'fallback (unstamped — build did not inject a commit)', commit, release };
}

module.exports = { resolveBuildVersion, SHORT_LEN };
