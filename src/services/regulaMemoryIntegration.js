/**
 * regulaMemoryIntegration.js — Settings events → durable memory facts.
 *
 * Phase 7 of SET-REGULA. Every meaningful settings change becomes a
 * memory entry so other agents can answer "why is verbosity set to
 * verbose?" or "when did we enable VOLT?" from the memory system
 * instead of trawling the audit log.
 *
 * Mapping rules:
 *   - reversible user-facing change     → type='preference'
 *   - destructive or plugin toggle      → type='decision'
 *   - REGULA recommendation accepted    → type='decision'
 *   - drift watchdog finding            → type='observation'
 *
 * We never store raw secret values (the emitter already redacts them,
 * but we defend in depth here too).
 */

import { getMemoryClient } from './memoryClient'
import { getSetting } from '../config/settingsRegistry'

const AGENT_ID = 'regula'

function isSecretSetting(settingId) {
  const id = String(settingId || '').toLowerCase()
  return id.startsWith('vault.') || id.includes('key') || id.includes('secret') || id.includes('password') || id.includes('token')
}

function formatValue(value) {
  if (value == null) return 'unset'
  if (typeof value === 'boolean') return value ? 'enabled' : 'disabled'
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 100)
  return String(value).slice(0, 100)
}

function classifyMemoryType(meta) {
  if (!meta) return 'preference'
  if (meta.destructive || meta.section === 'plugins') return 'decision'
  return 'preference'
}

function buildTags(meta, extra = []) {
  const tags = ['settings', 'regula']
  if (meta?.section) tags.push(`section:${meta.section}`)
  if (meta?.destructive) tags.push('destructive')
  if (meta?.hitlRequired) tags.push('hitl')
  return [...tags, ...extra]
}

/**
 * Record a settings change as a memory fact.
 *
 * @param {string} settingId
 * @param {object} opts
 * @param {*} opts.previousValue
 * @param {*} opts.newValue
 * @param {string} [opts.actor]
 * @param {string} [opts.reason]
 * @param {string} [opts.conversationId]
 */
export async function rememberSettingChange(settingId, {
  previousValue,
  newValue,
  actor = 'human.user',
  reason,
  conversationId,
} = {}) {
  if (isSecretSetting(settingId)) {
    // Never persist secret values to memory, even redacted — skip entirely.
    return null
  }
  const meta = getSetting(settingId)
  const label = meta?.label || settingId
  const section = meta?.section ? ` (${meta.section})` : ''
  const date = new Date().toISOString().slice(0, 10)

  const prev = formatValue(previousValue)
  const next = formatValue(newValue)
  const reasonClause = reason ? ` — ${reason}` : ''

  const content = `${actor.replace(/^human\./, '')} changed ${label}${section} from ${prev} to ${next} on ${date}${reasonClause}`
  const importance = meta?.destructive ? 'high' : 'medium'

  try {
    const client = getMemoryClient()
    return await client.saveMemory({
      type: classifyMemoryType(meta),
      content,
      importance,
      tags: buildTags(meta, [`setting:${settingId}`]),
      agentId: AGENT_ID,
      conversationId,
    })
  } catch (err) {
    console.warn('[REGULA] rememberSettingChange failed:', err)
    return null
  }
}

/**
 * Record a REGULA recommendation that the user accepted.
 */
export async function rememberRecommendation(settingId, {
  recommendation,
  rationale,
  conversationId,
} = {}) {
  if (isSecretSetting(settingId)) return null
  const meta = getSetting(settingId)
  const label = meta?.label || settingId
  const date = new Date().toISOString().slice(0, 10)

  const content = `REGULA recommended ${formatValue(recommendation)} for ${label} on ${date}${rationale ? ` — ${rationale}` : ''}`
  try {
    const client = getMemoryClient()
    return await client.saveMemory({
      type: 'decision',
      content,
      importance: 'medium',
      tags: buildTags(meta, [`setting:${settingId}`, 'recommendation']),
      agentId: AGENT_ID,
      conversationId,
    })
  } catch (err) {
    console.warn('[REGULA] rememberRecommendation failed:', err)
    return null
  }
}

/**
 * Record a finding from the drift watchdog as an observation.
 * Used by the sweep handler after runDriftSweep returns.
 */
export async function rememberDriftFinding(finding, { conversationId } = {}) {
  if (!finding || !finding.message) return null
  const date = new Date().toISOString().slice(0, 10)
  const content = `Drift sweep (${date}): [${finding.severity}] ${finding.message}`
  const importance = finding.severity === 'critical' ? 'high' : finding.severity === 'warning' ? 'medium' : 'low'

  try {
    const client = getMemoryClient()
    return await client.saveMemory({
      type: 'observation',
      content,
      importance,
      tags: [
        'settings',
        'regula',
        'drift',
        `severity:${finding.severity}`,
        ...(finding.settingId ? [`setting:${finding.settingId}`] : []),
      ],
      agentId: AGENT_ID,
      conversationId,
    })
  } catch (err) {
    console.warn('[REGULA] rememberDriftFinding failed:', err)
    return null
  }
}

/**
 * Fan-out: record every finding from a drift sweep result.
 */
export async function rememberSweepResult(result, opts = {}) {
  if (!result || !Array.isArray(result.findings)) return []
  const out = []
  for (const finding of result.findings) {
    const saved = await rememberDriftFinding(finding, opts)
    if (saved) out.push(saved)
  }
  return out
}

export default {
  rememberSettingChange,
  rememberRecommendation,
  rememberDriftFinding,
  rememberSweepResult,
}
