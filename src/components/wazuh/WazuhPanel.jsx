/**
 * WazuhPanel - Main Wazuh SIEM Panel
 *
 * Tabbed interface for Wazuh security monitoring:
 * - Overview: Manager health, agent summary, alert counts
 * - Agents: Agent list with deploy button
 * - Setup: One-click agent deployment via bastion SSH
 * - Alerts: Security alert feed with triage
 * - Vulnerabilities: CVE results per agent
 * - FIM: File integrity changes
 * - Compliance: SCA policy results
 */

import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getOverview,
  getAgents,
  getAlerts,
  getVulnerabilities,
  getSyscheck,
  getScaResults,
  getManagerStatus,
  deployAgentToHost,
  bulkDeployAgents,
  getDeployHistory,
  triggerActiveResponse,
  ACTIVE_RESPONSE_COMMANDS,
} from '../../services/wazuhClient'
import { listHosts } from '../../services/bastionClient'
import './wazuh-panel.css'

const TABS = [
  { id: 'overview', label: 'Overview', icon: '◉' },
  { id: 'agents', label: 'Agents', icon: '◈' },
  { id: 'setup', label: 'Setup', icon: '⚙' },
  { id: 'alerts', label: 'Alerts', icon: '▲' },
  { id: 'vulnerabilities', label: 'Vulnerabilities', icon: '⊘' },
  { id: 'fim', label: 'FIM', icon: '◫' },
  { id: 'compliance', label: 'Compliance', icon: '✓' },
]

function getLevelSeverity(level) {
  if (level >= 12) return 'critical'
  if (level >= 7) return 'high'
  if (level >= 4) return 'medium'
  if (level >= 1) return 'low'
  return 'info'
}

function severityToQxDot(status) {
  const map = {
    active: 'qx-dot--online',
    running: 'qx-dot--online',
    disconnected: 'qx-dot--offline',
    stopped: 'qx-dot--offline',
    failed: 'qx-dot--offline',
    never_connected: 'qx-dot--idle',
    pending: 'qx-dot--degraded',
  }
  return map[status] || 'qx-dot--idle'
}

// ── Sub-components ──────────────────────────────────────

function StatusDot({ status }) {
  return <span className={`qx-dot qx-dot--sm ${severityToQxDot(status)}`} title={status} />
}

// ── Overview Tab ─────────────────────────────────────────

function OverviewTab({ data, loading, error }) {
  if (loading) return <div className="qx-spinner" style={{ margin: '40px auto' }} />
  if (error) return <div className="qx-banner qx-banner--error">✕ {error}</div>

  if (!data) {
    return (
      <div className="qx-empty">
        <span className="qx-empty__icon">◉</span>
        <p className="qx-empty__title">No connection</p>
        <p className="qx-empty__body">Could not reach the Wazuh API. Check the plugin configuration.</p>
      </div>
    )
  }

  const { manager, agents } = data

  // Optional daemons that are expected to be stopped in most deployments
  const OPTIONAL_DAEMONS = new Set([
    'wazuh-agentlessd', 'agentlessd',
    'wazuh-csyslogd', 'csyslogd',
    'wazuh-dbd', 'dbd',
    'wazuh-integratord', 'integratord',
    'wazuh-maild', 'maild',
    'wazuh-reportd', 'reportd',
  ])

  const criticalDaemons = Object.entries(manager.daemons).filter(([name]) => !OPTIONAL_DAEMONS.has(name))
  const optionalDaemons = Object.entries(manager.daemons).filter(([name]) => OPTIONAL_DAEMONS.has(name))

  return (
    <div className="qx-stack">
      <div className="qx-card qx-card--compact">
        <div className="qx-section-title" style={{ marginBottom: 12 }}>Manager Health</div>
        <div className="wz-daemon-grid">
          {criticalDaemons.map(([name, status]) => (
            <div key={name} className="qx-host-row">
              <StatusDot status={status} />
              <span style={{ flex: 1, fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>{name.replace('wazuh-', '')}</span>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>{status}</span>
            </div>
          ))}
        </div>
        {optionalDaemons.length > 0 && (
          <details style={{ marginTop: 8 }}>
            <summary style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.8rem', cursor: 'pointer' }}>
              {optionalDaemons.length} optional services (stopped, normal)
            </summary>
            <div className="wz-daemon-grid" style={{ marginTop: '0.5rem', opacity: 0.5 }}>
              {optionalDaemons.map(([name, status]) => (
                <div key={name} className="qx-host-row">
                  <span style={{ color: '#6b7280', marginRight: '0.5rem' }}>○</span>
                  <span style={{ flex: 1, fontSize: 13 }}>{name.replace('wazuh-', '')}</span>
                  <span style={{ fontSize: 11, color: '#6b7280' }}>{status}</span>
                </div>
              ))}
            </div>
          </details>
        )}
        {!manager.healthy && (
          <div className="qx-banner qx-banner--warn" style={{ marginTop: 12 }}>
            ▲ Critical Wazuh daemons are not running. Check the manager service.
          </div>
        )}
      </div>

      <div className="qx-grid-4">
        <div className="qx-stat">
          <span className="qx-stat__value">{agents.total}</span>
          <span className="qx-stat__label">Total Agents</span>
        </div>
        <div className="qx-stat">
          <span className="qx-stat__value" style={{ color: '#22c55e' }}>{agents.active}</span>
          <span className="qx-stat__label">Active</span>
        </div>
        <div className="qx-stat">
          <span className="qx-stat__value" style={{ color: '#ef4444' }}>{agents.disconnected}</span>
          <span className="qx-stat__label">Disconnected</span>
        </div>
        <div className="qx-stat">
          <span className="qx-stat__value" style={{ color: '#6b7280' }}>{agents.neverConnected}</span>
          <span className="qx-stat__label">Never Connected</span>
        </div>
      </div>

      <div className="qx-card qx-card--compact">
        <div className="qx-section-title" style={{ marginBottom: 8 }}>Fleet Coverage</div>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', margin: 0, lineHeight: 1.5 }}>
          {agents.total <= 1
            ? 'Only the Wazuh server itself is monitored. Go to Setup to deploy agents across your fleet.'
            : `${agents.active} of ${agents.total} agents actively reporting.`}
        </p>
      </div>
    </div>
  )
}

// ── Agents Tab ───────────────────────────────────────────

function AgentsTab({ agents, loading, error, onRefresh }) {
  const [arTarget, setArTarget] = useState(null) // { id, name, ip } or null

  if (loading) return <div className="qx-spinner" style={{ margin: '40px auto' }} />
  if (error) return <div className="qx-banner qx-banner--error">✕ {error}</div>

  const agentList = agents?.data?.affected_items || []

  if (agentList.length === 0) {
    return (
      <div className="qx-empty">
        <span className="qx-empty__icon">◈</span>
        <p className="qx-empty__title">No agents</p>
        <p className="qx-empty__body">No Wazuh agents enrolled. Use the Setup tab to deploy agents to your fleet.</p>
      </div>
    )
  }

  return (
    <>
      <table className="qx-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>IP</th>
            <th>OS</th>
            <th>Version</th>
            <th>Status</th>
            <th style={{ width: 1, whiteSpace: 'nowrap' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {agentList.map(agent => (
            <tr key={agent.id}>
              <td><code className="qx-code">{agent.id}</code></td>
              <td>{agent.name}</td>
              <td><span style={{ fontFamily: 'var(--qx-font-mono)', fontSize: 12 }}>{agent.ip || '—'}</span></td>
              <td>{agent.os?.name || agent.os?.platform || '—'}</td>
              <td>{agent.version || '—'}</td>
              <td>
                <span className="qx-row" style={{ gap: 6 }}>
                  <StatusDot status={agent.status} />
                  {agent.status}
                </span>
              </td>
              <td>
                <button
                  className="qx-btn qx-btn--sm"
                  disabled={agent.status !== 'active'}
                  onClick={() => setArTarget({ id: agent.id, name: agent.name, ip: agent.ip })}
                  title={agent.status === 'active' ? 'Trigger an active response on this agent' : 'Active response requires an active agent'}
                >
                  Active Response
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {arTarget && (
        <ActiveResponseModal
          agent={arTarget}
          onClose={() => setArTarget(null)}
        />
      )}
    </>
  )
}

// ── Active Response modal — HITL-gated, posts to /collector/api/v1/wazuh/active-response

function ActiveResponseModal({ agent, onClose }) {
  const [command, setCommand] = useState(ACTIVE_RESPONSE_COMMANDS[0].id)
  const [reason, setReason] = useState('')
  const [srcIp, setSrcIp] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null) // { success, inboxItemId } | { success: false, error }

  const cmdMeta = ACTIVE_RESPONSE_COMMANDS.find(c => c.id === command) || ACTIVE_RESPONSE_COMMANDS[0]
  const reasonOk = reason.trim().length >= 10
  const ipOk = !cmdMeta.requiresIp || /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(srcIp.trim())
  const canSubmit = !submitting && reasonOk && ipOk && agent?.id

  async function handleSubmit() {
    setSubmitting(true)
    setResult(null)
    try {
      const args = cmdMeta.requiresIp ? [srcIp.trim()] : []
      const res = await triggerActiveResponse([agent.id], command, reason.trim(), args)
      setResult({ success: true, inboxItemId: res.inbox_item_id })
    } catch (err) {
      setResult({ success: false, error: err.message })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="qx-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="qx-modal" style={{ maxWidth: 480 }}>
        <div className="qx-modal__header">
          <h3>Active Response: {agent.name || agent.id}</h3>
          <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose} title="Close">✕</button>
        </div>

        {result?.success ? (
          <div className="qx-modal__success">
            <span style={{ color: '#22c55e', fontSize: 24 }}>✓</span>
            <p>Awaiting approval</p>
            <p className="qx-tip" style={{ textAlign: 'center' }}>
              Approval card sent to the inbox{result.inboxItemId ? ` (item ${result.inboxItemId})` : ''}.
              The command runs only after a human approves; AEE evidence is recorded at every step.
            </p>
            <div className="qx-modal__actions">
              <button className="qx-btn qx-btn--primary" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <div className="qx-modal__body">
            {result?.success === false && (
              <div className="qx-banner qx-banner--error">✕ {result.error}</div>
            )}

            <div className="qx-field">
              <label className="qx-field__label">Command</label>
              <select
                className="qx-select"
                value={command}
                onChange={e => setCommand(e.target.value)}
                disabled={submitting}
              >
                {ACTIVE_RESPONSE_COMMANDS.map(c => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
            </div>

            {cmdMeta.requiresIp && (
              <div className="qx-field">
                <label className="qx-field__label">Source IP to block</label>
                <input
                  className="qx-input"
                  type="text"
                  value={srcIp}
                  onChange={e => setSrcIp(e.target.value)}
                  placeholder="192.168.1.42"
                  disabled={submitting}
                />
                {srcIp && !ipOk && (
                  <span className="qx-tip qx-tip--warn">Must be a valid IPv4 address.</span>
                )}
              </div>
            )}

            <div className="qx-field">
              <label className="qx-field__label">Justification (≥ 10 chars)</label>
              <textarea
                className="qx-textarea"
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="Why this action: investigators reading the inbox card need this."
                rows={3}
                disabled={submitting}
              />
              <span className="qx-tip">{reason.trim().length}/10 minimum characters.</span>
            </div>

            <div className="qx-banner qx-banner--info" style={{ fontSize: 12 }}>
              This action is HITL-gated. Submitting creates an approval card in the inbox; the command only runs after a human approves it. AEE evidence is recorded at every step.
            </div>

            <div className="qx-modal__actions">
              <button className="qx-btn qx-btn--ghost" onClick={onClose} disabled={submitting}>Cancel</button>
              <button
                className="qx-btn qx-btn--primary"
                onClick={handleSubmit}
                disabled={!canSubmit}
              >
                {submitting ? 'Submitting…' : 'Send for approval'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Setup Tab (the killer feature) ──────────────────────

function SetupTab({ wazuhAgents, onDeploy }) {
  const [fleetHosts, setFleetHosts] = useState([])
  const [fleetLoading, setFleetLoading] = useState(true)
  const [fleetError, setFleetError] = useState(null)
  const [deploying, setDeploying] = useState({})
  const [results, setResults] = useState({})
  const [bulkDeploying, setBulkDeploying] = useState(false)
  const [locallyDeployed, setLocallyDeployed] = useState(new Set())

  // Fetch real fleet hosts from QuoxBastion + persistent deploy history from server
  useEffect(() => {
    let cancelled = false
    async function fetchHosts() {
      try {
        setFleetLoading(true)
        setFleetError(null)
        const [hosts, historyData] = await Promise.all([
          listHosts(),
          getDeployHistory('latest').catch(() => ({ deploys: [] })),
        ])
        if (!cancelled) {
          // Filter out non-Linux hosts and the Wazuh server itself (deploying agent there removes the manager)
          const NON_LINUX_TAGS = ['router', 'switch', 'firewall', 'appliance', 'windows']
          const EXCLUDED_IDS = ['mikrotik-router', 'prtg01', 'wazuh01']
          const linuxHosts = hosts.filter(h => {
            const tags = h.tags || []
            const id = h.id || h.alias || ''
            return !tags.some(t => NON_LINUX_TAGS.includes(t)) && !EXCLUDED_IDS.includes(id)
          })
          const mapped = linuxHosts.map(h => ({
            hostname: h.alias || h.hostname || h.id,
            ip: h.ip || h.address,
            sshUser: h.ssh?.user || 'control',
            sshPort: h.ssh?.port || 22,
            role: h.tags?.includes('proxmox') ? 'proxmox'
              : h.tags?.includes('docker') ? 'docker'
              : h.tags?.includes('bastion') ? 'bastion'
              : h.tags?.includes('security') ? 'security'
              : h.group || 'host',
          }))
          setFleetHosts(mapped)

          // Restore persistent deploy results from server-side DB
          const persistedResults = {}
          for (const d of historyData.deploys || []) {
            persistedResults[d.hostname] = {
              success: !!d.success,
              message: d.message || (d.success ? 'Deployed' : 'Failed'),
              deployedAt: d.deployed_at,
            }
          }
          setResults(persistedResults)
        }
      } catch (err) {
        if (!cancelled) {
          setFleetError(err.message || 'Failed to fetch fleet hosts')
        }
      } finally {
        if (!cancelled) setFleetLoading(false)
      }
    }
    fetchHosts()
    return () => { cancelled = true }
  }, [])

  // Cross-reference fleet hosts with enrolled Wazuh agents (match by name or IP)
  const wazuhItems = wazuhAgents?.data?.affected_items || []
  const enrolledNames = new Set(wazuhItems.map(a => a.name?.toLowerCase()))
  const enrolledIPs = new Set(wazuhItems.map(a => a.ip).filter(Boolean))

  const hostsWithStatus = fleetHosts.map(host => ({
    ...host,
    enrolled: enrolledNames.has(host.hostname.toLowerCase()) || enrolledIPs.has(host.ip) || locallyDeployed.has(host.hostname),
  }))

  const unenrolledHosts = hostsWithStatus.filter(h => !h.enrolled)
  const enrolledHosts = hostsWithStatus.filter(h => h.enrolled)

  async function handleDeploy(host) {
    setDeploying(prev => ({ ...prev, [host.hostname]: true }))
    setResults(prev => ({ ...prev, [host.hostname]: null }))

    try {
      const result = await deployAgentToHost(host.hostname, host.ip, { sshUser: host.sshUser, sshPort: host.sshPort })
      setResults(prev => ({
        ...prev,
        [host.hostname]: { success: true, message: result.message || 'Agent deployed' },
      }))
      setLocallyDeployed(prev => new Set([...prev, host.hostname]))
      if (onDeploy) onDeploy()
    } catch (err) {
      setResults(prev => ({
        ...prev,
        [host.hostname]: { success: false, message: err.message },
      }))
    } finally {
      setDeploying(prev => ({ ...prev, [host.hostname]: false }))
    }
  }

  async function handleBulkDeploy() {
    setBulkDeploying(true)
    try {
      const hosts = unenrolledHosts.map(h => ({ hostname: h.hostname, ip: h.ip, sshUser: h.sshUser, sshPort: h.sshPort }))
      const result = await bulkDeployAgents(hosts)
      const newResults = {}
      const newDeployed = []
      for (const r of result.results || []) {
        newResults[r.hostname] = {
          success: r.success,
          message: r.message || (r.success ? 'Deployed' : 'Failed'),
        }
        if (r.success) newDeployed.push(r.hostname)
      }
      setResults(prev => ({ ...prev, ...newResults }))
      if (newDeployed.length > 0) {
        setLocallyDeployed(prev => new Set([...prev, ...newDeployed]))
      }
      if (onDeploy) onDeploy()
    } catch (err) {
      for (const h of unenrolledHosts) {
        setResults(prev => ({
          ...prev,
          [h.hostname]: { success: false, message: err.message },
        }))
      }
    } finally {
      setBulkDeploying(false)
    }
  }

  return (
    <div className="qx-stack">
      <div className="qx-card qx-card--compact">
        <div className="qx-section-title" style={{ marginBottom: 8 }}>Fleet Agent Deployment</div>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', margin: 0, lineHeight: 1.5 }}>
          Deploy Wazuh agents to your fleet hosts via bastion SSH. Each agent will be
          installed, configured to report to the Wazuh server, and started automatically.
        </p>
      </div>

      {fleetLoading && (
        <div className="qx-skeleton qx-skeleton--block" style={{ height: 60 }} />
      )}

      {fleetError && (
        <div className="qx-banner qx-banner--error">✕ Could not fetch fleet hosts: {fleetError}</div>
      )}

      {!fleetLoading && !fleetError && fleetHosts.length === 0 && (
        <div className="qx-tip">No fleet hosts found. Ensure QuoxBastion is running and has hosts registered.</div>
      )}

      {unenrolledHosts.length > 0 && (
        <div className="qx-card qx-card--compact">
          <div className="qx-row qx-row--apart" style={{ marginBottom: 12 }}>
            <div className="qx-section-title" style={{ margin: 0 }}>
              Hosts without Wazuh
              <span className="qx-pill qx-pill--ghost qx-pill--sm" style={{ marginLeft: 8 }}>{unenrolledHosts.length}</span>
            </div>
            <button
              className="qx-btn qx-btn--primary qx-btn--sm"
              onClick={handleBulkDeploy}
              disabled={bulkDeploying}
            >
              {bulkDeploying ? '⟳ Deploying...' : '⚡ Deploy All'}
            </button>
          </div>
          <div className="wz-deploy-grid">
            {unenrolledHosts.map(host => (
              <div key={host.hostname} className="qx-card qx-card--compact" style={{ padding: 14 }}>
                <div className="qx-row qx-row--apart" style={{ marginBottom: 4 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>{host.hostname}</span>
                  <span className="qx-pill qx-pill--ghost qx-pill--xs">{host.role}</span>
                </div>
                <div style={{ fontSize: 12, fontFamily: 'var(--qx-font-mono)', color: 'rgba(255,255,255,0.6)', marginBottom: 4 }}>
                  {host.sshUser}@{host.ip}
                </div>
                {results[host.hostname] && (
                  <div className={`qx-banner ${results[host.hostname].success ? 'qx-banner--success' : 'qx-banner--error'}`} style={{ marginTop: 6, fontSize: 12 }}>
                    {results[host.hostname].success ? '✓' : '✕'} {results[host.hostname].message}
                  </div>
                )}
                <button
                  className="qx-btn qx-btn--primary qx-btn--sm"
                  style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                  onClick={() => handleDeploy(host)}
                  disabled={deploying[host.hostname]}
                >
                  {deploying[host.hostname] ? '⟳ Installing...' : '▶ Deploy Agent'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {enrolledHosts.length > 0 && (
        <div className="qx-card qx-card--compact">
          <div className="qx-section-title" style={{ marginBottom: 8 }}>
            ✓ Already enrolled
            <span className="qx-pill qx-pill--ghost qx-pill--sm" style={{ marginLeft: 8 }}>{enrolledHosts.length}</span>
          </div>
          <div className="qx-stack qx-stack--tight">
            {enrolledHosts.map(host => (
              <div key={host.hostname} className="qx-host-row">
                <StatusDot status="active" />
                <span style={{ flex: 1 }}>{host.hostname}</span>
                <span style={{ fontFamily: 'var(--qx-font-mono)', fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>{host.ip}</span>
                <span className="qx-pill qx-pill--ghost qx-pill--xs">{host.role}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="qx-card qx-card--compact" style={{ borderColor: 'rgba(0,169,229,0.1)', background: 'rgba(0,169,229,0.03)' }}>
        <div className="qx-section-title" style={{ marginBottom: 8 }}>How it works</div>
        <ol style={{ margin: '10px 0 0', paddingLeft: 20, fontSize: 13, color: 'rgba(255,255,255,0.6)', lineHeight: 1.8 }}>
          <li>QuoxCORE SSHs to the target host via the bastion (gw-01)</li>
          <li>Installs the Wazuh agent package from the official repository</li>
          <li>Configures the agent to report to the Wazuh server ({fleetHosts.find(h => h.role === 'security')?.ip || 'your Wazuh server'})</li>
          <li>Starts the agent service and verifies enrolment</li>
          <li>The host begins reporting security events within seconds</li>
        </ol>
      </div>
    </div>
  )
}

// ── Alerts Tab ───────────────────────────────────────────

function AlertsTab({ alerts, loading, error }) {
  if (loading) return <div className="qx-spinner" style={{ margin: '40px auto' }} />
  if (error) return <div className="qx-banner qx-banner--error">✕ {error}</div>

  const alertList = alerts || []

  if (alertList.length === 0) {
    return (
      <div className="qx-empty">
        <span className="qx-empty__icon">▲</span>
        <p className="qx-empty__title">No alerts</p>
        <p className="qx-empty__body">No security alerts recorded. This could mean the daemons need restarting or no agents are reporting.</p>
      </div>
    )
  }

  return (
    <div className="qx-stack qx-stack--tight">
      {alertList.map((alert, i) => {
        const severity = getLevelSeverity(alert.rule?.level || 0)
        const mitre = alert.rule?.mitre
        return (
          <div key={alert.id || i} className="qx-card qx-card--compact">
            <div className="qx-row" style={{ marginBottom: 6 }}>
              <span className={`qx-severity qx-severity--${severity}`}>{alert.rule?.level}</span>
              <span style={{ fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.85)', flex: 1 }}>{alert.rule?.description || 'Unknown'}</span>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', whiteSpace: 'nowrap' }}>
                {alert.timestamp ? new Date(alert.timestamp).toLocaleString() : '—'}
              </span>
            </div>
            <div className="qx-row" style={{ gap: 16, fontSize: 12, color: 'rgba(255,255,255,0.6)', flexWrap: 'wrap' }}>
              <span>Agent: {alert.agent?.name || '—'}</span>
              <span>Rule: {alert.rule?.id || '—'}</span>
              {mitre?.technique?.length > 0 && (
                <span style={{ color: 'rgba(0,169,229,0.7)' }}>MITRE: {mitre.technique.join(', ')}</span>
              )}
            </div>
            {alert.full_log && (
              <div className="qx-code-block" style={{ fontSize: 11, maxHeight: 80, overflowY: 'auto', marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {alert.full_log}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Vulnerabilities Tab ──────────────────────────────────

function VulnsTab({ agents }) {
  const navigate = useNavigate()
  const [selectedAgent, setSelectedAgent] = useState(null)
  const [vulns, setVulns] = useState(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const agentList = agents?.data?.affected_items || []

  async function loadVulns(agentId) {
    setSelectedAgent(agentId)
    setLoading(true)
    setError(null)
    try {
      const data = await getVulnerabilities(agentId)
      setVulns(data?.data || [])
      setTotal(data?.total || 0)
    } catch (err) {
      setError(err.message)
      setVulns(null)
    } finally {
      setLoading(false)
    }
  }

  // Group by severity for summary
  const severityCounts = {}
  if (vulns) {
    for (const v of vulns) {
      const sev = v.vulnerability?.severity || 'Unknown'
      severityCounts[sev] = (severityCounts[sev] || 0) + 1
    }
  }

  return (
    <div className="qx-stack">
      <div className="qx-row qx-row--apart">
        <div className="qx-field" style={{ flex: 1 }}>
          <label className="qx-field__label">Select agent</label>
          <select
            value={selectedAgent || ''}
            onChange={e => e.target.value && loadVulns(e.target.value)}
            className="qx-select"
          >
            <option value="">Choose an agent...</option>
            {agentList.map(a => (
              <option key={a.id} value={a.id}>{a.name} ({a.id})</option>
            ))}
          </select>
        </div>
        <button
          className="qx-btn qx-btn--ghost qx-btn--sm"
          style={{ alignSelf: 'flex-end', whiteSpace: 'nowrap' }}
          onClick={() => navigate('/workflow-builder?seed=wazuh.vulnerabilities')}
          title="Open workflow builder pre-seeded with a recurring vulnerability scan"
        >
          Schedule recurring scan
        </button>
      </div>

      {loading && <div className="qx-spinner" style={{ margin: '40px auto' }} />}
      {error && <div className="qx-banner qx-banner--error">✕ {error}</div>}

      {vulns && vulns.length === 0 && (
        <div className="qx-empty">
          <span className="qx-empty__icon">✓</span>
          <p className="qx-empty__title">No vulnerabilities</p>
          <p className="qx-empty__body">No CVEs found on this agent.</p>
        </div>
      )}

      {vulns && vulns.length > 0 && (
        <>
          <div className="qx-grid-4">
            <div className="qx-stat"><span className="qx-stat__value">{total}</span><span className="qx-stat__label">Total CVEs</span></div>
            <div className="qx-stat"><span className="qx-stat__value" style={{ color: '#ef4444' }}>{severityCounts['Critical'] || 0}</span><span className="qx-stat__label">Critical</span></div>
            <div className="qx-stat"><span className="qx-stat__value" style={{ color: '#f97316' }}>{severityCounts['High'] || 0}</span><span className="qx-stat__label">High</span></div>
            <div className="qx-stat"><span className="qx-stat__value" style={{ color: '#eab308' }}>{severityCounts['Medium'] || 0}</span><span className="qx-stat__label">Medium</span></div>
          </div>
          <table className="qx-table">
            <thead>
              <tr>
                <th>Severity</th>
                <th>CVE</th>
                <th>Package</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {vulns.map((v, i) => {
                const vuln = v.vulnerability || {}
                const pkg = v.package || {}
                const sev = vuln.severity?.toLowerCase() || 'info'
                return (
                  <tr key={i}>
                    <td><span className={`qx-severity qx-severity--${sev}`}>{vuln.severity || 'Unknown'}{vuln.score?.base ? ` (${vuln.score.base})` : ''}</span></td>
                    <td><code className="qx-code">{vuln.id || '—'}</code></td>
                    <td style={{ fontSize: 12 }}>{pkg.name || '—'} {pkg.version || ''}</td>
                    <td style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', maxWidth: 300 }}>
                      {vuln.description ? (vuln.description.length > 150 ? vuln.description.slice(0, 150) + '...' : vuln.description) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

// ── FIM Tab ──────────────────────────────────────────────

function FIMTab({ agents }) {
  const [selectedAgent, setSelectedAgent] = useState(null)
  const [events, setEvents] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const agentList = agents?.data?.affected_items || []

  async function loadFIM(agentId) {
    setSelectedAgent(agentId)
    setLoading(true)
    setError(null)
    try {
      const data = await getSyscheck(agentId)
      setEvents(data?.data?.affected_items || [])
    } catch (err) {
      setError(err.message)
      setEvents(null)
    } finally {
      setLoading(false)
    }
  }

  function eventToPill(eventType) {
    const map = { added: 'qx-pill--success', deleted: 'qx-pill--critical', modified: 'qx-pill--warn' }
    return map[eventType] || 'qx-pill--info'
  }

  return (
    <div className="qx-stack">
      <div className="qx-field">
        <label className="qx-field__label">Select agent</label>
        <select
          value={selectedAgent || ''}
          onChange={e => e.target.value && loadFIM(e.target.value)}
          className="qx-select"
        >
          <option value="">Choose an agent...</option>
          {agentList.map(a => (
            <option key={a.id} value={a.id}>{a.name} ({a.id})</option>
          ))}
        </select>
      </div>

      {loading && <div className="qx-spinner" style={{ margin: '40px auto' }} />}
      {error && <div className="qx-banner qx-banner--error">✕ {error}</div>}

      {events && events.length === 0 && (
        <div className="qx-empty">
          <span className="qx-empty__icon">◫</span>
          <p className="qx-empty__title">No FIM events</p>
          <p className="qx-empty__body">No file integrity changes detected on this agent.</p>
        </div>
      )}

      {events && events.length > 0 && (
        <table className="qx-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Path</th>
              <th>Modified</th>
              <th>Size</th>
              <th>MD5</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e, i) => (
              <tr key={i}>
                <td>
                  <span className={`qx-pill qx-pill--sm ${eventToPill(e.event)}`}>
                    {e.event || 'modified'}
                  </span>
                </td>
                <td style={{ fontFamily: 'var(--qx-font-mono)', fontSize: 12 }}>{e.file || e.path || '—'}</td>
                <td style={{ fontSize: 12 }}>{e.mtime ? new Date(e.mtime).toLocaleString() : '—'}</td>
                <td style={{ fontSize: 12 }}>{e.size || '—'}</td>
                <td style={{ fontFamily: 'var(--qx-font-mono)', fontSize: 11 }}>{e.md5 ? e.md5.substring(0, 12) + '...' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Compliance Tab ───────────────────────────────────────

function ComplianceTab({ agents }) {
  const navigate = useNavigate()
  const [selectedAgent, setSelectedAgent] = useState(null)
  const [scaData, setScaData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const agentList = agents?.data?.affected_items || []

  async function loadSCA(agentId) {
    setSelectedAgent(agentId)
    setLoading(true)
    setError(null)
    try {
      const data = await getScaResults(agentId)
      setScaData(data?.data?.affected_items || [])
    } catch (err) {
      setError(err.message)
      setScaData(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="qx-stack">
      <div className="qx-row qx-row--apart">
        <div className="qx-field" style={{ flex: 1 }}>
          <label className="qx-field__label">Select agent</label>
          <select
            value={selectedAgent || ''}
            onChange={e => e.target.value && loadSCA(e.target.value)}
            className="qx-select"
          >
            <option value="">Choose an agent...</option>
            {agentList.map(a => (
              <option key={a.id} value={a.id}>{a.name} ({a.id})</option>
            ))}
          </select>
        </div>
        <button
          className="qx-btn qx-btn--ghost qx-btn--sm"
          style={{ alignSelf: 'flex-end', whiteSpace: 'nowrap' }}
          onClick={() => navigate('/workflow-builder?seed=wazuh.compliance')}
          title="Open workflow builder pre-seeded with a recurring compliance scan"
        >
          Schedule recurring scan
        </button>
      </div>

      {loading && <div className="qx-spinner" style={{ margin: '40px auto' }} />}
      {error && <div className="qx-banner qx-banner--error">✕ {error}</div>}

      {scaData && scaData.length === 0 && (
        <div className="qx-empty">
          <span className="qx-empty__icon">✓</span>
          <p className="qx-empty__title">No SCA data</p>
          <p className="qx-empty__body">No compliance assessments found for this agent.</p>
        </div>
      )}

      {scaData && scaData.length > 0 && (
        <div className="qx-stack">
          {scaData.map((policy, i) => {
            const total = (policy.pass || 0) + (policy.fail || 0) + (policy.invalid || 0)
            const passRate = total > 0 ? Math.round((policy.pass / total) * 100) : 0
            const progressMod = passRate >= 80 ? 'qx-progress--success' : passRate >= 50 ? 'qx-progress--warn' : 'qx-progress--crit'
            return (
              <div key={i} className="qx-card qx-card--compact">
                <div className="qx-row qx-row--apart" style={{ marginBottom: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 500, color: 'rgba(255,255,255,0.8)' }}>{policy.name || policy.policy_id || '—'}</span>
                  <span
                    className="qx-percent-value"
                    style={{ color: passRate >= 80 ? '#22c55e' : passRate >= 50 ? '#eab308' : '#ef4444', fontSize: 18 }}
                  >
                    {passRate}<i>%</i>
                  </span>
                </div>
                <div className={`qx-progress ${progressMod}`} style={{ marginBottom: 8 }}>
                  <div style={{ width: `${passRate}%` }} />
                </div>
                <div className="qx-row" style={{ gap: 16, fontSize: 12 }}>
                  <span style={{ color: '#22c55e' }}>✓ {policy.pass || 0} pass</span>
                  <span style={{ color: '#ef4444' }}>✕ {policy.fail || 0} fail</span>
                  <span style={{ color: '#6b7280' }}>— {policy.invalid || 0} N/A</span>
                </div>
                {policy.description && (
                  <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginTop: 6, marginBottom: 0 }}>{policy.description}</p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Main Panel ───────────────────────────────────────────

export default function WazuhPanel({ activeTab: activeTabProp, onTabChange }) {
  const [internalTab, setInternalTab] = useState('overview')
  const activeTab = activeTabProp ?? internalTab
  const setActiveTab = onTabChange ?? setInternalTab
  const [overview, setOverview] = useState(null)
  const [agents, setAgents] = useState(null)
  const [alerts, setAlerts] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastRefresh, setLastRefresh] = useState(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [overviewData, agentsData] = await Promise.all([
        getOverview().catch(err => {
          console.warn('[Wazuh] Overview fetch failed:', err)
          return null
        }),
        getAgents({ limit: '500' }).catch(err => {
          console.warn('[Wazuh] Agents fetch failed:', err)
          return null
        }),
      ])
      setOverview(overviewData)
      setAgents(agentsData)
      setLastRefresh(new Date())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchAlerts = useCallback(async () => {
    try {
      const data = await getAlerts({ limit: '50' })
      setAlerts(data?.alerts || data?.data?.affected_items || [])
    } catch (err) {
      console.warn('[Wazuh] Alerts fetch failed:', err)
      setAlerts([])
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 60000)
    return () => clearInterval(interval)
  }, [fetchData])

  useEffect(() => {
    if (activeTab === 'alerts' && !alerts) {
      fetchAlerts()
    }
  }, [activeTab, alerts, fetchAlerts])

  return (
    <div className="wz-panel">
      <div className="qx-section-title wz-header-row">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00a9e5" strokeWidth="1.5">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
        Wazuh SIEM
        {overview?.manager && (
          <span className={`qx-pill qx-pill--sm ${overview.manager.healthy ? 'qx-pill--online' : 'qx-pill--critical'}`}>
            {overview.manager.healthy ? '● Healthy' : '● Daemons Down'}
          </span>
        )}
        <span className="wz-header-spacer" />
        {lastRefresh && (
          <span className="wz-last-refresh">
            Updated {lastRefresh.toLocaleTimeString()}
          </span>
        )}
        <button className="qx-btn qx-btn--sm" onClick={fetchData} title="Refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
            <path d="M21 3v5h-5"/>
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
            <path d="M8 16H3v5"/>
          </svg>
        </button>
      </div>

      <div className="qx-tabs qx-tabs--underline">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`qx-tab${activeTab === tab.id ? ' qx-tab--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      <div className="wz-content">
        {activeTab === 'overview' && (
          <OverviewTab data={overview} loading={loading} error={error} />
        )}
        {activeTab === 'agents' && (
          <AgentsTab agents={agents} loading={loading} error={error} onRefresh={fetchData} />
        )}
        {activeTab === 'setup' && (
          <SetupTab wazuhAgents={agents} onDeploy={fetchData} />
        )}
        {activeTab === 'alerts' && (
          <AlertsTab alerts={alerts} loading={!alerts && loading} error={error} />
        )}
        {activeTab === 'vulnerabilities' && (
          <VulnsTab agents={agents} />
        )}
        {activeTab === 'fim' && (
          <FIMTab agents={agents} />
        )}
        {activeTab === 'compliance' && (
          <ComplianceTab agents={agents} />
        )}
      </div>
    </div>
  )
}
