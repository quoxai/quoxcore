/**
 * regulaTools.js — REGULA's tool surface for the Settings agent runtime.
 *
 * Phase 5 of SET-REGULA. Each tool has a stable name, a description,
 * a parameter contract, and a handler. Read tools execute immediately.
 * Write tools route through `commitSettingChange` so destructive ones
 * end up in the HITL inbox as pending-approval intents before they
 * commit.
 *
 * The handlers take a `ctx` object the caller provides at invocation
 * time so we stay testable and can run in unit tests without touching
 * real IndexedDB, auth, or collector endpoints. In production, the
 * collector or the frontend chat runtime supplies the ctx.
 *
 * ctx shape:
 *   {
 *     // Read side
 *     getSettingValue(id)        → any
 *     listPlugins()              → [{ id, name, enabled, required, version }]
 *     listVaultEntries()         → [{ id, type, label, lastTestedAt, lastTestResult }]
 *     testVaultEntry(id)         → { ok: boolean, detail?: string }
 *     getBackupStatus()          → { enabled, schedule, lastSuccessAt, ... }
 *     getLicenseStatus()         → { tier, days_remaining, features }
 *     getAppearance()            → { backgroundMode, theme }
 *     getServiceStatus(name?)    → { name, status, responseTime } | [...]
 *
 *     // Write side
 *     applySettingValue(id, value) → Promise<void>  (actually mutates)
 *     enablePlugin(id) / disablePlugin(id)
 *     runBackup() / revokeVaultEntry(id)
 *     setAppearance(patch)
 *     subscribeNotification(channel) / unsubscribeNotification(channel)
 *
 *     // Side-channel
 *     createInboxItem(item)      → Promise<{ id }>  (for HITL routing)
 *     corr?: string              (conversation correlation ID)
 *     actor?: string             (caller identity)
 *   }
 */

import { getSetting, getSettingsBySection, searchSettings, explainSetting } from '../config/settingsRegistry'
import {
  commitSettingChange,
  emitRead,
  emitExplain,
  emitRecommend,
  emitImport,
  emitExport,
} from './settingsEmitter'
import { rememberSettingChange, rememberRecommendation } from './regulaMemoryIntegration'

export const TOOL_CATEGORIES = {
  READ: 'read',
  WRITE: 'write',
  NOTIFY: 'notify',
}

// ────────────────────────────────────────────────────────── Read tools

async function settings_get({ settingId }, ctx = {}) {
  const meta = getSetting(settingId)
  if (!meta) {
    return { ok: false, error: `Unknown setting: ${settingId}` }
  }
  const value = typeof ctx.getSettingValue === 'function'
    ? ctx.getSettingValue(settingId)
    : undefined

  await emitRead(settingId, { corr: ctx.corr, reason: 'tool:settings_get' })
  return {
    ok: true,
    settingId,
    label: meta.label,
    section: meta.section,
    type: meta.type,
    value,
    default: meta.defaultValue,
  }
}

async function settings_explain({ settingId }, ctx = {}) {
  const exp = explainSetting(settingId)
  if (!exp) return { ok: false, error: `Unknown setting: ${settingId}` }
  await emitExplain(settingId, { corr: ctx.corr, query: 'tool:settings_explain' })
  return { ok: true, explanation: exp }
}

async function settings_search({ query, limit = 10 }, _ctx = {}) {
  if (!query) return { ok: false, error: 'query is required' }
  const results = searchSettings(query, { limit })
  return { ok: true, count: results.length, results: results.map(r => ({
    id: r.id, label: r.label, section: r.section, shortDescription: r.shortDescription,
  })) }
}

async function settings_list({ section }, _ctx = {}) {
  if (!section) return { ok: false, error: 'section is required' }
  const entries = getSettingsBySection(section)
  return { ok: true, count: entries.length, entries: entries.map(e => ({
    id: e.id, label: e.label, type: e.type, destructive: e.destructive,
  })) }
}

async function plugin_list(_params, ctx = {}) {
  if (typeof ctx.listPlugins !== 'function') {
    return { ok: false, error: 'ctx.listPlugins not provided' }
  }
  const plugins = await ctx.listPlugins()
  return { ok: true, count: plugins.length, plugins }
}

async function vault_list(_params, ctx = {}) {
  if (typeof ctx.listVaultEntries !== 'function') {
    return { ok: false, error: 'ctx.listVaultEntries not provided' }
  }
  const entries = await ctx.listVaultEntries()
  // Defence in depth: strip any secret value that leaked into the list.
  const safe = entries.map(e => {
    const { value, secret, apiKey, token, ...rest } = e || {}
    return rest
  })
  return { ok: true, count: safe.length, entries: safe }
}

async function vault_test({ entryId }, ctx = {}) {
  if (!entryId) return { ok: false, error: 'entryId is required' }
  if (typeof ctx.testVaultEntry !== 'function') {
    return { ok: false, error: 'ctx.testVaultEntry not provided' }
  }
  const result = await ctx.testVaultEntry(entryId)
  return { ok: true, entryId, result }
}

async function backup_status(_params, ctx = {}) {
  if (typeof ctx.getBackupStatus !== 'function') {
    return { ok: false, error: 'ctx.getBackupStatus not provided' }
  }
  return { ok: true, backup: await ctx.getBackupStatus() }
}

async function license_status(_params, ctx = {}) {
  if (typeof ctx.getLicenseStatus !== 'function') {
    return { ok: false, error: 'ctx.getLicenseStatus not provided' }
  }
  return { ok: true, license: await ctx.getLicenseStatus() }
}

async function appearance_get(_params, ctx = {}) {
  if (typeof ctx.getAppearance !== 'function') {
    return { ok: false, error: 'ctx.getAppearance not provided' }
  }
  return { ok: true, appearance: await ctx.getAppearance() }
}

async function service_check({ name }, ctx = {}) {
  if (typeof ctx.getServiceStatus !== 'function') {
    return { ok: false, error: 'ctx.getServiceStatus not provided' }
  }
  return { ok: true, status: await ctx.getServiceStatus(name) }
}

// ──────────────────────────────────────────────────── HITL routing helper

async function routeHitlOrCommit(settingId, {
  previousValue,
  newValue,
  onCommit,
  ctx,
  reason,
  title,
  bodyMd,
}) {
  const result = await commitSettingChange(settingId, {
    previousValue,
    newValue,
    corr: ctx.corr,
    actor: ctx.actor || 'human.user',
    reason,
    onCommit,
  })

  if (result.needsApproval) {
    if (typeof ctx.createInboxItem === 'function') {
      try {
        await ctx.createInboxItem({
          kind: 'approval',
          priority: 'high',
          title: title || `REGULA wants to change ${settingId}`,
          body_md: bodyMd || `REGULA is requesting approval to change **${settingId}**.\n\nPrevious: \`${String(previousValue)}\`\nProposed: \`${String(newValue)}\`\n\n${reason || ''}`,
          payload: {
            source: 'regula',
            envelopeId: result.envelope?.id,
            settingId,
            previousValue,
            newValue,
          },
        })
      } catch (err) {
        console.warn('[REGULA] createInboxItem failed:', err)
      }
    }
    return {
      ok: true,
      committed: false,
      needsApproval: true,
      envelopeId: result.envelope?.id || null,
      message: 'One-way door. Queued for approval in your HITL inbox.',
    }
  }

  // Fire-and-forget memory entry for reversible commits.
  rememberSettingChange(settingId, {
    previousValue,
    newValue,
    actor: ctx.actor,
    reason,
    conversationId: ctx.corr,
  }).catch(() => {})

  return { ok: true, committed: true, needsApproval: false, envelopeId: result.envelope?.id || null }
}

// ────────────────────────────────────────────────────────── Write tools

async function settings_set({ settingId, value, reason }, ctx = {}) {
  const meta = getSetting(settingId)
  if (!meta) return { ok: false, error: `Unknown setting: ${settingId}` }
  const previousValue = typeof ctx.getSettingValue === 'function'
    ? ctx.getSettingValue(settingId)
    : undefined

  return routeHitlOrCommit(settingId, {
    previousValue,
    newValue: value,
    onCommit: async () => {
      if (typeof ctx.applySettingValue === 'function') {
        await ctx.applySettingValue(settingId, value)
      }
    },
    ctx,
    reason,
    title: `Change ${meta.label}`,
    bodyMd: `Change **${meta.label}** (${meta.section}) to \`${String(value)}\`.\n\n${reason || ''}`,
  })
}

async function plugin_enable({ pluginId, reason }, ctx = {}) {
  const settingId = `plugins.${pluginId}`
  return routeHitlOrCommit(settingId, {
    previousValue: false,
    newValue: true,
    onCommit: async () => {
      if (typeof ctx.enablePlugin === 'function') await ctx.enablePlugin(pluginId)
    },
    ctx,
    reason,
    title: `Enable plugin ${pluginId}`,
    bodyMd: `Enable the **${pluginId}** plugin.\n\n${reason || ''}`,
  })
}

async function plugin_disable({ pluginId, reason }, ctx = {}) {
  const settingId = `plugins.${pluginId}`
  return routeHitlOrCommit(settingId, {
    previousValue: true,
    newValue: false,
    onCommit: async () => {
      if (typeof ctx.disablePlugin === 'function') await ctx.disablePlugin(pluginId)
    },
    ctx,
    reason,
    title: `Disable plugin ${pluginId}`,
    bodyMd: `Disable the **${pluginId}** plugin.\n\n${reason || ''}`,
  })
}

async function backup_run(_params, ctx = {}) {
  if (typeof ctx.runBackup !== 'function') {
    return { ok: false, error: 'ctx.runBackup not provided' }
  }
  const result = await ctx.runBackup()
  return { ok: true, result }
}

async function appearance_set({ patch, reason }, ctx = {}) {
  // Appearance is reversible — commit immediately.
  const previousValue = typeof ctx.getAppearance === 'function' ? await ctx.getAppearance() : undefined
  return routeHitlOrCommit('appearance.backgroundMode', {
    previousValue: previousValue?.backgroundMode,
    newValue: patch?.backgroundMode ?? previousValue?.backgroundMode,
    onCommit: async () => {
      if (typeof ctx.setAppearance === 'function') await ctx.setAppearance(patch)
    },
    ctx,
    reason,
    title: 'Update appearance',
  })
}

async function notification_subscribe({ channel }, ctx = {}) {
  if (!channel) return { ok: false, error: 'channel is required' }
  if (typeof ctx.subscribeNotification === 'function') {
    await ctx.subscribeNotification(channel)
  }
  return routeHitlOrCommit('notifications.channels', {
    previousValue: 'unknown',
    newValue: channel,
    onCommit: async () => {},
    ctx,
    reason: `subscribed to ${channel}`,
    title: `Subscribe notifications: ${channel}`,
  })
}

async function notification_unsubscribe({ channel }, ctx = {}) {
  if (!channel) return { ok: false, error: 'channel is required' }
  if (typeof ctx.unsubscribeNotification === 'function') {
    await ctx.unsubscribeNotification(channel)
  }
  return routeHitlOrCommit('notifications.channels', {
    previousValue: channel,
    newValue: 'unsubscribed',
    onCommit: async () => {},
    ctx,
    reason: `unsubscribed from ${channel}`,
    title: `Unsubscribe notifications: ${channel}`,
  })
}

async function settings_recommend({ settingId, recommendation, rationale }, ctx = {}) {
  if (!settingId || recommendation === undefined) {
    return { ok: false, error: 'settingId and recommendation are required' }
  }
  await emitRecommend(settingId, { recommendation, rationale, corr: ctx.corr })
  rememberRecommendation(settingId, {
    recommendation,
    rationale,
    conversationId: ctx.corr,
  }).catch(() => {})
  return { ok: true, settingId, recommendation, rationale: rationale || null }
}

async function settings_export(_params, ctx = {}) {
  const actor = ctx.actor || 'human.user'
  const count = typeof ctx.getSettingsSnapshot === 'function'
    ? Object.keys(await ctx.getSettingsSnapshot()).length
    : 0
  await emitExport({ settingCount: count, corr: ctx.corr, actor })
  return { ok: true, count }
}

async function settings_import({ sourceLabel, bundle }, ctx = {}) {
  const actor = ctx.actor || 'human.user'
  const settingCount = bundle ? Object.keys(bundle).length : 0
  // Import is always destructive — route through HITL.
  if (typeof ctx.createInboxItem === 'function') {
    try {
      await ctx.createInboxItem({
        kind: 'approval',
        priority: 'high',
        title: `REGULA wants to import ${settingCount} settings`,
        body_md: `Import bundle from **${sourceLabel || 'unknown'}** with ${settingCount} settings.`,
        payload: { source: 'regula', sourceLabel, settingCount },
      })
    } catch (err) {
      console.warn('[REGULA] import inbox item failed:', err)
    }
  }
  const env = await emitImport({ sourceLabel, settingCount, corr: ctx.corr, actor })
  return {
    ok: true,
    committed: false,
    needsApproval: true,
    envelopeId: env?.id || null,
    settingCount,
    message: 'Import queued for approval in the HITL inbox.',
  }
}

// ────────────────────────────────────────────────────────── Registry

export const REGULA_TOOLS = {
  // Read
  settings_get: { category: TOOL_CATEGORIES.READ, destructive: false, description: 'Read the current value and metadata of a single setting.', handler: settings_get },
  settings_explain: { category: TOOL_CATEGORIES.READ, destructive: false, description: 'Explain a setting in plain English with dependencies.', handler: settings_explain },
  settings_search: { category: TOOL_CATEGORIES.READ, destructive: false, description: 'Search settings by natural-language query.', handler: settings_search },
  settings_list: { category: TOOL_CATEGORIES.READ, destructive: false, description: 'List all settings in a section.', handler: settings_list },
  plugin_list: { category: TOOL_CATEGORIES.READ, destructive: false, description: 'List installed plugins and their status.', handler: plugin_list },
  vault_list: { category: TOOL_CATEGORIES.READ, destructive: false, description: 'List vault entries (NEVER reveals raw secret values).', handler: vault_list },
  vault_test: { category: TOOL_CATEGORIES.READ, destructive: false, description: 'Test connectivity for a vault credential.', handler: vault_test },
  backup_status: { category: TOOL_CATEGORIES.READ, destructive: false, description: 'Return backup schedule, last run, retention.', handler: backup_status },
  license_status: { category: TOOL_CATEGORIES.READ, destructive: false, description: 'Return license tier and days remaining.', handler: license_status },
  appearance_get: { category: TOOL_CATEGORIES.READ, destructive: false, description: 'Return current appearance mode.', handler: appearance_get },
  service_check: { category: TOOL_CATEGORIES.READ, destructive: false, description: 'Probe a registered service for health.', handler: service_check },

  // Write (some destructive → HITL)
  settings_set: { category: TOOL_CATEGORIES.WRITE, destructive: 'dynamic', description: 'Change a setting. Destructive ones route through HITL.', handler: settings_set },
  plugin_enable: { category: TOOL_CATEGORIES.WRITE, destructive: true, description: 'Enable a plugin. Routes through HITL.', handler: plugin_enable },
  plugin_disable: { category: TOOL_CATEGORIES.WRITE, destructive: true, description: 'Disable a plugin. Routes through HITL.', handler: plugin_disable },
  backup_run: { category: TOOL_CATEGORIES.WRITE, destructive: false, description: 'Trigger a manual backup run.', handler: backup_run },
  appearance_set: { category: TOOL_CATEGORIES.WRITE, destructive: false, description: 'Update appearance mode. Reversible, immediate.', handler: appearance_set },
  notification_subscribe: { category: TOOL_CATEGORIES.WRITE, destructive: false, description: 'Subscribe to a notification channel.', handler: notification_subscribe },
  notification_unsubscribe: { category: TOOL_CATEGORIES.WRITE, destructive: false, description: 'Unsubscribe from a notification channel.', handler: notification_unsubscribe },
  settings_recommend: { category: TOOL_CATEGORIES.WRITE, destructive: false, description: 'Record a REGULA recommendation without applying it.', handler: settings_recommend },
  settings_export: { category: TOOL_CATEGORIES.WRITE, destructive: false, description: 'Export a settings bundle.', handler: settings_export },
  settings_import: { category: TOOL_CATEGORIES.WRITE, destructive: true, description: 'Import a settings bundle. Routes through HITL.', handler: settings_import },
}

/**
 * Invoke a named tool with params and ctx. Returns the tool's result.
 * Unknown tool → { ok: false, error }.
 */
export async function invokeRegulaTool(toolName, params = {}, ctx = {}) {
  const tool = REGULA_TOOLS[toolName]
  if (!tool) return { ok: false, error: `Unknown REGULA tool: ${toolName}` }
  try {
    return await tool.handler(params, ctx)
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}

export function listRegulaTools() {
  return Object.entries(REGULA_TOOLS).map(([name, meta]) => ({
    name,
    category: meta.category,
    destructive: meta.destructive,
    description: meta.description,
  }))
}

export default REGULA_TOOLS
