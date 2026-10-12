/**
 * Resolve the QuoxCORE version string.
 *
 * Resolution order:
 *   1. process.env.QUOXCORE_VERSION  (Docker build arg — preferred)
 *   2. trimmed contents of the canonical VERSION file (default /app/VERSION,
 *      COPY'd into the image from the repo root)
 *   3. '0.0.0'  (last-resort placeholder)
 *
 * This exists because QUOXCORE_VERSION is a build arg; if an operator's .env
 * has it commented out the service would otherwise silently report '0.0.0'
 * (this caused a real prod incident on customer-01). The VERSION-file fallback
 * guarantees no install silently reports the placeholder.
 *
 * The result is computed once and cached at module load.
 *
 * @param {string} versionFilePath - path to the VERSION file (overridable for tests)
 * @param {NodeJS.ProcessEnv} env - environment (overridable for tests)
 * @returns {string}
 */
import { readFileSync } from 'fs';

export function resolveVersion(versionFilePath = '/app/VERSION', env = process.env) {
  if (env.QUOXCORE_VERSION) return env.QUOXCORE_VERSION;
  try {
    const v = readFileSync(versionFilePath, 'utf8').trim();
    if (v) return v;
  } catch {
    /* file absent or unreadable — fall through to placeholder */
  }
  return '0.0.0';
}

// Cached once at module load so the file is read at most once per process.
export const RESOLVED_VERSION = resolveVersion();
