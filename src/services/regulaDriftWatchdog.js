/**
 * regulaDriftWatchdog.js — REGULA's autonomous drift sweep.
 *
 * Phase 6 of SET-REGULA. Runs a bundle of health checks against the
 * current settings surface and emits findings as AEE envelopes on
 * AOCL Layer 11 (config.plane) + optional inbox items for human review.
 *
 * Checks:
 *   1. License expiry — flags if <=30 days remaining, critical if expired.
 *   2. Backup recency — flags if last successful backup is older than
 *      the configured schedule would predict.
 *   3. Plugin manifest drift — flags plugins installed but not active,
 *      or active plugins whose manifests have changed since last sweep.
 *   4. Destructive-setting posture — flags dangerous configurations
 *      (VOLT disabled, backups disabled, retention below compliance floor).
 *   5. Vault health — flags vault entries that have never been tested.
 *
 * Findings are plain JSON: { id, severity, settingId, message, detail }.
 * Severity ladder: 'info' < 'warning' < 'critical'.
 *
 * The sweep is PURE — it takes a context object (license, backups,
 * plugins, settings) and returns findings. Cron wiring and I/O happen
 * outside so the watchdog stays testable.
 */

import { emitAudit } from './settingsEmitter'
import { getDestructiveSettings } from '../config/settingsRegistry'

const SEVERITY_ORDER = { info: 0, warning: 1, critical: 2 }

function compareSeverity(a, b) {
  return (SEVERITY_ORDER[b] || 0) - (SEVERITY_ORDER[a] || 0)
}

// Compliance floor for retention — below this triggers a warning.
const RETENTION_FLOOR_DAYS = 90

// Hours without a successful backup before we warn.
const BACKUP_STALE_HOURS = {
  hourly: 4,
  daily: 36,
  weekly: 192,
}

// ─────────────────────────────────────────────────────────── checks

export function checkLicenseExpiry(licenseStatus) {
  const findings = []
  if (!licenseStatus) return findings

  const days = licenseStatus.days_remaining ?? licenseStatus.daysRemaining
  if (days == null) return findings

  if (days < 0) {
    findings.push({
      id: 'license.expired',
      severity: 'critical',
      settingId: 'license.status',
      message: `Licence expired ${Math.abs(days)} days ago.`,
      detail: {
        tier: licenseStatus.tier || (licenseStatus.tiers && licenseStatus.tiers[0]) || null,
        daysRemaining: days,
      },
    })
  } else if (days <= 7) {
    findings.push({
      id: 'license.expiring-soon',
      severity: 'critical',
      settingId: 'license.status',
      message: `Licence expires in ${days} day${days === 1 ? '' : 's'}.`,
      detail: { daysRemaining: days },
    })
  } else if (days <= 30) {
    findings.push({
      id: 'license.expiring',
      severity: 'warning',
      settingId: 'license.status',
      message: `Licence expires in ${days} days.`,
      detail: { daysRemaining: days },
    })
  }
  return findings
}

export function checkBackupRecency(backupStatus, { now = Date.now() } = {}) {
  const findings = []
  if (!backupStatus) return findings

  if (backupStatus.enabled === false) {
    findings.push({
      id: 'backup.disabled',
      severity: 'critical',
      settingId: 'backup.enabled',
      message: 'Automatic backups are disabled. No new restore points are being created.',
      detail: { enabled: false },
    })
    return findings
  }

  const lastRun = backupStatus.lastSuccessAt || backupStatus.last_success_at
  if (!lastRun) {
    findings.push({
      id: 'backup.never-run',
      severity: 'warning',
      settingId: 'backup.enabled',
      message: 'No successful backup has ever been recorded.',
      detail: {},
    })
    return findings
  }

  const ageMs = now - new Date(lastRun).getTime()
  const ageHours = ageMs / (1000 * 60 * 60)
  const schedule = backupStatus.schedule || 'daily'
  const threshold = BACKUP_STALE_HOURS[schedule] || BACKUP_STALE_HOURS.daily

  if (ageHours > threshold * 2) {
    findings.push({
      id: 'backup.critically-stale',
      severity: 'critical',
      settingId: 'backup.schedule',
      message: `Last successful backup was ${Math.round(ageHours)} hours ago — more than double the ${schedule} threshold.`,
      detail: { ageHours: Math.round(ageHours), schedule, threshold },
    })
  } else if (ageHours > threshold) {
    findings.push({
      id: 'backup.stale',
      severity: 'warning',
      settingId: 'backup.schedule',
      message: `Last successful backup was ${Math.round(ageHours)} hours ago, past the ${schedule} threshold of ${threshold}h.`,
      detail: { ageHours: Math.round(ageHours), schedule, threshold },
    })
  }
  return findings
}

export function checkPluginDrift(pluginState) {
  const findings = []
  if (!pluginState || !Array.isArray(pluginState.installed)) return findings

  const installed = pluginState.installed
  const activeIds = new Set((pluginState.active || []).map(p => p.id || p))

  for (const plugin of installed) {
    if (plugin.required && !activeIds.has(plugin.id)) {
      findings.push({
        id: `plugin.required-inactive:${plugin.id}`,
        severity: 'critical',
        settingId: `plugins.${plugin.id}`,
        message: `Required plugin "${plugin.name || plugin.id}" is installed but not active.`,
        detail: { pluginId: plugin.id, required: true },
      })
    }
    if (plugin.manifestChanged) {
      findings.push({
        id: `plugin.manifest-drift:${plugin.id}`,
        severity: 'warning',
        settingId: `plugins.${plugin.id}`,
        message: `Plugin "${plugin.name || plugin.id}" manifest has changed since the last sweep.`,
        detail: { pluginId: plugin.id },
      })
    }
  }
  return findings
}

export function checkDestructivePosture(settingsValues) {
  const findings = []
  if (!settingsValues) return findings

  // VOLT disabled → compliance evidence pipeline broken.
  if (settingsValues['plugins.volt'] === false) {
    findings.push({
      id: 'posture.volt-disabled',
      severity: 'critical',
      settingId: 'plugins.volt',
      message: 'VOLT is disabled. Hash-chained evidence receipts are not being generated.',
      detail: {},
    })
  }

  // WARD depends on VOLT and is itself required for sealed attestation.
  if (settingsValues['plugins.ward'] === false) {
    findings.push({
      id: 'posture.ward-disabled',
      severity: 'warning',
      settingId: 'plugins.ward',
      message: 'WARD is disabled. Daily seals are not being produced — evidence cannot be externally verified.',
      detail: {},
    })
  }

  // Retention floor — GDPR / SOC2 require at least 90 days of audit history.
  const retention = settingsValues['privacy.dataRetention']
  if (typeof retention === 'number' && retention < RETENTION_FLOOR_DAYS) {
    findings.push({
      id: 'posture.retention-below-floor',
      severity: 'warning',
      settingId: 'privacy.dataRetention',
      message: `Data retention is ${retention} days — below the ${RETENTION_FLOOR_DAYS}-day compliance floor.`,
      detail: { retention, floor: RETENTION_FLOOR_DAYS },
    })
  }

  const backupRetention = settingsValues['backup.retention']
  if (typeof backupRetention === 'number' && backupRetention < 30) {
    findings.push({
      id: 'posture.backup-retention-low',
      severity: 'warning',
      settingId: 'backup.retention',
      message: `Backup retention is ${backupRetention} days — consider at least 30 for recovery headroom.`,
      detail: { backupRetention },
    })
  }

  return findings
}

export function checkVaultHealth(vaultState) {
  const findings = []
  if (!vaultState || !Array.isArray(vaultState.entries)) return findings

  for (const entry of vaultState.entries) {
    if (entry.lastTestedAt == null) {
      findings.push({
        id: `vault.untested:${entry.id}`,
        severity: 'info',
        settingId: 'vault.listing',
        message: `Vault entry "${entry.label || entry.id}" has never been tested for connectivity.`,
        detail: { entryId: entry.id, type: entry.type || null },
      })
    } else if (entry.lastTestResult === 'failed') {
      findings.push({
        id: `vault.last-test-failed:${entry.id}`,
        severity: 'warning',
        settingId: 'vault.listing',
        message: `Vault entry "${entry.label || entry.id}" last connectivity test failed.`,
        detail: { entryId: entry.id },
      })
    }
  }
  return findings
}

// ───────────────────────────────────────────────────────── orchestration

/**
 * Run all drift checks against a context object and return findings.
 * PURE — does not emit or persist. Use `runDriftSweep` for the full pipeline.
 *
 * @param {object} ctx
 * @param {object} [ctx.license] - License status snapshot
 * @param {object} [ctx.backup]  - Backup status snapshot
 * @param {object} [ctx.plugins] - { installed, active }
 * @param {object} [ctx.settings] - flat id→value map of current settings
 * @param {object} [ctx.vault] - { entries: [{ id, label, lastTestedAt, lastTestResult }] }
 * @param {number} [ctx.now]
 */
export function collectFindings(ctx = {}) {
  const findings = [
    ...checkLicenseExpiry(ctx.license),
    ...checkBackupRecency(ctx.backup, { now: ctx.now }),
    ...checkPluginDrift(ctx.plugins),
    ...checkDestructivePosture(ctx.settings),
    ...checkVaultHealth(ctx.vault),
  ]
  findings.sort((a, b) => compareSeverity(a.severity, b.severity))
  return findings
}

/**
 * Run the full sweep: collect findings, emit an audit envelope, return
 * a structured result the caller can surface in the UI or inbox.
 */
export async function runDriftSweep(ctx = {}, { corr } = {}) {
  const findings = collectFindings(ctx)
  const summary = {
    total: findings.length,
    critical: findings.filter(f => f.severity === 'critical').length,
    warning: findings.filter(f => f.severity === 'warning').length,
    info: findings.filter(f => f.severity === 'info').length,
  }

  let envelope = null
  try {
    envelope = await emitAudit({
      findings,
      sweepType: 'drift',
      corr,
    })
  } catch (err) {
    console.warn('[REGULA] drift sweep emission failed:', err)
  }

  return {
    findings,
    summary,
    envelope,
    ranAt: new Date().toISOString(),
  }
}

/**
 * Produce a human-readable narration of findings for REGULA's chat.
 * Keeps the calm, deliberate warden tone.
 */
export function narrateFindings(findings) {
  if (!findings || findings.length === 0) {
    return 'All quiet. Nothing is drifting — your settings match the expected posture.'
  }
  const lines = [`I found ${findings.length} item${findings.length === 1 ? '' : 's'} worth your attention:`]
  for (const f of findings) {
    const prefix = f.severity === 'critical' ? '⚠' : f.severity === 'warning' ? '!' : '·'
    lines.push(`  ${prefix} [${f.severity}] ${f.message}`)
  }
  return lines.join('\n')
}

// ───────────────────────────────────────────────────────── helpers

/**
 * Build a snapshot of destructive-setting values from a getter.
 * The getter takes a setting id and returns the current value.
 * Used by callers that already have a settings store but want the
 * watchdog to sample just the destructive subset.
 */
export function snapshotDestructiveSettings(getValue) {
  if (typeof getValue !== 'function') return {}
  const snapshot = {}
  for (const meta of getDestructiveSettings()) {
    try {
      snapshot[meta.id] = getValue(meta.id)
    } catch {
      snapshot[meta.id] = undefined
    }
  }
  return snapshot
}

export default {
  checkLicenseExpiry,
  checkBackupRecency,
  checkPluginDrift,
  checkDestructivePosture,
  checkVaultHealth,
  collectFindings,
  runDriftSweep,
  narrateFindings,
  snapshotDestructiveSettings,
}
