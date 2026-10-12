/**
 * OnboardView — visual tenant onboarding wizard
 *
 * Mirrors the `quox onboard <host>` CLI as one guided, idempotent flow:
 * creates a customer tenant (org + roadmap) and its governed security setup
 * (engagement + verified target + gripe target + recurring scan), and captures
 * the GitHub PAT securely inline — the dashboard's advantage over the CLI,
 * which stops at that gate.
 *
 * Every step is check-before-create, so re-running resumes cleanly: a second
 * run shows existing/done rather than duplicating anything. Auth conventions
 * are kept straight: securityEngagementClient + org/vault calls take authFetch;
 * createRoadmap uses its own cookie-through-proxy fetch.
 *
 * Glass design system only: qx-card/qx-stack/qx-row/qx-input/qx-textarea/
 * qx-hint/qx-btn plus the shared .qsec-badge status variants.
 */

import { useState } from 'react'
import { PageLayout } from '../../components/layout'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import {
  listEngagements, createEngagement, getEngagement,
  addTarget, verifyTarget, setGripeTarget,
  createSchedule, listSchedules,
  ENVIRONMENT_TIERS,
} from '../../services/securityEngagementClient'
import { listDevServers } from '../../services/devServersClient'
import { api as quoxplanApi, ApiError } from '../../services/quoxplanApiClient.js'
import './security-console.css'

// ── Icons (repo rule: every button carries an inline SVG) ──────────────────
function PlayIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  )
}
function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────
function slug(name) {
  return (name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// IP / CIDR -> cidr, scheme or host:port -> url, otherwise a hostname -> domain
function inferType(value) {
  const v = (value || '').trim()
  if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(v)) return 'cidr'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /:\d+(\/|$)/.test(v)) return 'url'
  return 'domain'
}

const STATUS_VARIANT = {
  pending: 'qsec-badge--muted',
  running: 'qsec-badge--info',
  done: 'qsec-badge--ok',
  waiting: 'qsec-badge--warn',
  error: 'qsec-badge--danger',
}
const STATUS_LABEL = {
  pending: 'pending', running: 'running', done: 'done', waiting: 'waiting', error: 'error',
}

const STEP_DEFS = [
  { key: 'org', label: 'Organisation' },
  { key: 'roadmap', label: 'Delivery roadmap' },
  { key: 'engagement', label: 'Security engagement' },
  { key: 'target', label: 'Scan target' },
  { key: 'github', label: 'GitHub connector' },
  { key: 'gripe', label: 'Gripe target' },
  { key: 'schedule', label: 'Recurring scan' },
  { key: 'summary', label: 'Summary' },
]

function freshSteps() {
  return STEP_DEFS.map(s => ({ ...s, status: 'pending', message: '' }))
}

export default function OnboardView() {
  const { authFetch } = useAuth()
  const { createOrg } = useWorkspace()

  // Form state
  const [hostId, setHostId] = useState('')
  const [name, setName] = useState('')
  const [repo, setRepo] = useState('')
  const [target, setTarget] = useState('')
  const [envTier, setEnvTier] = useState('dev')
  const [cron, setCron] = useState('0 2 * * 3')
  const [pat, setPat] = useState('')

  // Host check
  const [hostCheck, setHostCheck] = useState(null) // { checking, checked, found, verified, error }

  // Run state
  const [steps, setSteps] = useState(freshSteps())
  const [running, setRunning] = useState(false)
  const [summary, setSummary] = useState(null) // populated on finish/stop
  const [complete, setComplete] = useState(false)

  const effectiveTarget = (target.trim() || hostId.trim())

  function setStep(key, status, message) {
    setSteps(prev => prev.map(s => (s.key === key ? { ...s, status, message: message || '' } : s)))
  }

  async function checkHost() {
    const id = hostId.trim()
    if (!id) return
    setHostCheck({ checking: true })
    try {
      const servers = await listDevServers({ authFetch })
      const match = servers.find(s => s.host_id === id)
      setHostCheck({ checked: true, found: !!match, verified: !!match?.profile_verified })
    } catch (err) {
      setHostCheck({ checked: true, error: err.message })
    }
  }

  async function runOnboarding() {
    if (running || !name.trim()) return
    setRunning(true)
    setComplete(false)
    setSummary(null)
    setSteps(freshSteps())

    const ctx = {
      name: name.trim(),
      repo: repo.trim(),
      target: effectiveTarget,
      envTier,
      cron: cron.trim(),
      orgId: null,
      roadmapId: slug(name),
      engagementId: null,
      targetVerified: false,
    }

    // Ordered, idempotent step runners. A runner may return
    // { stop: true, status, message } to halt cleanly (the PAT gate).
    const runners = {
      async org() {
        const res = await authFetch('/api/orgs')
        let existing = null
        if (res.ok) {
          const data = await res.json().catch(() => ({}))
          const list = data.organizations || data.orgs || []
          existing = list.find(o => (o.name || '').toLowerCase() === ctx.name.toLowerCase())
        }
        if (existing) {
          ctx.orgId = existing.id
          return { message: `[existing] ${ctx.orgId}` }
        }
        const created = await createOrg({ name: ctx.name })
        ctx.orgId = created.id
        return { message: `[created] ${ctx.orgId}` }
      },

      async roadmap() {
        try {
          await quoxplanApi.createRoadmap({ id: ctx.roadmapId, name: `${ctx.name} delivery` })
          return { message: `[created] ${ctx.roadmapId}` }
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) {
            return { message: `[existing] ${ctx.roadmapId}` }
          }
          throw err
        }
      },

      async engagement() {
        const engName = `${ctx.name} security`
        const list = await listEngagements({ authFetch })
        const existing = list.find(e => (e.name || '').toLowerCase() === engName.toLowerCase())
        if (existing) {
          ctx.engagementId = existing.id
          return { message: `[existing] ${ctx.engagementId}` }
        }
        const created = await createEngagement({
          authFetch, name: engName, environmentTier: ctx.envTier, riskCeiling: 'safe_active',
        })
        ctx.engagementId = created.id
        return { message: `[created] ${ctx.engagementId}` }
      },

      async target() {
        if (!ctx.target) return { status: 'waiting', message: 'no target supplied, skipped' }
        const { targets } = await getEngagement({ authFetch, id: ctx.engagementId })
        let t = (targets || []).find(x => x.value === ctx.target)
        if (!t) {
          t = await addTarget({
            authFetch, engagementId: ctx.engagementId,
            type: inferType(ctx.target), value: ctx.target,
            verificationMethod: 'quoxagent_install',
          })
        }
        if (t && !t.verified) {
          try {
            const verified = await verifyTarget({ authFetch, engagementId: ctx.engagementId, targetId: t.id })
            t = verified || t
          } catch { /* verification is best-effort; report unverified below */ }
        }
        ctx.targetVerified = !!t?.verified
        return { message: `${ctx.target} — verified: ${ctx.targetVerified}` }
      },

      async github() {
        if (!pat.trim()) {
          return { stop: true, status: 'waiting', message: 'add a GitHub PAT to enable gripe + scheduled scans' }
        }
        // Skip if the org already has a github connector.
        try {
          const r = await authFetch(`/api/orgs/${ctx.orgId}/integrations`)
          if (r.ok) {
            const d = await r.json().catch(() => ({}))
            const list = Array.isArray(d) ? d : (d.integrations || d.credentials || [])
            if (list.some(i => (i.integration_type || i.type) === 'github')) {
              return { message: '[existing] github connector present' }
            }
          }
        } catch { /* fall through to create; a duplicate is treated as ok below */ }

        const resp = await authFetch(`/api/orgs/${ctx.orgId}/integrations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            integration_type: 'github',
            label: `GitHub (${ctx.name})`,
            credentials: { token: pat.trim() },
            auth_type: 'api_key',
            is_default: true,
            description: `GitHub PAT for ${ctx.name}`,
          }),
        })
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}))
          const msg = (body?.error || body?.message || '').toLowerCase()
          if (resp.status === 409 || msg.includes('exist') || msg.includes('duplicate')) {
            return { message: '[existing] github connector present' }
          }
          throw new Error(body?.error || body?.message || `Failed to store PAT: HTTP ${resp.status}`)
        }
        return { message: '[created] github connector' }
      },

      async gripe() {
        await setGripeTarget({
          authFetch, engagementId: ctx.engagementId,
          gripe_repo: ctx.repo, gripe_connector_org_id: ctx.orgId,
        })
        return { message: ctx.repo ? `findings -> ${ctx.repo}` : 'platform default repo' }
      },

      async schedule() {
        const list = await listSchedules({ authFetch, engagementId: ctx.engagementId })
        const existing = (list || []).find(s => s.target_value === ctx.target && s.tool === 'vuln_scan')
        if (existing) return { message: `[existing] ${existing.cron_expression || existing.schedule_kind}` }
        await createSchedule({
          authFetch, engagementId: ctx.engagementId,
          tool: 'vuln_scan', target_value: ctx.target,
          schedule_kind: 'cron', cron_expression: ctx.cron,
        })
        return { message: `[created] cron ${ctx.cron}` }
      },

      async summary() {
        return { message: 'tenant ready' }
      },
    }

    let stopped = false
    for (const def of STEP_DEFS) {
      setStep(def.key, 'running')
      try {
        const result = await runners[def.key]()
        if (result?.stop) {
          setStep(def.key, result.status || 'waiting', result.message)
          stopped = true
          break
        }
        setStep(def.key, result?.status || 'done', result?.message)
      } catch (err) {
        setStep(def.key, 'error', err.message)
        stopped = true
        break
      }
    }

    setSummary({
      orgId: ctx.orgId,
      roadmapId: ctx.roadmapId,
      engagementId: ctx.engagementId,
      target: ctx.target,
      targetVerified: ctx.targetVerified,
      repo: ctx.repo,
      cron: ctx.cron,
    })
    setComplete(!stopped)
    setRunning(false)
  }

  return (
    <PageLayout>
      <div className="qx-view" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ marginBottom: 16 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--m-text-primary)' }}>
            Onboard a tenant
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--m-text-tertiary)' }}>
            One guided, idempotent flow that mirrors <span className="qx-mono">quox onboard &lt;host&gt;</span>: it
            creates the customer org and delivery roadmap, stands up a governed security engagement with a verified
            target, and captures the GitHub PAT inline so gripe filing and scheduled scans work end to end. Re-running
            resumes cleanly.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
          {/* ── Form ── */}
          <div className="qx-card" style={{ padding: 20 }}>
            <div className="qx-stack">
              <label className="qx-stack qx-stack--tight">
                <span className="qx-hint qx-hint--sm">Host id</span>
                <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                  <input
                    className="qx-input"
                    placeholder="e.g. acme-dev01"
                    value={hostId}
                    onChange={e => setHostId(e.target.value)}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <button
                    type="button"
                    className="qx-btn qx-btn--sm qx-btn--ghost"
                    onClick={checkHost}
                    disabled={!hostId.trim() || hostCheck?.checking}
                  >
                    <SearchIcon /> {hostCheck?.checking ? 'Checking' : 'Check host'}
                  </button>
                </div>
                {hostCheck?.checked && (
                  hostCheck.error
                    ? <span className={`qsec-badge ${STATUS_VARIANT.error}`}>check failed: {hostCheck.error}</span>
                    : !hostCheck.found
                      ? <span className={`qsec-badge ${STATUS_VARIANT.warn || 'qsec-badge--warn'}`}>host not in registry</span>
                      : <span className={`qsec-badge ${hostCheck.verified ? 'qsec-badge--ok' : 'qsec-badge--warn'}`}>
                          {hostCheck.verified ? 'profile verified' : 'unverified'}
                        </span>
                )}
              </label>

              <label className="qx-stack qx-stack--tight">
                <span className="qx-hint qx-hint--sm">Customer name <span style={{ color: 'var(--m-danger, #ff9b82)' }}>*</span></span>
                <input className="qx-input" placeholder="e.g. Acme Ltd" value={name} onChange={e => setName(e.target.value)} />
                {name.trim() && <span className="qx-hint qx-hint--sm qx-mono">roadmap id: {slug(name) || '(needs letters or digits)'}</span>}
              </label>

              <label className="qx-stack qx-stack--tight">
                <span className="qx-hint qx-hint--sm">GitHub repo (owner/name)</span>
                <input className="qx-input" placeholder="acme/infra" value={repo} onChange={e => setRepo(e.target.value)} />
              </label>

              <label className="qx-stack qx-stack--tight">
                <span className="qx-hint qx-hint--sm">Scan target host / IP</span>
                <input className="qx-input" placeholder={hostId.trim() || 'host or IP to scan'} value={target} onChange={e => setTarget(e.target.value)} />
                {!target.trim() && hostId.trim() && <span className="qx-hint qx-hint--sm">defaults to host id: {hostId.trim()}</span>}
              </label>

              <label className="qx-stack qx-stack--tight">
                <span className="qx-hint qx-hint--sm">Environment tier</span>
                <select className="qx-input" value={envTier} onChange={e => setEnvTier(e.target.value)}>
                  {ENVIRONMENT_TIERS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>

              <label className="qx-stack qx-stack--tight">
                <span className="qx-hint qx-hint--sm">Schedule (cron)</span>
                <input className="qx-input qx-mono" placeholder="0 2 * * 3" value={cron} onChange={e => setCron(e.target.value)} />
              </label>

              <label className="qx-stack qx-stack--tight">
                <span className="qx-hint qx-hint--sm">GitHub PAT</span>
                <input
                  className="qx-input"
                  type="password"
                  placeholder="Paste the customer's GitHub PAT"
                  value={pat}
                  onChange={e => setPat(e.target.value)}
                  autoComplete="new-password"
                />
                <span className="qx-hint qx-hint--sm">
                  Stored server-side only, never reaches the browser after setup. Leave blank to stop before the
                  gripe and scheduled-scan steps, which need the connector.
                </span>
              </label>

              <div className="qx-row qx-row--apart" style={{ marginTop: 4 }}>
                <span className="qx-hint qx-hint--sm">{running ? 'Running…' : complete ? 'Complete' : 'Ready'}</span>
                <button
                  type="button"
                  className="qx-btn qx-btn--primary"
                  onClick={runOnboarding}
                  disabled={running || !name.trim()}
                >
                  <PlayIcon /> {running ? 'Running…' : 'Run onboarding'}
                </button>
              </div>
            </div>
          </div>

          {/* ── Progress + summary ── */}
          <div className="qx-stack">
            <div className="qx-card" style={{ padding: 20 }}>
              <h2 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700 }}>Progress</h2>
              <div className="qx-stack qx-stack--tight">
                {steps.map(s => (
                  <div key={s.key} className="qx-row qx-row--apart" style={{ alignItems: 'center', gap: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--m-text-primary)' }}>{s.label}</div>
                      {s.message && (
                        <div className="qx-mono" style={{ fontSize: 11, color: 'var(--m-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {s.message}
                        </div>
                      )}
                    </div>
                    <span className={`qsec-badge ${STATUS_VARIANT[s.status]}`}>{STATUS_LABEL[s.status]}</span>
                  </div>
                ))}
              </div>
            </div>

            {summary && (
              <div className="qx-card" style={{ padding: 20 }}>
                <div className="qx-row qx-row--apart" style={{ alignItems: 'center', marginBottom: 12 }}>
                  <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Summary</h2>
                  <span className={`qsec-badge ${complete ? 'qsec-badge--ok' : 'qsec-badge--warn'}`}>
                    {complete ? 'COMPLETE' : 'WAITING'}
                  </span>
                </div>
                <div className="qx-stack qx-stack--tight" style={{ fontSize: 13 }}>
                  <SummaryRow label="Org id" value={summary.orgId} mono />
                  <SummaryRow label="Roadmap" value={summary.roadmapId} mono />
                  <SummaryRow label="Engagement id" value={summary.engagementId} mono />
                  <SummaryRow label="Target" value={summary.target ? `${summary.target} (verified: ${summary.targetVerified})` : '—'} />
                  <SummaryRow label="Gripe repo" value={summary.repo || 'platform default'} />
                  <SummaryRow label="Schedule" value={summary.cron ? `cron ${summary.cron}` : '—'} mono />
                </div>
                {!complete && (
                  <p className="qx-hint qx-hint--sm" style={{ marginTop: 12 }}>
                    Add a GitHub PAT above and run again to finish the gripe target and scheduled scan.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </PageLayout>
  )
}

function SummaryRow({ label, value, mono }) {
  return (
    <div className="qx-row qx-row--apart" style={{ gap: 12 }}>
      <span className="qx-hint qx-hint--sm">{label}</span>
      <span className={mono ? 'qx-mono' : undefined} style={{ color: 'var(--m-text-primary)', textAlign: 'right', wordBreak: 'break-all' }}>
        {value || '—'}
      </span>
    </div>
  )
}
