// effectiveConfig.js: BRAIN2-V2 V2-10 "settings truth".
//
// One read-only view of what the RUNNING brain actually uses for every tunable
// QUOXBRAIN_* knob, with where each value came from. It is an ALLOWLIST: a knob
// only appears here because someone listed it, so a secret-shaped env var
// (keys, tokens, URLs with credentials, vault roots) can never leak by being
// swept up. Nothing here reads process.env generically.
//
// source: 'setting' (a stored org/instance setting won), 'env' (the server
// environment set it), 'default' (neither), plus the honest degraded values
// 'last-known-good' / 'unknown' that brainConfig reports when the collector's
// settings API did not answer.
//
// restartRequired: true when a stored setting for this knob is only honoured
// after a quoxbrain restart (or the knob is env-only). For those, `effective`
// is what the running process booted with (env or default); a stored value
// that differs is DRIFT the UI flags.

import { getSetting, getInstanceSetting } from './configResolver.js'
import {
  resolveRelevanceThresholds, resolveQueryEmbedTimeout, resolveDreamLlmAllowed,
  resolveRerankEnabledDetailed, resolveExpandEnabledDetailed,
} from './brainConfig.js'

// Env-only knobs (not settable in the UI). parse: how the code that reads the
// knob validates it; an invalid env value falls back to the default, exactly as
// the reader does. Defaults mirror the constants at each read site.
const ENV_ONLY = [
  { key: 'QUOXBRAIN_ANN', dflt: 'off', parse: 'ann', note: 'Dense-search backend: "qdrant" selects the ANN index, anything else uses the packed scan.' },
  { key: 'QUOXBRAIN_DENSE_SCAN_CAP', dflt: '100000', parse: 'pos' },
  { key: 'QUOXBRAIN_DENSE_LOW_SIGNAL_CAP', dflt: '5000', parse: 'nonneg' },
  { key: 'QUOXBRAIN_DENSE_CACHE_TTL_MS', dflt: '600000', parse: 'nonneg' },
  { key: 'QUOXBRAIN_DENSE_CACHE_MAX_VECTORS', dflt: '400000', parse: 'pos' },
  { key: 'QUOXBRAIN_DENSE_INVALIDATE_DROP_MAX', dflt: '20000', parse: 'nonneg' },
  { key: 'QUOXBRAIN_DENSE_TAIL_BUDGET_MS', dflt: '2500', parse: 'nonneg' },
  { key: 'QUOXBRAIN_DENSE_TAIL_PAGE', dflt: '2000', parse: 'nonneg' },
  { key: 'QUOXBRAIN_DENSE_WORKER_TIMEOUT_MS', dflt: '120000', parse: 'pos' },
  { key: 'QUOXBRAIN_RRF_DENSE_WEIGHT', dflt: '4', parse: 'weight' },
  { key: 'QUOXBRAIN_ORG_RPM', dflt: '600', parse: 'nonneg' },
  { key: 'QUOXBRAIN_QUERY_EMBED_WEAK_EXTRA_MS', dflt: '3500', parse: 'nonneg' },
  { key: 'QUOXBRAIN_RERANK_TIMEOUT_MS', dflt: '6000', parse: 'pos' },
  { key: 'QUOXBRAIN_EXPAND_TIMEOUT_MS', dflt: '4500', parse: 'pos' },
  { key: 'QUOXBRAIN_INGEST_MAX_FILE_BYTES', dflt: String(2 * 1024 * 1024), parse: 'pos' },
  { key: 'QUOXBRAIN_INGEST_MAX_FILES', dflt: '20000', parse: 'pos' },
  { key: 'QUOXBRAIN_INGEST_MAX_DEPTH', dflt: '32', parse: 'pos' },
  { key: 'QUOXBRAIN_RETRACT_MAX_ATTEMPTS', dflt: '8', parse: 'pos' },
]

// Settable (instance scope) but resolved only at scheduler start.
const BOOT_ONLY = [
  { key: 'QUOXBRAIN_EMBED_BACKFILL_ENABLED', dflt: 'false', parse: 'bool' },
  { key: 'QUOXBRAIN_EMBED_BACKFILL_WARMUP_MS', dflt: String(2 * 60 * 1000), parse: 'nonneg' },
  { key: 'QUOXBRAIN_EMBED_BACKFILL_INTERVAL_MS', dflt: String(15 * 60 * 1000), parse: 'nonneg' },
  { key: 'QUOXBRAIN_EMBED_BACKFILL_MAX_ORGS', dflt: '10', parse: 'nonneg' },
  { key: 'QUOXBRAIN_EMBED_BACKFILL_BATCH_CAP', dflt: '200', parse: 'nonneg' },
]

function validate(parse, raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  const s = String(raw).trim()
  if (parse === 'ann') return s === 'qdrant' ? s : null
  if (parse === 'bool') return s === 'true' ? 'true' : 'false'
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  if (parse === 'pos') return n > 0 ? s : null
  if (parse === 'weight') return n > 0 && n <= 10 ? s : null
  return n >= 0 ? s : null // nonneg
}

function fromEnv({ key, dflt, parse }, env) {
  const v = validate(parse, env[key])
  return v === null ? { effective: dflt, source: 'default' } : { effective: v, source: 'env' }
}

async function storedOrEnv(fetchStored, key, env, dflt, parse) {
  let stored = null
  try { stored = await fetchStored(key) } catch { /* resolver never throws; belt and braces */ }
  if (stored && typeof stored.value === 'string' && stored.value !== '') return { effective: stored.value, source: 'setting' }
  return fromEnv({ key, dflt, parse }, env)
}

/**
 * @param {string} orgId
 * @param {object} [deps] { env, getSetting, getInstanceSetting, plus brainConfig deps }
 * @returns {Promise<Array<{key,effective,source,restartRequired,scope,note?}>>}
 */
export async function describeEffectiveConfig(orgId, deps = {}) {
  const env = deps.env || process.env
  const orgGet = deps.getSetting || getSetting
  const instGet = deps.getInstanceSetting || getInstanceSetting
  const out = []
  const push = (key, effective, source, restartRequired, scope, note) =>
    out.push({ key, effective: String(effective), source, restartRequired, scope, ...(note ? { note } : {}) })

  const [thresholds, qTimeout, dream, rerank, expand, hybrid, embedTimeout] = await Promise.all([
    resolveRelevanceThresholds(orgId, deps),
    resolveQueryEmbedTimeout(orgId, deps),
    resolveDreamLlmAllowed(orgId, deps),
    resolveRerankEnabledDetailed(orgId, deps),
    resolveExpandEnabledDetailed(orgId, deps),
    storedOrEnv((k) => orgGet(orgId, k, deps), 'QUOXBRAIN_HYBRID_ENABLED', env, 'false', 'bool'),
    storedOrEnv((k) => instGet(k, deps), 'QUOXBRAIN_EMBED_TIMEOUT_MS', env, '45000', 'pos'),
  ])

  // Org-scoped, restart-free (resolved per request).
  push('QUOXBRAIN_HYBRID_ENABLED', hybrid.effective, hybrid.source, false, 'org')
  push('QUOXBRAIN_MIN_COVERAGE', thresholds.minCoverage, thresholds.sources.QUOXBRAIN_MIN_COVERAGE, false, 'org')
  push('QUOXBRAIN_MIN_DENSE_COSINE', thresholds.minDenseCosine, thresholds.sources.QUOXBRAIN_MIN_DENSE_COSINE, false, 'org')
  push('QUOXBRAIN_MIN_DENSE_FLOOR', thresholds.minDenseFloor, thresholds.sources.QUOXBRAIN_MIN_DENSE_FLOOR, false, 'org')
  push('QUOXBRAIN_MIN_DENSE_COSINE_LARGE', thresholds.minDenseCosineLarge, thresholds.sources.QUOXBRAIN_MIN_DENSE_COSINE_LARGE, false, 'org')
  push('QUOXBRAIN_MIN_DENSE_FLOOR_LARGE', thresholds.minDenseFloorLarge, thresholds.sources.QUOXBRAIN_MIN_DENSE_FLOOR_LARGE, false, 'org')
  push('QUOXBRAIN_QUERY_EMBED_TIMEOUT_MS', qTimeout.value, qTimeout.source, false, 'org')
  push('QUOXDREAM_ALLOW_LLM_TEXT', dream.allowed, dream.source, false, 'org')
  push('BRAIN_RERANK_ENABLED', rerank.enabled, rerank.source, false, 'org')
  push('BRAIN_EXPAND_ENABLED', expand.enabled, expand.source, false, 'org')

  // Instance-scoped, restart-free (resolved per call).
  push('QUOXBRAIN_EMBED_TIMEOUT_MS', embedTimeout.effective, embedTimeout.source, false, 'instance')

  // Instance-scoped, honoured only after a restart: effective = what it booted with.
  for (const k of BOOT_ONLY) {
    const r = fromEnv(k, env)
    push(k.key, r.effective, r.source, true, 'instance', 'Running value is the server environment or default; a stored setting applies after a quoxbrain restart.')
  }

  // Env-only: not settable from the UI.
  for (const k of ENV_ONLY) {
    const r = fromEnv(k, env)
    push(k.key, r.effective, r.source, true, 'env', k.note)
  }
  return out
}
