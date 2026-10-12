/**
 * ActivityView - AEE Envelope Activity Viewer
 *
 * Master-detail layout: conversation list on left, detail panel on right.
 * Features:
 * - Group by conversation (corr)
 * - Master-detail split view
 * - Filter by type, intent, date, AOCL layer
 * - Click to continue conversation
 * - Export to CSV, JSON, Markdown, NDJSON
 * - Copy thread to clipboard
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  getConversations,
  getConversation,
  getConversationsFromServer,
  getConversationFromServer,
  getStats,
  getEnvelopeSummary,
  AOCL_LAYERS
} from '../../lib/aee'
import { classifySource } from '../../lib/aee/store'
import ConversationList from './ConversationList'
import ConversationDetail from './ConversationDetail'
import ActivityFilters, { DEFAULT_FILTERS } from './ActivityFilters'
import { getEnvelopeDisplayValue } from './activityEmptyState'
import { ReplayModal } from '../replay'
import { TraceComparisonView } from '../comparison'
import { CorrelationTimeline } from '../correlation'
import { useComplianceSuiteStatus } from '../../services/aoclPluginService'
import { subscribeToAEEStatus, getAEEDiagnostics } from '../../services/aeeStatusService'
import './activity.css'

/**
 * Format conversation to Markdown for export/copy
 */
function formatConversationMarkdown(conv, messages) {
  let md = `# Conversation: ${conv.corr}\n\n`
  md += `**Started:** ${new Date(conv.firstMessage?.ts).toLocaleString()}\n`
  md += `**Messages:** ${conv.count}\n\n`
  md += `---\n\n`

  for (const msg of messages) {
    const time = new Date(msg.ts).toLocaleTimeString()
    const isUser = msg.from?.includes('human') || msg.intent?.includes('query')
    const sender = isUser ? 'User' : msg.from || 'Agent'

    if (msg.intent?.startsWith('aocl.')) {
      const layer = msg.payload?.layer || ''
      const status = msg.payload?.status || ''
      const layerInfo = AOCL_LAYERS[layer]
      md += `**[${time}] AOCL ${layer}** (${layerInfo?.label || layer}): ${status}\n`
      if (msg.payload?.duration_ms) {
        md += `  - Duration: ${msg.payload.duration_ms}ms\n`
      }
      md += `\n`
      continue
    }

    const content = msg.payload?.text || msg.payload?.content || JSON.stringify(msg.payload)
    md += `**[${time}] ${sender}:**\n${content}\n\n`
  }

  return md
}

/**
 * Format messages to CSV
 */
function formatConversationCSV(allMessages) {
  const header = 'Timestamp,Type,From,To,Intent,Layer,Content,Correlation ID,Envelope ID\n'
  const rows = allMessages.map(msg => {
    const text = (msg.payload?.text || msg.payload?.command || msg.payload?.error_message || '')
      .replace(/"/g, '""')
      .replace(/\n/g, ' ')
    const layer = msg.payload?.layer || ''
    return `"${msg.ts}","${msg.type}","${msg.from}","${msg.to}","${msg.intent}","${layer}","${text}","${msg.corr}","${msg.id}"`
  })
  return header + rows.join('\n')
}

/**
 * Format conversation to NDJSON
 */
function formatConversationNDJSON(messages) {
  return messages.map(msg => JSON.stringify(msg)).join('\n')
}

/**
 * Download text content as a file
 */
function downloadFile(content, filename, mimeType = 'text/plain') {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export default function ActivityView({ onContinueConversation, onSwitchView, showInsightsTab, onSwitchToInsights, onSwitchToExport, onExportContextChange, initialCorr }) {
  const { licensed: replayLicensed } = useComplianceSuiteStatus()
  const [conversations, setConversations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [stats, setStats] = useState(null)
  // AEE-STATS-DECOUPLE follow-up: the heavy `/collector/aee/stats`
  // COUNT DISTINCT query (~6.5s measured at 1.18M envelopes) is fetched in
  // its own background effect (see loadStats below) so it never blocks the
  // conversation LIST from rendering. `statsLoading` tracks only that
  // background fetch — it must never gate the main `loading` flag or the
  // empty-state banner.
  const [statsLoading, setStatsLoading] = useState(true)
  const PAGE_SIZE = 30
  const [pagination, setPagination] = useState({ total: 0, offset: 0, limit: PAGE_SIZE })

  // ACTIVITY-TABS-2 (taxonomy fix): owner feedback — "Conversations should
  // be USER CHATS with agents ONLY, not core-agent objectives/workflows."
  // Six log-type tabs, each a server-scoped query with its own pagination —
  // not a client-side slice — backed by REAL corr-prefix families verified
  // against the live aee.db (see services/collector/server.js aeeStatements
  // for the full precedence rule + SESSION_ classification evidence):
  //   Chats      — CONV_ (real user<->agent conversations)
  //   Objectives — OBJ_
  //   Workflows  — WORKFLOW_/WF_/wf- executions
  //   Governance — AOCL_ policy events + ANOM_ anomaly detections
  //   Tools      — TOOL_ orphan tool executions
  //   System     — the infra catch-all (AUTH_/MEM_/SESSION_/SHELL_/OPS_/etc)
  const LOG_TABS = [
    { id: 'chats', label: 'Chats',
      icon: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
    { id: 'objectives', label: 'Objectives',
      icon: 'M12 2l3 6.5 7 1-5.1 5 1.2 7L12 18l-6.1 3.5 1.2-7-5.1-5 7-1z' },
    { id: 'workflows', label: 'Workflows',
      icon: 'M22 12h-4l-3 9L9 3l-3 9H2' },
    { id: 'governance', label: 'Governance',
      icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' },
    { id: 'tools', label: 'Tools',
      icon: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' },
    // ACTIVITY-TABS-2 follow-up: Matrix room-DAG activity (`!<roomId>:quox`
    // receipts + `matrix_<roomId>` agent turns) was previously buried in the
    // System catch-all with no way to find it — first-class tab instead.
    { id: 'rooms', label: 'Rooms',
      icon: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10' },
    { id: 'system', label: 'System',
      icon: 'M4 17l6-6-6-6M12 19h8' },
  ]
  const [activeTab, setActiveTab] = useState('chats')
  const [page, setPage] = useState(1)

  // Master-detail state
  const [selectedConv, setSelectedConv] = useState(null)
  const [selectedMessages, setSelectedMessages] = useState([])
  const [loadingMessages, setLoadingMessages] = useState(false)

  // Modal state
  const [showReplayModal, setShowReplayModal] = useState(false)
  const [replayTrace, setReplayTrace] = useState(null)
  const [showComparisonView, setShowComparisonView] = useState(false)
  const [selectedForComparison, setSelectedForComparison] = useState(new Set())
  const [showCorrelationView, setShowCorrelationView] = useState(false)
  const [correlationRunId, setCorrelationRunId] = useState(null)
  const [selectedEnvelope, setSelectedEnvelope] = useState(null)

  // Export menu
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [envelopeViewMode, setEnvelopeViewMode] = useState('pretty')

  // Filters (localStorage persistence handled inside ActivityFilters)
  const [filters, setFilters] = useState({ ...DEFAULT_FILTERS })

  // QOBS follow-up: guards the one-shot auto-relax effect below (see the
  // effect near the data-loading hooks) so it only fires once per tab —
  // set here (not just inside the effect) so a MANUAL "Show hidden
  // activity" click also counts as "already handled" and the effect never
  // re-fires and shows a stale "auto-relaxed" note for a click the user
  // made themselves.
  const autoRelaxedOnceRef = useRef(false)
  // Whether the "Showing all activity..." inline note should render — only
  // true when the auto-relax effect (not the manual button) fired.
  const [autoRelaxNotice, setAutoRelaxNotice] = useState(false)

  // QOBS follow-up: one-click "show hidden activity" action for the honest
  // filtered-empty state — clears all filters AND reveals infrastructure
  // events so a user staring at a misleadingly-empty list can see why.
  const handleRelaxFilters = useCallback(() => {
    autoRelaxedOnceRef.current = true
    setFilters({ ...DEFAULT_FILTERS, includeInfra: true, onlyWithUserActions: false })
  }, [])

  // Re-apply the signal-only default lens (undoes the auto-relax) and
  // dismiss the inline note. Does NOT permanently change the default lens
  // philosophy — just lets the user go back to it after auto-relax showed
  // them what was hidden.
  const handleReapplySignalLens = useCallback(() => {
    setAutoRelaxNotice(false)
    setFilters({ ...DEFAULT_FILTERS })
  }, [])

  // Backup health
  const [backupHealth, setBackupHealth] = useState(null)

  // AEE health
  const [aeeStatus, setAeeStatus] = useState({ healthy: null, lastError: null, consecutiveErrors: 0 })
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [diagnostics, setDiagnostics] = useState(null)

  // Subscribe to AEE status changes
  useEffect(() => {
    const unsubscribe = subscribeToAEEStatus((status) => {
      setAeeStatus(status)
    })
    return unsubscribe
  }, [])

  // Fetch last backup status for health indicator
  useEffect(() => {
    async function fetchBackupHealth() {
      try {
        const res = await fetch('/auth/orgs/default/backups?limit=1&status=completed', {
          signal: AbortSignal.timeout(5000)
        })
        if (!res.ok) return
        const data = await res.json()
        const backups = data.data || data.items || []
        if (backups.length > 0) {
          const lastBackup = backups[0]
          const completedAt = new Date(lastBackup.completed_at || lastBackup.created_at)
          const hoursAgo = (Date.now() - completedAt.getTime()) / (1000 * 60 * 60)
          setBackupHealth({
            lastBackupTime: completedAt,
            hoursAgo,
            status: hoursAgo < 24 ? 'recent' : hoursAgo < 168 ? 'stale' : 'critical'
          })
        } else {
          setBackupHealth({ lastBackupTime: null, hoursAgo: Infinity, status: 'critical' })
        }
      } catch {
        // Backup API unavailable — don't show indicator
      }
    }
    fetchBackupHealth()
  }, [])

  // Load diagnostics when requested
  const loadDiagnostics = async () => {
    setShowDiagnostics(true)
    try {
      const diag = await getAEEDiagnostics()
      setDiagnostics(diag)
    } catch (err) {
      setDiagnostics({ error: err.message })
    }
  }

  // AEE-CORE-2.4: infra-events toggle tracked via ref so loadData closures
  // pick up changes without re-binding the whole callback.
  const includeInfraRef = useRef(false)
  useEffect(() => { includeInfraRef.current = !!filters.includeInfra }, [filters.includeInfra])

  // Load the current page for the active tab (server-first, IndexedDB
  // fallback only on the default Chats tab's first page — the other
  // families/pages have no local equivalent grouping to merge).
  // Used for initial mount, tab switch, infra-toggle flips, the manual
  // Refresh button, and the 30s auto-refresh interval.
  const loadData = useCallback(async ({ silent = false } = {}) => {
    // silent=true (the 30s auto-refresh) skips the loading flag so the list
    // doesn't flash/reset every 30s — that flicker read as "glitchy".
    if (!silent) setLoading(true)
    setError(null)

    try {
      let convs = []
      const offset = (page - 1) * PAGE_SIZE
      try {
        const result = await getConversationsFromServer({
          limit: PAGE_SIZE,
          offset,
          includeNoise: includeInfraRef.current,
          family: activeTab,
        })
        convs = result.conversations
        setPagination({ total: result.total, offset, limit: PAGE_SIZE })
      } catch (serverErr) {
        console.warn('[Activity] Server unavailable, falling back to local:', serverErr.message)
      }
      // Merge any unsynced local IndexedDB conversations — only meaningful
      // on the default tab's first page (other families/pages are purely
      // server-scoped queries with no local mirror).
      if (activeTab === 'chats' && page === 1) {
        try {
          const localConvs = await getConversations({ limit: PAGE_SIZE })
          const serverCorrs = new Set(convs.map(c => c.corr))
          const localOnly = localConvs.filter(c => !serverCorrs.has(c.corr))
          convs = [...convs, ...localOnly]
        } catch (localErr) {
          console.warn('[Activity] IndexedDB unavailable:', localErr.message)
        }
      }
      setConversations(convs)

      // AEE-CORE-2.4: standalone "Recent Events" strip removed. Orphan
      // events now live in the main list under the "Include infrastructure
      // events" toggle — one unified audit surface instead of two.

      // AEE-STATS-DECOUPLE follow-up: the heavy `/collector/aee/stats`
      // COUNT DISTINCT query used to be awaited HERE, meaning the whole
      // list load (and the `loading` flag) waited on it — at 1.18M
      // envelopes that query takes ~6.5s, and on failure/timeout the
      // fallback to local getStats() returned an empty/zeroed result that
      // made the entire screen render "No activity yet" even though the
      // list above just loaded 61,972 real conversations. The stats count
      // is now fetched independently in the background (see loadStats) so
      // it can never block or blank the list.
    } catch (err) {
      console.error('Failed to load activity:', err)
      setError('Failed to load activity data')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [page, activeTab])

  // AEE-STATS-DECOUPLE follow-up: the heavy, global "conversations"/
  // "envelopes" COUNT query — decoupled from the list load above so a slow
  // or failing count (measured ~6.5s at 1.18M envelopes, can be slower
  // under load) never blocks the list from rendering or makes the screen
  // look empty. Not scoped to the active tab/page — `/aee/stats` reports
  // instance-wide totals regardless of which log-type tab is selected.
  // Timeout raised from 10s to 20s so the slow-but-working query has room
  // to actually complete instead of spuriously failing under load.
  const loadStats = useCallback(async () => {
    setStatsLoading(true)
    try {
      const statsRes = await fetch('/collector/aee/stats', { signal: AbortSignal.timeout(20000) })
      if (statsRes.ok) {
        const serverStats = await statsRes.json()
        setStats({
          totalEnvelopes: serverStats.total_envelopes,
          conversations: serverStats.conversations,
          oldestTs: serverStats.oldest_ts,
          newestTs: serverStats.newest_ts
        })
      } else {
        throw new Error('stats endpoint unavailable')
      }
    } catch (err) {
      console.warn('[Activity] /aee/stats unavailable, falling back to local:', err.message)
      try {
        const s = await getStats()
        setStats(s)
      } catch (localErr) {
        console.warn('[Activity] Local stats fallback failed:', localErr.message)
      }
    } finally {
      setStatsLoading(false)
    }
  }, [])

  // Navigate to a specific page of the active tab's query. A direct fetch
  // (rather than just setPage + relying on the loadData effect) keeps
  // pagination clicks snappy and deselects any open detail panel, since the
  // previously selected conversation may not exist on the new page.
  const goToPage = useCallback(async (targetPage) => {
    if (targetPage < 1 || loading) return
    setLoading(true)
    setError(null)
    try {
      const offset = (targetPage - 1) * PAGE_SIZE
      const result = await getConversationsFromServer({
        limit: PAGE_SIZE,
        offset,
        includeNoise: includeInfraRef.current,
        family: activeTab,
      })
      setConversations(result.conversations)
      setPagination({ total: result.total, offset, limit: PAGE_SIZE })
      setPage(targetPage)
      setSelectedConv(null)
      setSelectedMessages([])
    } catch (err) {
      console.error('Failed to load page:', err)
      setError('Failed to load activity data')
    } finally {
      setLoading(false)
    }
  }, [activeTab, loading])

  // Switch log-type tab — resets to page 1 and closes any open detail panel.
  const handleTabChange = useCallback((tabId) => {
    if (tabId === activeTab) return
    setActiveTab(tabId)
    setPage(1)
    setSelectedConv(null)
    setSelectedMessages([])
    // QOBS follow-up: each tab is an independent server-scoped query with
    // its own default lens behavior — re-arm the auto-relax guard so a
    // freshly hidden tab gets the same "don't strand the user" treatment.
    autoRelaxedOnceRef.current = false
    setAutoRelaxNotice(false)
    // ACTIVITY-TABS-2 follow-up: the source-group filter UI only renders on
    // the Chats tab (hideSourceGroups) — a set-then-hidden filters.sources
    // silently hid rows on other tabs with no visible control to clear it.
    // Reset it on every tab switch so it can only ever apply on Chats.
    setFilters(prev => (prev.sources && prev.sources.length > 0) ? { ...prev, sources: [] } : prev)
  }, [activeTab])

  useEffect(() => {
    loadData()
  }, [loadData])

  // AEE-STATS-DECOUPLE follow-up: fetch the heavy background stats count
  // ONCE on mount — it is instance-wide, not scoped to the active tab/page/
  // filters, so it must not re-fire on every tab switch, page change, or
  // infra-toggle flip the way it used to when it lived inside loadData.
  useEffect(() => {
    loadStats()
  }, [loadStats])

  // AEE-CORE-2.4: re-fetch when the infra toggle flips so the new filter
  // mode applies immediately without waiting for the 30s auto-refresh.
  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.includeInfra])

  // Auto-select conversation from URL param (deep link from Agent Stream).
  // Fetches the conversation directly by corr rather than requiring it to
  // already be present in the currently-loaded page.
  useEffect(() => {
    if (initialCorr && !loading && !selectedConv) {
      selectConversation(initialCorr)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCorr, loading])

  // Auto-refresh every 30 seconds — refetches the current page of the
  // active tab (pagination no longer accumulates, so this is a plain reload)
  // AND independently refreshes the background stats count (decoupled —
  // one being slow/failing never blocks or delays the other).
  useEffect(() => {
    const interval = setInterval(() => {
      loadData({ silent: true })
      loadStats()
    }, 30000)
    return () => clearInterval(interval)
  }, [loadData, loadStats])

  // Close export menu on click outside
  useEffect(() => {
    if (!showExportMenu) return
    const handleClick = () => setShowExportMenu(false)
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [showExportMenu])

  // Select a conversation and load its messages (server-first with IndexedDB fallback)
  const selectConversation = async (corr) => {
    if (selectedConv === corr) {
      setSelectedConv(null)
      setSelectedMessages([])
      return
    }
    setSelectedConv(corr)
    setLoadingMessages(true)
    try {
      let messages
      try {
        messages = await getConversationFromServer(corr)
      } catch {
        messages = await getConversation(corr)
      }
      setSelectedMessages(messages)
    } catch (err) {
      console.error('Failed to load conversation:', err)
    } finally {
      setLoadingMessages(false)
    }
  }

  // Continue a conversation. AOCL-DISPATCH-B10: reconstruct the full
  // chat from its envelopes including:
  //   - User prompt (from aocl.run.start.text/queryPreview OR type=task)
  //   - Assistant reply (from type=result OR quox.chat.success.text)
  //   - Failed runs render as a failed-assistant message with the error
  //     so the user can see why it failed AND refresh-and-retry
  //   - Each message carries corr + ts so MessageTrace can render the
  //     persistent AOCL layer trace below it on resume
  const handleContinue = (conv) => {
    // Find timestamp anchors for the conversation's run window
    const runStart = selectedMessages.find(e => e?.intent === 'aocl.run.start')
    const runEnd = selectedMessages.find(e => e?.intent === 'aocl.run.complete' || e?.intent === 'aocl.run.reject')
    const turnStart = runStart?.ts || conv.first_ts
    const turnEnd = runEnd?.ts || conv.last_ts

    const chatMessages = []
    let failureCaptured = false

    for (const env of selectedMessages) {
      if (!env || !env.intent) continue
      const baseMeta = { envelopeId: env.id, ts: env.ts, corr: conv.corr, turnStart, turnEnd }

      // User message — prefer the standard task envelope, fall back to
      // aocl.run.start which carries the full prompt for system or
      // service-key initiated runs.
      if (env.type === 'task' && env.payload?.text) {
        chatMessages.push({ ...baseMeta, role: 'user', text: env.payload.text })
        continue
      }
      if (env.intent === 'aocl.run.start') {
        const text = env.payload?.text || env.payload?.queryPreview || env.payload?.query_preview
        if (text && !chatMessages.some(m => m.role === 'user')) {
          chatMessages.push({ ...baseMeta, role: 'user', text,
            _systemInitiated: env.payload?.userId === 'system' })
        }
        continue
      }

      // Successful assistant reply
      if ((env.type === 'result' || env.intent === 'quox.chat.success') && env.payload?.text) {
        chatMessages.push({
          ...baseMeta,
          role: 'assistant',
          text: env.payload.text,
          assistant: env.from?.replace('agent.', '') || conv.agent || undefined,
        })
        continue
      }

      // Failure: render as a proper assistant message marked failed so
      // the user sees the error inline (with corr+turnStart attached so
      // the AOCL trace renders below — they get prompt + thinking +
      // failure rather than a blank page).
      if (env.intent === 'aocl.run.reject' && !failureCaptured) {
        const reason = env.payload?.firstDenialReason || 'unknown'
        const layer = env.payload?.deniedAtLayer || ''
        const detail = `**Previous attempt failed**${layer ? ` at ${layer}` : ''}: ${reason}`
        chatMessages.push({
          ...baseMeta,
          role: 'assistant',
          text: detail,
          failed: true,
          errorCode: reason,
          deniedAtLayer: layer,
          assistant: conv.agent || 'quox',
        })
        failureCaptured = true
      }
    }

    // Order by timestamp
    chatMessages.sort((a, b) => (a.ts && b.ts) ? new Date(a.ts) - new Date(b.ts) : 0)

    const resultEnv = selectedMessages.find(env =>
      (env.type === 'result' || env.intent === 'quox.chat.success') && env.from)
    const detectedAssistant = resultEnv?.from?.replace('agent.', '') || conv.agent || null
    const payload = {
      corr: conv.corr,
      messages: chatMessages,
      assistantId: detectedAssistant,
      turnStart,
      turnEnd,
    }

    if (chatMessages.length > 0) {
      try { localStorage.setItem('quox-continue-conversation', JSON.stringify(payload)) } catch { /* quota */ }
    } else {
      console.warn('[Activity] Continue: no resumable content for', conv.corr,
        '— intents:', selectedMessages.map(e => e.intent).slice(0, 12))
    }

    if (onContinueConversation) {
      onContinueConversation({ ...conv, _continuePayload: payload })
    } else if (onSwitchView) {
      onSwitchView('command')
    }
  }

  // Copy a conversation thread to clipboard
  const copyThread = async (conv) => {
    try {
      const messages = selectedConv === conv.corr && selectedMessages.length > 0
        ? selectedMessages
        : await getConversation(conv.corr)
      const md = formatConversationMarkdown(conv, messages)
      await navigator.clipboard.writeText(md)
    } catch (err) {
      console.error('Copy failed:', err)
    }
  }

  // Replay
  const handleReplay = (conv, messages) => {
    const queryMsg = messages?.find(m => m.intent === 'quox.chat.query')
    const responseMsg = messages?.find(m => m.intent === 'quox.chat.response')
    const runStartMsg = messages?.find(m => m.intent === 'aocl.run.start')
    const runCompleteMsg = messages?.find(m => m.intent === 'aocl.run.complete')

    setReplayTrace({
      corr: conv.corr,
      runId: runStartMsg?.payload?.runId || conv.corr,
      query: queryMsg?.payload?.text || '',
      response: responseMsg?.payload?.text || '',
      duration_ms: runCompleteMsg?.payload?.duration_ms || 0,
      messages
    })
    setShowReplayModal(true)
  }

  // Comparison
  const handleToggleComparison = (corr, clearAll = false) => {
    if (clearAll) {
      setSelectedForComparison(new Set())
      return
    }
    setSelectedForComparison(prev => {
      const next = new Set(prev)
      if (next.has(corr)) next.delete(corr)
      else next.add(corr)
      return next
    })
  }

  const handleCompare = () => {
    setShowComparisonView(true)
  }

  // Correlation
  const handleViewCorrelation = (conv) => {
    setCorrelationRunId(conv.corr)
    setShowCorrelationView(true)
  }

  // ============================================================
  // Export functions
  // ============================================================

  const collectFilteredEnvelopes = async () => {
    const allEnvelopes = []
    for (const conv of filteredConversations) {
      const messages = await getConversation(conv.corr)
      allEnvelopes.push(...messages)
    }
    allEnvelopes.sort((a, b) => a.ts.localeCompare(b.ts))
    return allEnvelopes
  }

  // Export helpers — support both "all filtered" and "selected conversation" modes
  const getExportMessages = async (scope) => {
    if (scope === 'selected' && selectedConv && selectedMessages.length > 0) {
      return selectedMessages
    }
    return collectFilteredEnvelopes()
  }

  const getExportFilename = (scope, ext) => {
    const timestamp = new Date().toISOString().slice(0, 10)
    if (scope === 'selected' && selectedConv) {
      const safeCorr = selectedConv.slice(0, 16).replace(/[^a-zA-Z0-9_-]/g, '')
      return `aee-${safeCorr}-${timestamp}.${ext}`
    }
    return `aee-export-${timestamp}.${ext}`
  }

  const exportCSV = async (scope = 'all') => {
    try {
      const messages = await getExportMessages(scope)
      const content = formatConversationCSV(messages)
      downloadFile(content, getExportFilename(scope, 'csv'), 'text/csv')
    } catch (err) {
      console.error('CSV export failed:', err)
    }
  }

  const exportJSON = async (scope = 'all') => {
    try {
      const messages = await getExportMessages(scope)
      const content = JSON.stringify(messages, null, 2)
      downloadFile(content, getExportFilename(scope, 'json'), 'application/json')
    } catch (err) {
      console.error('Export failed:', err)
    }
  }

  const exportMarkdown = async (scope = 'all') => {
    try {
      let md = `# AEE Activity Export\n\n`
      md += `**Exported:** ${new Date().toLocaleString()}\n`

      if (scope === 'selected' && selectedConv) {
        const conv = filteredConversations.find(c => c.corr === selectedConv)
        if (conv) {
          md += formatConversationMarkdown(conv, selectedMessages)
        }
      } else {
        md += `**Conversations:** ${filteredConversations.length}\n\n`
        for (const conv of filteredConversations) {
          const messages = await getConversation(conv.corr)
          md += formatConversationMarkdown(conv, messages)
          md += `\n---\n\n`
        }
      }

      downloadFile(md, getExportFilename(scope, 'md'), 'text/markdown')
    } catch (err) {
      console.error('Export failed:', err)
    }
  }

  const exportNDJSON = async (scope = 'all') => {
    try {
      if (scope === 'selected' && selectedConv && selectedMessages.length > 0) {
        const content = formatConversationNDJSON(selectedMessages)
        downloadFile(content, getExportFilename(scope, 'ndjson'), 'application/x-ndjson')
      } else {
        const lines = []
        for (const conv of filteredConversations) {
          const messages = await getConversation(conv.corr)
          lines.push(formatConversationNDJSON(messages))
        }
        const content = lines.join('\n')
        downloadFile(content, getExportFilename(scope, 'ndjson'), 'application/x-ndjson')
      }
    } catch (err) {
      console.error('Export failed:', err)
    }
  }

  // ============================================================
  // Filters
  // ============================================================

  // AEE-CORE-5.2: derive distinct agent ids from loaded conversations for
  // the filter dropdown. Cheap — the data is already in memory.
  const availableAgents = useMemo(() => {
    const set = new Set()
    for (const conv of conversations) {
      const from = conv.firstMessage?.from || ''
      if (from.startsWith('agent.')) set.add(from.slice(6))
      const p = conv.firstMessage?.payload || {}
      const candidate = p.agent || p.agentId || p.agent_name
      if (candidate && typeof candidate === 'string') set.add(candidate)
    }
    return [...set].filter(Boolean).sort()
  }, [conversations])

  const filteredConversations = useMemo(() => conversations.filter(conv => {
    // Source filter — primary filter mechanism. ACTIVITY-TABS-2: the sources
    // UI is only rendered on the Chats tab (hideSourceGroups={activeTab !==
    // 'chats'} below) — applying a stale filters.sources set on other tabs
    // silently hid rows with no visible control to explain why.
    if (activeTab === 'chats' && filters.sources && filters.sources.length > 0) {
      if (!filters.sources.includes(classifySource(conv.corr))) return false
    }

    // AEE-CORE-5: agent filter — match `from: agent.<name>` or payload.agent
    if (filters.agent) {
      const from = conv.firstMessage?.from || ''
      const fromAgent = from.startsWith('agent.') ? from.slice(6) : ''
      const payloadAgent = conv.firstMessage?.payload?.agent || conv.firstMessage?.payload?.agentId || conv.firstMessage?.payload?.agent_name || ''
      if (fromAgent !== filters.agent && payloadAgent !== filters.agent) return false
    }

    // QOBS-1b: signal-first default lens — hide pure-infra conversations
    // (zero user actions) unless the user has enabled the infra toggle.
    // Conversations whose breakdown failed to compute (null) are never
    // hidden by this filter — an honest failure shouldn't suppress data.
    // ACTIVITY-TABS-2: only applies on the Chats tab — the Objectives/
    // Workflows/Governance/Tools/System tabs are infra/non-chat BY
    // DEFINITION, so this lens would otherwise silently hide everything
    // on those tabs.
    if (activeTab === 'chats' && filters.onlyWithUserActions && conv.breakdown && conv.breakdown.user_actions === 0) return false

    // AEE-CORE-5: breakdown quick-filters — only pass rows with >0 in category
    if (filters.onlyWithTools && !(conv.breakdown?.tools > 0)) return false
    if (filters.onlyWithPolicy && !(conv.breakdown?.policy_checks > 0)) return false
    if (filters.onlyWithErrors && !(conv.breakdown?.errors > 0)) return false

    // Type filter — skip when a specific intent filter is active (intent is more specific)
    if (filters.type !== 'all' && filters.intent === 'all') {
      if (conv.firstMessage?.type !== filters.type) return false
    }

    // Intent filter
    if (filters.intent !== 'all') {
      const intent = conv.firstMessage?.intent || ''
      let matchesIntent = false

      switch (filters.intent) {
        case 'chat':
          matchesIntent = intent.includes('chat')
          break
        case 'testing':
          matchesIntent = intent.includes('testing') || intent.includes('test')
          break
        case 'quoxagent':
          matchesIntent = intent.includes('quoxagent') || intent.includes('mha')
          break
        case 'ops':
          matchesIntent = intent.includes('ops') || intent.includes('operation')
          break
        case 'aee':
          matchesIntent = intent.includes('aee') && !intent.includes('aocl')
          break
        case 'workflow':
          matchesIntent = intent.includes('quox.flow') || intent.includes('workflow')
          break
        case 'aocl':
          matchesIntent = intent.startsWith('aocl.')
          break
        default:
          matchesIntent = intent.includes(filters.intent)
      }

      if (!matchesIntent) return false
    }

    // Layer filter (advanced — only applies when not 'all')
    if (filters.layer && filters.layer !== 'all') {
      const firstIntent = conv.firstMessage?.intent || ''
      const isAoclEvent = firstIntent.startsWith('aocl.')

      if (filters.layer === 'layers-only') {
        if (!isAoclEvent) return false
      } else {
        // Specific layer selected
        const layerMatch = conv.firstMessage?.payload?.layer === filters.layer
        if (!layerMatch) return false
      }
    }

    // Search filter
    if (filters.search) {
      const summary = getEnvelopeSummary(conv.firstMessage).toLowerCase()
      if (!summary.includes(filters.search.toLowerCase())) return false
    }

    // Date filter
    if (filters.dateRange !== 'all') {
      const convDate = new Date(conv.firstMessage?.ts)
      const now = new Date()

      if (filters.dateRange === 'hour' && convDate < new Date(now - 3600000)) return false
      if (filters.dateRange === 'day' && convDate < new Date(now - 86400000)) return false
      if (filters.dateRange === 'week' && convDate < new Date(now - 604800000)) return false
    }

    return true
  }), [conversations, filters, activeTab])

  // Push export context to parent for ExportView tab
  const exportContext = useMemo(() => ({
    conversations: filteredConversations,
    selectedConv,
    selectedConversation: selectedConv
      ? filteredConversations.find(conv => conv.corr === selectedConv) || null
      : null,
    selectedMessages,
    filters
  }), [filteredConversations, selectedConv, selectedMessages, filters])

  useEffect(() => {
    if (onExportContextChange) {
      onExportContextChange(exportContext)
    }
  }, [exportContext, onExportContextChange])

  // QOBS follow-up: don't strand the user on an empty screen when the
  // current lens (most commonly the signal-first default, which hides
  // agent/system conversations) hides EVERY conversation while real
  // activity exists. Auto-relax once — same effect as clicking "Show
  // hidden activity" — so the real data renders immediately, with an
  // honest inline note + a one-click way back to the signal-only lens.
  // Guarded by autoRelaxedOnceRef so this only ever fires once per tab
  // (reset on tab change in handleTabChange) — it must never fight a
  // filter choice the user makes after the auto-relax has already run.
  useEffect(() => {
    if (loading) return
    if (autoRelaxedOnceRef.current) return
    const visibleCount = filteredConversations.length
    const totalCount = pagination.total || conversations.length
    // Preserve the genuinely-empty case (totalCount === 0) — no auto-relax,
    // the per-tab "genuine empty" copy in ConversationList handles it.
    if (visibleCount === 0 && totalCount > 0) {
      autoRelaxedOnceRef.current = true
      setAutoRelaxNotice(true)
      handleRelaxFilters()
    }
  }, [loading, filteredConversations.length, pagination.total, conversations.length, handleRelaxFilters])

  // AEE-CORE-2.4: standalone events list retired — one unified surface.

  // AEE-STATS-DECOUPLE follow-up: single source of truth for "how many
  // conversations does the user actually have" — the fast, paginated
  // conversation LIST's own `pagination.total` for the active tab is
  // authoritative and ALWAYS preferred, independent of whether the slow
  // background `/aee/stats` count has resolved yet (`stats` can legitimately
  // be null for a moment on load, or fail/time out under load — neither
  // case should ever make this read as 0). `stats.conversations` is only a
  // last-resort fallback for the rare case the list itself has no total
  // (e.g. the list fetch also failed). Reused by the header stat block AND
  // by the genuinely-empty banner gate below.
  const conversationsTotal = pagination.total || stats?.conversations || 0

  // "No activity yet" must be driven ONLY by the actual conversation LIST —
  // never by the slow/backgrounded stats count. A pending or failed stats
  // fetch must NEVER cause this to read true.
  const listGenuinelyEmpty = conversations.length === 0 && pagination.total === 0

  // ============================================================
  // Render
  // ============================================================

  if (loading && conversations.length === 0) {
    return (
      <div className="activity-view">
        <div className="activity-loading">Loading activity...</div>
      </div>
    )
  }

  return (
    <div className="activity-view">
      {/* PANEL 1 — Header + Filters */}
      <div className="activity-view__panel activity-view__panel-header">
      <div className="activity-header">
        <div className="activity-header-brand">
          <div className="activity-header-icon">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <div className="activity-header-text">
            <h2>ACTIVITY CENTRE</h2>
            <span className="activity-subtitle">Enterprise Compliance & Accountability</span>
          </div>
        </div>
        {(() => {
          // AEE-STATS-DECOUPLE follow-up: the header now renders as soon as
          // the (fast) conversation list has loaded — it no longer waits on
          // `stats` at all. "conversations" always uses the list-driven
          // `conversationsTotal` (see above). "envelopes" shows a neutral
          // "…" placeholder while the background stats query is still
          // pending (first load, before it has ever resolved), rather than
          // 0/blank — and falls back to "—" if it resolves to a value that
          // is mathematically impossible (lower than the conversation
          // count — only happens from a stale/partial fallback, e.g. local
          // IndexedDB after the server /aee/stats call timed out).
          const envelopePending = stats == null && statsLoading
          const envelopeDisplay = envelopePending
            ? null
            : getEnvelopeDisplayValue(stats?.totalEnvelopes, conversationsTotal)
          return (
            <div className="activity-stats">
              <div className="stat-block">
                <span
                  className="stat-value"
                  title={envelopePending
                    ? 'Calculating envelope count…'
                    : envelopeDisplay == null ? 'Envelope count temporarily unavailable' : undefined}
                >
                  {envelopeDisplay != null ? envelopeDisplay.toLocaleString() : (envelopePending ? '…' : '—')}
                </span>
                <span className="stat-label">envelopes</span>
              </div>
              <div className="stat-divider" />
              <div className="stat-block">
                <span className="stat-value">{conversationsTotal?.toLocaleString() ?? '—'}</span>
                <span className="stat-label">conversations</span>
              </div>
            </div>
          )
        })()}
        {/* Backup health indicator */}
        {backupHealth && (
          <div className={`backup-health backup-health--${backupHealth.status}`} title={
            backupHealth.lastBackupTime
              ? `Last backup: ${backupHealth.lastBackupTime.toLocaleString()}`
              : 'No recent backup found'
          }>
            <span className="backup-health-dot" />
            <span className="backup-health-text">
              {backupHealth.status === 'recent' && `Backup: ${Math.round(backupHealth.hoursAgo)}h ago`}
              {backupHealth.status === 'stale' && `Backup: ${Math.round(backupHealth.hoursAgo / 24)}d ago`}
              {backupHealth.status === 'critical' && 'No recent backup'}
            </span>
          </div>
        )}

        <div className="activity-header-actions">
          {showInsightsTab && onSwitchToInsights && (
            <button className="header-action-btn insights-tab-btn" onClick={onSwitchToInsights}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
              </svg>
              Insights
            </button>
          )}
          {onSwitchToExport && (
            <button className="header-action-btn export-tab-btn" onClick={onSwitchToExport}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Export
            </button>
          )}
          <button className="header-action-btn refresh-btn" onClick={loadData} disabled={loading}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            {loading ? '...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Log-type tabs — the primary sectioning. Each tab is a distinct
          server-scoped query (see LOG_TABS) rather than a client filter,
          so switching tabs resets to page 1 and re-fetches. */}
      <div className="activity-tabs" role="tablist" aria-label="Activity log type">
        {LOG_TABS.map(tab => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`activity-tab ${activeTab === tab.id ? 'activity-tab--active' : ''}`}
            onClick={() => handleTabChange(tab.id)}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d={tab.icon}/>
            </svg>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filters — inside the same header panel; source-group checkboxes
          only shown on the Chats tab since the other tabs already scope
          the query server-side (Objectives/Workflows/Governance/Tools/
          System each have a single, unambiguous corr family). */}
      <ActivityFilters
        filters={filters}
        onFilterChange={setFilters}
        totalCount={conversations.length}
        filteredCount={filteredConversations.length}
        availableAgents={availableAgents}
        hideSourceGroups={activeTab !== 'chats'}
      />
      </div>
      {/* End PANEL 1 */}

      {error && (
        <div className="activity-error">{error}</div>
      )}

      {/* AEE Storage Status Banner */}
      {aeeStatus.healthy === false && (
        <div className="aee-status-banner aee-status-error">
          <span className="aee-status-icon">!</span>
          <span className="aee-status-text">
            <strong>AEE Storage Failed</strong>
            {aeeStatus.lastError && <span> - {aeeStatus.lastError}</span>}
            {aeeStatus.consecutiveErrors > 1 && <span> ({aeeStatus.consecutiveErrors} consecutive failures)</span>}
          </span>
          <button className="aee-diagnose-btn" onClick={loadDiagnostics}>Diagnose</button>
        </div>
      )}

      {/* Genuinely-Empty Notice — AEE-STATS-DECOUPLE follow-up: this used to
          gate (partly) on `stats?.totalEnvelopes === 0`, which fires for an
          org with real conversations (e.g. 61,972) whenever the slow
          background `/aee/stats` COUNT DISTINCT query (~6.5s at 1.18M
          envelopes) was still pending, timed out, or fell back to an
          empty/stale local result — a false "no activity" scare on data
          that was already loaded and visible in the list above. This now
          gates ONLY on `listGenuinelyEmpty` — the actual fetched
          conversation LIST and its own `pagination.total` — which is fast,
          paginated, and never blocked by the stats query. A
          pending/failed stats fetch can never trigger this banner. The
          storage-error scare is reserved for the separate
          `aeeStatus.healthy === false` banner above, which already covers
          genuine AEE failures. */}
      {!loading && listGenuinelyEmpty && aeeStatus.healthy !== false && (
        <div className="aee-status-banner aee-status-info">
          <span className="aee-status-icon">i</span>
          <span className="aee-status-text">
            <strong>No activity yet</strong> - conversations and events will appear here once agents start working.
          </span>
        </div>
      )}

      {/* Diagnostics Panel */}
      {showDiagnostics && diagnostics && (
        <div className="aee-diagnostics-panel">
          <div className="diagnostics-header">
            <h3>AEE Storage Diagnostics</h3>
            <button className="close-btn" onClick={() => setShowDiagnostics(false)}>x</button>
          </div>
          <div className="diagnostics-content">
            <div className="diag-section">
              <strong>IndexedDB Available:</strong> {diagnostics.indexedDBAvailable ? 'Yes' : 'No'}
            </div>
            <div className="diag-section">
              <strong>Storage Status:</strong> {aeeStatus.healthy === true ? 'Healthy' : aeeStatus.healthy === false ? 'Failed' : 'Unknown'}
            </div>
            {diagnostics.storageEstimate && !diagnostics.storageEstimate.error && (
              <div className="diag-section">
                <strong>Storage Usage:</strong> {(diagnostics.storageEstimate.usage / 1024 / 1024).toFixed(2)} MB
                / {(diagnostics.storageEstimate.quota / 1024 / 1024).toFixed(0)} MB
                ({diagnostics.storageEstimate.usagePercent})
              </div>
            )}
            {diagnostics.dbStats && !diagnostics.dbStats.error && (
              <div className="diag-section">
                <strong>Envelopes:</strong> {diagnostics.dbStats.totalEnvelopes || 0} stored
              </div>
            )}
            {diagnostics.dbStats?.error && (
              <div className="diag-section diag-error">
                <strong>Database Error:</strong> {diagnostics.dbStats.error}
              </div>
            )}
            {aeeStatus.lastError && (
              <div className="diag-section diag-error">
                <strong>Last Error:</strong> {aeeStatus.lastError}
                {aeeStatus.lastErrorTime && (
                  <span> at {new Date(aeeStatus.lastErrorTime).toLocaleTimeString()}</span>
                )}
              </div>
            )}
            {diagnostics.recommendations?.length > 0 && (
              <div className="diag-section">
                <strong>Recommendations:</strong>
                <ul>
                  {diagnostics.recommendations.map((rec, i) => (
                    <li key={i}>{rec}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="diag-section diag-stats">
              <strong>Session Stats:</strong> {aeeStatus.writeCount} writes, {aeeStatus.errorCount} errors
            </div>
          </div>
        </div>
      )}

      {/* PANELS 2 + 3 — list + detail row */}
      <div className="activity-view__panel-row">
        {/* PANEL 2 — Conversation list */}
        <div className="activity-view__panel activity-view__panel-list">
          <div className="activity-list-panel">
            {/* QOBS follow-up: honest inline note when the default lens was
                auto-relaxed because it hid every conversation on load — see
                the guarded effect near the top of this component. */}
            {autoRelaxNotice && (
              <div className="activity-relax-notice">
                <span>Showing all activity (system/agent events included)</span>
                <button
                  type="button"
                  className="activity-relax-notice__btn"
                  onClick={handleReapplySignalLens}
                  title="Re-apply the signal-only lens (hide agent/system events)"
                >
                  Signal only
                </button>
              </div>
            )}
            {/* QOBS follow-up: this is now the ONLY scrollable region — the
                pagination bar below is a pinned sibling, not part of the
                scroll area, so Prev/Next stay reachable without scrolling
                past a full page of conversations. */}
            <div className="activity-list-panel__scroll">
              <ConversationList
                conversations={filteredConversations}
                selectedConv={selectedConv}
                onSelect={selectConversation}
                comparisonEnabled={replayLicensed}
                selectedForComparison={selectedForComparison}
                onToggleComparison={handleToggleComparison}
                onCompare={handleCompare}
                verbosity={filters.verbosity}
                totalCount={pagination.total || conversations.length}
                onRelaxFilters={handleRelaxFilters}
                activeTab={activeTab}
              />
            </div>
            {/* Server-backed pagination — Prev/Next + page indicator, driven
                by the endpoint's total/offset/limit. Changing page refetches
                from the server (goToPage); nothing is client-sliced. */}
            {pagination.total > 0 && (() => {
              const totalPages = Math.max(1, Math.ceil(pagination.total / PAGE_SIZE))
              const rangeStart = pagination.offset + 1
              const rangeEnd = pagination.offset + conversations.length
              return (
                <div className="activity-pagination">
                  <span className="activity-pagination__range">
                    {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of {pagination.total.toLocaleString()}
                  </span>
                  <div className="activity-pagination__controls">
                    <button
                      type="button"
                      className="activity-pagination__btn"
                      onClick={() => goToPage(page - 1)}
                      disabled={page <= 1 || loading}
                      title="Previous page"
                    >
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="15 18 9 12 15 6"/>
                      </svg>
                      Prev
                    </button>
                    <span className="activity-pagination__page">Page {page} of {totalPages}</span>
                    <button
                      type="button"
                      className="activity-pagination__btn"
                      onClick={() => goToPage(page + 1)}
                      disabled={page >= totalPages || loading}
                      title="Next page"
                    >
                      Next
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 18 15 12 9 6"/>
                      </svg>
                    </button>
                  </div>
                </div>
              )
            })()}
          </div>
        </div>

        {/* PANEL 3 — Detail (always shown; placeholder when no selection) */}
        <div className="activity-view__panel activity-view__panel-detail">
          {selectedConv ? (
            <div className="activity-detail-panel">
              <ConversationDetail
                corr={selectedConv}
                messages={filters.layer === 'chat-only'
                  ? selectedMessages.filter(m => !m.intent?.startsWith('aocl.'))
                  : selectedMessages}
                loading={loadingMessages}
                conversation={filteredConversations.find(c => c.corr === selectedConv)}
                onClose={() => { setSelectedConv(null); setSelectedMessages([]) }}
                onContinue={handleContinue}
                onCopyThread={copyThread}
                onReplay={handleReplay}
                onSelectEnvelope={setSelectedEnvelope}
                onViewCorrelation={handleViewCorrelation}
                replayEnabled={replayLicensed}
                correlationEnabled={replayLicensed}
                verbosity={filters.verbosity}
              />
            </div>
          ) : (
            <div className="activity-detail-empty">
              <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
              </svg>
              <p>Select a conversation to view its envelope chain</p>
            </div>
          )}
        </div>
      </div>

      {/* Comparison View Modal */}
      {showComparisonView && (
        <div className="comparison-modal-overlay">
          <div className="comparison-modal">
            <TraceComparisonView
              selectedTraces={Array.from(selectedForComparison)}
              onClose={() => {
                setShowComparisonView(false)
                setSelectedForComparison(new Set())
              }}
            />
          </div>
        </div>
      )}

      {/* Correlation View Modal */}
      {showCorrelationView && correlationRunId && (
        <div className="correlation-modal-overlay">
          <div className="correlation-modal">
            <CorrelationTimeline
              runId={correlationRunId}
              onClose={() => {
                setShowCorrelationView(false)
                setCorrelationRunId(null)
              }}
            />
          </div>
        </div>
      )}

      {/* Replay Modal */}
      <ReplayModal
        isOpen={showReplayModal}
        onClose={() => {
          setShowReplayModal(false)
          setReplayTrace(null)
        }}
        trace={replayTrace}
      />

      {/* Envelope Detail Modal */}
      {selectedEnvelope && (
        <div className="envelope-modal-overlay" onClick={() => setSelectedEnvelope(null)}>
          <div className="envelope-modal" onClick={e => e.stopPropagation()}>
            <div className="envelope-modal-header">
              <h3>Envelope Detail</h3>
              <div className="envelope-modal-controls">
                <div className="detail-view-toggle">
                  <button
                    className={`detail-view-btn ${envelopeViewMode === 'pretty' ? 'active' : ''}`}
                    onClick={() => setEnvelopeViewMode('pretty')}
                  >Pretty</button>
                  <button
                    className={`detail-view-btn ${envelopeViewMode === 'json' ? 'active' : ''}`}
                    onClick={() => setEnvelopeViewMode('json')}
                  >JSON</button>
                </div>
                <button onClick={() => setSelectedEnvelope(null)}>Close</button>
              </div>
            </div>
            {envelopeViewMode === 'pretty' ? (
              <div className="envelope-pretty">
                <table className="envelope-pretty-table">
                  <tbody>
                    <tr><td className="ep-label">ID</td><td className="ep-value ep-mono">{selectedEnvelope.id}</td></tr>
                    <tr><td className="ep-label">Timestamp</td><td className="ep-value">{new Date(selectedEnvelope.ts).toLocaleString()}</td></tr>
                    <tr><td className="ep-label">Type</td><td className="ep-value"><span className={`conv-tag indicator-${selectedEnvelope.type}`}>{selectedEnvelope.type}</span></td></tr>
                    <tr><td className="ep-label">From</td><td className="ep-value ep-sender">{selectedEnvelope.from}</td></tr>
                    <tr><td className="ep-label">To</td><td className="ep-value">{selectedEnvelope.to}</td></tr>
                    <tr><td className="ep-label">Intent</td><td className="ep-value ep-mono">{selectedEnvelope.intent}</td></tr>
                    <tr><td className="ep-label">Correlation</td><td className="ep-value ep-mono">{selectedEnvelope.corr}</td></tr>
                    {selectedEnvelope.reply_to && <tr><td className="ep-label">Reply To</td><td className="ep-value ep-mono">{selectedEnvelope.reply_to}</td></tr>}
                  </tbody>
                </table>
                <div className="envelope-pretty-payload">
                  <div className="ep-payload-label">Payload</div>
                  <pre className="ep-payload-content">{JSON.stringify(selectedEnvelope.payload, null, 2)}</pre>
                </div>
              </div>
            ) : (
              <pre className="envelope-json">
                {JSON.stringify(selectedEnvelope, null, 2)}
              </pre>
            )}
            <div className="envelope-modal-actions">
              <button onClick={() => {
                navigator.clipboard.writeText(JSON.stringify(selectedEnvelope, null, 2))
              }}>
                Copy JSON
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
