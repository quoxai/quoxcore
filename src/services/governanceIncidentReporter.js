/**
 * MON-GOV-1d: Frontend governance incident reporter
 *
 * Registers a callback on the browser L3 PolicyGate so that any security
 * alert raised client-side is POSTed to the collector's governance
 * incidents API as a defence-in-depth signal. The authoritative
 * enforcement still lives in the collector (GOV-E pipeline + MON-GOV
 * emitter wrap); this path exists so browser-only rejections (e.g. L3
 * rate-limit hits that short-circuit before reaching the network) are
 * still visible on the incidents dashboard.
 */

import { setSecurityAlertCallback } from './layers/policyGate.js'

const ALLOWED_SEVERITIES = new Set(['high', 'medium', 'low', 'info'])

function normaliseSeverity(severity) {
  const s = String(severity || '').toLowerCase()
  // Clients cannot open critical-severity incidents (admin-gated on the API),
  // so downgrade to high before posting.
  if (s === 'critical') return 'high'
  return ALLOWED_SEVERITIES.has(s) ? s : 'low'
}

function buildCorr() {
  return `FRONTEND_L3_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`
}

async function postIncident(severity, message, details) {
  try {
    const body = {
      incident_type: 'policy_violation',
      severity: normaliseSeverity(severity),
      layer: 'L3',
      corr: buildCorr(),
      title: message || 'Browser-side policy alert',
      description: details?.message || message || '',
      agent_id: details?.agentId || null,
      context_json: {
        source: 'browser.policyGate',
        component: details?.component || 'PolicyGate',
        timestamp: details?.timestamp || new Date().toISOString(),
        details,
      },
    }
    const resp = await fetch('/collector/governance/incidents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      console.warn(
        `[MON-GOV] incident post failed (${resp.status}) — browser alert will remain console-only`,
      )
    }
  } catch (err) {
    console.warn('[MON-GOV] incident post threw (non-fatal):', err?.message || err)
  }
}

export function initGovernanceIncidentReporter() {
  setSecurityAlertCallback((severity, message, details) => {
    // Fire-and-forget — never block the caller.
    postIncident(severity, message, details)
  })
}
