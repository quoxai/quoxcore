// brainConfig.js — BRAIN2-V3 B4: settings-resolved Brain2 knobs + egress facts.
//
// Every switch here used to be env-only. Each now resolves with the same
// precedence as QUOXBRAIN_HYBRID_ENABLED: a STORED org setting (collector's
// org_platform_settings, fetched via configResolver.getSetting, which only
// ever returns a stored override) beats the process env, which beats the
// hard-coded default. configResolver never throws and returns null for
// "no override stored" AND for "collector unreachable"; callers therefore
// keep their env/default fallback in both cases, EXCEPT for the two
// privacy-RESTRICTING settings (QUOXBRAIN_EMBED_EXCLUDE_VAULTS,
// QUOXDREAM_ALLOW_LLM_TEXT; BRAIN2-W2 2). Those use resolvePrivacyRaw():
// when the lookup fails they fall back to the last-known-good value for the
// org (persisted in privacy_setting_lkg, so it survives a restart), and when
// nothing was ever known they FAIL CLOSED (the caller must not embed / must
// not send text to an LLM). A lookup failure never means "no restriction".

import { getSetting, getSettingStatus } from './configResolver.js'
import { getDatabase } from './db.js'

function numOr(v, dflt) {
  if (v === undefined || v === null || String(v).trim() === '') return dflt
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : dflt
}

// Resolves one value, reporting where it came from.
async function resolveRaw(orgId, key, envValue, dflt, deps) {
  try {
    const r = await getSetting(orgId, key, deps)
    if (r && typeof r.value === 'string' && r.value !== '') return { value: r.value, source: 'setting' }
  } catch { /* getSetting never throws; belt and braces */ }
  if (envValue !== undefined && envValue !== null && String(envValue).trim() !== '') {
    return { value: String(envValue), source: 'env' }
  }
  return { value: dflt, source: 'default' }
}

// ---------------------------------------------------------------------------
// Privacy-restricting settings: last-known-good, fail closed.
// ---------------------------------------------------------------------------
function readLkg(orgId, key, deps) {
  if (deps.lkgStore) return deps.lkgStore.get(orgId, key)
  try {
    const row = getDatabase().prepare('SELECT value FROM privacy_setting_lkg WHERE org_id = ? AND key = ?').get(orgId, key)
    return row ? row.value : null
  } catch (err) {
    console.error(`[QuoxBrain brainConfig] last-known-good read failed for org=${orgId} key=${key}: ${err.message}`)
    return null
  }
}

function writeLkg(orgId, key, value, deps) {
  try {
    if (deps.lkgStore) return deps.lkgStore.set(orgId, key, value)
    getDatabase().prepare(`
      INSERT INTO privacy_setting_lkg (org_id, key, value, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      WHERE privacy_setting_lkg.value IS NOT excluded.value
    `).run(orgId, key, value, new Date().toISOString())
  } catch (err) {
    console.error(`[QuoxBrain brainConfig] last-known-good write failed for org=${orgId} key=${key}: ${err.message}`)
  }
}

/**
 * Resolves a privacy-RESTRICTING setting. `known:false` means the collector
 * did not answer AND no last-known-good exists for this org: the caller MUST
 * fail closed. Otherwise `value` is the setting > env > default result (when
 * the collector answered) or the persisted last-known-good (source
 * 'last-known-good').
 */
async function resolvePrivacyRaw(orgId, key, envValue, dflt, deps) {
  let status = { ok: false, result: null }
  try { status = await getSettingStatus(orgId, key, deps) } catch { /* never throws; belt and braces */ }
  if (status.ok) {
    let r
    if (status.result && typeof status.result.value === 'string' && status.result.value !== '') {
      r = { value: status.result.value, source: 'setting' }
    } else if (envValue !== undefined && envValue !== null && String(envValue).trim() !== '') {
      r = { value: String(envValue), source: 'env' }
    } else {
      r = { value: dflt, source: 'default' }
    }
    writeLkg(orgId, key, r.value, deps)
    return { ...r, known: true }
  }
  const lkg = readLkg(orgId, key, deps)
  if (lkg !== null && lkg !== undefined) return { value: lkg, source: 'last-known-good', known: true }
  console.error(`[QuoxBrain brainConfig] org=${orgId} ${key}: settings lookup failed and no last-known-good exists, failing closed`)
  return { value: null, source: 'unknown', known: false }
}

const THRESHOLD_DEFAULTS = {
  QUOXBRAIN_MIN_COVERAGE: 0.5,
  QUOXBRAIN_MIN_DENSE_COSINE: 0.6,
  QUOXBRAIN_MIN_DENSE_FLOOR: 0.465,
  QUOXBRAIN_MIN_DENSE_COSINE_LARGE: 0.6,
  QUOXBRAIN_MIN_DENSE_FLOOR_LARGE: 0.472, // calibrated on held-out set 1, text-embedding-3-large@768 (2026-10-06): found 0.476-0.592, near-miss 0.406-0.53
}

/** Abstention thresholds for an org: setting > env > default. */
export async function resolveRelevanceThresholds(orgId, deps = {}) {
  const env = deps.env || process.env
  const out = {}
  for (const [key, dflt] of Object.entries(THRESHOLD_DEFAULTS)) {
    const r = await resolveRaw(orgId, key, env[key], String(dflt), deps)
    out[key] = { value: numOr(r.value, dflt), source: r.source }
  }
  return {
    minCoverage: out.QUOXBRAIN_MIN_COVERAGE.value,
    minDenseCosine: out.QUOXBRAIN_MIN_DENSE_COSINE.value,
    minDenseFloor: out.QUOXBRAIN_MIN_DENSE_FLOOR.value,
    minDenseCosineLarge: out.QUOXBRAIN_MIN_DENSE_COSINE_LARGE.value,
    minDenseFloorLarge: out.QUOXBRAIN_MIN_DENSE_FLOOR_LARGE.value,
    sources: {
      QUOXBRAIN_MIN_COVERAGE: out.QUOXBRAIN_MIN_COVERAGE.source,
      QUOXBRAIN_MIN_DENSE_COSINE: out.QUOXBRAIN_MIN_DENSE_COSINE.source,
      QUOXBRAIN_MIN_DENSE_FLOOR: out.QUOXBRAIN_MIN_DENSE_FLOOR.source,
      QUOXBRAIN_MIN_DENSE_COSINE_LARGE: out.QUOXBRAIN_MIN_DENSE_COSINE_LARGE.source,
      QUOXBRAIN_MIN_DENSE_FLOOR_LARGE: out.QUOXBRAIN_MIN_DENSE_FLOOR_LARGE.source,
    },
  }
}

export const DEFAULT_QUERY_EMBED_TIMEOUT_MS = 1500

/** Interactive query-embed timeout for an org: setting > env > 1500ms. */
export async function resolveQueryEmbedTimeout(orgId, deps = {}) {
  const env = deps.env || process.env
  const r = await resolveRaw(orgId, 'QUOXBRAIN_QUERY_EMBED_TIMEOUT_MS', env.QUOXBRAIN_QUERY_EMBED_TIMEOUT_MS, String(DEFAULT_QUERY_EMBED_TIMEOUT_MS), deps)
  const n = Number(r.value)
  return { value: Number.isFinite(n) && n > 0 ? n : DEFAULT_QUERY_EMBED_TIMEOUT_MS, source: r.source }
}

// A lone '-' is the documented "exclude nothing" value: the settings store
// cannot hold an empty string, so '-' is how an admin overrides an env-set
// exclusion list back to empty.
export function parseCsv(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter((t) => t && t !== '-')
}

/**
 * Exclusion tokens for an org with a fail-closed signal. `known:false` =
 * the settings lookup failed and no last-known-good exists: callers that
 * send text off-box (embedding backfill, Dream dedup) must NOT proceed.
 */
export async function resolveEmbedExclusionsDetailed(orgId, deps = {}) {
  if (Array.isArray(deps.embedExcludeVaults)) return { tokens: deps.embedExcludeVaults, known: true, source: 'deps' }
  const env = deps.env || process.env
  const r = await resolvePrivacyRaw(orgId, 'QUOXBRAIN_EMBED_EXCLUDE_VAULTS', env.QUOXBRAIN_EMBED_EXCLUDE_VAULTS, '', deps)
  return { tokens: r.known ? parseCsv(r.value) : [], known: r.known, source: r.source }
}

/**
 * Raw exclusion tokens (vault ids or names) for an org. Read-side (search,
 * egress panel) view: last-known-good when the lookup fails, [] only when
 * nothing was ever known (nothing off-box is sent from these paths; send
 * paths use resolveEmbedExclusionsDetailed and fail closed).
 */
export async function resolveEmbedExclusions(orgId, deps = {}) {
  return (await resolveEmbedExclusionsDetailed(orgId, deps)).tokens
}

/**
 * Maps exclusion tokens (vault id, or case-insensitive vault name) onto the
 * org's actual vault ids. `vaults` = [{id, name}].
 */
export function excludedVaultIds(tokens, vaults) {
  if (!tokens || tokens.length === 0) return new Set()
  const ids = new Set(tokens)
  const names = new Set(tokens.map((t) => t.toLowerCase()))
  const out = new Set()
  for (const v of vaults || []) {
    if (ids.has(v.id) || names.has(String(v.name || '').toLowerCase())) out.add(v.id)
  }
  return out
}

/**
 * Whether QuoxDream may send this org's note text to the LLM. Default
 * (collector answered, nothing set) is allowed; only the literal 'false'
 * blocks. If the lookup fails, the last-known-good value applies; if none
 * was ever known the answer is NOT allowed (fail closed, source 'unknown').
 */
export async function resolveDreamLlmAllowed(orgId, deps = {}) {
  const env = deps.env || process.env
  const r = await resolvePrivacyRaw(orgId, 'QUOXDREAM_ALLOW_LLM_TEXT', env.QUOXDREAM_ALLOW_LLM_TEXT, 'true', deps)
  if (!r.known) return { allowed: false, source: 'unknown' }
  return { allowed: r.value !== 'false', source: r.source }
}

/**
 * BRAIN2-W11 B: whether this org opted in to LLM reranking (note text sent to
 * the chat model). Default false. Fails CLOSED: if the settings lookup fails
 * the answer is false, with no last-known-good (an opt-in egress must never be
 * switched on by a stale value). `known:false` lets the egress panel say so.
 */
export async function resolveRerankEnabled(orgId, deps = {}) {
  return (await resolveRerankEnabledDetailed(orgId, deps)).enabled
}

export async function resolveRerankEnabledDetailed(orgId, deps = {}) {
  const env = deps.env || process.env
  let status = { ok: false, result: null }
  try { status = await getSettingStatus(orgId, 'BRAIN_RERANK_ENABLED', deps) } catch { /* never throws */ }
  if (!status.ok) return { enabled: false, source: 'unknown', known: false }
  let model = 'gpt-4o-mini'
  try {
    const m = await getSettingStatus(orgId, 'BRAIN_RERANK_MODEL', deps)
    const v = m.ok && m.result && typeof m.result.value === 'string' ? m.result.value.trim() : ''
    if (v && /^(gpt|o\d|chatgpt)/i.test(v)) model = v
  } catch { /* default model */ }
  if (status.result && typeof status.result.value === 'string' && status.result.value !== '') {
    return { enabled: status.result.value === 'true', source: 'setting', known: true, model }
  }
  if (env.BRAIN_RERANK_ENABLED !== undefined && String(env.BRAIN_RERANK_ENABLED).trim() !== '') {
    return { enabled: String(env.BRAIN_RERANK_ENABLED) === 'true', source: 'env', known: true, model }
  }
  return { enabled: false, source: 'default', known: true, model }
}

/**
 * BRAIN2-W13 D: whether this org opted in to query expansion (the query text is
 * sent to the chat model). Its own switch, default false, fails CLOSED. It no
 * longer rides on BRAIN_RERANK_ENABLED: measured on the blind set, expansion
 * lowered hybrid MRR (0.518 -> 0.467), so it must be a deliberate choice.
 */
export async function resolveExpandEnabled(orgId, deps = {}) {
  return (await resolveExpandEnabledDetailed(orgId, deps)).enabled
}

export async function resolveExpandEnabledDetailed(orgId, deps = {}) {
  const env = deps.env || process.env
  let status = { ok: false, result: null }
  try { status = await getSettingStatus(orgId, 'BRAIN_EXPAND_ENABLED', deps) } catch { /* never throws */ }
  if (!status.ok) return { enabled: false, source: 'unknown', known: false }
  if (status.result && typeof status.result.value === 'string' && status.result.value !== '') {
    return { enabled: status.result.value === 'true', source: 'setting', known: true }
  }
  if (env.BRAIN_EXPAND_ENABLED !== undefined && String(env.BRAIN_EXPAND_ENABLED).trim() !== '') {
    return { enabled: String(env.BRAIN_EXPAND_ENABLED) === 'true', source: 'env', known: true }
  }
  return { enabled: false, source: 'default', known: true }
}

/**
 * Egress facts from config, not prose. `providerInfo` is the collector's live
 * embed-provider probe ({provider, model} | null when unreachable).
 */
export function describeEgress({ providerInfo = null, dreamAllowed = true, excludedVaults = [], rerank = { enabled: false, known: true }, expand = { enabled: false, known: true } } = {}) {
  return {
    embedding: {
      route: 'collector /internal/embed',
      provider: providerInfo ? (providerInfo.provider || null) : null,
      model: providerInfo ? (providerInfo.model || null) : null,
      known: providerInfo !== null && providerInfo !== undefined,
      sendsChunkText: !!(providerInfo && providerInfo.provider),
      excludedVaults,
    },
    dream: {
      route: 'collector LLM route (org-resolved chat model)',
      sendsNoteText: !!dreamAllowed,
    },
    rerank: {
      route: 'collector /internal/rerank',
      provider: 'openai',
      model: rerank.model || 'gpt-4o-mini',
      enabled: !!rerank.enabled,
      known: rerank.known !== false,
      sendsPassageText: !!rerank.enabled,
    },
    expand: {
      route: 'collector /internal/expand',
      provider: 'openai',
      enabled: !!expand.enabled,
      known: expand.known !== false,
      sendsQueryText: !!expand.enabled,
    },
    agents: {
      route: 'collector chat dispatch (Brain2 passages are injected into the agent prompt and Cortex context)',
      sendsPassagesToChatModel: true,
    },
  }
}

export default {
  resolveRelevanceThresholds, resolveQueryEmbedTimeout, resolveEmbedExclusions, resolveEmbedExclusionsDetailed,
  excludedVaultIds, resolveDreamLlmAllowed, resolveRerankEnabled, resolveRerankEnabledDetailed, resolveExpandEnabled, resolveExpandEnabledDetailed, describeEgress, parseCsv,
}
