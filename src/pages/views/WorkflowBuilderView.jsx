/**
 * WorkflowBuilderView — chat-driven workflow builder.
 *
 * Layout: [WireMap Canvas (read-only) | DAEDALUS Chat]
 *
 * STUDY-REV D2 (Option B): chat is the only input surface.
 * Canvas is a live visualisation of what DAEDALUS builds via quoxflow-action blocks
 * parsed by services/workflowActions. No NodePalette, no drag-to-canvas, no
 * connect handles, no delete keys. Per-node click opens a read-only DetailPanel.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { WireMap, NodePalette } from '../../components/workflow'
import { useExecutionOverlay } from '../../components/workflow/WireMap/useExecutionOverlay'
import EvolutionStagePill from '../../components/automation/EvolutionStagePill'
import WorkflowBuilderChat from '../../components/workflow/WorkflowBuilderChat'
import NodeConfigDrawer from '../../components/workflow/NodeConfigDrawer/NodeConfigDrawer'
import PreDeployWarning from '../../components/workflow/NodeConfigDrawer/PreDeployWarning'
import { validateWorkflow } from '../../components/workflow/NodeConfigDrawer/fieldSchema'
import { useWorkflowBuilder } from '../../hooks/useWorkflowBuilder'
import { loadWorkflowJson } from '../../services/workflowLoader'
import {
  createWorkflow,
  getWorkflow,
  executeWorkflow,
  activateWorkflow,
  deactivateWorkflow,
  deleteWorkflow,
  listExecutions,
} from '../../services/workflowEngine'
import LLMAuthBanner from '../../components/ui/LLMAuthBanner'
import PlatformDependencyNotice from '../../components/ui/PlatformDependencyNotice.jsx'
import { getPlatformDependencyIssue } from '../../services/platformDependencyIssues'
import { getObjective } from '../../services/objectivesClient'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import VersionHistory from '../../components/workflow/VersionHistory'
import { evaluateBudgetForExecution } from '../../lib/budgetGuard'
import HardStopDialog from '../../components/HardStopDialog'
import { listPolicies } from '../../services/policyStoreClient'
import '../../components/workflow/WorkflowBuilder.css'

// WAZ-P8 — seed templates keyed by ?seed= param value.
// Each template is a minimal 3-node draft: trigger:schedule → agent:agentic(argus) → notification:deliver.
const WAZUH_SEEDS = {
  'wazuh.vulnerabilities': {
    name: 'Weekly Wazuh vulnerability scan',
    description: 'Runs every Monday at 06:00 UTC. ARGUS scans the fleet for CVEs and delivers a digest to your inbox.',
    nodes: [
      {
        id: 'trigger-schedule-wazuh-vulns',
        type: 'trigger:schedule',
        name: 'Weekly schedule (Mon 06:00 UTC)',
        category: 'trigger',
        config: { cron: '0 6 * * 1', timezone: 'UTC', enabled: true },
        position: { x: 100, y: 160 },
      },
      {
        id: 'argus-scan',
        type: 'agent:agentic',
        name: 'ARGUS — vulnerability scan',
        category: 'action',
        config: {
          goal: 'Run a fleet vulnerability scan via Wazuh and identify the highest-severity CVEs',
          agentId: 'argus',
          maxIterations: 10,
          tools: ['wazuh_vuln_scan', 'wazuh_alerts_list'],
        },
        position: { x: 340, y: 160 },
      },
      {
        id: 'notify',
        type: 'notification:deliver',
        name: 'Deliver digest to inbox',
        category: 'notification',
        config: { title: 'Weekly Wazuh vulnerability digest', body: '${input.summary}', channel: 'inbox' },
        position: { x: 580, y: 160 },
      },
    ],
    edges: [
      { id: 'e-trigger-argus', source: 'trigger-schedule-wazuh-vulns', target: 'argus-scan' },
      { id: 'e-argus-notify', source: 'argus-scan', target: 'notify' },
    ],
  },
  'wazuh.compliance': {
    name: 'Monthly Wazuh compliance report',
    description: 'Runs on the 1st of each month at 07:00 UTC. ARGUS audits SCA posture across the fleet and calls out failing CIS / PCI controls.',
    nodes: [
      {
        id: 'trigger-schedule-wazuh-compliance',
        type: 'trigger:schedule',
        name: 'Monthly schedule (1st 07:00 UTC)',
        category: 'trigger',
        config: { cron: '0 7 1 * *', timezone: 'UTC', enabled: true },
        position: { x: 100, y: 160 },
      },
      {
        id: 'argus-scan',
        type: 'agent:agentic',
        name: 'ARGUS — compliance audit',
        category: 'action',
        config: {
          goal: 'Run a compliance posture report via Wazuh SCA across the fleet and call out failing CIS / PCI controls',
          agentId: 'argus',
          maxIterations: 10,
          tools: ['wazuh_sca_check', 'wazuh_agents_list'],
        },
        position: { x: 340, y: 160 },
      },
      {
        id: 'notify',
        type: 'notification:deliver',
        name: 'Deliver report to inbox',
        category: 'notification',
        config: { title: 'Monthly Wazuh compliance report', body: '${input.summary}', channel: 'inbox' },
        position: { x: 580, y: 160 },
      },
    ],
    edges: [
      { id: 'e-trigger-argus', source: 'trigger-schedule-wazuh-compliance', target: 'argus-scan' },
      { id: 'e-argus-notify', source: 'argus-scan', target: 'notify' },
    ],
  },
}

function WorkflowBuilderView({ embedded = false }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const urlWorkflowId = searchParams.get('id')
  const urlMode = searchParams.get('mode')
  const urlFromObjective = searchParams.get('fromObjective')
  const urlExecutionId = searchParams.get('executionId')
  const viewOnly = urlMode === 'view'
  const builder = useWorkflowBuilder()
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const orgId = currentOrg?.id

  // P5.B — Live execution overlay: subscribe to node-level envelopes for the
  // current execution. Works for both live runs and replays of finished runs.
  const { nodeStatus } = useExecutionOverlay(urlExecutionId)

  // STUDY-REV-2 P1.E — ?fromObjective= banner state
  const [objectiveBanner, setObjectiveBanner] = useState(null) // { title: string } | null

  const [deploying, setDeploying] = useState(false)
  const [deployStatus, setDeployStatus] = useState(null)
  const [running, setRunning] = useState(false)
  const [runFeedback, setRunFeedback] = useState(null)
  // P8.B.3 — budget hard-stop guard
  const [hardStopGuard, setHardStopGuard] = useState(null) // { workflowId, guard }
  const [paletteOpen, setPaletteOpen] = useState(true)
  const [chatOpen, setChatOpen] = useState(true)
  const [drawerNodeId, setDrawerNodeId] = useState(null)
  const [drawerMode, setDrawerMode] = useState('edit')
  const [pendingDeployReport, setPendingDeployReport] = useState(null)
  // P6 phase 2: Activate/Deactivate + Delete + Recent Runs.
  const [active, setActive] = useState(false)
  const [togglingActive, setTogglingActive] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [recentRuns, setRecentRuns] = useState([])
  const [runsTick, setRunsTick] = useState(0)
  // P8.C — policy gate ghost-render: policies that match current workflow nodes
  const [policyGates, setPolicyGates] = useState([]) // [{ nodeId, nodeType, policyId, policyName }]
  // Palette auto-collapses while the drawer is open so the left slot is the
  // drawer alone. The user's prior choice is restored on close.
  const savedPaletteOpenRef = useRef(null)
  const deployIssue = !deployStatus?.success
    ? getPlatformDependencyIssue(deployStatus?.message, {
      service: 'quoxflow',
      featureName: 'Workflow deploy'
    })
    : null

  // Pre-load source: URL ?id= takes priority over location.state.template
  // (the latter is the back-compat path from /workflow-library). With ?id=
  // we hit getWorkflow → builder.loadFromTemplate; the URL is the deep link.
  useEffect(() => {
    if (urlWorkflowId) {
      getWorkflow(urlWorkflowId)
        .then((wf) => {
          if (wf) {
            builder.loadFromTemplate(wf)
            setActive(!!(wf.active ?? wf.isActive))
          }
        })
        .catch((err) => console.error(`Workflow ${urlWorkflowId} load failed:`, err))
      return
    }
    if (location.state?.template) {
      const template = location.state.template
      loadWorkflowJson(template)
        .then((json) => {
          if (json) builder.loadFromTemplate(json)
        })
        .catch((err) => console.error('Template load failed:', err))
    }
  }, [urlWorkflowId, location.state])

  // STUDY-REV-2 P10.I-2 — seed the builder when ?fromObjective= is present.
  // Upgraded from P1.E (1-node stub) to a 4-node draft:
  //   trigger:schedule → agent:agentic (using the objective's agent or QUOX) →
  //   data:transform → human:task (notification delivery placeholder)
  // A banner is shown above the canvas until dismissed.
  // Failure is non-blocking — the builder opens empty on error.
  useEffect(() => {
    if (!urlFromObjective || !authFetch) return
    getObjective(authFetch, urlFromObjective)
      .then((obj) => {
        if (!obj) return
        const title = obj.title || obj.name || 'Objective draft'
        const agentId = obj.agent_id || 'quox'
        const triggerId = `trigger-schedule-${urlFromObjective}`
        const agentNodeId = `agent-invoke-${urlFromObjective}`
        const transformId = `data-transform-${urlFromObjective}`
        const deliverId = `human-deliver-${urlFromObjective}`
        builder.loadFromTemplate({
          name: `${title} — workflow draft`,
          description: obj.description || '',
          nodes: [
            {
              id: triggerId,
              type: 'trigger:schedule',
              name: 'Schedule (daily)',
              category: 'trigger',
              config: { cron: '0 9 * * *', timezone: 'UTC', enabled: true, objectiveId: urlFromObjective, _seedFromObjective: true },
              position: { x: 100, y: 160 },
            },
            {
              id: agentNodeId,
              type: 'agent:agentic',
              name: `${agentId.toUpperCase()} — run objective`,
              category: 'action',
              config: { goal: title, agentId, maxIterations: 10, tools: [] },
              position: { x: 340, y: 160 },
            },
            {
              id: transformId,
              type: 'data:transform',
              name: 'Format output',
              category: 'data',
              config: { expression: '', outputField: 'result' },
              position: { x: 580, y: 160 },
            },
            {
              id: deliverId,
              type: 'human:task',
              name: 'Deliver notification',
              category: 'human',
              config: { title: 'Review output', message: 'Workflow output ready for review.', assignTo: ['*'], priority: 'normal' },
              position: { x: 820, y: 160 },
            },
          ],
          edges: [
            { id: `e-${triggerId}-${agentNodeId}`, source: triggerId, target: agentNodeId },
            { id: `e-${agentNodeId}-${transformId}`, source: agentNodeId, target: transformId },
            { id: `e-${transformId}-${deliverId}`, source: transformId, target: deliverId },
          ],
        })
        setObjectiveBanner({ title })
      })
      .catch((err) => {
        console.error(`[WorkflowBuilderView] fromObjective fetch failed (${urlFromObjective}):`, err)
        // non-blocking — builder remains usable in empty state
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlFromObjective, authFetch])

  // WAZ-P8 — seed the builder from ?seed=wazuh.<scanType> when no workflow id
  // or objective param is present. Fires once on mount only.
  const urlSeed = searchParams.get('seed')
  useEffect(() => {
    if (!urlSeed || urlWorkflowId || urlFromObjective) return
    const template = WAZUH_SEEDS[urlSeed]
    if (!template) return
    builder.loadFromTemplate(template)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // P6 phase 2: load Recent Runs whenever ?id= is present. Re-runs after
  // a Run click via runsTick bump so the panel reflects the new execution.
  useEffect(() => {
    if (!urlWorkflowId) return
    let cancelled = false
    listExecutions({ workflowId: urlWorkflowId, limit: 5 })
      .then((res) => {
        if (cancelled) return
        const list = res?.executions || res?.data || (Array.isArray(res) ? res : [])
        setRecentRuns(list.slice(0, 5))
      })
      .catch((err) => console.error('listExecutions failed:', err))
    return () => { cancelled = true }
  }, [urlWorkflowId, runsTick])

  // Drawer auto-close: if the open node disappears (undo, clear, remove),
  // drop the drawer ref so we don't render a phantom panel.
  useEffect(() => {
    if (!drawerNodeId) return
    const stillExists = builder.nodes.some((n) => n.id === drawerNodeId)
    if (!stillExists) setDrawerNodeId(null)
  }, [drawerNodeId, builder.nodes])

  // Palette auto-collapse while the drawer is open. The drawer occupies the
  // left slot; keeping the palette mounted underneath wastes the column. We
  // remember whatever the user had set and restore on close.
  useEffect(() => {
    if (drawerNodeId) {
      if (savedPaletteOpenRef.current === null) {
        savedPaletteOpenRef.current = paletteOpen
        if (paletteOpen) setPaletteOpen(false)
      }
    } else if (savedPaletteOpenRef.current !== null) {
      setPaletteOpen(savedPaletteOpenRef.current)
      savedPaletteOpenRef.current = null
    }
    // We don't include paletteOpen in deps so the user manually toggling
    // palette mid-edit doesn't reset our memory of the original state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerNodeId])

  // Deploy to QuoxFlow — confirmed (post pre-deploy warning, if any).
  const performDeploy = useCallback(async () => {
    setDeploying(true)
    setDeployStatus(null)
    try {
      const workflow = builder.exportToQuoxFlow()
      const created = await createWorkflow(workflow)
      setDeployStatus({
        success: true,
        message: `Deployed "${created.name || workflow.name}" (ID: ${created.id})`,
      })
      // Surface the Run / Activate / Delete buttons in the toolbar without
      // forcing the user to navigate to /workflows. Updating ?id=<workflowId>
      // arms the existing buttons that key off urlWorkflowId.
      if (created?.id) {
        const next = new URLSearchParams(searchParams)
        next.set('id', created.id)
        setSearchParams(next, { replace: true })
      }
    } catch (err) {
      setDeployStatus({ success: false, message: err.message })
    } finally {
      setDeploying(false)
    }
  }, [builder, searchParams, setSearchParams])

  // Deploy entry point: schema-validate first; if there are missing-required
  // or unfilled-placeholder fields, surface the soft warning modal. The user
  // can still deploy through it; we just want them to see the issues.
  const handleDeploy = useCallback(() => {
    const report = validateWorkflow(builder.nodes)
    if (report.issueCount > 0) {
      setPendingDeployReport(report)
      return
    }
    performDeploy()
  }, [builder.nodes, performDeploy])

  // STUDY-REV-2 P6 (workflow-builder unification, MVP slice): Run button.
  // Only enabled when the workflow has been deployed (we need a workflowId).
  // Two paths: ?id= URL means we're viewing a deployed workflow → use that
  // id directly. Otherwise the user needs to Deploy first.
  //
  // P5.B: On success, we update the URL with ?executionId= so the overlay
  // hook subscribes immediately and stays on the builder canvas. The user
  // can see nodes light up as the workflow executes. Navigation to
  // /executions/:id is now done from the Recent Runs panel (click a run).
  const doRunWorkflowInBuilder = async (workflowId) => {
    setRunning(true)
    setRunFeedback(null)
    try {
      const result = await executeWorkflow(workflowId, { async: true })
      const data = result?.data || result
      const newExecId = data?.executionId || data?.stored?.id || data?.id
      setRunsTick((t) => t + 1)
      if (newExecId) {
        const next = new URLSearchParams(searchParams)
        next.set('executionId', newExecId)
        navigate(`${location.pathname}?${next.toString()}`, { replace: true })
      } else {
        setRunFeedback({ success: true, message: 'Run started — no execution id returned.' })
      }
    } catch (err) {
      setRunFeedback({ success: false, message: err?.message || 'Run failed' })
    } finally {
      setRunning(false)
      setHardStopGuard(null)
    }
  }

  const handleRun = useCallback(async () => {
    if (!urlWorkflowId || running) return

    // P8.B.3 — check budget before firing
    try {
      const guard = await evaluateBudgetForExecution({ authFetch, workflowId: urlWorkflowId })
      if (guard.willHardStop) {
        setHardStopGuard({ workflowId: urlWorkflowId, guard })
        return
      }
    } catch {
      // Guard failure must not block — let server enforce
    }

    await doRunWorkflowInBuilder(urlWorkflowId)
  }, [urlWorkflowId, running, authFetch])

  const handleToggleActive = useCallback(async () => {
    if (!urlWorkflowId || togglingActive) return
    setTogglingActive(true)
    setRunFeedback(null)
    try {
      const fn = active ? deactivateWorkflow : activateWorkflow
      await fn(urlWorkflowId)
      setActive((v) => !v)
      setRunFeedback({ success: true, message: active ? 'Workflow deactivated.' : 'Workflow activated — triggers registered.' })
    } catch (err) {
      setRunFeedback({ success: false, message: err?.message || 'Toggle failed' })
    } finally {
      setTogglingActive(false)
    }
  }, [urlWorkflowId, active, togglingActive])

  const handleDelete = useCallback(async () => {
    if (!urlWorkflowId || deleting) return
    if (!window.confirm(`Delete workflow "${builder.meta?.name || urlWorkflowId}"?\n\nThis is permanent. Active triggers will be unregistered. Past executions stay in /executions for audit.`)) return
    setDeleting(true)
    setRunFeedback(null)
    try {
      await deleteWorkflow(urlWorkflowId)
      navigate('/workflows')
    } catch (err) {
      setRunFeedback({ success: false, message: err?.message || 'Delete failed' })
      setDeleting(false)
    }
  }, [urlWorkflowId, deleting, builder.meta, navigate])

  // Export JSON
  const handleExport = useCallback(() => {
    const workflow = builder.exportToQuoxFlow()
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${workflow.id || 'workflow'}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [builder])

  // Open the drawer in 'create' mode for a freshly-added node.
  const openCreateDrawer = useCallback((nodeId) => {
    if (!nodeId) return
    setDrawerNodeId(nodeId)
    setDrawerMode('create')
  }, [])

  // Drop from the palette: build the right addNode call based on the
  // payload kind. Agent drops resolve to agent:agentic with the agent id
  // pre-filled; node drops carry through unchanged. Each successful add
  // pops the drawer in create mode so the user can configure immediately.
  const handleNodeDrop = useCallback(
    (payload, position) => {
      if (!payload || !payload.nodeType) return
      let created
      if (payload.kind === 'agent') {
        created = builder.addNode(
          'agent:agentic',
          { agent: payload.agentId, name: payload.agentName || payload.agentId },
          position
        )
      } else {
        created = builder.addNode(payload.nodeType, {}, position)
      }
      openCreateDrawer(created?.id)
    },
    [builder, openCreateDrawer]
  )

  const handlePaletteSelect = useCallback(
    (nodeType) => {
      const created = builder.addNode(nodeType, {}, null)
      openCreateDrawer(created?.id)
    },
    [builder, openCreateDrawer]
  )

  const handlePaletteAgentSelect = useCallback(
    (agent) => {
      const created = builder.addNode('agent:agentic', { agent: agent.id, name: agent.name }, null)
      openCreateDrawer(created?.id)
    },
    [builder, openCreateDrawer]
  )

  // Clicking a node on the canvas opens the drawer. In view-only mode
  // (URL ?mode=view) the drawer locks to read-only.
  const handleNodeSelect = useCallback((node) => {
    if (!node?.id) return
    setDrawerNodeId(node.id)
    setDrawerMode(viewOnly ? 'view' : 'edit')
  }, [viewOnly])

  const handleDrawerClose = useCallback(() => setDrawerNodeId(null), [])
  const handleDrawerCancelCreate = useCallback(() => setDrawerNodeId(null), [])

  // Empty-canvas drop: WireMap isn't mounted yet, so the canvas wrapper
  // accepts drops directly. Position is relative to the placeholder so the
  // first node lands roughly where the user dropped it.
  const handleEmptyCanvasDragOver = useCallback((e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleEmptyCanvasDrop = useCallback(
    (e) => {
      e.preventDefault()
      let payload = null
      const structured = e.dataTransfer.getData('application/quoxflow-drop-item')
      if (structured) {
        try { payload = JSON.parse(structured) } catch (_) { payload = null }
      }
      if (!payload) {
        const legacy = e.dataTransfer.getData('application/quoxflow-node')
        if (legacy) payload = { kind: 'node', nodeType: legacy }
      }
      if (!payload) return
      const bounds = e.currentTarget.getBoundingClientRect()
      const position = { x: e.clientX - bounds.left, y: e.clientY - bounds.top }
      handleNodeDrop(payload, position)
    },
    [handleNodeDrop]
  )

  // Connect via dragging between handles on the canvas. Builder dedupes
  // duplicate edges and rejects self-loops.
  const handleConnect = useCallback(
    (source, target, sourceHandle, targetHandle) =>
      builder.connectNodes(source, target, sourceHandle, targetHandle),
    [builder]
  )

  const handleEdgeDelete = useCallback(
    (edgeId) => builder.disconnectEdge(edgeId),
    [builder]
  )

  // P5.C — Version restore: re-fetch the workflow and reload the builder canvas.
  const handleRestore = useCallback(() => {
    if (!urlWorkflowId) return
    getWorkflow(urlWorkflowId)
      .then((wf) => {
        if (wf) {
          builder.loadFromTemplate(wf)
          setActive(!!(wf.active ?? wf.isActive))
        }
      })
      .catch((err) => console.error('[WorkflowBuilderView] handleRestore reload failed:', err))
  }, [urlWorkflowId, builder])


  // P8.C — load policies and cross-reference with workflow nodes to compute ghost gates
  useEffect(() => {
    if (!orgId) return
    listPolicies(orgId)
      .then((result) => {
        const policies = (result?.data || []).filter((p) => p.enabled !== false)
        const nodeTypes = builder.nodes.map((n) => n.type).filter(Boolean)
        if (nodeTypes.length === 0 || policies.length === 0) {
          setPolicyGates([])
          return
        }
        const gates = []
        for (const policy of policies) {
          const scopedTypes = policy.scope?.nodeTypes || []
          for (const node of builder.nodes) {
            if (scopedTypes.includes(node.type)) {
              gates.push({
                nodeId: node.id,
                nodeType: node.type,
                policyId: policy.id,
                policyName: policy.name,
                gatePosition: policy.gate_position || 'pre_node',
              })
            }
          }
        }
        setPolicyGates(gates)
      })
      .catch(() => {
        // Policy load failure is non-fatal; ghost gates degrade gracefully
      })
  }, [orgId, builder.nodes])

  // Build WireMap-compatible JSON from builder state (memoised to avoid re-renders)
  const wireMapJson = useMemo(() => {
    if (builder.nodes.length === 0) return null
    return builder.exportToQuoxFlow()
  }, [builder.nodes, builder.edges, builder.meta])

  const { validation, nodes, meta } = builder

  return (
    <div className="wb-shell">
      <LLMAuthBanner />
      <div
        className={`wb-layout${paletteOpen ? '' : ' wb-layout--no-palette'}${chatOpen ? '' : ' wb-layout--no-chat'}${drawerNodeId ? ' wb-layout--with-drawer' : ''}`}
      >

      {/* Toolbar */}
      <div className="wb-toolbar">
        <button
          className={`wb-toolbar__panel-toggle${paletteOpen ? ' wb-toolbar__panel-toggle--active' : ''}`}
          onClick={() => setPaletteOpen((v) => !v)}
          title={paletteOpen ? 'Hide palette' : 'Show palette'}
          type="button"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1"/>
            <rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/>
            <rect x="14" y="14" width="7" height="7" rx="1"/>
          </svg>
        </button>
        <div className="wb-toolbar__title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
          Workflow Builder
        </div>
        <EvolutionStagePill currentStage="workflow" compact />

        <div className="wb-toolbar__name">
          <input
            type="text"
            placeholder="Untitled Workflow"
            value={meta.name}
            onChange={(e) => builder.updateMeta({ name: e.target.value })}
          />
        </div>

        <div className="wb-toolbar__spacer" />

        <div className="wb-toolbar__actions">
          <button
            className="wb-toolbar__btn"
            onClick={builder.undo}
            disabled={!builder.canUndo}
            title="Undo"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="1 4 1 10 7 10"/>
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
            </svg>
          </button>
          <button
            className="wb-toolbar__btn"
            onClick={builder.redo}
            disabled={!builder.canRedo}
            title="Redo"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>

          <button
            className="wb-toolbar__btn"
            onClick={builder.clear}
            title="Clear canvas (chat preserved)"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
            Clear canvas
          </button>

          <button className="wb-toolbar__btn" onClick={handleExport} title="Export JSON">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Export
          </button>

          <button
            className="wb-toolbar__btn wb-toolbar__btn--primary"
            onClick={handleDeploy}
            disabled={deploying || !validation.valid || nodes.length === 0 || viewOnly}
            title={viewOnly ? 'View-only mode — open without ?mode=view to deploy' : (!validation.valid ? 'Fix validation errors first' : 'Deploy to QuoxFlow')}
            style={viewOnly ? { display: 'none' } : undefined}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="16 16 12 12 8 16"/>
              <line x1="12" y1="12" x2="12" y2="21"/>
              <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
            </svg>
            {deploying ? 'Deploying...' : 'Deploy'}
          </button>

          {urlWorkflowId && (
            <>
              <button
                className="wb-toolbar__btn wb-toolbar__btn--primary"
                onClick={handleRun}
                disabled={running}
                title={running ? 'Running…' : 'Run this workflow now'}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                {running ? 'Running…' : 'Run'}
              </button>
              <button
                className="wb-toolbar__btn"
                onClick={handleToggleActive}
                disabled={togglingActive}
                title={active ? 'Stop the engine from firing this workflow on schedule / event / webhook' : 'Register triggers so this workflow fires on its schedule / event / webhook'}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                  {active
                    ? <><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></>
                    : <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/></>
                  }
                </svg>
                {togglingActive ? '…' : (active ? 'Deactivate' : 'Activate')}
              </button>
              <button
                className="wb-toolbar__btn"
                onClick={handleDelete}
                disabled={deleting}
                title="Delete this workflow (past executions are preserved for audit)"
                style={{ color: '#ef4444' }}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
                {deleting ? '…' : 'Delete'}
              </button>
            </>
          )}

          <button
            className={`wb-toolbar__panel-toggle${chatOpen ? ' wb-toolbar__panel-toggle--active' : ''}`}
            onClick={() => setChatOpen((v) => !v)}
            title={chatOpen ? 'Hide chat' : 'Show chat'}
            type="button"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
        </div>

        <div className={`wb-toolbar__status ${validation.valid ? 'wb-toolbar__status--valid' : nodes.length > 0 ? 'wb-toolbar__status--invalid' : ''}`}>
          <span className="wb-toolbar__dot" />
          {nodes.length === 0
            ? 'Empty'
            : validation.valid
              ? `${nodes.length} nodes`
              : `${validation.errors.length} error${validation.errors.length > 1 ? 's' : ''}`
          }
        </div>
      </div>

      {/* Left: Palette (nodes + agents + teams placeholder).
          Hidden in view-only mode — adding nodes would defeat the lock. */}
      {paletteOpen && !viewOnly && (
        <aside className="wb-palette">
          <NodePalette
            onSelectNode={handlePaletteSelect}
            onSelectAgent={handlePaletteAgentSelect}
          />
        </aside>
      )}

      {/* Center: WireMap Canvas (chat + palette drive mutations) */}
      <div className="wb-canvas">
        {/* STUDY-REV-2 P1.E — fromObjective prefill banner */}
        {objectiveBanner && (
          <div
            style={{
              position: 'absolute',
              top: 12,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 10,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 14px',
              background: 'rgba(99,102,241,0.12)',
              border: '1px solid rgba(99,102,241,0.3)',
              borderRadius: 8,
              fontSize: 12,
              color: 'rgba(165,180,252,0.9)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              whiteSpace: 'nowrap',
              maxWidth: 480,
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(165,180,252,0.8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
            <span>Drafted from objective: <strong style={{ color: 'rgba(199,210,254,0.95)' }}>{objectiveBanner.title}</strong></span>
            <button
              onClick={() => setObjectiveBanner(null)}
              style={{ background: 'none', border: 'none', color: 'rgba(165,180,252,0.6)', cursor: 'pointer', fontSize: 14, padding: '0 2px', lineHeight: 1, marginLeft: 4 }}
              title="Dismiss"
            >✕</button>
          </div>
        )}

        {/* P6 phase 2: Recent Runs panel — top-right of the canvas, only when ?id= is loaded.
            Five most recent executions, click to /executions/:id. Pure overlay, no layout shift. */}
        {urlWorkflowId && recentRuns.length > 0 && (
          <div
            style={{
              position: 'absolute',
              top: 16,
              right: 16,
              zIndex: 5,
              width: 240,
              maxHeight: 'calc(100% - 32px)',
              overflowY: 'auto',
              background: 'var(--m-bg-base)',
              backdropFilter: 'var(--qx-blur)',
              WebkitBackdropFilter: 'var(--qx-blur)',
              border: '1px solid var(--m-border-default)',
              borderRadius: 'var(--qx-radius)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.45)',
              padding: '12px',
              isolation: 'isolate',
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
              Recent runs
            </div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {recentRuns.map((run) => {
                const id = run.id || run.executionId
                const status = run.status || 'unknown'
                const palette = status === 'completed'
                  ? { color: '#86efac', label: 'completed' }
                  : status === 'failed' || status === 'completed_with_errors'
                  ? { color: '#fca5a5', label: status }
                  : status === 'paused' || status === 'waiting_approval'
                  ? { color: '#fcd34d', label: 'paused' }
                  : status === 'running'
                  ? { color: '#7dd3fc', label: 'running' }
                  : { color: 'rgba(255,255,255,0.7)', label: status }
                const startedRaw = run.startedAt || run.started_at || run.createdAt
                const ts = startedRaw ? new Date(startedRaw).toLocaleString() : ''
                return (
                  <li key={id}>
                    <button
                      onClick={() => navigate(`/executions/${id}`)}
                      style={{
                        width: '100%', textAlign: 'left',
                        background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: 8, padding: '6px 8px', cursor: 'pointer',
                        fontSize: 11, color: 'rgba(255,255,255,0.85)',
                        display: 'flex', flexDirection: 'column', gap: 2,
                      }}
                      title={`Open execution ${id}`}
                    >
                      <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ color: palette.color, fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                          ● {palette.label}
                        </span>
                        <span style={{ color: 'rgba(255,255,255,0.5)', fontFamily: 'monospace', fontSize: 9 }}>
                          {String(id).slice(-8)}
                        </span>
                      </span>
                      {ts && <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 10 }}>{ts}</span>}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {wireMapJson ? (
          <WireMap
            workflowJson={wireMapJson}
            onNodeDrop={handleNodeDrop}
            onNodeSelect={handleNodeSelect}
            onConnect={handleConnect}
            onEdgeDelete={handleEdgeDelete}
            disableDetailPanel={true}
            nodeStatus={nodeStatus}
          />
        ) : (
          <div
            className="wb-canvas__empty"
            onDragOver={handleEmptyCanvasDragOver}
            onDrop={handleEmptyCanvasDrop}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <p>Empty workflow.</p>
            <span className="wb-canvas__empty-hint">Drag a node or agent from the palette, or chat with WEAVER on the right.</span>
          </div>
        )}

        {/* P8.C — policy gate ghost-render: show which nodes have approval policies.
            Anchored top-LEFT (not top-right) so it never collides with the
            Recent Runs panel, which also anchors top-right when a workflow
            is loaded (both used to sit in the same corner). */}
        {policyGates.length > 0 && (
          <div
            aria-label="Policy gate indicators"
            style={{
              position: 'absolute',
              top: 12,
              left: 12,
              zIndex: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              maxWidth: 280,
            }}
          >
            {policyGates.map((gate) => (
              <div
                key={`${gate.policyId}-${gate.nodeId}`}
                title={`Approval policy "${gate.policyName}" applies to node "${gate.nodeType}" (${gate.gatePosition})`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 10,
                  fontWeight: 700,
                  fontFamily: 'monospace',
                  letterSpacing: 0.5,
                  color: '#a78bfa',
                  background: 'rgba(167,139,250,0.10)',
                  border: '1px solid rgba(167,139,250,0.25)',
                  borderRadius: 6,
                  padding: '3px 8px',
                }}
              >
                <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
                Approval policy: {gate.policyName}
              </div>
            ))}
          </div>
        )}

        {/* Shared bottom-center toast region — stacks deploy status above run
            feedback so the two never paint over each other (both used to
            anchor to the same bottom:16/left:50% spot independently). */}
        {(deployStatus || runFeedback) && (
          <div
            style={{
              position: 'absolute',
              bottom: 16,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 10,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 8,
              width: 'min(560px, calc(100% - 32px))',
            }}
          >
            {deployStatus && (
              deployIssue ? (
                <PlatformDependencyNotice
                  issue={deployIssue}
                  compact
                  onDismiss={() => setDeployStatus(null)}
                  style={{ width: '100%' }}
                />
              ) : (
                <div style={{
                  padding: '8px 16px',
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 500,
                  background: deployStatus.success ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                  color: deployStatus.success ? '#10b981' : '#ef4444',
                  border: `1px solid ${deployStatus.success ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}>
                  {deployStatus.message}
                  <button
                    onClick={() => setDeployStatus(null)}
                    style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}
                  >
                    x
                  </button>
                </div>
              )
            )}

            {/* Run feedback banner (only shown on error — happy path navigates away). */}
            {runFeedback && (
              <div style={{
                padding: '8px 16px',
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 500,
                background: runFeedback.success ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                color: runFeedback.success ? '#10b981' : '#ef4444',
                border: `1px solid ${runFeedback.success ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}>
                <span>{runFeedback.message}</span>
                <button
                  onClick={() => setRunFeedback(null)}
                  style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}
                >
                  x
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right rail: WEAVER chat + (optionally) Version History footer.
          Wrapped in a single grid cell (col 3, row 2) so the Version History
          disclosure sits BELOW the chat rather than auto-placing into a new
          grid row that pushes canvas + chat off the footer. */}
      {(chatOpen || (urlWorkflowId && orgId && authFetch)) && (
        <div className="wb-rightrail">
          {chatOpen && <WorkflowBuilderChat builder={builder} />}
          {urlWorkflowId && orgId && authFetch && (
            <div className="wb-rightrail__footer">
              <VersionHistory
                workflowId={urlWorkflowId}
                orgId={orgId}
                authFetch={authFetch}
                currentDefinition={wireMapJson}
                onRestore={handleRestore}
              />
            </div>
          )}
        </div>
      )}

      {/* Drawer overlays the chat when a node is selected. */}
      {drawerNodeId && (
        <NodeConfigDrawer
          builder={builder}
          nodeId={drawerNodeId}
          mode={drawerMode}
          lockMode={viewOnly}
          onClose={handleDrawerClose}
          onCancelCreate={handleDrawerCancelCreate}
        />
      )}

      {/* Pre-deploy soft-warn modal — fires only when the schema reports
          missing-required or unfilled-placeholder fields. */}
      {pendingDeployReport && (
        <PreDeployWarning
          report={pendingDeployReport}
          onCancel={() => setPendingDeployReport(null)}
          onConfirm={() => {
            setPendingDeployReport(null)
            performDeploy()
          }}
        />
      )}

      {/* P8.B.3 — Budget hard-stop dialog */}
      <HardStopDialog
        open={!!hardStopGuard}
        onClose={() => setHardStopGuard(null)}
        scope="org"
        current={hardStopGuard?.guard?.current || {}}
        projected={hardStopGuard?.guard?.projected || {}}
        exceeded={hardStopGuard?.guard?.exceeded || []}
        onOverride={() => {
          const wfId = hardStopGuard?.workflowId
          setHardStopGuard(null)
          if (wfId) doRunWorkflowInBuilder(wfId)
        }}
      />
    </div>
    </div>
  )
}

export default WorkflowBuilderView
