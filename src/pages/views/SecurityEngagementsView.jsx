/**
 * SecurityEngagementsView (QUOX-SECURITY Phase 1, console redesign)
 *
 * Dashboard UI for the security testing engagement/scope substrate. Hits
 * the real REST API (services/collector/server.js's
 * /api/v1/security/engagements/* routes), no mocked data.
 *
 * List (no engagement selected) -> tabbed console (Overview/Targets/Tools/
 * Findings) once one is, with DRAGO's chat sidebar alongside, same
 * side-by-side pattern as BastionView (JANUS) / WazuhView (ARGUS).
 *
 * Tool execution is real: POST /api/v1/security/engagements/:id/capability/:tool
 * already accepted a normal authenticated user, no agent-only restriction
 * ever existed at the backend, this was purely a missing frontend button.
 * A run's outcome (success, policy denial, "command not found", or a real
 * result like "Connection refused") is rendered honestly either way, never
 * hidden or reframed as a failure of the UI.
 *
 * Glass design system only: qx-view/qx-card/qx-table/qx-field/qx-empty/
 * qx-banner/qx-tabs/qx-terminal-v2/qx-log-stream/qx-heatmap/qx-severity/
 * qx-cap, no bespoke per-view CSS beyond the shared .security-v2-layout/
 * .security-v2/.security-sidebar rules added alongside Bastion's/Wazuh's.
 */

import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import { PageLayout } from '../../components/layout'
import { useAuth } from '../../contexts/AuthContext'
import SecurityChatSidebar from '../../components/security/SecurityChatSidebar'
import {
  listEngagements, createEngagement, getEngagement,
  addTarget, verifyTarget, listFindings, reportFinding, verifyFinding,
  listCapabilityTools, startCapabilityToolJob, getScanJob, listScanJobs,
  fileFindingGripe, proposeFindingQuoxplan, downloadEngagementReportPdf,
  listSchedules, enableSchedule, disableSchedule,
  createSchedule, updateSchedule, deleteSchedule,
  resolveFinding, syncIssueStates, setGripeTarget,
  RISK_TIERS, ENVIRONMENT_TIERS, TARGET_TYPES, VERIFICATION_METHODS,
} from '../../services/securityEngagementClient'
import './views.css'
import './security-console.css'

function formatDate(iso) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString() } catch { return '—' }
}

// Relative time both ways: "in 3d" for a next run, "2h ago" for a last run.
function formatRelative(iso) {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const diffMs = then - Date.now()
  const future = diffMs >= 0
  const abs = Math.abs(diffMs)
  const s = Math.round(abs / 1000)
  const m = Math.round(s / 60)
  const h = Math.round(m / 60)
  const d = Math.round(h / 24)
  let val
  if (s < 60) val = `${s}s`
  else if (m < 60) val = `${m}m`
  else if (h < 24) val = `${h}h`
  else val = `${d}d`
  return future ? `in ${val}` : `${val} ago`
}

// interval_seconds -> "every 7 days". Picks the largest whole unit.
function formatInterval(seconds) {
  const n = Number(seconds)
  if (!n || n <= 0) return '—'
  const units = [['day', 86400], ['hour', 3600], ['minute', 60]]
  for (const [name, size] of units) {
    if (n >= size) {
      const count = Math.round(n / size)
      return `every ${count} ${name}${count === 1 ? '' : 's'}`
    }
  }
  return `every ${n}s`
}

function formatDuration(start, end) {
  if (!start || !end) return '—'
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (Number.isNaN(ms) || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

// last_status is free text ('queued' / 'denied: ...' / 'error: ...' / 'ok').
// Prefix-match, not equality, into a badge variant.
function statusVariant(status) {
  const s = String(status || '').toLowerCase()
  if (!s) return 'muted'
  if (s.startsWith('denied')) return 'danger'
  if (s.startsWith('error') || s.startsWith('fail')) return 'warn'
  if (s.startsWith('running')) return 'info'
  if (s.startsWith('queued') || s.startsWith('start') || s.startsWith('pending')) return 'muted'
  if (s.startsWith('ok') || s.startsWith('done') || s.startsWith('complet') || s.startsWith('success') || s.startsWith('changed') || s.startsWith('unchanged')) return 'ok'
  return 'muted'
}

function StatusBadge({ status, variant }) {
  const v = variant || statusVariant(status)
  return <span className={`qsec-badge qsec-badge--${v}`}>{status || '—'}</span>
}

// last_diff_json may carry arrays or plain counts; normalise either shape.
function diffCount(v) {
  if (Array.isArray(v)) return v.length
  if (typeof v === 'number') return v
  return 0
}

function parseDiff(raw) {
  if (!raw) return null
  let d = raw
  if (typeof raw === 'string') {
    try { d = JSON.parse(raw) } catch { return null }
  }
  if (!d || typeof d !== 'object') return null
  return {
    added: diffCount(d.added),
    removed: diffCount(d.removed),
    unchanged: diffCount(d.unchanged),
    newHighSeverity: diffCount(d.newHighSeverity),
  }
}

// output can be an array of finding lines or a single string blob.
function outputCount(result) {
  const out = result?.output
  if (Array.isArray(out)) return out.length
  if (typeof out === 'string' && out.trim()) return 1
  return 0
}

const TARGET_TYPE_LABELS = {
  domain: 'Domains',
  cidr: 'Hosts / CIDR',
  repo: 'Repositories',
  cloud_account: 'Cloud accounts',
}

// ── Arsenal metadata ──────────────────────────────────────────────────────
// Enriches the bare catalog (tool/binary/risk/description from the API) with
// the category, accent, and "what it finds" line that make the Tools tab read
// like a real toolkit instead of a form. Keyed by the short tool name the API
// returns (sectest_ prefix already stripped server-side).
const ICON = {
  radar: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" opacity="0.5" /><circle cx="12" cy="12" r="5" opacity="0.7" /><path d="M12 12L19 7" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  ),
  dns: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3z" opacity="0.6" />
    </svg>
  ),
  globe: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="14" rx="2" opacity="0.5" /><path d="M3 9h18M7 18v2M17 18v2M6 21h12" />
    </svg>
  ),
  lock: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4.5" y="10" width="15" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" opacity="0.6" /><circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  ),
  crosshair: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" opacity="0.85" />
    </svg>
  ),
  gripe: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="13" r="7" /><path d="M9 6l-1.5-2M15 6l1.5-2M9 13h.01M15 13h.01" /><path d="M5 13h14M12 20v-3" opacity="0.6" />
    </svg>
  ),
  quoxplan: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="3" width="14" height="18" rx="2" opacity="0.6" /><path d="M9 8h6M9 12h6M9 16h4" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 19h16" opacity="0.6" />
    </svg>
  ),
  sync: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5M3 21v-5h5" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  ),
  power: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v9" /><path d="M6.5 7a8 8 0 1 0 11 0" />
    </svg>
  ),
  chevron: (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  edit: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z" /><path d="M13.5 6.5l3 3" opacity="0.6" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /><path d="M10 11v6M14 11v6" opacity="0.6" />
    </svg>
  ),
}

const TOOL_META = {
  discover_hosts: { cat: 'recon', accent: 'var(--qsec-recon)', icon: ICON.radar, finds: 'subdomains of a domain' },
  resolve_dns: { cat: 'recon', accent: 'var(--qsec-recon)', icon: ICON.dns, finds: 'A / AAAA / CNAME records' },
  probe_http: { cat: 'web', accent: 'var(--qsec-web)', icon: ICON.globe, finds: 'live HTTP services, tech, titles' },
  inspect_tls: { cat: 'web', accent: 'var(--qsec-web)', icon: ICON.lock, finds: 'cert chain + TLS configuration' },
  vuln_scan: { cat: 'offensive', accent: 'var(--qsec-offensive)', icon: ICON.crosshair, finds: 'template-matched vulnerabilities' },
}
const CAT_ORDER = ['recon', 'web', 'offensive']
const CAT_LABELS = { recon: 'Reconnaissance', web: 'Web & TLS', offensive: 'Offensive' }
const CAT_ACCENT = { recon: 'var(--qsec-recon)', web: 'var(--qsec-web)', offensive: 'var(--qsec-offensive)' }

// ── CreateEngagementForm ─────────────────────────────────────────────────

function CreateEngagementForm({ onCreated, onCancel }) {
  const { authFetch } = useAuth()
  const [name, setName] = useState('')
  const [environmentTier, setEnvironmentTier] = useState('dev')
  const [riskCeiling, setRiskCeiling] = useState('discovery')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const engagement = await createEngagement({ authFetch, name, environmentTier, riskCeiling })
      onCreated(engagement)
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="qx-card" style={{ padding: 20 }}>
      <h3 style={{ margin: '0 0 16px', fontSize: 15, color: 'var(--m-text-primary)' }}>New engagement</h3>
      {error && <div className="qx-banner qx-banner--error" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="qx-field">
        <label className="qx-field__label qx-field__label--required">Name</label>
        <input type="text" className="qx-input" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="qx-row" style={{ gap: 16, marginTop: 12 }}>
        <div className="qx-field" style={{ flex: 1 }}>
          <label className="qx-field__label">Environment tier</label>
          <select className="qx-select" value={environmentTier} onChange={(e) => setEnvironmentTier(e.target.value)}>
            {ENVIRONMENT_TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="qx-field" style={{ flex: 1 }}>
          <label className="qx-field__label">Risk ceiling</label>
          <select className="qx-select" value={riskCeiling} onChange={(e) => setRiskCeiling(e.target.value)}>
            {RISK_TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          {environmentTier === 'production' && (
            <p className="qx-field__hint">Production is hard-capped at discovery risk, no elevation path yet.</p>
          )}
        </div>
      </div>
      <div className="qx-row" style={{ gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
        <button type="button" className="qx-btn qx-btn--ghost" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button type="submit" className="qx-btn qx-btn--primary" disabled={submitting || !name.trim()}>
          {submitting ? 'Creating…' : 'Create engagement'}
        </button>
      </div>
    </form>
  )
}

// ── AddTargetForm ────────────────────────────────────────────────────────

function AddTargetForm({ engagementId, onAdded, onCancel }) {
  const { authFetch } = useAuth()
  const [type, setType] = useState('domain')
  const [value, setValue] = useState('')
  const [verificationMethod, setVerificationMethod] = useState('dns_txt')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const target = await addTarget({ authFetch, engagementId, type, value, verificationMethod: verificationMethod || undefined })
      onAdded(target)
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="qx-card" style={{ padding: 20 }}>
      <h3 style={{ margin: '0 0 16px', fontSize: 15, color: 'var(--m-text-primary)' }}>Add target</h3>
      {error && <div className="qx-banner qx-banner--error" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="qx-row" style={{ gap: 16 }}>
        <div className="qx-field" style={{ width: 160 }}>
          <label className="qx-field__label">Type</label>
          <select className="qx-select" value={type} onChange={(e) => setType(e.target.value)}>
            {TARGET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="qx-field" style={{ flex: 1 }}>
          <label className="qx-field__label qx-field__label--required">Value</label>
          <input type="text" className="qx-input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="example.test" required />
        </div>
      </div>
      <div className="qx-field" style={{ marginTop: 12 }}>
        <label className="qx-field__label">Verification method</label>
        <select className="qx-select" value={verificationMethod} onChange={(e) => setVerificationMethod(e.target.value)}>
          {VERIFICATION_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          <option value="">none (cannot be verified, capability calls will be blocked)</option>
        </select>
        {verificationMethod === 'quoxagent_install' && (
          <p className="qx-field__hint">Proves control via real QuoxAgent fleet membership, use for internal hosts/VMs already carrying the sidecar. No token to publish.</p>
        )}
      </div>
      <div className="qx-row" style={{ gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
        <button type="button" className="qx-btn qx-btn--ghost" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button type="submit" className="qx-btn qx-btn--primary" disabled={submitting || !value.trim()}>
          {submitting ? 'Adding…' : 'Add target'}
        </button>
      </div>
    </form>
  )
}

// ── ReportFindingForm ────────────────────────────────────────────────────

function ReportFindingForm({ engagementId, targets, onAdded, onCancel }) {
  const { authFetch } = useAuth()
  const [targetValue, setTargetValue] = useState(targets[0]?.value || '')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState('info')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const finding = await reportFinding({ authFetch, engagementId, targetValue, title, description, severity })
      onAdded(finding)
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="qx-card" style={{ padding: 20 }}>
      <h3 style={{ margin: '0 0 16px', fontSize: 15, color: 'var(--m-text-primary)' }}>Report finding</h3>
      {error && <div className="qx-banner qx-banner--error" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="qx-row" style={{ gap: 16 }}>
        <div className="qx-field" style={{ flex: 1 }}>
          <label className="qx-field__label qx-field__label--required">Target</label>
          <select className="qx-select" value={targetValue} onChange={(e) => setTargetValue(e.target.value)} required>
            {targets.map((t) => <option key={t.id} value={t.value}>{t.value}</option>)}
          </select>
        </div>
        <div className="qx-field" style={{ width: 160 }}>
          <label className="qx-field__label">Severity</label>
          <select className="qx-select" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            {['info', 'low', 'medium', 'high', 'critical'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>
      <div className="qx-field" style={{ marginTop: 12 }}>
        <label className="qx-field__label qx-field__label--required">Title</label>
        <input type="text" className="qx-input" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div className="qx-field" style={{ marginTop: 12 }}>
        <label className="qx-field__label qx-field__label--required">Description</label>
        <textarea className="qx-textarea" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} required />
      </div>
      <div className="qx-row" style={{ gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
        <button type="button" className="qx-btn qx-btn--ghost" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button type="submit" className="qx-btn qx-btn--primary" disabled={submitting || !title.trim() || !description.trim() || !targetValue}>
          {submitting ? 'Reporting…' : 'Report finding'}
        </button>
      </div>
    </form>
  )
}

// ── GripeTargetCard ─────────────────────────────────────────────────────────
// Where findings raised from this engagement file as GitHub issues, and which
// org GitHub connector token files them. Null on both = the platform default
// (quoxai/quox) with the engagement own org token. A customer-site engagement
// living under an internal org points these at the customer repo + org.
function GripeTargetCard({ engagement, onChanged }) {
  const { authFetch } = useAuth()
  const [editing, setEditing] = useState(false)
  const [repo, setRepo] = useState(engagement.gripe_repo || '')
  const [connectorOrg, setConnectorOrg] = useState(engagement.gripe_connector_org_id || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const startEdit = () => {
    setRepo(engagement.gripe_repo || '')
    setConnectorOrg(engagement.gripe_connector_org_id || '')
    setError(null)
    setEditing(true)
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      await setGripeTarget({
        authFetch,
        engagementId: engagement.id,
        gripe_repo: repo.trim() || null,
        gripe_connector_org_id: connectorOrg.trim() || null,
      })
      setEditing(false)
      onChanged && onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="qx-card" style={{ padding: 20 }}>
      <div className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 15, color: 'var(--m-text-primary)' }}>Issue filing target</h3>
        {!editing && (
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={startEdit}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>
            Edit
          </button>
        )}
      </div>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--m-text-tertiary)' }}>
        Where a finding raised from this engagement files as a GitHub issue, and which org GitHub connector token files it.
      </p>

      {error && <div className="qx-banner qx-banner--error" style={{ marginBottom: 12 }}>{error}</div>}

      {editing ? (
        <div className="qx-stack" style={{ gap: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--m-text-secondary)' }}>
            Repo (owner/name)
            <input
              className="qx-input"
              style={{ marginTop: 4 }}
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="platform default (quoxai/quox)"
            />
          </label>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--m-text-secondary)' }}>
            Connector org id
            <input
              className="qx-input"
              style={{ marginTop: 4 }}
              value={connectorOrg}
              onChange={(e) => setConnectorOrg(e.target.value)}
              placeholder="engagement own org"
            />
          </label>
          <div className="qx-row" style={{ gap: 8 }}>
            <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" onClick={handleSave} disabled={saving}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8M7 3v5h8" /></svg>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setEditing(false)} disabled={saving}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="qx-stack" style={{ gap: 6 }}>
          <div className="qx-row" style={{ gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--m-text-tertiary)', minWidth: 96 }}>Repo</span>
            <span className="qsec-mono" style={{ fontSize: 12, color: 'var(--m-text-primary)' }}>{engagement.gripe_repo || 'platform default (quoxai/quox)'}</span>
          </div>
          <div className="qx-row" style={{ gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--m-text-tertiary)', minWidth: 96 }}>Connector org</span>
            <span className="qsec-mono" style={{ fontSize: 12, color: 'var(--m-text-primary)' }}>{engagement.gripe_connector_org_id || 'engagement own org'}</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ── OverviewTab ───────────────────────────────────────────────────────────

function OverviewTab({ engagement, targets, findings, onChanged }) {
  const verifiedCount = targets.filter((t) => t.verification_status === 'verified').length
  const candidateFindings = findings.filter((f) => f.status === 'candidate').length
  const criticalHigh = findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length

  return (
    <div className="qx-stack">
      {/* HUD: glass tiles, not bare text on the background */}
      <div className="qsec-hud">
        <div className="qsec-stat">
          <div className="qsec-stat__label">Environment</div>
          <div className="qsec-stat__value qsec-stat__value--sm">{engagement.environment_tier}</div>
          <div className="qsec-stat__sub">status: {engagement.status}</div>
        </div>
        <div className="qsec-stat" style={{ '--qsec-accent': 'var(--qsec-offensive)' }}>
          <div className="qsec-stat__label">Risk ceiling</div>
          <div className="qsec-stat__value qsec-stat__value--sm">{engagement.risk_ceiling}</div>
          <div className="qsec-stat__sub">max capability tier allowed</div>
        </div>
        <div className="qsec-stat" style={{ '--qsec-accent': 'var(--qsec-recon)' }}>
          <div className="qsec-stat__label">Targets verified</div>
          <div className="qsec-stat__value">{verifiedCount}<span style={{ opacity: 0.4, fontSize: 16 }}> / {targets.length}</span></div>
          <div className="qsec-stat__sub">{targets.length - verifiedCount} awaiting verification</div>
        </div>
        <div className="qsec-stat" style={{ '--qsec-accent': criticalHigh ? 'var(--qsec-offensive)' : 'var(--qsec-recon)' }}>
          <div className="qsec-stat__label">Findings</div>
          <div className="qsec-stat__value">{findings.length}<span style={{ opacity: 0.4, fontSize: 16 }}> ({candidateFindings} open)</span></div>
          <div className="qsec-stat__sub">{criticalHigh} critical / high</div>
        </div>
      </div>

      <div className="qx-card" style={{ padding: 20 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 15, color: 'var(--m-text-primary)' }}>Attack surface</h3>
        {targets.length === 0 ? (
          <div className="qx-empty"><p>No targets yet, add one in the Targets tab.</p></div>
        ) : (
          <div className="qx-heatmap">
            {targets.map((t) => {
              const status = t.verification_status === 'verified' ? 'healthy'
                : t.verification_status === 'failed' ? 'crit'
                : t.verification_status === 'unverified' ? 'unknown'
                : 'warn'
              const intensity = t.verification_status === 'verified' ? 0.75 : 0.25
              return (
                <div key={t.id} className={`qx-heatmap__cell qx-heatmap__cell--${status}`} style={{ '--qx-cell-intensity': intensity }}>
                  <span className="qx-heatmap__label qsec-mono">{t.value}</span>
                  <span className="qx-heatmap__val">{t.verification_status}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Governance, compact: the policy gate as a pipeline, not a slab of prose */}
      <div className="qsec-gate">
        <span className="qsec-gate__title">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l7 4v5c0 4.4-3 8.3-7 9-4-0.7-7-4.6-7-9V7l7-4z" /></svg>
          Every scan passes
        </span>
        <div className="qsec-gate__chain">
          <span className="qsec-gate__node">in scope</span>
          <span className="qsec-gate__arrow">→</span>
          <span className="qsec-gate__node">verified</span>
          <span className="qsec-gate__arrow">→</span>
          <span className="qsec-gate__node">risk ≤ {engagement.risk_ceiling}</span>
          <span className="qsec-gate__arrow">→</span>
          <span className="qsec-gate__node">in window</span>
        </div>
      </div>

      <GripeTargetCard engagement={engagement} onChanged={onChanged} />
    </div>
  )
}

// ── TargetsTab ────────────────────────────────────────────────────────────

function TargetsTab({ engagementId, targets, onChanged }) {
  const { authFetch } = useAuth()
  const [showAddTarget, setShowAddTarget] = useState(false)
  const [verifyingId, setVerifyingId] = useState(null)
  const [error, setError] = useState(null)

  const handleVerify = async (targetId) => {
    setVerifyingId(targetId)
    setError(null)
    try {
      await verifyTarget({ authFetch, engagementId, targetId })
      onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setVerifyingId(null)
    }
  }

  const grouped = targets.reduce((acc, t) => {
    (acc[t.type] = acc[t.type] || []).push(t)
    return acc
  }, {})

  return (
    <div className="qx-stack">
      <div className="qx-row" style={{ justifyContent: 'space-between' }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--m-text-tertiary)' }}>
          {targets.length} target{targets.length === 1 ? '' : 's'} across {Object.keys(grouped).length} attack-surface group{Object.keys(grouped).length === 1 ? '' : 's'}
        </p>
        {!showAddTarget && (
          <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" onClick={() => setShowAddTarget(true)}>Add target</button>
        )}
      </div>

      {error && <div className="qx-banner qx-banner--error">{error}</div>}

      {showAddTarget && (
        <AddTargetForm
          engagementId={engagementId}
          onAdded={() => { setShowAddTarget(false); onChanged() }}
          onCancel={() => setShowAddTarget(false)}
        />
      )}

      {targets.length === 0 ? (
        <div className="qx-empty"><p>No targets yet.</p></div>
      ) : (
        Object.entries(grouped).map(([type, group]) => (
          <div key={type} className="qx-card" style={{ padding: 20 }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--m-text-primary)' }}>
              {TARGET_TYPE_LABELS[type] || type} <span className="qx-pill qx-pill--muted qx-pill--sm">{group.length}</span>
            </h3>
            <div style={{ overflowX: 'auto' }}>
              <table className="qx-table">
                <thead>
                  <tr><th>Value</th><th>Verification</th><th>Status</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {group.map((t) => (
                    <tr key={t.id}>
                      <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{t.value}</td>
                      <td>{t.verification_method || '—'}</td>
                      <td>
                        <span className={`qx-pill${t.verification_status === 'verified' ? '' : ' qx-pill--muted'}`}>
                          {t.verification_status}
                        </span>
                      </td>
                      <td>
                        {t.verification_status !== 'verified' && t.verification_method && (
                          <button
                            type="button"
                            className="qx-row-action"
                            disabled={verifyingId === t.id}
                            onClick={() => handleVerify(t.id)}
                            style={{ padding: '2px 8px', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6, fontSize: 12 }}
                          >
                            {verifyingId === t.id ? 'Checking…' : 'Check verification'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  )
}

// ── ToolsTab ──────────────────────────────────────────────────────────────

const RISK_CAP_CLASS = { passive: 'read', discovery: 'read', safe_active: 'write', intrusive: 'exec', credential_sensitive: 'exec', exploit_emulation: 'exec' }

function ToolCard({ tool, verifiedTargets, allowedRisk, onRun, running }) {
  const [target, setTarget] = useState(verifiedTargets[0]?.value || '')
  const overRisk = RISK_TIERS.indexOf(tool.capabilityRisk) > RISK_TIERS.indexOf(allowedRisk)
  const meta = TOOL_META[tool.tool] || {}
  const accent = meta.accent || 'var(--qsec-ember)'

  return (
    <div className={`qsec-tool${overRisk ? ' qsec-tool--locked' : ''}`} style={{ '--qsec-accent': accent }}>
      <div className="qsec-tool__top">
        <div className="qsec-tool__icon">{meta.icon}</div>
        <div className="qsec-tool__id">
          <div className="qsec-tool__name">{tool.tool}</div>
          <div className="qsec-tool__bin">{tool.binary}</div>
        </div>
        <span className={`qx-cap qx-cap--${RISK_CAP_CLASS[tool.capabilityRisk] || 'read'} qsec-tool__risk`}><span className="qx-cap__dot" />{tool.capabilityRisk}</span>
      </div>
      <p className="qsec-tool__desc">{tool.description}</p>
      {meta.finds && (
        <div className="qsec-tool__finds"><span>finds</span><b>{meta.finds}</b></div>
      )}
      {overRisk ? (
        <div className="qsec-tool__hint">🔒 Above this engagement's ceiling ({allowedRisk}). Raise the risk ceiling to unlock.</div>
      ) : verifiedTargets.length === 0 ? (
        <div className="qsec-tool__hint">No verified targets yet, verify one in the Targets tab.</div>
      ) : (
        <div className="qsec-tool__run">
          <select className="qx-select" value={target} onChange={(e) => setTarget(e.target.value)}>
            {verifiedTargets.map((t) => <option key={t.id} value={t.value}>{t.value}</option>)}
          </select>
          <button
            type="button"
            className="qx-btn qx-btn--primary qx-btn--sm"
            disabled={running || !target}
            onClick={() => onRun(tool.tool, target)}
          >
            {running ? 'Running…' : 'Run'}
          </button>
        </div>
      )}
    </div>
  )
}

const JOB_POLL_MS = 1500

function ToolsTab({ engagement, targets }) {
  const { authFetch } = useAuth()
  const [tools, setTools] = useState(null)
  const [error, setError] = useState(null)
  const [runs, setRuns] = useState([])
  const pollTimers = useRef({})

  useEffect(() => {
    listCapabilityTools({ authFetch }).then(setTools).catch((err) => setError(err.message))
    return () => {
      Object.values(pollTimers.current).forEach(clearTimeout)
    }
  }, [authFetch])

  const verifiedTargets = targets.filter((t) => t.verification_status === 'verified')
  const activeTools = new Set(runs.filter((r) => r.status === 'queued' || r.status === 'running').map((r) => r.tool))

  const pollJob = (runKey, jobId) => {
    const tick = async () => {
      try {
        const job = await getScanJob({ authFetch, jobId })
        setRuns((prev) => prev.map((r) => (r.key === runKey ? { ...r, status: job.status, result: job.result, error: job.error } : r)))
        if (job.status === 'queued' || job.status === 'running') {
          pollTimers.current[runKey] = setTimeout(tick, JOB_POLL_MS)
        } else {
          delete pollTimers.current[runKey]
        }
      } catch (err) {
        setRuns((prev) => prev.map((r) => (r.key === runKey ? { ...r, status: 'failed', error: err.message } : r)))
        delete pollTimers.current[runKey]
      }
    }
    pollTimers.current[runKey] = setTimeout(tick, JOB_POLL_MS)
  }

  const handleRun = async (tool, target) => {
    const startedAt = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const key = `${tool}-${Date.now()}`
    setRuns((prev) => [{ key, tool, target, startedAt, status: 'starting' }, ...prev])
    try {
      const started = await startCapabilityToolJob({ authFetch, engagementId: engagement.id, tool, target })
      if (started.allowed === false) {
        setRuns((prev) => prev.map((r) => (r.key === key ? { ...r, status: 'denied', error: started.error } : r)))
        return
      }
      setRuns((prev) => prev.map((r) => (r.key === key ? { ...r, status: 'queued', jobId: started.job_id } : r)))
      pollJob(key, started.job_id)
    } catch (err) {
      setRuns((prev) => prev.map((r) => (r.key === key ? { ...r, status: 'failed', error: err.message } : r)))
    }
  }

  if (error) return <div className="qx-banner qx-banner--error">{error}</div>
  if (!tools) return <div className="qx-empty"><p>Loading tool catalog…</p></div>

  const anyActive = activeTools.size > 0

  const readyCount = verifiedTargets.length > 0
    ? tools.filter((t) => RISK_TIERS.indexOf(t.capabilityRisk) <= RISK_TIERS.indexOf(engagement.risk_ceiling)).length
    : 0
  const byCat = CAT_ORDER
    .map((cat) => ({ cat, tools: tools.filter((t) => (TOOL_META[t.tool]?.cat || 'recon') === cat) }))
    .filter((g) => g.tools.length > 0)

  return (
    <div className="qx-stack">
      <div className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--m-text-tertiary)' }}>
          {tools.length}-tool arsenal · <strong style={{ color: 'var(--m-text-primary)' }}>{readyCount}</strong> ready at this engagement's ceiling
        </p>
        <span className="qx-pill qx-pill--muted qx-pill--sm">{engagement.risk_ceiling} ceiling</span>
      </div>

      {byCat.map(({ cat, tools: catTools }) => (
        <div key={cat}>
          <div className="qsec-arsenal-head" style={{ '--qsec-accent': CAT_ACCENT[cat] }}>
            <span className="qsec-arsenal-head__dot" />
            {CAT_LABELS[cat]}
            <span className="qsec-arsenal-head__count">{catTools.length} tool{catTools.length === 1 ? '' : 's'}</span>
          </div>
          <div className="qsec-tools-grid">
            {catTools.map((t) => (
              <ToolCard
                key={t.tool}
                tool={t}
                verifiedTargets={verifiedTargets}
                allowedRisk={engagement.risk_ceiling}
                onRun={handleRun}
                running={activeTools.has(t.tool)}
              />
            ))}
          </div>
        </div>
      ))}

      <div className="qx-terminal-v2">
        <div className="qx-terminal-v2__head">
          <span className="qx-terminal-v2__title">{engagement.name} : capability runs</span>
          <span className="qx-terminal-v2__chip"><span className={`qx-dot qx-dot--sm ${anyActive ? 'qx-dot--online' : ''}`} /> {anyActive ? 'RUNNING' : 'IDLE'}</span>
        </div>
        <div className="qx-terminal-v2__body">
          {runs.length === 0 ? (
            <span style={{ opacity: 0.6 }}>No tool runs yet. Pick a target above and hit Run.</span>
          ) : runs.map((r) => (
            <div key={r.key} className="qsec-term-line" style={{ marginBottom: 10 }}>
              <span className="qx-terminal-v2__prompt">sectest_{r.tool}</span>:<span className="qx-terminal-v2__user">{r.target}</span>$ <span style={{ opacity: 0.5 }}>{r.startedAt}</span>
              {r.jobId && <span style={{ opacity: 0.4, fontSize: 11 }}> job:{r.jobId}</span>}
              {'\n'}
              {r.status === 'starting' || r.status === 'queued' ? (
                <span style={{ opacity: 0.6 }}>{r.status === 'starting' ? 'starting…' : 'queued…'}</span>
              ) : r.status === 'running' ? (
                <span style={{ color: 'var(--qx-accent-cyan, #4ecdc4)' }}>running…</span>
              ) : r.status === 'denied' ? (
                <span style={{ color: 'var(--qx-danger, #ff6b6b)' }}>DENIED: {r.error}</span>
              ) : r.status === 'failed' ? (
                <span style={{ color: 'var(--qx-warn, #ffb020)' }}>{r.error || 'command failed'}</span>
              ) : (
                <span className="qx-terminal-v2__ok">
                  {Array.isArray(r.result?.output) ? (r.result.output.length ? r.result.output.join('\n') : '(no output)') : (r.result?.output || '(no output)')}
                </span>
              )}
            </div>
          ))}
          <span className="qx-terminal-v2__cursor"></span>
        </div>
      </div>
    </div>
  )
}

// ── FindingActionBar ─────────────────────────────────────────────────────
// Turns a single finding into filed work: Raise as Gripe (GitHub issue),
// Propose as QuoxPlan (a note on the QUOX-SECURITY stream), Download PDF
// (the whole engagement report, same action as the header button — kept
// here too since a reviewer working one finding at a time still wants it
// close at hand). Fail-soft: a GitHub-not-configured response renders an
// honest inline message, never a fake success.

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function FindingActionBar({ engagementId, finding, onChanged }) {
  const { authFetch } = useAuth()
  const [busy, setBusy] = useState(null) // 'gripe' | 'quoxplan' | 'pdf' | null
  const [message, setMessage] = useState(null) // { kind: 'error'|'info', text }

  const handleGripe = async () => {
    setBusy('gripe'); setMessage(null)
    try {
      const result = await fileFindingGripe({ authFetch, findingId: finding.id })
      if (result.configured === false) {
        setMessage({ kind: 'info', text: result.message || 'GitHub not configured.' })
      } else if (result.ok === false) {
        setMessage({ kind: 'error', text: result.message || 'GitHub connection rejected.' })
      } else if (result.alreadyFiled) {
        setMessage({ kind: 'info', text: `Already filed: ${result.url}` })
      } else {
        setMessage({ kind: 'info', text: `Filed: ${result.url}` })
        onChanged()
      }
    } catch (err) {
      setMessage({ kind: 'error', text: err.message })
    } finally {
      setBusy(null)
    }
  }

  const handleQuoxplan = async () => {
    setBusy('quoxplan'); setMessage(null)
    try {
      const result = await proposeFindingQuoxplan({ authFetch, findingId: finding.id })
      setMessage({ kind: 'info', text: `Proposed on ${result.streamId}.` })
      onChanged()
    } catch (err) {
      setMessage({ kind: 'error', text: err.message })
    } finally {
      setBusy(null)
    }
  }

  const handleDownload = async () => {
    setBusy('pdf'); setMessage(null)
    try {
      const blob = await downloadEngagementReportPdf({ authFetch, engagementId })
      triggerBlobDownload(blob, `quox-security-${engagementId}.pdf`)
    } catch (err) {
      setMessage({ kind: 'error', text: err.message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="qx-row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={busy === 'gripe'} onClick={handleGripe}>
          {ICON.gripe} {busy === 'gripe' ? 'Filing…' : 'Raise issue'}
        </button>
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={busy === 'quoxplan'} onClick={handleQuoxplan}>
          {ICON.quoxplan} {busy === 'quoxplan' ? 'Proposing…' : 'Propose as QuoxPlan'}
        </button>
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={busy === 'pdf'} onClick={handleDownload}>
          {ICON.download} {busy === 'pdf' ? 'Preparing…' : 'Download PDF'}
        </button>
      </div>
      {message && (
        <p style={{ margin: '6px 0 0', fontSize: 11, color: message.kind === 'error' ? 'var(--m-danger, #e05a5a)' : 'var(--m-text-tertiary)', wordBreak: 'break-all' }}>
          {message.text}
        </p>
      )}
      {(finding.gripe_url || finding.quoxplan_ref) && (
        <div className="qx-row" style={{ gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
          {finding.gripe_url && (
            <a href={finding.gripe_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: 'var(--m-accent-cyan, #4ecdc4)' }}>
              Issue →
            </a>
          )}
          {finding.quoxplan_ref && (
            <a href={finding.quoxplan_ref} style={{ fontSize: 11, color: 'var(--m-accent-cyan, #4ecdc4)' }}>
              QuoxPlan proposal →
            </a>
          )}
        </div>
      )}
    </div>
  )
}

// ── FindingsTab ───────────────────────────────────────────────────────────

function FindingsTab({ engagementId, targets, findings, onChanged }) {
  const { authFetch } = useAuth()
  const [showReport, setShowReport] = useState(false)
  const [verifyingId, setVerifyingId] = useState(null)
  const [reasonDraft, setReasonDraft] = useState({})
  const [error, setError] = useState(null)
  const [reportBusy, setReportBusy] = useState(false)
  const [reportError, setReportError] = useState(null)

  const handleVerify = async (findingId, verdict) => {
    const reason = reasonDraft[findingId]
    if (!reason?.trim()) { setError('A reason is required to confirm or refute a finding.'); return }
    setVerifyingId(findingId)
    setError(null)
    try {
      await verifyFinding({ authFetch, findingId, verdict, reason })
      onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setVerifyingId(null)
    }
  }

  const handleDownloadReport = async () => {
    setReportBusy(true); setReportError(null)
    try {
      const blob = await downloadEngagementReportPdf({ authFetch, engagementId })
      triggerBlobDownload(blob, `quox-security-${engagementId}.pdf`)
    } catch (err) {
      setReportError(err.message)
    } finally {
      setReportBusy(false)
    }
  }

  return (
    <div className="qx-stack">
      <div className="qx-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--m-text-tertiary)' }}>
          {findings.length} finding{findings.length === 1 ? '' : 's'}
        </p>
        <div className="qx-row" style={{ gap: 8 }}>
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={reportBusy} onClick={handleDownloadReport}>
            {ICON.download} {reportBusy ? 'Preparing…' : 'Download engagement PDF'}
          </button>
          {!showReport && targets.length > 0 && (
            <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" onClick={() => setShowReport(true)}>Report finding</button>
          )}
        </div>
      </div>

      {reportError && <div className="qx-banner qx-banner--error">{reportError}</div>}
      {error && <div className="qx-banner qx-banner--error">{error}</div>}

      {showReport && (
        <ReportFindingForm
          engagementId={engagementId}
          targets={targets}
          onAdded={() => { setShowReport(false); onChanged() }}
          onCancel={() => setShowReport(false)}
        />
      )}

      {findings.length === 0 ? (
        <div className="qx-empty"><p>No findings reported yet.</p></div>
      ) : (
        findings.map((f) => (
          <div key={f.id} className="qx-card" style={{ padding: 16 }}>
            <div className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--m-text-primary)' }}>{f.title}</div>
                <div style={{ fontSize: 12, color: 'var(--m-text-tertiary)', fontFamily: 'monospace', marginTop: 2 }}>{f.target_value}</div>
              </div>
              <div className="qx-row" style={{ gap: 6 }}>
                <span className={`qx-severity qx-severity--${f.severity}`}>{f.severity}</span>
                <span className={`qx-pill${f.status === 'confirmed' ? '' : f.status === 'refuted' ? ' qx-pill--muted' : ''}`}>{f.status}</span>
              </div>
            </div>
            <p style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--m-text-secondary, #ddd)' }}>{f.description}</p>
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--m-text-tertiary)' }}>Reported {formatDate(f.created_at)}</div>
            {f.status === 'candidate' && (
              <div className="qx-row" style={{ gap: 8, marginTop: 12 }}>
                <input
                  type="text"
                  className="qx-input"
                  style={{ flex: 1 }}
                  placeholder="Reason (required to confirm or refute)"
                  value={reasonDraft[f.id] || ''}
                  onChange={(e) => setReasonDraft((prev) => ({ ...prev, [f.id]: e.target.value }))}
                />
                <button type="button" className="qx-btn qx-btn--sm" disabled={verifyingId === f.id} onClick={() => handleVerify(f.id, 'confirmed')}>Confirm</button>
                <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={verifyingId === f.id} onClick={() => handleVerify(f.id, 'refuted')}>Refute</button>
              </div>
            )}
            <FindingActionBar engagementId={engagementId} finding={f} onChanged={onChanged} />
          </div>
        ))
      )}
    </div>
  )
}

// ── HistoryTab ────────────────────────────────────────────────────────────
// The durable record of every scan job, server-side. The Tools tab keeps its
// live polling for in-flight runs; History is the persistent log that survives
// a refresh, newest-first, with each run's raw findings on expand.

function HistoryTab({ engagementId }) {
  const { authFetch } = useAuth()
  const [jobs, setJobs] = useState(null)
  const [error, setError] = useState(null)
  const [expandedId, setExpandedId] = useState(null)

  useEffect(() => {
    let alive = true
    listScanJobs({ authFetch, engagementId })
      .then((data) => { if (alive) setJobs(data) })
      .catch((err) => { if (alive) setError(err.message) })
    return () => { alive = false }
  }, [authFetch, engagementId])

  if (error) return <div className="qx-banner qx-banner--error">{error}</div>
  if (!jobs) return <div className="qx-empty"><p>Loading scan history…</p></div>
  if (jobs.length === 0) return <div className="qx-empty"><p>No scan jobs recorded yet. Runs from the Tools tab land here.</p></div>

  const sorted = [...jobs].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))

  return (
    <div className="qx-stack">
      <p style={{ margin: 0, fontSize: 13, color: 'var(--m-text-tertiary)' }}>
        {jobs.length} scan job{jobs.length === 1 ? '' : 's'} on the durable record
      </p>
      <div className="qx-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="qx-table">
            <thead>
              <tr><th></th><th>Tool</th><th>Target</th><th>Status</th><th>Started</th><th>Finished</th><th>Duration</th><th>Findings</th><th>Source</th></tr>
            </thead>
            <tbody>
              {sorted.map((job) => {
                const open = expandedId === job.id
                const findingLines = Array.isArray(job.result?.output) ? job.result.output : (job.result?.output ? [job.result.output] : [])
                return (
                  <Fragment key={job.id}>
                    <tr onClick={() => setExpandedId(open ? null : job.id)} style={{ cursor: 'pointer' }}>
                      <td style={{ color: 'var(--m-text-tertiary)' }}>
                        <span className="qsec-chevron" style={{ display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s ease' }}>{ICON.chevron}</span>
                      </td>
                      <td className="qsec-mono" style={{ fontSize: 12 }}>{job.tool}</td>
                      <td className="qsec-mono" style={{ fontSize: 12 }}>{job.target}</td>
                      <td><StatusBadge status={job.status} /></td>
                      <td style={{ fontSize: 12, color: 'var(--m-text-tertiary)' }}>{formatRelative(job.started_at)}</td>
                      <td style={{ fontSize: 12, color: 'var(--m-text-tertiary)' }}>{formatRelative(job.finished_at)}</td>
                      <td style={{ fontSize: 12 }}>{formatDuration(job.started_at, job.finished_at)}</td>
                      <td style={{ fontSize: 12 }}>{outputCount(job.result)}</td>
                      <td>{job.schedule_id ? <span className="qsec-badge qsec-badge--info">scheduled</span> : <span className="qsec-badge qsec-badge--muted">manual</span>}</td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={9} style={{ padding: 0 }}>
                          <div className="qx-terminal-v2" style={{ margin: 12 }}>
                            <div className="qx-terminal-v2__head">
                              <span className="qx-terminal-v2__title">sectest_{job.tool} : {job.target}</span>
                              <span className="qx-terminal-v2__chip">{findingLines.length} line{findingLines.length === 1 ? '' : 's'}</span>
                            </div>
                            <div className="qx-terminal-v2__body">
                              {job.error ? (
                                <span className="qsec-term-line" style={{ color: 'var(--qx-danger, #ff6b6b)' }}>{job.error}</span>
                              ) : findingLines.length === 0 ? (
                                <span style={{ opacity: 0.6 }}>(no output)</span>
                              ) : (
                                findingLines.map((line, i) => (
                                  <div key={i} className="qsec-term-line">{typeof line === 'string' ? line : JSON.stringify(line)}</div>
                                ))
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── SchedulesTab ──────────────────────────────────────────────────────────
// Recurring scans as durable server-side schedules: cadence, next/last run,
// last status and the diff its last run produced. Enable/disable toggles hit
// the collector and reload.

// Cadence label for a stored schedule: cron rows read their expression, an
// interval row reads its seconds.
function formatCadence(s) {
  if (s.schedule_kind === 'cron') return s.cron_expression ? `cron ${s.cron_expression}` : 'cron'
  return formatInterval(s.interval_seconds)
}

// Bare capability tool names to fall back on if the live catalog cannot load,
// so the form is never empty. Matches the recon/web/offensive TOOL_META set.
const STATIC_TOOL_NAMES = ['discover_hosts', 'resolve_dns', 'probe_http', 'inspect_tls', 'vuln_scan']

// ── ScheduleForm ──────────────────────────────────────────────────────────
// Create AND edit share this one form. `existing` null = create (POST); a
// schedule object = edit (PATCH), prefilled from that row. Target is a select
// of verified, in-scope targets; tool a select of bare capability names;
// cadence a toggle between an interval (seconds, min 300) and a 5-field UTC
// cron. Validation errors from the backend render inline.

function ScheduleForm({ engagementId, targets, toolNames, existing, onSaved, onCancel }) {
  const { authFetch } = useAuth()
  const isEdit = !!existing
  const verified = targets.filter((t) => t.verification_status === 'verified')
  // Edit may reference a target/tool no longer in the current lists; keep it
  // selectable so a save does not silently drop it.
  const targetOptions = [...new Set([...(isEdit && existing.target_value ? [existing.target_value] : []), ...verified.map((t) => t.value)])]
  const toolOptions = [...new Set([...(isEdit && existing.tool ? [existing.tool] : []), ...toolNames])]

  const [targetValue, setTargetValue] = useState(existing?.target_value || targetOptions[0] || '')
  const [tool, setTool] = useState(existing?.tool || toolOptions[0] || '')
  const [kind, setKind] = useState(existing?.schedule_kind || 'interval')
  const [intervalSeconds, setIntervalSeconds] = useState(
    existing && existing.schedule_kind !== 'cron' && existing.interval_seconds ? String(existing.interval_seconds) : '86400'
  )
  const [cronExpr, setCronExpr] = useState(existing?.cron_expression || '0 2 * * 3')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      if (kind === 'interval') {
        const secs = parseInt(intervalSeconds, 10)
        if (!Number.isInteger(secs) || secs < 300) {
          throw new Error('Interval must be a whole number of seconds, at least 300.')
        }
      }
      if (isEdit) {
        const patch = { scheduleId: existing.id, target_value: targetValue, tool, schedule_kind: kind }
        if (kind === 'cron') patch.cron_expression = cronExpr.trim()
        else patch.interval_seconds = parseInt(intervalSeconds, 10)
        await updateSchedule({ authFetch, ...patch })
      } else {
        const args = { authFetch, engagementId, target_value: targetValue, tool, schedule_kind: kind }
        if (kind === 'cron') args.cron_expression = cronExpr.trim()
        else args.interval_seconds = parseInt(intervalSeconds, 10)
        await createSchedule(args)
      }
      onSaved()
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const noTargets = targetOptions.length === 0

  return (
    <form onSubmit={handleSubmit} className="qx-card" style={{ padding: 20 }}>
      <h3 style={{ margin: '0 0 16px', fontSize: 15, color: 'var(--m-text-primary)' }}>{isEdit ? 'Edit schedule' : 'New schedule'}</h3>
      {error && <div className="qx-banner qx-banner--error" style={{ marginBottom: 12 }}>{error}</div>}
      {noTargets && !isEdit && (
        <div className="qx-banner qx-banner--warn" style={{ marginBottom: 12 }}>No verified targets yet. Verify a target in the Targets tab before scheduling a scan.</div>
      )}
      <div className="qx-row" style={{ gap: 16, flexWrap: 'wrap' }}>
        <div className="qx-field" style={{ flex: 1, minWidth: 200 }}>
          <label className="qx-field__label qx-field__label--required">Target</label>
          <select className="qx-select" value={targetValue} onChange={(e) => setTargetValue(e.target.value)} disabled={noTargets}>
            {targetOptions.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div className="qx-field" style={{ flex: 1, minWidth: 160 }}>
          <label className="qx-field__label qx-field__label--required">Tool</label>
          <select className="qx-select" value={tool} onChange={(e) => setTool(e.target.value)}>
            {toolOptions.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>
      <div className="qsec-sched-cadence">
        <label className="qx-field__label">Cadence</label>
        <div className="qsec-sched-cadence__toggle">
          <label className={`qsec-sched-cadence__opt ${kind === 'interval' ? 'is-active' : ''}`}>
            <input type="radio" name="sched-kind" checked={kind === 'interval'} onChange={() => setKind('interval')} />
            Interval
          </label>
          <label className={`qsec-sched-cadence__opt ${kind === 'cron' ? 'is-active' : ''}`}>
            <input type="radio" name="sched-kind" checked={kind === 'cron'} onChange={() => setKind('cron')} />
            Cron
          </label>
        </div>
        {kind === 'interval' ? (
          <div className="qx-field" style={{ marginTop: 10 }}>
            <input
              type="number"
              min="300"
              step="1"
              className="qx-input"
              value={intervalSeconds}
              onChange={(e) => setIntervalSeconds(e.target.value)}
            />
            <p className="qx-field__hint">Seconds between runs, minimum 300. {formatInterval(parseInt(intervalSeconds, 10) || 0) !== '—' ? `Runs ${formatInterval(parseInt(intervalSeconds, 10) || 0)}.` : ''}</p>
          </div>
        ) : (
          <div className="qx-field" style={{ marginTop: 10 }}>
            <input
              type="text"
              className="qx-input qsec-mono"
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              placeholder="0 2 * * 3"
            />
            <p className="qx-field__hint">minute hour day-of-month month day-of-week, UTC. Example: 0 2 * * 3 runs every Wednesday 02:00.</p>
          </div>
        )}
      </div>
      <div className="qx-row" style={{ gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
        <button type="button" className="qx-btn qx-btn--ghost" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button type="submit" className="qx-btn qx-btn--primary" disabled={submitting || !targetValue || !tool}>
          {ICON.check} {submitting ? 'Saving…' : (isEdit ? 'Save changes' : 'Create schedule')}
        </button>
      </div>
    </form>
  )
}

function SchedulesTab({ engagementId, targets }) {
  const { authFetch } = useAuth()
  const [schedules, setSchedules] = useState(null)
  const [toolNames, setToolNames] = useState(STATIC_TOOL_NAMES)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState(null)

  const load = useCallback(() => {
    setError(null)
    listSchedules({ authFetch, engagementId })
      .then(setSchedules)
      .catch((err) => setError(err.message))
  }, [authFetch, engagementId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    listCapabilityTools({ authFetch })
      .then((tools) => {
        const names = (tools || []).map((t) => t.tool).filter(Boolean)
        if (names.length) setToolNames(names)
      })
      .catch(() => { /* keep the static fallback */ })
  }, [authFetch])

  const handleToggle = async (schedule) => {
    setBusyId(schedule.id)
    setError(null)
    try {
      if (schedule.enabled) await disableSchedule({ authFetch, scheduleId: schedule.id })
      else await enableSchedule({ authFetch, scheduleId: schedule.id })
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (schedule) => {
    if (!window.confirm(`Delete this schedule (${schedule.tool} on ${schedule.target_value})? This cannot be undone.`)) return
    setBusyId(schedule.id)
    setError(null)
    try {
      await deleteSchedule({ authFetch, scheduleId: schedule.id })
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  const openCreate = () => { setEditing(null); setShowForm(true) }
  const openEdit = (schedule) => { setEditing(schedule); setShowForm(true) }
  const closeForm = () => { setShowForm(false); setEditing(null) }
  const onSaved = () => { closeForm(); load() }

  if (error && !schedules) return <div className="qx-banner qx-banner--error">{error}</div>
  if (!schedules) return <div className="qx-empty"><p>Loading schedules…</p></div>

  return (
    <div className="qx-stack">
      {error && <div className="qx-banner qx-banner--error">{error}</div>}
      <div className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--m-text-tertiary)' }}>
          {schedules.length} recurring scan{schedules.length === 1 ? '' : 's'} · {schedules.filter((s) => s.enabled).length} enabled
        </p>
        {!showForm && (
          <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" onClick={openCreate}>
            {ICON.plus} New schedule
          </button>
        )}
      </div>
      {showForm && (
        <ScheduleForm
          engagementId={engagementId}
          targets={targets || []}
          toolNames={toolNames}
          existing={editing}
          onSaved={onSaved}
          onCancel={closeForm}
        />
      )}
      {schedules.length === 0 ? (
        <div className="qx-empty"><p>No recurring scans scheduled. Schedules run server-side on their cadence, independent of any open tab.</p></div>
      ) : (
        schedules.map((s) => {
          const diff = parseDiff(s.last_diff_json)
          return (
            <div key={s.id} className="qx-card" style={{ padding: 16 }}>
              <div className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--m-text-primary)' }} className="qsec-mono">{s.tool}</div>
                  <div style={{ fontSize: 12, color: 'var(--m-text-tertiary)', marginTop: 2 }} className="qsec-mono">{s.target_value}</div>
                </div>
                <div className="qx-row" style={{ gap: 8, alignItems: 'center' }}>
                  <span className={`qsec-badge qsec-badge--${s.enabled ? 'ok' : 'muted'}`}>{s.enabled ? 'enabled' : 'disabled'}</span>
                  <button
                    type="button"
                    className="qx-btn qx-btn--ghost qx-btn--sm"
                    disabled={busyId === s.id}
                    onClick={() => handleToggle(s)}
                  >
                    {ICON.power} {busyId === s.id ? 'Saving…' : (s.enabled ? 'Disable' : 'Enable')}
                  </button>
                  <button
                    type="button"
                    className="qx-btn qx-btn--ghost qx-btn--sm"
                    disabled={busyId === s.id}
                    onClick={() => openEdit(s)}
                  >
                    {ICON.edit} Edit
                  </button>
                  <button
                    type="button"
                    className="qx-btn qx-btn--ghost qx-btn--sm"
                    disabled={busyId === s.id}
                    onClick={() => handleDelete(s)}
                  >
                    {ICON.trash} Delete
                  </button>
                </div>
              </div>
              <div className="qsec-sched-meta">
                <div><span>Cadence</span><b>{formatCadence(s)}</b></div>
                <div><span>Next run</span><b>{formatRelative(s.next_run_at)}</b></div>
                <div><span>Last run</span><b>{formatRelative(s.last_run_at)}</b></div>
                <div><span>Last status</span><b>{s.last_status ? <StatusBadge status={s.last_status} /> : '—'}</b></div>
              </div>
              {diff && (
                <div className="qx-row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  <span className="qsec-badge qsec-badge--ok">+{diff.added} added</span>
                  <span className="qsec-badge qsec-badge--muted">-{diff.removed} removed</span>
                  <span className="qsec-badge qsec-badge--muted">{diff.unchanged} unchanged</span>
                  {diff.newHighSeverity > 0 && <span className="qsec-badge qsec-badge--danger">{diff.newHighSeverity} new high severity</span>}
                </div>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}

// ── PostureTab ────────────────────────────────────────────────────────────
// Cross-site security posture: every engagement's open findings, high/critical
// load, last-scan age and schedule health on one board, with a roll-up header.

function PostureCard({ engagement }) {
  const { authFetch } = useAuth()
  const [data, setData] = useState(null)

  useEffect(() => {
    let alive = true
    Promise.all([
      listFindings({ authFetch, engagementId: engagement.id }).catch(() => []),
      listScanJobs({ authFetch, engagementId: engagement.id }).catch(() => []),
      listSchedules({ authFetch, engagementId: engagement.id }).catch(() => []),
    ]).then(([findings, jobs, schedules]) => {
      if (!alive) return
      const open = findings.filter((f) => f.status === 'candidate' || f.status === 'confirmed')
      const highCrit = findings.filter((f) => (f.severity === 'high' || f.severity === 'critical') && f.status !== 'resolved' && f.status !== 'refuted')
      const criticalOpen = open.filter((f) => f.severity === 'critical').length
      const finishedJobs = jobs.filter((j) => j.finished_at).map((j) => new Date(j.finished_at).getTime())
      const lastScan = finishedJobs.length ? new Date(Math.max(...finishedJobs)).toISOString() : null
      const enabledSchedules = schedules.filter((s) => s.enabled)
      const nextRuns = enabledSchedules.map((s) => s.next_run_at).filter(Boolean).map((t) => new Date(t).getTime())
      const soonestNext = nextRuns.length ? new Date(Math.min(...nextRuns)).toISOString() : null
      setData({ open: open.length, highCrit: highCrit.length, criticalOpen, lastScan, enabledSchedules: enabledSchedules.length, soonestNext })
    })
    return () => { alive = false }
  }, [authFetch, engagement.id])

  const tierVariant = engagement.environment_tier === 'production' ? 'danger' : engagement.environment_tier === 'staging' ? 'warn' : 'muted'

  return (
    <div className="qsec-posture-card" style={{ '--qsec-accent': data?.criticalOpen ? 'var(--qsec-offensive)' : 'var(--qsec-recon)' }}>
      <div className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--m-text-primary)', overflowWrap: 'anywhere', minWidth: 0 }}>{engagement.name}</div>
        <span className={`qsec-badge qsec-badge--${tierVariant}`}>{engagement.environment_tier}</span>
      </div>
      {!data ? (
        <div style={{ fontSize: 12, color: 'var(--m-text-tertiary)', marginTop: 10 }}>Loading…</div>
      ) : (
        <>
          <div className="qsec-posture-metrics">
            <div><b>{data.open}</b><span>open findings</span></div>
            <div><b style={{ color: data.highCrit ? 'var(--qsec-ember)' : undefined }}>{data.highCrit}</b><span>high / critical</span></div>
            <div><b>{formatRelative(data.lastScan)}</b><span>last scan</span></div>
          </div>
          <div className="qx-row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <span className={`qsec-badge qsec-badge--${data.enabledSchedules ? 'ok' : 'muted'}`}>{data.enabledSchedules} schedule{data.enabledSchedules === 1 ? '' : 's'}</span>
            {data.soonestNext && <span className="qsec-badge qsec-badge--info">next {formatRelative(data.soonestNext)}</span>}
          </div>
        </>
      )}
    </div>
  )
}

function PostureTab() {
  const { authFetch } = useAuth()
  const [engagements, setEngagements] = useState(null)
  const [error, setError] = useState(null)
  const [totalCriticals, setTotalCriticals] = useState(null)

  useEffect(() => {
    let alive = true
    listEngagements({ authFetch })
      .then(async (list) => {
        if (!alive) return
        setEngagements(list)
        // Roll-up: total open criticals across every site.
        const perSite = await Promise.all(list.map((e) =>
          listFindings({ authFetch, engagementId: e.id })
            .then((fs) => fs.filter((f) => f.severity === 'critical' && (f.status === 'candidate' || f.status === 'confirmed')).length)
            .catch(() => 0)
        ))
        if (alive) setTotalCriticals(perSite.reduce((a, b) => a + b, 0))
      })
      .catch((err) => { if (alive) setError(err.message) })
    return () => { alive = false }
  }, [authFetch])

  if (error) return <div className="qx-banner qx-banner--error">{error}</div>
  if (!engagements) return <div className="qx-empty"><p>Loading posture across sites…</p></div>
  if (engagements.length === 0) return <div className="qx-empty"><p>No engagements to report posture on yet.</p></div>

  return (
    <div className="qx-stack">
      <div className="qsec-stat" style={{ '--qsec-accent': totalCriticals ? 'var(--qsec-offensive)' : 'var(--qsec-recon)' }}>
        <div className="qsec-stat__label">Open criticals across all sites</div>
        <div className="qsec-stat__value">{totalCriticals == null ? '…' : totalCriticals}<span style={{ opacity: 0.4, fontSize: 16 }}> across {engagements.length} engagement{engagements.length === 1 ? '' : 's'}</span></div>
        <div className="qsec-stat__sub">unresolved critical-severity findings, whole estate</div>
      </div>
      <div className="qsec-posture-grid">
        {engagements.map((e) => <PostureCard key={e.id} engagement={e} />)}
      </div>
    </div>
  )
}

// ── IssuesTab ─────────────────────────────────────────────────────────────
// Issues raised AND fixed: findings that carry a filed issue link, their state
// (candidate/confirmed/resolved/refuted), a per-finding Mark resolved, and a
// tab-level Sync that reconciles every linked finding against its upstream.

function IssuesTab({ engagementId, findings, onChanged }) {
  const { authFetch } = useAuth()
  const [busyId, setBusyId] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)

  const issueFindings = findings.filter((f) => f.gripe_url)

  const handleResolve = async (findingId) => {
    setBusyId(findingId)
    setError(null)
    try {
      await resolveFinding({ authFetch, findingId })
      onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    setError(null)
    setMessage(null)
    try {
      const result = await syncIssueStates({ authFetch, engagementId })
      if (result.configured === false) {
        setMessage('GitHub is not configured, nothing to sync.')
      } else {
        const resolved = Array.isArray(result.resolved) ? result.resolved.length : 0
        const errs = Array.isArray(result.errors) ? result.errors.length : 0
        setMessage(`Checked ${result.checked ?? 0} linked issue${result.checked === 1 ? '' : 's'}, ${resolved} newly resolved${errs ? `, ${errs} error${errs === 1 ? '' : 's'}` : ''}.`)
      }
      onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="qx-stack">
      <div className="qx-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--m-text-tertiary)' }}>
          {issueFindings.length} finding{issueFindings.length === 1 ? '' : 's'} with a filed issue · {issueFindings.filter((f) => f.status === 'resolved').length} fixed
        </p>
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={syncing} onClick={handleSync}>
          {ICON.sync} {syncing ? 'Syncing…' : 'Sync issue states'}
        </button>
      </div>

      {message && <div className="qx-banner">{message}</div>}
      {error && <div className="qx-banner qx-banner--error">{error}</div>}

      {issueFindings.length === 0 ? (
        <div className="qx-empty"><p>No findings have a filed issue yet. Raise one from the Findings tab.</p></div>
      ) : (
        issueFindings.map((f) => {
          const fixed = f.status === 'resolved'
          return (
            <div key={f.id} className={`qx-card${fixed ? ' qsec-issue--fixed' : ''}`} style={{ padding: 16 }}>
              <div className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--m-text-primary)', overflowWrap: 'anywhere' }}>{f.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--m-text-tertiary)', marginTop: 2 }} className="qsec-mono">{f.target_value}</div>
                </div>
                <div className="qx-row" style={{ gap: 6, alignItems: 'center' }}>
                  <span className={`qx-severity qx-severity--${f.severity}`}>{f.severity}</span>
                  <span className={`qsec-badge qsec-badge--${fixed ? 'fixed' : f.status === 'confirmed' ? 'warn' : f.status === 'refuted' ? 'muted' : 'info'}`}>
                    {fixed ? 'fixed' : f.status}
                  </span>
                </div>
              </div>
              <div className="qx-row" style={{ gap: 12, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <a href={f.gripe_url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--m-accent-cyan, #4ecdc4)' }} className="qsec-mono">
                  {f.gripe_url} →
                </a>
                {fixed && f.resolved_at && (
                  <span style={{ fontSize: 11, color: 'var(--m-text-tertiary)' }}>Resolved {formatDate(f.resolved_at)}</span>
                )}
              </div>
              {!fixed && (
                <div className="qx-row" style={{ gap: 8, marginTop: 12 }}>
                  <button type="button" className="qx-btn qx-btn--sm" disabled={busyId === f.id} onClick={() => handleResolve(f.id)}>
                    {ICON.check} {busyId === f.id ? 'Resolving…' : 'Mark resolved'}
                  </button>
                </div>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}

// ── EngagementConsole ─────────────────────────────────────────────────────

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'targets', label: 'Targets' },
  { id: 'tools', label: 'Tools' },
  { id: 'history', label: 'History' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'findings', label: 'Findings' },
  { id: 'issues', label: 'Issues' },
  { id: 'posture', label: 'Posture' },
]

function EngagementConsole({ engagementId, onBack }) {
  const { authFetch } = useAuth()
  const [engagement, setEngagement] = useState(null)
  const [targets, setTargets] = useState([])
  const [findings, setFindings] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('overview')
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    Promise.all([
      getEngagement({ authFetch, id: engagementId }),
      listFindings({ authFetch, engagementId }).catch(() => []),
    ])
      .then(([detail, findingsData]) => {
        setEngagement(detail.engagement)
        setTargets(detail.targets)
        setFindings(findingsData)
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [authFetch, engagementId])

  useEffect(() => { load() }, [load])

  if (loading) return <div className="qx-empty"><p>Loading engagement…</p></div>
  if (error) return <div className="qx-banner qx-banner--error">{error}</div>
  if (!engagement) return <div className="qx-empty"><p>Engagement not found.</p></div>

  return (
    <div className="security-v2-layout">
      <div className="security-v2">
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onBack} style={{ alignSelf: 'flex-start', marginBottom: 12 }}>
          ← Back to engagements
        </button>

        <div className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, color: 'var(--m-text-primary)' }}>{engagement.name}</h2>
            <p className="qsec-mono" style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--m-text-tertiary)' }}>{engagement.id}</p>
          </div>
          <span className="qx-pill">{engagement.status}</span>
        </div>

        <div className="qx-tabs" role="tablist" aria-label="Engagement tabs" style={{ marginBottom: 16 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`qx-tab${tab === t.id ? ' qx-tab--active' : ''}`}
              role="tab"
              aria-selected={tab === t.id}
              type="button"
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === 'findings' && findings.length > 0 && <span className="qx-pill qx-pill--sm qx-pill--muted" style={{ marginLeft: 6 }}>{findings.length}</span>}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {tab === 'overview' && <OverviewTab engagement={engagement} targets={targets} findings={findings} onChanged={load} />}
          {tab === 'targets' && <TargetsTab engagementId={engagementId} targets={targets} onChanged={load} />}
          {tab === 'tools' && <ToolsTab engagement={engagement} targets={targets} />}
          {tab === 'history' && <HistoryTab engagementId={engagementId} />}
          {tab === 'schedules' && <SchedulesTab engagementId={engagementId} targets={targets} />}
          {tab === 'findings' && <FindingsTab engagementId={engagementId} targets={targets} findings={findings} onChanged={load} />}
          {tab === 'issues' && <IssuesTab engagementId={engagementId} findings={findings} onChanged={load} />}
          {tab === 'posture' && <PostureTab />}
        </div>
      </div>

      {sidebarOpen ? (
        <aside className="security-sidebar">
          <SecurityChatSidebar activeTab={tab} engagement={engagement} targets={targets} onClose={() => setSidebarOpen(false)} />
        </aside>
      ) : (
        <button
          className="qx-btn qx-btn--sm"
          style={{ position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)', zIndex: 10, writingMode: 'vertical-rl', padding: '12px 6px' }}
          onClick={() => setSidebarOpen(true)}
          title="Open DRAGO"
        >
          DRAGO
        </button>
      )}
    </div>
  )
}

// ── EngagementList ───────────────────────────────────────────────────────

function EngagementList({ onSelect }) {
  const { authFetch } = useAuth()
  const [engagements, setEngagements] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showCreate, setShowCreate] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    listEngagements({ authFetch })
      .then(setEngagements)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [authFetch])

  useEffect(() => { load() }, [load])

  if (loading) return <div className="qx-empty"><p>Loading engagements…</p></div>
  if (error) return <div className="qx-banner qx-banner--error">{error}</div>

  return (
    <div className="qx-stack">
      <div className="qx-row" style={{ justifyContent: 'space-between' }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--m-text-tertiary)' }}>
          {(engagements || []).length} engagement{(engagements || []).length === 1 ? '' : 's'}
        </p>
        {!showCreate && (
          <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" onClick={() => setShowCreate(true)}>
            New engagement
          </button>
        )}
      </div>

      {showCreate && (
        <CreateEngagementForm
          onCreated={() => { setShowCreate(false); load() }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {(!engagements || engagements.length === 0) ? (
        <div className="qx-empty">
          <p>No engagements yet.</p>
          <p style={{ fontSize: 12, color: 'var(--m-text-tertiary)' }}>
            An engagement is the authorization container every capability call is checked against: environment tier, risk ceiling, and verified targets.
          </p>
        </div>
      ) : (
        <div className="qx-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="qx-table">
              <thead>
                <tr><th>Name</th><th>Environment</th><th>Risk ceiling</th><th>Status</th><th>Created</th></tr>
              </thead>
              <tbody>
                {engagements.map((e) => (
                  <tr key={e.id} onClick={() => onSelect(e.id)} style={{ cursor: 'pointer' }}>
                    <td style={{ color: 'var(--m-accent-cyan, #4ecdc4)' }}>{e.name}</td>
                    <td>{e.environment_tier}</td>
                    <td>{e.risk_ceiling}</td>
                    <td><span className="qx-pill">{e.status}</span></td>
                    <td style={{ color: 'var(--m-text-tertiary)', fontSize: 12 }}>{formatDate(e.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ── SecurityEngagementsView ──────────────────────────────────────────────

export default function SecurityEngagementsView() {
  const [selectedId, setSelectedId] = useState(null)

  return (
    <PageLayout>
      <div className="qx-view">
        <div style={{ marginBottom: 16 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--m-text-primary)' }}>
            QUOX-SECURITY
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--m-text-tertiary)' }}>
            Security testing engagements: authorization, scope, target verification, and real capability tools
            (subfinder, httpx, nuclei, dig, openssl), each gated by the same policy check every path uses.
          </p>
        </div>

        {selectedId
          ? <EngagementConsole engagementId={selectedId} onBack={() => setSelectedId(null)} />
          : (
            <div className="qx-card" style={{ padding: 20 }}>
              <EngagementList onSelect={setSelectedId} />
            </div>
          )}
      </div>
    </PageLayout>
  )
}
