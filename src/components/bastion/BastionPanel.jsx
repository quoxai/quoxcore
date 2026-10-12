/**
 * BastionPanel - Fleet Management UI
 *
 * Main panel for QuoxBastion plugin showing:
 * - Host registry with CRUD operations
 * - Command execution panel
 * - Fleet status overview
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import * as bastionClient from '../../services/bastionClient'
import { getCommandAction } from '../../config/denylist'
import CommandValidationModal from './CommandValidationModal'
import TerminalEmbed from '../terminal/TerminalEmbed'
import { execInTerminal } from '../../services/terminalExecService'
import ToolsTab from './ToolsTab'
import KeysTab from './KeysTab'
import AuditTab from './AuditTab'
import { formatExitCode } from '../../utils/exitCodes'
import './BastionPanel.css'
// quox#541: quick-connect targets the org Jump Host setting, not a hardcode.
import { resolveBastionHost } from '../../services/jumpHostConfig'

// Icons
const ServerIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
    <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
    <line x1="6" y1="6" x2="6.01" y2="6"/>
    <line x1="6" y1="18" x2="6.01" y2="18"/>
  </svg>
)

const PlusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="12" y1="5" x2="12" y2="19"/>
    <line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
)

const RefreshIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="23 4 23 10 17 10"/>
    <polyline points="1 20 1 14 7 14"/>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
  </svg>
)

const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="3 6 5 6 21 6"/>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
  </svg>
)

const TerminalIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="4 17 10 11 4 5"/>
    <line x1="12" y1="19" x2="20" y2="19"/>
  </svg>
)

const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
)

const XIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18"/>
    <line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
)

const AlertIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="8" x2="12" y2="12"/>
    <line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>
)

const DownloadIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
)

const UploadIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="17 8 12 3 7 8"/>
    <line x1="12" y1="3" x2="12" y2="15"/>
  </svg>
)

const SearchIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="8"/>
    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
)

const EditIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
)

const ShellIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="2" y="3" width="20" height="18" rx="2"/>
    <polyline points="7 15 10 12 7 9"/>
    <line x1="13" y1="15" x2="17" y2="15"/>
  </svg>
)

const WrenchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
  </svg>
)

const KeyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
  </svg>
)

const ClipboardIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
    <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
  </svg>
)

// SECURITY FIX C3: the bastion API token is no longer held or configured by
// the frontend. All bastion calls go through the collector proxy
// (/collector/api/v1/bastion/proxy/*), which injects BASTION_API_TOKEN
// server-side and authorizes by dashboard role. bastionClient talks to the
// proxy using cookie auth — no client-side token config needed.

export default function BastionPanel({ config = {}, onTabChange, onSelectedHostChange }) {
  const navigate = useNavigate()

  const [hosts, setHosts] = useState([])
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [backendStatus, setBackendStatus] = useState(null)
  const [pingResults, setPingResults] = useState({}) // host_id -> { reachable, latency_ms }
  const [pinging, setPinging] = useState(false)

  // UI State
  const [showAddHost, setShowAddHost] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [editHost, setEditHost] = useState(null) // host being edited
  const [selectedHost, setSelectedHost] = useState(null)
  const [commandInput, setCommandInput] = useState('')
  const [commandResult, setCommandResult] = useState(null)
  const [executing, setExecuting] = useState(false)
  const [auditJumpFilter, setAuditJumpFilter] = useState(null)
  const [importMode, setImportMode] = useState('merge')
  const [showValidationModal, setShowValidationModal] = useState(false)
  const [currentValidation, setCurrentValidation] = useState(null)
  const [notification, setNotification] = useState(null)
  const [saving, setSaving] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterGroup, setFilterGroup] = useState('all')
  const [filterStatus, setFilterStatus] = useState('all')
  const [activeTab, setActiveTab] = useState('fleet')

  // Notify parent (BastionView) when tab/selection changes so sidebar can see it.
  useEffect(() => {
    if (typeof onTabChange === 'function') onTabChange(activeTab)
    try { localStorage.setItem('bastion-active-tab', activeTab) } catch {}
  }, [activeTab, onTabChange])

  useEffect(() => {
    if (typeof onSelectedHostChange === 'function') onSelectedHostChange(selectedHost)
  }, [selectedHost, onSelectedHostChange])
  const [cliSessionId, setCliSessionId] = useState(null)
  const [cliMounted, setCliMounted] = useState(false)
  const [cliKey, setCliKey] = useState(0)
  const cliAutoRunRef = useRef(false)
  const cliReconnectRef = useRef(null)

  // New host form
  const [newHost, setNewHost] = useState({
    id: '',
    ip: '',
    group: '',
    tags: ''
  })

  const showNotification = useCallback((message, type = 'success') => {
    setNotification({ message, type })
    setTimeout(() => setNotification(null), 4000)
  }, [])

  // Ping all hosts
  const pingHosts = useCallback(async () => {
    setPinging(true)
    try {
      const results = await bastionClient.pingHosts()
      const pingMap = {}
      results.forEach(r => {
        pingMap[r.host_id] = { reachable: r.reachable, latency_ms: r.latency_ms }
      })
      setPingResults(pingMap)
    } catch (err) {
      console.error('Ping failed:', err)
    } finally {
      setPinging(false)
    }
  }, [])

  // Load data — bastionClient talks to the collector proxy (cookie auth,
  // token injected server-side), so there's no client-side token to check.
  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const health = await bastionClient.checkHealth()
      setBackendStatus(health._rate_limited ? { status: 'healthy' } : health)

      const hostList = await bastionClient.listHosts()
      if (!hostList._rate_limited) setHosts(Array.isArray(hostList) ? hostList : [])

      const groupList = await bastionClient.listGroups()
      if (!groupList._rate_limited) setGroups(Array.isArray(groupList) ? groupList : [])

      // Ping hosts after loading
      pingHosts()
    } catch (err) {
      console.error('[BastionPanel] API error:', err.message)
      if (err.message.includes('unauthorized') || err.message.includes('401') || err.message.includes('403')) {
        setError('Not authorized to reach QuoxBastion. Make sure you are signed in with sufficient permissions.')
      } else {
        setError(`Failed to connect to QuoxBastion: ${err.message}`)
        setBackendStatus(null)
      }
    } finally {
      setLoading(false)
    }
  }, [pingHosts])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Filtered hosts for search/filter
  const filteredHosts = useMemo(() => {
    let result = hosts
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(h =>
        h.id.toLowerCase().includes(q) ||
        h.ip.includes(q) ||
        (h.fqdn || '').toLowerCase().includes(q) ||
        (h.aliases || []).some(a => a.toLowerCase().includes(q)) ||
        (h.tags || []).some(t => t.toLowerCase().includes(q)) ||
        (h.ssh?.user || '').toLowerCase().includes(q) ||
        (h.metadata?.mac || '').toLowerCase().includes(q)
      )
    }
    if (filterGroup !== 'all') {
      result = result.filter(h => (h.group || 'default') === filterGroup)
    }
    if (filterStatus !== 'all') {
      result = result.filter(h => {
        const ping = pingResults[h.id]
        if (filterStatus === 'online') return ping?.reachable === true
        if (filterStatus === 'offline') return ping?.reachable === false
        return !ping // unknown
      })
    }
    return result
  }, [hosts, searchQuery, filterGroup, filterStatus, pingResults])

  // Keyboard shortcut: / to focus search
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === '/' && !e.ctrlKey && !e.metaKey &&
          !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        e.preventDefault()
        document.querySelector('.bastion-search-input')?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Add host
  const handleAddHost = async (e) => {
    e.preventDefault()
    try {
      const host = {
        id: newHost.id,
        ip: newHost.ip,
        group: newHost.group || 'default',
        tags: newHost.tags ? newHost.tags.split(',').map(t => t.trim()) : []
      }
      await bastionClient.addHost(host)
      setNewHost({ id: '', ip: '', group: '', tags: '' })
      setShowAddHost(false)
      loadData()
      showNotification('Host added to registry')
    } catch (err) {
      setError(`Failed to add host: ${err.message}`)
    }
  }

  // Delete host
  const handleDeleteHost = async (id) => {
    if (!confirm(`Delete host "${id}"?`)) return
    try {
      await bastionClient.removeHost(id)
      if (selectedHost?.id === id) setSelectedHost(null)
      loadData()
      showNotification('Host removed from registry')
    } catch (err) {
      setError(`Failed to delete host: ${err.message}`)
    }
  }

  // Export registry
  const handleExport = async () => {
    try {
      const registry = await bastionClient.exportRegistry()
      const json = JSON.stringify(registry, null, 2)
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `bastion-hosts-${new Date().toISOString().split('T')[0]}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(`Export failed: ${err.message}`)
    }
  }

  // Import registry
  const handleImport = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      const registry = JSON.parse(text)
      await bastionClient.importRegistry(registry, importMode)
      setShowImport(false)
      loadData()
      showNotification('Registry imported successfully')
    } catch (err) {
      setError(`Import failed: ${err.message}`)
    }
  }

  // Start editing a host
  const handleEditHost = (host) => {
    setEditHost({
      ...host,
      tags: host.tags?.join(', ') || '',
      aliases: host.aliases?.join(', ') || '',
      sshUser: host.ssh?.user || 'control',
      sshPort: host.ssh?.port || 22,
      mac: host.metadata?.mac || ''
    })
  }

  // Save edited host
  const handleSaveEdit = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      const updates = {
        ip: editHost.ip,
        group: editHost.group,
        fqdn: editHost.fqdn,
        aliases: editHost.aliases ? editHost.aliases.split(',').map(a => a.trim()).filter(Boolean) : [],
        tags: editHost.tags ? editHost.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
        ssh: {
          user: editHost.sshUser,
          port: parseInt(editHost.sshPort) || 22
        },
        metadata: {
          ...editHost.metadata,
          mac: editHost.mac
        }
      }
      await bastionClient.updateHost(editHost.id, updates)
      setEditHost(null)
      loadData()
      showNotification('Host updated successfully')
    } catch (err) {
      setError(`Failed to update host: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  // Execute command (internal - bypasses validation)
  const executeCommandDirect = async () => {
    setExecuting(true)
    setCommandResult(null)

    const execTimestamp = new Date().toISOString()
    try {
      const result = await bastionClient.execOnHost(selectedHost.id, commandInput)
      setCommandResult({ ...result, _execAt: execTimestamp, _command: commandInput, _hostId: selectedHost.id })
    } catch (err) {
      setCommandResult({ error: err.message, exit_code: -1, _execAt: execTimestamp, _command: commandInput, _hostId: selectedHost.id })
    } finally {
      setExecuting(false)
    }
  }

  // Execute command with validation
  const handleExecuteCommand = async () => {
    if (!commandInput.trim() || !selectedHost) return

    // Validate the command
    const validation = getCommandAction(commandInput)

    // If action is ALLOW, execute immediately
    if (validation.action === 'ALLOW') {
      await executeCommandDirect()
      return
    }

    // For BLOCK, WARN, REQUIRE_APPROVAL, or REQUIRE_OVERRIDE: show validation modal
    setCurrentValidation(validation)
    setShowValidationModal(true)
  }

  // Handle confirmed execution after WARN
  const handleConfirmExecution = async () => {
    setShowValidationModal(false)
    setCurrentValidation(null)
    await executeCommandDirect()
  }

  // Handle approval request for REQUIRE_APPROVAL or REQUIRE_OVERRIDE
  const handleRequestApproval = async () => {
    try {
      // Call the API to create an approval request
      // Note: orgId would come from auth context in production
      const orgId = 'default'
      await bastionClient.requestCommandApproval(orgId, selectedHost.id, selectedHost.id, commandInput)
      setShowValidationModal(false)
      setCurrentValidation(null)
      setCommandResult({
        stdout: 'Approval request submitted. You will be notified when approved.',
        exit_code: 0
      })
    } catch (err) {
      setCommandResult({ error: `Failed to create approval request: ${err.message}`, exit_code: -1 })
      setShowValidationModal(false)
      setCurrentValidation(null)
    }
  }

  // Health indicator
  const getHealthColor = (health) => {
    switch (health) {
      case 'healthy': return '#22c55e'
      case 'unhealthy': return '#ef4444'
      default: return '#6b7280'
    }
  }

  // Build WebSocket URL for bastion CLI shell
  // MUST be before early returns to satisfy React rules of hooks
  const bastionWsUrl = useMemo(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    // quox#541: honour the org Jump Host setting (Settings -> Infrastructure);
    // the install default (gw-01) applies only when the setting is off.
    return `${proto}//${window.location.host}/collector/terminal/shell/ws?mode=ssh&host=${encodeURIComponent(resolveBastionHost())}`
  }, [])

  // Auto-run bastion tui after terminal connects
  const handleCliSessionId = useCallback((sessionId) => {
    setCliSessionId(sessionId)
    if (!cliAutoRunRef.current) {
      cliAutoRunRef.current = true
      setTimeout(() => {
        execInTerminal(sessionId, 'bastion tui').catch(err => {
          console.warn('[BastionPanel] Failed to auto-launch bastion tui:', err)
        })
      }, 800)
    }
  }, [])

  // Mount terminal on first CLI tab visit, keep it alive after that
  const handleTabChange = useCallback((tab) => {
    if (tab === 'cli' && !cliMounted) {
      setCliMounted(true)
    }
    setActiveTab(tab)
  }, [cliMounted])

  // Reset terminal — unmount and remount with new key
  const handleCliReset = useCallback(() => {
    cliAutoRunRef.current = false
    setCliSessionId(null)
    setCliKey(k => k + 1)
    setCliMounted(true)
  }, [])

  if (loading) {
    return (
      <div className="bastion-panel bastion-loading">
        <div className="bastion-spinner" />
        <span>Connecting to QuoxBastion...</span>
      </div>
    )
  }

  if (error && !backendStatus) {
    const isConnectionError = /502|503|504|fetch|network|abort|timeout|connect/i.test(error)
    const isAuthError = /401|unauthorized|auth/i.test(error)
    const isTimeout = /timeout|abort/i.test(error)

    let diagnosis, suggestion
    if (isAuthError) {
      diagnosis = 'Not authorized'
      suggestion = 'You may need higher dashboard permissions to reach QuoxBastion, or the bastion service may not be configured on the server.'
    } else if (isTimeout) {
      diagnosis = 'Connection timed out'
      suggestion = 'The bastion host may be under load or unreachable. Check network connectivity and firewall rules.'
    } else if (isConnectionError) {
      diagnosis = 'Could not connect to QuoxBastion server'
      suggestion = 'The QuoxBastion service may not be running. SSH into your bastion host and run: systemctl status bastion'
    } else {
      diagnosis = error
      suggestion = 'Check the bastion service logs: journalctl -u bastion -n 50'
    }

    return (
      <div className="bastion-panel bastion-error">
        <AlertIcon />
        <div>
          <h3>QuoxBastion Offline</h3>
          <p>{diagnosis}</p>
          <div className="bastion-diag-details">
            <p className="bastion-hint">{suggestion}</p>
            <p className="bastion-hint bastion-hint-secondary">
              Endpoint: <code>/collector/api/v1/bastion/proxy/health</code>
            </p>
            {isConnectionError && (
              <div className="bastion-troubleshoot">
                <p className="bastion-hint bastion-hint-secondary">Troubleshooting checklist:</p>
                <ul className="bastion-checklist">
                  <li>Is the bastion host powered on and reachable?</li>
                  <li>Is the QuoxBastion service running? (<code>systemctl status bastion</code>)</li>
                  <li>Is <code>BASTION_URL</code> / <code>BASTION_API_TOKEN</code> configured on the collector?</li>
                </ul>
              </div>
            )}
          </div>
          <button onClick={loadData} className="bastion-btn">
            <RefreshIcon /> Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="bastion-panel">
      {/* Tab Bar */}
      <div className="bastion-tab-bar">
        <button
          className={`bastion-tab ${activeTab === 'fleet' ? 'bastion-tab-active' : ''}`}
          onClick={() => handleTabChange('fleet')}
        >
          <ServerIcon /> Fleet
        </button>
        <button
          className={`bastion-tab ${activeTab === 'cli' ? 'bastion-tab-active' : ''}`}
          onClick={() => handleTabChange('cli')}
        >
          <ShellIcon /> CLI Shell
        </button>
        <button
          className={`bastion-tab ${activeTab === 'tools' ? 'bastion-tab-active' : ''}`}
          onClick={() => handleTabChange('tools')}
        >
          <WrenchIcon /> Tools
        </button>
        <button
          className={`bastion-tab ${activeTab === 'keys' ? 'bastion-tab-active' : ''}`}
          onClick={() => handleTabChange('keys')}
        >
          <KeyIcon /> Keys
        </button>
        <button
          className={`bastion-tab ${activeTab === 'audit' ? 'bastion-tab-active' : ''}`}
          onClick={() => handleTabChange('audit')}
        >
          <ClipboardIcon /> Audit
        </button>
      </div>

      {/* JANUS narrator strip — gateway warden narrates fleet state per tab */}
      {(() => {
        const reachable = hosts.filter(h => pingResults[h.id]?.reachable === true).length
        const unreachable = hosts.filter(h => pingResults[h.id]?.reachable === false).length
        const unknown = hosts.length - reachable - unreachable
        let narration = ''
        switch (activeTab) {
          case 'fleet':
            if (hosts.length === 0) narration = 'The gateway is quiet. No hosts registered yet — add one to begin.'
            else if (unreachable > 0) narration = `${hosts.length} hosts at the gateway · ${reachable} reachable · ${unreachable} unreachable — shall we investigate?`
            else if (unknown > 0) narration = `${hosts.length} hosts registered · ${reachable} confirmed reachable · ${unknown} awaiting first ping.`
            else narration = `${hosts.length} hosts at the gateway · all reachable. The gateway holds.`
            break
          case 'cli':
            narration = cliSessionId
              ? `CLI session live on ${resolveBastionHost()}. I am watching every command that crosses the threshold.`
              : 'No CLI session yet. Press Reset to open the gateway shell.'
            break
          case 'tools':
            narration = 'Tools registry. Before any command crosses the threshold, I will narrate what will happen.'
            break
          case 'keys':
            narration = 'Key lifecycle. Generate, deploy, revoke — I will narrate the steps; you hold the keys.'
            break
          case 'audit':
            narration = 'Audit trail. Every session that passes through the gateway leaves a trace here.'
            break
          default:
            narration = 'The gateway holds.'
        }
        return (
          <div className="bastion-janus-strip">
            <div className="bastion-janus-avatar" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <defs>
                  <linearGradient id="janusGrad" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#a855f7"/>
                    <stop offset="100%" stopColor="#38bdf8"/>
                  </linearGradient>
                </defs>
                <circle cx="12" cy="12" r="9" stroke="url(#janusGrad)" strokeWidth="1.5"/>
                <path d="M8 9v6M16 9v6" stroke="url(#janusGrad)" strokeWidth="1.5" strokeLinecap="round"/>
                <path d="M12 6v12" stroke="url(#janusGrad)" strokeWidth="1.5" strokeLinecap="round" opacity="0.5"/>
              </svg>
            </div>
            <div className="bastion-janus-body">
              <div className="bastion-janus-name">JANUS <span className="bastion-janus-tagline">— Gate Warden</span></div>
              <div className="bastion-janus-message">{narration}</div>
            </div>
            {hosts.length > 0 && activeTab === 'fleet' && (
              <div className="bastion-janus-stats">
                <div className="bastion-janus-stat">
                  <span className="bastion-janus-stat-dot" style={{ background: '#30ff90' }} />
                  <span>{reachable}</span>
                </div>
                {unreachable > 0 && (
                  <div className="bastion-janus-stat">
                    <span className="bastion-janus-stat-dot" style={{ background: '#ef4444' }} />
                    <span>{unreachable}</span>
                  </div>
                )}
                {unknown > 0 && (
                  <div className="bastion-janus-stat">
                    <span className="bastion-janus-stat-dot" style={{ background: '#f59e0b' }} />
                    <span>{unknown}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })()}

      {/* CLI Shell Tab — stays mounted for session persistence */}
      <div className="bastion-cli-shell" style={{ display: activeTab === 'cli' ? 'flex' : 'none' }}>
        <div className="bastion-cli-header">
          <div className="bastion-cli-title">
            <ShellIcon />
            <span>Bastion CLI</span>
            <span className="bastion-cli-badge">{resolveBastionHost()}</span>
            {cliSessionId && <span className="bastion-cli-connected">Connected</span>}
          </div>
          <div className="bastion-cli-actions">
            <button
              onClick={handleCliReset}
              className="bastion-btn"
              title="Reset terminal session"
            >
              <RefreshIcon /> Reset
            </button>
          </div>
        </div>
        {cliMounted && (
          <div className="bastion-cli-terminal">
            <TerminalEmbed
              key={cliKey}
              wsUrl={bastionWsUrl}
              reconnectRef={cliReconnectRef}
              onSessionId={handleCliSessionId}
              onConnect={() => console.log('[BastionPanel] CLI shell connected')}
              onDisconnect={() => {
                console.log('[BastionPanel] CLI shell disconnected')
                cliAutoRunRef.current = false
                setCliSessionId(null)
              }}
              className="bastion-cli-embed"
            />
          </div>
        )}
      </div>

      {/* Fleet Tab */}
      {activeTab === 'fleet' && <>
      {/* Header — title + backend pill + actions, all on ONE row */}
      <div className="bastion-header">
        <div className="bastion-title">
          <ServerIcon />
          <h2>Fleet Registry</h2>
          {backendStatus && (
            <span
              className="qx-pill qx-pill--online qx-pill--sm"
              title="Backend: via collector bastion proxy"
              style={{ marginLeft: 4 }}
            >
              <span className="qx-dot qx-dot--online qx-dot--sm" />
              v{backendStatus.version}
              {backendStatus.uptime_sec != null && (
                <span style={{ opacity: 0.85, marginLeft: 4 }}>
                  · up {backendStatus.uptime_sec >= 86400
                    ? `${Math.floor(backendStatus.uptime_sec / 86400)}d`
                    : backendStatus.uptime_sec >= 3600
                      ? `${Math.floor(backendStatus.uptime_sec / 3600)}h`
                      : `${Math.floor(backendStatus.uptime_sec / 60)}m`}
                </span>
              )}
            </span>
          )}
        </div>
        <div className="bastion-actions">
          <button
            onClick={pingHosts}
            className={`bastion-btn ${pinging ? 'bastion-btn-spinning' : ''}`}
            title="Ping all hosts"
            disabled={pinging}
          >
            <RefreshIcon /> {pinging ? 'Pinging...' : 'Ping All'}
          </button>
          <button onClick={handleExport} className="bastion-btn" title="Export hosts.json">
            <DownloadIcon /> Export
          </button>
          <button onClick={() => setShowImport(true)} className="bastion-btn" title="Import hosts.json">
            <UploadIcon /> Import
          </button>
          <button onClick={() => setShowAddHost(true)} className="bastion-btn bastion-btn-primary">
            <PlusIcon /> Add Host
          </button>
        </div>
      </div>

      {notification && (
        <div className={`bastion-alert bastion-alert-${notification.type}`}>
          {notification.type === 'success' ? <CheckIcon /> : <AlertIcon />}
          {notification.message}
          <button onClick={() => setNotification(null)} className="bastion-alert-close"><XIcon /></button>
        </div>
      )}

      {error && (
        <div className="bastion-alert bastion-alert-error">
          <AlertIcon /> {error}
          <button onClick={() => setError(null)} className="bastion-alert-close"><XIcon /></button>
        </div>
      )}

      {/* Search & Filters */}
      {hosts.length > 0 && (
        <div className="bastion-search-bar">
          <div className="bastion-search-input-wrapper">
            <SearchIcon />
            <input
              type="text"
              placeholder="Search hosts by name, IP, group, tag, MAC..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bastion-search-input"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="bastion-search-clear">
                <XIcon />
              </button>
            )}
          </div>
          <select
            value={filterGroup}
            onChange={(e) => setFilterGroup(e.target.value)}
            className="bastion-filter-select"
          >
            <option value="all">All Groups</option>
            {groups.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="bastion-filter-select"
          >
            <option value="all">All Status</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="unknown">Unknown</option>
          </select>
          {(searchQuery || filterGroup !== 'all' || filterStatus !== 'all') && (
            <span className="bastion-filter-count">
              {filteredHosts.length} of {hosts.length}
            </span>
          )}
        </div>
      )}

      {/* Add Host Form */}
      {showAddHost && (
        <div className="bastion-modal-overlay">
          <form className="bastion-modal" onSubmit={handleAddHost}>
            <h3>Add New Host</h3>
            <div className="bastion-form-group">
              <label>Host ID *</label>
              <input
                type="text"
                placeholder="docker01"
                value={newHost.id}
                onChange={(e) => setNewHost({ ...newHost, id: e.target.value })}
                required
              />
            </div>
            <div className="bastion-form-group">
              <label>IP Address *</label>
              <input
                type="text"
                placeholder="10.0.0.101"
                value={newHost.ip}
                onChange={(e) => setNewHost({ ...newHost, ip: e.target.value })}
                required
              />
            </div>
            <div className="bastion-form-group">
              <label>Group</label>
              <input
                type="text"
                placeholder="docker"
                value={newHost.group}
                onChange={(e) => setNewHost({ ...newHost, group: e.target.value })}
                list="groups-list"
              />
              <datalist id="groups-list">
                {groups.map(g => <option key={g} value={g} />)}
              </datalist>
            </div>
            <div className="bastion-form-group">
              <label>Tags (comma separated)</label>
              <input
                type="text"
                placeholder="production, critical"
                value={newHost.tags}
                onChange={(e) => setNewHost({ ...newHost, tags: e.target.value })}
              />
            </div>
            <div className="bastion-modal-actions">
              <button type="button" onClick={() => setShowAddHost(false)} className="bastion-btn">
                Cancel
              </button>
              <button type="submit" className="bastion-btn bastion-btn-primary">
                <PlusIcon /> Add Host
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Import Modal */}
      {showImport && (
        <div className="bastion-modal-overlay">
          <div className="bastion-modal">
            <h3><UploadIcon /> Import Hosts</h3>
            <p className="bastion-modal-desc">
              Import a hosts.json file to restore or add hosts to the registry.
            </p>
            <div className="bastion-form-group">
              <label>Import Mode</label>
              <div className="bastion-radio-group">
                <label className="bastion-radio">
                  <input
                    type="radio"
                    name="importMode"
                    value="merge"
                    checked={importMode === 'merge'}
                    onChange={() => setImportMode('merge')}
                  />
                  <span>Merge</span>
                  <small>Add new hosts, update existing</small>
                </label>
                <label className="bastion-radio">
                  <input
                    type="radio"
                    name="importMode"
                    value="replace"
                    checked={importMode === 'replace'}
                    onChange={() => setImportMode('replace')}
                  />
                  <span>Replace</span>
                  <small>Delete all hosts and import fresh</small>
                </label>
              </div>
            </div>
            <div className="bastion-form-group">
              <label>Select File</label>
              <input
                type="file"
                accept=".json"
                onChange={handleImport}
                className="bastion-file-input"
              />
            </div>
            <div className="bastion-modal-actions">
              <button type="button" onClick={() => setShowImport(false)} className="bastion-btn">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Host Modal */}
      {editHost && (
        <div className="bastion-modal-overlay">
          <form className="bastion-modal bastion-modal-wide" onSubmit={handleSaveEdit}>
            <h3><EditIcon /> Edit Host: {editHost.id}</h3>
            <div className="bastion-form-row">
              <div className="bastion-form-group">
                <label>IP Address *</label>
                <input
                  type="text"
                  value={editHost.ip}
                  onChange={(e) => setEditHost({ ...editHost, ip: e.target.value })}
                  required
                />
              </div>
              <div className="bastion-form-group">
                <label>Group</label>
                <input
                  type="text"
                  value={editHost.group || ''}
                  onChange={(e) => setEditHost({ ...editHost, group: e.target.value })}
                  list="edit-groups-list"
                />
                <datalist id="edit-groups-list">
                  {groups.map(g => <option key={g} value={g} />)}
                </datalist>
              </div>
            </div>
            <div className="bastion-form-row">
              <div className="bastion-form-group">
                <label>SSH User</label>
                <input
                  type="text"
                  value={editHost.sshUser}
                  onChange={(e) => setEditHost({ ...editHost, sshUser: e.target.value })}
                  placeholder="control"
                />
              </div>
              <div className="bastion-form-group">
                <label>SSH Port</label>
                <input
                  type="number"
                  value={editHost.sshPort}
                  onChange={(e) => setEditHost({ ...editHost, sshPort: e.target.value })}
                  placeholder="22"
                />
              </div>
            </div>
            <div className="bastion-form-group">
              <label>FQDN</label>
              <input
                type="text"
                value={editHost.fqdn || ''}
                onChange={(e) => setEditHost({ ...editHost, fqdn: e.target.value })}
                placeholder="host.example.com"
              />
            </div>
            <div className="bastion-form-group">
              <label>MAC Address</label>
              <input
                type="text"
                value={editHost.mac}
                onChange={(e) => setEditHost({ ...editHost, mac: e.target.value })}
                placeholder="AA:BB:CC:DD:EE:FF"
              />
            </div>
            <div className="bastion-form-group">
              <label>Aliases (comma separated)</label>
              <input
                type="text"
                value={editHost.aliases}
                onChange={(e) => setEditHost({ ...editHost, aliases: e.target.value })}
                placeholder="alias1, alias2"
              />
            </div>
            <div className="bastion-form-group">
              <label>Tags (comma separated)</label>
              <input
                type="text"
                value={editHost.tags}
                onChange={(e) => setEditHost({ ...editHost, tags: e.target.value })}
                placeholder="production, critical"
              />
            </div>
            <div className="bastion-modal-actions">
              <button type="button" onClick={() => setEditHost(null)} className="bastion-btn">
                Cancel
              </button>
              <button type="submit" className={`bastion-btn bastion-btn-primary${saving ? ' bastion-btn-spinning' : ''}`} disabled={saving}>
                {saving ? <><RefreshIcon /> Saving...</> : <><CheckIcon /> Save Changes</>}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Main content */}
      <div className="bastion-content">
        {/* Host list */}
        <div className="bastion-hosts">
          {filteredHosts.length === 0 ? (
            <div className="bastion-empty">
              <div className="bastion-empty-icon"><ServerIcon /></div>
              {hosts.length === 0 ? (
                <>
                  <h3>Your fleet is empty</h3>
                  <p>Register your first host to start managing your infrastructure.</p>
                  <button onClick={() => setShowAddHost(true)} className="bastion-btn bastion-btn-primary">
                    <PlusIcon /> Add Your First Host
                  </button>
                </>
              ) : (
                <>
                  <h3>No hosts match your filters</h3>
                  <p>{hosts.length} hosts in registry, but none match the current search.</p>
                  <button onClick={() => { setSearchQuery(''); setFilterGroup('all'); setFilterStatus('all') }} className="bastion-btn">
                    Clear Filters
                  </button>
                </>
              )}
            </div>
          ) : (
            <table className="bastion-table">
              <thead>
                <tr>
                  <th>Host</th>
                  <th>IP</th>
                  <th>User</th>
                  <th>Group</th>
                  <th>MAC</th>
                  <th>Status</th>
                  <th>Ping</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredHosts.map(host => {
                  const ping = pingResults[host.id]
                  const statusColor = ping ? (ping.reachable ? '#22c55e' : '#ef4444') : '#6b7280'
                  const statusText = ping ? (ping.reachable ? 'Online' : 'Offline') : 'Unknown'
                  return (
                    <tr
                      key={host.id}
                      className={selectedHost?.id === host.id ? 'bastion-row-selected' : ''}
                      onClick={() => setSelectedHost(host)}
                    >
                      <td className="bastion-cell-id">
                        {host.id}
                        {host.aliases?.length > 0 && (
                          <span className="bastion-aliases">({host.aliases.join(', ')})</span>
                        )}
                      </td>
                      <td className="bastion-cell-ip">{host.ip}</td>
                      <td className="bastion-cell-user">{host.ssh?.user || 'control'}</td>
                      <td>
                        <span className="bastion-group-badge">{host.group || 'default'}</span>
                      </td>
                      <td className="bastion-cell-mac">{host.metadata?.mac || '-'}</td>
                      <td>
                        <span className="bastion-status-badge" style={{ color: statusColor }}>
                          <span className="bastion-health-dot" style={{ background: statusColor }} />
                          {statusText}
                        </span>
                      </td>
                      <td className="bastion-cell-ping">
                        {ping ? (
                          ping.reachable ? (
                            <span className="bastion-ping-value">{ping.latency_ms}ms</span>
                          ) : (
                            <span className="bastion-ping-timeout">timeout</span>
                          )
                        ) : (
                          <span className="bastion-ping-pending">{pinging ? '...' : '-'}</span>
                        )}
                      </td>
                      <td className="bastion-cell-actions">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleEditHost(host) }}
                          className="bastion-btn-sm"
                          title="Edit host"
                        >
                          <EditIcon />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setSelectedHost(host) }}
                          className="bastion-btn-sm"
                          title="Execute command"
                        >
                          <TerminalIcon />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); navigate(`/terminal?mode=ssh&host=${host.id}`) }}
                          className="bastion-btn-sm"
                          title="Open shell"
                        >
                          <ShellIcon />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteHost(host.id) }}
                          className="bastion-btn-sm bastion-btn-danger"
                          title="Delete host"
                        >
                          <TrashIcon />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Command panel */}
        {selectedHost && (
          <div className="bastion-command-panel">
            <div className="bastion-command-header">
              <h3><TerminalIcon /> Execute on {selectedHost.id}</h3>
              <button onClick={() => setSelectedHost(null)} className="bastion-btn-sm">
                <XIcon />
              </button>
            </div>
            <div className="bastion-command-input">
              <input
                type="text"
                placeholder="Enter command (e.g., df -h, uptime)"
                value={commandInput}
                onChange={(e) => setCommandInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleExecuteCommand()}
                disabled={executing}
              />
              <button
                onClick={handleExecuteCommand}
                className="bastion-btn bastion-btn-primary"
                disabled={executing || !commandInput.trim()}
              >
                {executing ? 'Running...' : 'Execute'}
              </button>
            </div>
            {commandResult && (
              <div className="bastion-command-output">
                <div className="bastion-output-header">
                  {commandResult.exit_code === 0 ? (
                    <span className="bastion-success"><CheckIcon /> Success</span>
                  ) : (
                    <span className="bastion-error"><XIcon /> {formatExitCode(commandResult.exit_code)}</span>
                  )}
                  {commandResult.duration_ms && (
                    <span className="bastion-duration">{commandResult.duration_ms}ms</span>
                  )}
                  {commandResult._execAt && (
                    <button
                      className="bastion-audit-jump-link"
                      onClick={() => {
                        setAuditJumpFilter({
                          since: commandResult._execAt,
                          search: commandResult._command,
                        })
                        handleTabChange('audit')
                      }}
                    >
                      <ClipboardIcon /> View in Activity
                    </button>
                  )}
                </div>
                {commandResult.stdout && (
                  <pre className="bastion-stdout">{commandResult.stdout}</pre>
                )}
                {commandResult.stderr && (
                  <pre className="bastion-stderr">{commandResult.stderr}</pre>
                )}
                {commandResult.error && (
                  <pre className="bastion-stderr">{commandResult.error}</pre>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Groups summary */}
      {groups.length > 0 && (
        <div className="bastion-groups">
          <h4>Groups ({groups.length})</h4>
          <div className="bastion-group-list">
            {groups.map(g => {
              const count = hosts.filter(h => h.group === g).length
              return (
                <button
                  key={g}
                  className={`bastion-group-chip${filterGroup === g ? ' active' : ''}`}
                  onClick={() => setFilterGroup(filterGroup === g ? 'all' : g)}
                >
                  {g} <span className="bastion-group-chip-count">{count}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Command Validation Modal */}
      <CommandValidationModal
        isOpen={showValidationModal}
        onClose={() => {
          setShowValidationModal(false)
          setCurrentValidation(null)
        }}
        validation={currentValidation}
        command={commandInput}
        hostName={selectedHost?.id}
        onConfirm={handleConfirmExecution}
        onRequestApproval={handleRequestApproval}
      />

      </>}

      {/* Tools Tab */}
      {activeTab === 'tools' && (
        <ToolsTab hosts={hosts} groups={groups} showNotification={showNotification} />
      )}

      {/* Keys Tab */}
      {activeTab === 'keys' && (
        <KeysTab hosts={hosts} groups={groups} showNotification={showNotification} />
      )}

      {/* Audit Tab */}
      {activeTab === 'audit' && (
        <AuditTab showNotification={showNotification} initialFilter={auditJumpFilter} onFilterConsumed={() => setAuditJumpFilter(null)} />
      )}

      <style>{`
        /* .bastion-panel root rule lives in BastionPanel.css — do NOT redefine
           here. Earlier this block overrode border-radius to 8px and used a
           hardcoded calc(100vh - 80px) height, both of which broke the glass
           treatment. Removed; CSS file is the single source. */

        .bastion-loading, .bastion-error {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          padding: 40px;
          text-align: center;
        }

        .bastion-error {
          flex-direction: column;
          color: #ef4444;
        }

        .bastion-error h3 {
          margin: 0 0 8px 0;
        }

        .bastion-error p {
          margin: 4px 0;
          color: var(--m-text-secondary, #a1a1aa);
        }

        .bastion-hint {
          font-size: 12px;
          opacity: 0.7;
        }

        .bastion-spinner {
          width: 24px;
          height: 24px;
          border: 2px solid var(--m-text-tertiary, #71717a);
          border-top-color: var(--m-quox-primary, #38bdf8);
          border-radius: 50%;
          animation: bastion-spin 1s linear infinite;
        }

        @keyframes bastion-spin {
          to { transform: rotate(360deg); }
        }

        .bastion-search-bar {
          display: flex;
          gap: 8px;
          align-items: center;
          margin-bottom: 12px;
        }

        .bastion-search-input-wrapper {
          flex: 1;
          position: relative;
          display: flex;
          align-items: center;
        }

        .bastion-search-input-wrapper > svg {
          position: absolute;
          left: 10px;
          color: var(--m-text-tertiary, #71717a);
          pointer-events: none;
        }

        .bastion-search-input {
          width: 100%;
          padding: 10px 34px 10px 36px;
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
          border-radius: 10px;
          background: rgba(255,255,255,0.06);
          color: #fff;
          font-size: 13px;
          box-shadow: inset 0 1px 0 rgba(0,0,0,0.25);
          transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
        }

        .bastion-search-input:focus {
          outline: none;
          border-color: rgba(56,189,248,0.55);
          background: rgba(255,255,255,0.08);
          box-shadow: inset 0 1px 0 rgba(0,0,0,0.25),
                      0 0 0 3px rgba(56,189,248,0.14),
                      0 0 14px rgba(56,189,248,0.12);
        }

        .bastion-search-input::placeholder {
          color: rgba(255,255,255,0.6);
        }

        .bastion-search-clear {
          position: absolute;
          right: 8px;
          background: none;
          border: none;
          color: rgba(255,255,255,0.75);
          cursor: pointer;
          padding: 4px;
          display: flex;
          border-radius: 6px;
          transition: background 0.15s ease, color 0.15s ease;
        }

        .bastion-search-clear:hover {
          color: #fff;
          background: rgba(255,255,255,0.08);
        }

        .bastion-filter-select {
          padding: 10px 36px 10px 14px;
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
          border-radius: 10px;
          background: rgba(255,255,255,0.06);
          color: #fff;
          font-size: 13px;
          font-family: inherit;
          min-width: 140px;
          cursor: pointer;
          appearance: none;
          -webkit-appearance: none;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='rgba(255,255,255,0.75)' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 12px center;
          background-size: 14px 14px;
          box-shadow: inset 0 1px 0 rgba(0,0,0,0.25);
          transition: border-color 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease;
        }

        .bastion-filter-select:hover {
          border-color: rgba(255,255,255,0.28);
        }

        .bastion-filter-select:focus {
          outline: none;
          border-color: rgba(56,189,248,0.55);
          background-color: rgba(255,255,255,0.08);
          box-shadow: inset 0 1px 0 rgba(0,0,0,0.25),
                      0 0 0 3px rgba(56,189,248,0.14),
                      0 0 14px rgba(56,189,248,0.12);
        }

        .bastion-filter-select option {
          background: #0a0c14;
          color: #fff;
        }

        .bastion-filter-count {
          font-size: 12px;
          color: var(--m-text-tertiary, #71717a);
          white-space: nowrap;
        }

        .bastion-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }

        .bastion-title {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .bastion-title h2 {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
        }

        .bastion-count {
          background: var(--m-bg-elevated, rgba(255, 255, 255, 0.05));
          padding: 2px 8px;
          border-radius: 12px;
          font-size: 12px;
          color: var(--m-text-secondary, #a1a1aa);
        }

        .bastion-actions {
          display: flex;
          gap: 8px;
        }

        .bastion-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 8px 12px;
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.08));
          border-radius: 6px;
          background: var(--m-bg-elevated, rgba(255, 255, 255, 0.05));
          color: var(--m-text-primary, #f4f4f5);
          cursor: pointer;
          font-size: 13px;
          transition: all 0.15s;
        }

        .bastion-btn:hover {
          background: var(--m-bg-float, #1f1f24);
        }

        .bastion-btn-icon {
          padding: 8px;
        }

        .bastion-btn-primary {
          background: var(--m-quox-primary, #38bdf8);
          border-color: var(--m-quox-primary, #38bdf8);
          color: white;
        }

        .bastion-btn-primary:hover {
          background: #0ea5e9;
        }

        .bastion-btn-sm {
          padding: 4px 8px;
          border: none;
          background: transparent;
          color: var(--m-text-secondary, #a1a1aa);
          cursor: pointer;
          border-radius: 4px;
        }

        .bastion-btn-sm:hover {
          background: var(--m-bg-elevated, rgba(255, 255, 255, 0.05));
          color: var(--m-text-primary, #f4f4f5);
        }

        .bastion-btn-danger:hover {
          background: rgba(239, 68, 68, 0.2);
          color: #ef4444;
        }

        .bastion-status-bar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          background: var(--m-bg-elevated, rgba(255, 255, 255, 0.05));
          border-radius: 6px;
          margin-bottom: 12px;
          font-size: 12px;
          color: var(--m-text-secondary, #a1a1aa);
        }

        .bastion-status-indicator {
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }

        .bastion-status-version {
          margin-left: auto;
          opacity: 0.6;
        }

        .bastion-alert {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 12px;
          border-radius: 6px;
          margin-bottom: 12px;
          font-size: 13px;
        }

        .bastion-alert-error {
          background: rgba(239, 68, 68, 0.15);
          color: #ef4444;
        }

        .bastion-alert-success {
          background: rgba(34, 197, 94, 0.12);
          border: 1px solid rgba(34, 197, 94, 0.3);
          color: #86efac;
        }

        .bastion-alert-close {
          margin-left: auto;
          background: none;
          border: none;
          cursor: pointer;
          color: inherit;
          opacity: 0.6;
        }

        .bastion-modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.6);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }

        .bastion-modal {
          background: var(--m-bg-base, rgba(255,255,255,0.04));
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.08));
          border-radius: 14px;
          padding: 20px;
          width: 400px;
          max-width: 90vw;
        }

        .bastion-modal h3 {
          margin: 0 0 16px 0;
          font-size: 16px;
        }

        .bastion-form-group {
          margin-bottom: 12px;
        }

        .bastion-form-group label {
          display: block;
          font-size: 12px;
          color: var(--m-text-secondary, #a1a1aa);
          margin-bottom: 4px;
        }

        .bastion-form-group input {
          width: 100%;
          padding: 8px 12px;
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.08));
          border-radius: 6px;
          background: var(--m-bg-elevated, rgba(255, 255, 255, 0.05));
          color: var(--m-text-primary, #f4f4f5);
          font-size: 14px;
        }

        .bastion-form-group input:focus {
          outline: none;
          border-color: var(--m-quox-primary, #38bdf8);
        }

        .bastion-modal-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 16px;
        }

        .bastion-content {
          display: flex;
          flex-direction: column;
          gap: 16px;
          flex: 1;
          overflow-y: auto;
          min-height: 0;
        }

        .bastion-hosts {
          overflow: auto;
          flex: 1;
          min-height: 0;
          max-height: calc(100vh - 360px);
        }

        .bastion-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          padding: 48px 24px;
          color: var(--m-text-secondary, #a1a1aa);
        }

        .bastion-empty-icon {
          width: 48px;
          height: 48px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--m-quox-muted, rgba(56, 189, 248, 0.15));
          border-radius: 14px;
          color: var(--m-quox-primary, #38bdf8);
          margin-bottom: 4px;
        }

        .bastion-empty h3 {
          margin: 0;
          font-size: 16px;
          font-weight: 600;
          color: var(--m-text-primary, #f4f4f5);
        }

        .bastion-empty p {
          margin: 0 0 8px;
          color: var(--m-text-tertiary, #71717a);
          font-size: 13px;
        }

        .bastion-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }

        /* Plain table header — NO sticky, NO own backdrop-filter, NO dark
           overlay. The morphism comes from the parent .bastion-hosts /
           .bastion-panel glass card frame, same as every other panel. */
        .bastion-table th {
          text-align: left;
          padding: 14px 14px;
          color: #fff;
          font-weight: 700;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          background: transparent;
          border-bottom: 1px solid rgba(255,255,255,0.18);
        }

        .bastion-table td {
          padding: 12px 14px;
          border-bottom: 1px solid rgba(255,255,255,0.06);
          color: #fff;
        }

        .bastion-table tr {
          cursor: pointer;
          transition: background 0.15s ease, box-shadow 0.15s ease;
        }

        .bastion-table tr:hover {
          background: rgba(255,255,255,0.04);
        }

        .bastion-row-selected {
          background: linear-gradient(90deg, rgba(168,85,247,0.14), rgba(56,189,248,0.04)) !important;
          box-shadow: inset 2px 0 0 #a855f7;
        }

        .bastion-cell-id {
          font-weight: 500;
        }

        .bastion-aliases {
          font-weight: normal;
          color: var(--m-text-secondary, #a1a1aa);
          font-size: 11px;
        }

        .bastion-cell-ip {
          font-family: monospace;
          color: var(--m-text-secondary, #a1a1aa);
        }

        .bastion-cell-actions {
          display: flex;
          gap: 4px;
        }

        .bastion-group-badge {
          display: inline-block;
          padding: 2px 8px;
          background: var(--m-bg-elevated, rgba(255, 255, 255, 0.05));
          border-radius: 4px;
          font-size: 11px;
        }

        .bastion-health-dot {
          display: inline-block;
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }

        .bastion-command-panel {
          background: var(--m-bg-elevated, rgba(255, 255, 255, 0.05));
          border-radius: 14px;
          padding: 12px;
        }

        .bastion-command-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
        }

        .bastion-command-header h3 {
          margin: 0;
          font-size: 14px;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .bastion-command-input {
          display: flex;
          gap: 8px;
        }

        .bastion-command-input input {
          flex: 1;
          padding: 8px 12px;
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.08));
          border-radius: 6px;
          background: var(--m-bg-base, rgba(255,255,255,0.04));
          color: var(--m-text-primary, #f4f4f5);
          font-family: monospace;
          font-size: 13px;
        }

        .bastion-command-input input:focus {
          outline: none;
          border-color: var(--m-quox-primary, #38bdf8);
        }

        .bastion-command-output {
          margin-top: 12px;
          background: var(--m-bg-deepest, #09090b);
          border-radius: 6px;
          padding: 12px;
        }

        .bastion-output-header {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 8px;
          font-size: 12px;
        }

        .bastion-audit-jump-link {
          margin-left: auto;
          background: none;
          border: none;
          color: var(--m-text-secondary, #a1a1aa);
          font-size: 11px;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 2px 6px;
          border-radius: 4px;
          transition: color 0.15s, background 0.15s;
        }
        .bastion-audit-jump-link:hover {
          color: var(--m-text-primary, #f4f4f5);
          background: rgba(255,255,255,0.06);
        }

        .bastion-success {
          color: #22c55e;
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .bastion-error {
          color: #ef4444;
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .bastion-duration {
          color: var(--m-text-secondary, #a1a1aa);
        }

        .bastion-stdout, .bastion-stderr {
          margin: 0;
          padding: 8px;
          border-radius: 4px;
          font-family: monospace;
          font-size: 12px;
          white-space: pre-wrap;
          word-break: break-all;
          max-height: 200px;
          overflow: auto;
        }

        .bastion-stdout {
          background: rgba(34, 197, 94, 0.1);
          color: #86efac;
        }

        .bastion-stderr {
          background: rgba(239, 68, 68, 0.1);
          color: #fca5a5;
        }

        .bastion-groups {
          padding-top: 12px;
          border-top: 1px solid var(--m-border-default, rgba(255,255,255,0.08));
        }

        .bastion-groups h4 {
          margin: 0 0 8px 0;
          font-size: 12px;
          color: var(--m-text-secondary, #a1a1aa);
          font-weight: 500;
        }

        .bastion-group-list {
          display: flex;
          flex-wrap: nowrap;
          gap: 6px;
          overflow-x: auto;
          overflow-y: hidden;
          scrollbar-width: thin;
          padding-bottom: 4px;
        }
        .bastion-group-list::-webkit-scrollbar { height: 4px; }
        .bastion-group-list::-webkit-scrollbar-track { background: transparent; }
        .bastion-group-list::-webkit-scrollbar-thumb { background: rgba(168,85,247,0.2); border-radius: 2px; }

        .bastion-group-chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 5px 12px;
          background: rgba(255,255,255,0.05);
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
          border-radius: 10px;
          color: #fff;
          font-size: 12px;
          cursor: pointer;
          transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, transform 0.15s ease;
          white-space: nowrap;
          flex-shrink: 0;
        }

        .bastion-group-chip:hover {
          background: rgba(255,255,255,0.09);
          border-color: rgba(255,255,255,0.28);
        }

        .bastion-group-chip:active {
          transform: translateY(1px) scale(0.98);
          transition-duration: 0.04s;
        }

        .bastion-group-chip.active {
          background: linear-gradient(145deg, rgba(168,85,247,0.18), rgba(56,189,248,0.08));
          border-color: rgba(168,85,247,0.45);
          color: #fff;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.18), 0 0 14px rgba(168,85,247,0.18);
        }

        .bastion-group-chip-count {
          background: rgba(255,255,255,0.08);
          padding: 1px 6px;
          border-radius: 8px;
          font-size: 11px;
          font-weight: 500;
        }

        .bastion-group-chip.active .bastion-group-chip-count {
          background: rgba(56, 189, 248, 0.2);
        }

        .bastion-btn-spinning svg {
          animation: bastion-spin 1s linear infinite;
        }

        .bastion-status-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          font-weight: 500;
        }

        .bastion-cell-ping {
          font-family: monospace;
          font-size: 12px;
        }

        .bastion-ping-value {
          color: #22c55e;
          font-weight: 500;
        }

        .bastion-ping-timeout {
          color: #ef4444;
          font-size: 11px;
        }

        .bastion-ping-pending {
          color: var(--m-text-tertiary, #71717a);
        }

        .bastion-modal-desc {
          margin: 0 0 16px 0;
          color: var(--m-text-secondary, #a1a1aa);
          font-size: 13px;
        }

        .bastion-radio-group {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .bastion-radio {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          cursor: pointer;
          padding: 8px;
          border-radius: 6px;
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.08));
          transition: all 0.15s;
        }

        .bastion-radio:hover {
          background: var(--m-bg-elevated, rgba(255, 255, 255, 0.05));
        }

        .bastion-radio:has(input:checked) {
          border-color: var(--m-quox-primary, #38bdf8);
          background: rgba(56, 189, 248, 0.1);
        }

        .bastion-radio input {
          margin-top: 2px;
        }

        .bastion-radio span {
          font-weight: 500;
        }

        .bastion-radio small {
          display: block;
          color: var(--m-text-secondary, #a1a1aa);
          font-size: 11px;
          margin-top: 2px;
        }

        .bastion-file-input {
          width: 100%;
          padding: 12px;
          border: 2px dashed var(--m-border-default, rgba(255,255,255,0.08));
          border-radius: 6px;
          background: var(--m-bg-elevated, rgba(255, 255, 255, 0.05));
          color: var(--m-text-primary, #f4f4f5);
          cursor: pointer;
        }

        .bastion-file-input:hover {
          border-color: var(--m-quox-primary, #38bdf8);
        }

        .bastion-modal-wide {
          width: 500px;
        }

        .bastion-form-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }

        .bastion-cell-user {
          font-family: monospace;
          font-size: 12px;
          color: var(--m-text-secondary, #a1a1aa);
        }

        .bastion-cell-mac {
          font-family: monospace;
          font-size: 11px;
          color: var(--m-text-tertiary, #71717a);
        }

        /* Tab Bar */
        .bastion-tab-bar {
          display: flex;
          gap: 0;
          margin-bottom: 16px;
          border-bottom: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
          padding: 0;
          width: 100%;
        }

        .bastion-tab {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 12px 18px;
          background: transparent;
          border: none;
          border-radius: 0;
          color: rgba(255,255,255,0.8);
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: color 0.18s ease, background 0.18s ease, transform 0.15s ease;
          position: relative;
          margin-bottom: -1px;
        }

        .bastion-tab:hover:not(.bastion-tab-active) {
          color: #fff;
          background: transparent;
        }

        .bastion-tab:active:not(.bastion-tab-active) {
          transform: translateY(1px) scale(0.985);
          transition-duration: 0.04s;
        }

        .bastion-tab-active {
          color: #fff;
        }

        .bastion-tab-active::after {
          content: '';
          position: absolute;
          left: 0; right: 0; bottom: -1px;
          height: 2px;
          background: linear-gradient(90deg, #38bdf8, #a855f7);
          border-radius: 2px;
          box-shadow: 0 0 8px rgba(168,85,247,0.5);
        }

        .bastion-tab-active:hover {
          color: #fff;
        }

        /* CLI Shell */
        /* ═══ JANUS narrator strip ═══ */
        .bastion-janus-strip {
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 12px 18px;
          margin: 0;
          backdrop-filter: blur(20px) saturate(1.4);
          -webkit-backdrop-filter: blur(20px) saturate(1.4);
          background:
            linear-gradient(90deg, rgba(168,85,247,0.08), rgba(56,189,248,0.04)),
            rgba(0,0,0,0.25);
          border-bottom: 1px solid rgba(255,255,255,0.12);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.1);
          position: relative;
        }
        .bastion-janus-strip::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 2px;
          background: linear-gradient(180deg, #a855f7 0%, #38bdf8 100%);
          box-shadow: 0 0 12px rgba(168,85,247,0.5);
        }
        .bastion-janus-avatar {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background:
            radial-gradient(circle at 30% 30%, rgba(168,85,247,0.25), rgba(56,189,248,0.08) 70%);
          border: 1px solid rgba(168,85,247,0.35);
          box-shadow: 0 0 18px rgba(168,85,247,0.22), inset 0 1px 0 rgba(255,255,255,0.15);
          flex-shrink: 0;
        }
        .bastion-janus-body {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .bastion-janus-name {
          font-size: 10px;
          font-weight: 700;
          color: #a855f7;
          text-transform: uppercase;
          letter-spacing: 0.1em;
        }
        .bastion-janus-tagline {
          color: rgba(255,255,255,0.55);
          font-weight: 500;
          letter-spacing: 0.05em;
        }
        .bastion-janus-message {
          font-size: 13px;
          color: rgba(255,255,255,0.88);
          font-style: italic;
          line-height: 1.4;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .bastion-janus-stats {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 6px 12px;
          background: rgba(0,0,0,0.3);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 999px;
          flex-shrink: 0;
        }
        .bastion-janus-stat {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          font-weight: 700;
          color: #fff;
          font-family: var(--font-mono, monospace);
        }
        .bastion-janus-stat-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          box-shadow: 0 0 8px currentColor;
          animation: bastion-janus-pulse 2.4s ease-in-out infinite;
        }
        @keyframes bastion-janus-pulse {
          0%, 100% { opacity: 0.7; }
          50% { opacity: 1; }
        }

        /* CLI Tool — styled as .qx-terminal-v2 (radial cyan ambient +
           scanlines + glowing cyan accent). */
        .bastion-cli-shell {
          display: flex;
          flex-direction: column;
          flex: 1;
          min-height: 0;
        }

        .bastion-cli-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 12px;
          flex-wrap: nowrap;
          gap: 10px;
        }

        .bastion-cli-title {
          display: flex;
          align-items: center;
          gap: 8px;
          font-weight: 700;
          font-size: 13px;
          color: #fff;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }

        .bastion-cli-badge {
          display: inline-flex;
          align-items: center;
          padding: 3px 10px;
          background: rgba(48,255,144,0.14);
          border: 1px solid rgba(48,255,144,0.35);
          color: #30ff90;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 700;
          font-family: var(--qx-font-mono, 'JetBrains Mono', monospace);
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }

        .bastion-cli-actions {
          display: flex;
          gap: 8px;
          align-items: center;
          flex-shrink: 0;
        }

        .bastion-cli-connected {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 10px;
          color: #30ff90;
          background: rgba(48,255,144,0.14);
          border: 1px solid rgba(48,255,144,0.35);
          padding: 3px 10px;
          border-radius: 999px;
          font-weight: 700;
          font-family: var(--qx-font-mono, 'JetBrains Mono', monospace);
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }
        .bastion-cli-connected::before {
          content: '';
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #30ff90;
          box-shadow: 0 0 6px rgba(48,255,144,0.8);
          animation: qx-dot-breathe 2s ease-in-out infinite;
        }

        .bastion-cli-terminal {
          flex: 1;
          min-height: 0;
          position: relative;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,0.1);
          border-top: 1px solid rgba(56,189,248,0.35);
          border-radius: 14px;
          background:
            radial-gradient(ellipse at 50% 0%, rgba(56,189,248,0.08), transparent 60%),
            #06080f;
          box-shadow:
            0 10px 50px rgba(0,0,0,0.55),
            0 0 24px rgba(56,189,248,0.1),
            inset 0 1px 0 rgba(255,255,255,0.08);
        }

        .bastion-cli-terminal::before {
          content: '';
          position: absolute;
          inset: 0;
          pointer-events: none;
          background: repeating-linear-gradient(
            180deg,
            rgba(56,189,248,0) 0,
            rgba(56,189,248,0) 2px,
            rgba(56,189,248,0.015) 2px,
            rgba(56,189,248,0.015) 3px
          );
          z-index: 3;
          animation: qx-scan 4s linear infinite;
        }

        .bastion-cli-terminal .terminal-embed-container {
          height: 100%;
          position: relative;
          z-index: 2;
        }

        .bastion-cli-embed {
          height: 100% !important;
        }
      `}</style>
    </div>
  )
}
