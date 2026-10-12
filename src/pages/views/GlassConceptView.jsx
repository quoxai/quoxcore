/**
 * GlassConceptView v10 — Fixed layout + glass flyout + SVG icons + white titles
 */
import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import React from 'react'
import { EvidenceChainBrowser, DelegationRadar, SwimlaneDiagram, SankeyFlow, TraceWaterfall, LayerHealthMatrix, GaugeCluster, EscalationLadder, NeuralNetwork, RadarSweep, TopologyMap, HexGrid, WorldMap, Oscilloscope, FleetHeatmap as FleetHeatmapViz, OrgTree, RouterConfidence, CapabilityMap, ConnectionGraph, ApprovalCard, OrbitalHUD, SecurityShield, CommandStream, PowerGrid, DataStream, CircuitBoard, GlitchText, DNAHelix, ThreatLevel, MemoryConstellation, MatrixRain, PieChart3D, AgentLeaderboard, PipelineStageIndicator, InboxFeed, Starfield, KITTScanner, HashChain, FlowDiagram, LayerStack, AgentSwarm, StatusGrid, MetricCard, ConversationBubble, ParticleVortex, CognitiveCore, IrisAperture, AlertWaterfall, HoloGrid, ObjectiveChainTimeline, WisdomStore, ObserverDashboard, PostMortemView, AdvisorPanel, GuardianAlert, ContentPipeline, MediaGrid, ClusterTopology, AuditLake, MarketingTeamDashboard, AsyncAgentCard, FederatedWisdomPanel, ComplianceDashboard, CertificationPanel, ReplayBrowser, MatrixRoomView, PricingCalculator, SDKPlayground, InvestorDeckSlide, OnboardingFlow, TrustScorecard, PolicyEditor, AuditExplorer, AgentMarketplace, RevenueMetrics, APIExplorer, WebhookMonitor, IncidentTimeline, CapacityPlanner, DeploymentTracker, AgentCapabilityComparison, TeamCapacityGauge, MemoryTypeBreakdown, EvidenceQualityScore, AgentMeshLatency, ErrorPropagationTree, PluginDependencyResolver, WorkflowSimulator, DocumentCluster, UserJourneyMap, LiveTelemetry, CostAnalytics, TeamTopologyCard, TeamRunDashboard, TeamPerformanceHistory, LearningRouterViz, FallbackChainViz, OpsDeckCanvas, ObjectiveNodeGraph, ZombiePanelView, TaskDependencyMatrix, HeartbeatMonitor, ObjectiveTimeline, ObjectiveComparison, ObjectiveTemplateGallery, BudgetTracker, ObjectiveQueueView, HoloAgentGrid, HoloHierarchyGrid, HoloPipelineGrid, HoloMeshGrid, HoloBattlefield, CognitiveCoreMap, AgentMeshConstellation, ExecutionSolarSystem, MemoryLatticeView, CoreShellHealth, DelegationArcDemo, TopologyTransition, OpsDeck3DPreview, OpsDeckFullPage, OpsDeckWallboard, OpsDeckNodeDetail, OpsDeckObjectiveDetail, OpsDeckMetricStrip, OpsDeck3DControlRoom, OpsDeckAgentGrid, OpsDeckEventStream, OpsDeck3DNucleus, OpsDeck3DFlightPath, MeshArchitecture, MeshRoomList, MeshTimeline, MeshRoomTypes, MeshFederationMap, MeshEventTypes, MeshIncidentRoom, MeshBridgeStatus, MeshHiveWisdom, MeshGatewayFlow, MeshMigrationStatus, MeshFullPage, AssistantQDashboard, AssistantQInbox, AssistantQCalendar, AssistantQActions, AssistantQDemo, AssistantQBrowser, AssistantQEvidence, ContentOpsDashboard, ContentOpsVoice, ContentOpsImage, ContentOpsPipeline, ContentOpsVideo, ContentOpsTeam, ContentOpsBundles, ActionQFullPage, ActionQSmartCard, ActionQAssistant, ActionQPriorityMatrix, ActionQDependencyGraph, ActionQAnalytics, ActionQDelegation, ActionQIntegrations, OrgFullPage, OrgHierarchyTree, OrgMemberDirectory, OrgResourceAllocation, OrgComplianceOverview, DivisionFullPage, DivisionComparisonChart, DivisionOrgChart, DivisionActivityFeed, DivisionBudget, DepartmentFullPage, DepartmentTeamView, DepartmentKnowledge, DepartmentMetrics, DepartmentRBAC, CoreVizMinimal, CoreVizConstellation, CoreVizPulse, CoreVizHUD, CoreVizNebula, CoreVizMatrix, InboxQFullPage, InboxQCompose, InboxQTriageRules, InboxQMultiInbox, InboxQAnalytics, CalendarQFullPage, CalendarQWeekView, CalendarQMeetingPrep, CalendarQConflicts, CalendarQAvailability, BrowserQFullPage, BrowserQSessionManager, BrowserQRecorder, BrowserQExtraction, BrowserQSecurity, MediaQFullPage, MediaQGrid, MediaQLightbox, MediaQCollections, MediaQAgent, MediaQTimeline, MediaQAnalytics, MediaQSources } from '../../components/library/GlassShowcaseComponents'

function LazyPanel({ children, height = 300, style = {} }) {
  const ref = React.useRef(null)
  const [visible, setVisible] = React.useState(false)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVisible(true) }, { rootMargin: '200px' })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])
  return <div ref={ref} style={{ minHeight: visible ? 'auto' : height, ...style }}>
    {visible ? children : <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.3)', fontSize: 11, fontFamily: "'JetBrains Mono',monospace" }}>Loading...</div>}
  </div>
}

export default function GlassConceptView() {
  const [activeGroup, setActiveGroup] = useState(null)
  const [activeItem, setActiveItem] = useState('dashboard')
  const [mainTab, setMainTab] = useState('overview')
  const [tabCat, setTabCat] = useState('platform')

  const tabCategories = {
    showcase: { label: '\u25C6 Showcase', tabs: ['showcase'] },
    platform: { label: 'Platform', tabs: ['overview', 'fleet', 'agents', 'evidence', 'statusgrid', 'metriccard', 'alertfall', 'agentcompare', 'teamcapacity', 'memorybreak', 'livetelemetry'] },
    execution: { label: 'Execution', tabs: ['swimlane', 'waterfall', 'escalation', 'chain', 'leaderboard', 'pipeline', 'inbox', 'approval', 'objectivechain', 'workflowsim', 'errorprop', 'costanalytics'] },
    intelligence: { label: 'Intelligence', tabs: ['wisdom', 'observer', 'postmortem', 'advisor', 'guardian', 'delegation', 'router', 'capability', 'constellation', 'evidencequality', 'agentmesh', 'doccluster'] },
    dataviz: { label: 'Data Viz', tabs: ['sankey', 'gauges', 'oscilloscope', 'heatmap', 'piechartd', 'flowdiagram'] },
    infrastructure: { label: 'Infrastructure', tabs: ['topology', 'fleetheat', 'orgtree', 'connections', 'cluster', 'auditlake', 'powergrid', 'commandstream'] },
    scifi: { label: 'Sci-Fi', tabs: ['neural', 'hexgrid', 'worldmap', 'orbital', 'shield', 'datastream', 'circuit', 'glitch', 'dna', 'matrix', 'threat', 'starfield', 'kitt', 'particlevortex', 'iris', 'hologrid', 'cogcore', 'radarsweep', 'hashchain', 'layerstack', 'agentswarm', 'conversation'] },
    holo: { label: '3D Hologrid', tabs: ['holoagent', 'holohierarchy', 'holopipeline', 'holomesh', 'holobattlefield'] },
    teams: { label: 'Agentic Teams', tabs: ['teamtopo', 'teamrun', 'teamperf', 'learningrouter', 'fallbackchain'] },
    opsdeck: { label: 'OpsDeck', tabs: ['opscanvas', 'objnodegraph', 'zombiepanel', 'taskdepmatrix', 'heartbeatmon', 'opsfullpage', 'opswallboard', 'opsnodedetail', 'opsobjdetail', 'opsmetrics', 'opsagentgrid', 'opseventstream'] },
    opsdeck3d: { label: 'OpsDeck3D', tabs: ['cogmap', 'agentmesh3d', 'execsolar', 'memlattice', 'shellhealth', 'delarc', 'topotrans', 'ops3dpreview', 'ops3dcontrol', 'ops3dnucleus', 'ops3dflight'] },
    objectives: { label: 'Objectives', tabs: ['objtimeline', 'objcompare', 'objtemplates', 'budgettrack', 'objqueue'] },
    matrix: { label: 'Matrix/Mesh', tabs: ['mesharch', 'meshroomlist', 'meshtimeline', 'meshroomtypes', 'meshfedmap', 'meshevents', 'meshincident', 'meshbridges', 'meshhive', 'meshgateway', 'meshmigrate', 'meshfullpage'] },
    roadmap: { label: 'Roadmap', tabs: ['contentpipe', 'mediagrid', 'marketteam', 'asyncagent', 'fedwisdom', 'compliancedash', 'certpanel', 'replaybrowser', 'matrixroom', 'pricingcalc', 'sdkplayground', 'investordeck', 'onboarding', 'trustscore', 'policyeditor', 'auditexplorer', 'agentmarket', 'revenuemetrics', 'apiexplorer', 'webhookmon', 'incidenttime', 'capacityplan', 'deploytrack', 'plugindeps', 'userjourney'] },
    assistantq: { label: 'AssistantQ', tabs: ['aqdash', 'aqinbox', 'aqcalendar', 'aqactions', 'aqdemo', 'aqbrowser', 'aqevidence'] },
    actionq: { label: 'Action-Q', tabs: ['aqfullpage', 'aqsmartcard', 'aqassistant', 'aqpriority', 'aqdepgraph', 'aqanalytics', 'aqdelegation', 'aqintegrations'] },
    contentops2: { label: 'ContentOps', tabs: ['codash', 'covoice', 'coimage', 'copipeline', 'covideo', 'coteam', 'cobundles'] },
    orgs: { label: 'Organisations', tabs: ['orgfull', 'orghierarchy', 'orgmembers', 'orgresources', 'orgcompliance'] },
    divisions: { label: 'Divisions', tabs: ['divfull', 'divcompare', 'divorgchart', 'divactivity', 'divbudget'] },
    departments: { label: 'Departments', tabs: ['deptfull', 'deptteams', 'deptknowledge', 'deptmetrics', 'deptrbac'] },
    inboxq: { label: 'Inbox-Q', tabs: ['iqfull', 'iqcompose', 'iqrules', 'iqmulti', 'iqanalytics'] },
    calendarq: { label: 'Calendar-Q', tabs: ['cqfull', 'cqweek', 'cqprep', 'cqconflicts', 'cqavail'] },
    browserq: { label: 'Browser-Q', tabs: ['bqfull', 'bqsessions', 'bqrecorder', 'bqextract', 'bqsecurity'] },
    mediaq: { label: 'Media-Q', tabs: ['mqfull', 'mqgrid', 'mqlightbox', 'mqcollections', 'mqagent', 'mqtimeline', 'mqanalytics', 'mqsources'] },
    corequox: { label: 'Core Q', tabs: ['qminimal', 'qconstellation', 'qpulse', 'qhud', 'qnebula', 'qmatrix'] },
    settings: { label: '\u2699 Theme', tabs: ['settings'] },
  }

  const tabLabels = {
    overview: 'Overview', fleet: 'Fleet', agents: 'Agents', evidence: 'Evidence',
    sankey: 'Sankey', gauges: 'Gauges', oscilloscope: 'Oscilloscope', heatmap: 'Health',
    swimlane: 'Swimlane', waterfall: 'Trace', escalation: 'Escalation', chain: 'Evidence Chain',
    radarsweep: 'Radar Sweep', delegation: 'Delegation', router: 'Router', capability: 'Capability',
    topology: 'Topology', neural: 'Neural Net', hexgrid: 'Hex Grid', worldmap: 'World Map',
    fleetheat: 'Fleet Heat', orgtree: 'Org Tree', connections: 'Connections',
    approval: 'Approval', settings: 'Theme',
    showcase: 'Showcase',
    orbital: 'Orbital HUD', shield: 'Security Shield', datastream: 'Data Stream', circuit: 'Circuit Board',
    glitch: 'Glitch Text', dna: 'DNA Helix', matrix: 'Matrix Rain', threat: 'Threat Level',
    constellation: 'Memory Constellation', piechartd: '3D Pie Chart',
    commandstream: 'Command Stream', powergrid: 'Power Grid', leaderboard: 'Agent Leaderboard',
    pipeline: 'Pipeline', inbox: 'Inbox Feed',
    starfield: 'Starfield', kitt: 'KITT Scanner', particlevortex: 'Particle Vortex',
    iris: 'Iris Aperture', hologrid: 'Holo Grid', cogcore: 'Cognitive Core',
    hashchain: 'Hash Chain', flowdiagram: 'Flow Diagram', layerstack: 'Layer Stack',
    agentswarm: 'Agent Swarm', objectivechain: 'Objective Chain', conversation: 'Conversation',
    statusgrid: 'Status Grid', metriccard: 'Metric Card', alertfall: 'Alert Waterfall',
    wisdom: 'Wisdom Store', observer: 'Observer', postmortem: 'Post-Mortem', advisor: 'Advisor', guardian: 'Guardian',
    contentpipe: 'Pipeline', mediagrid: 'Media Grid',
    cluster: 'Cluster', auditlake: 'Audit Lake',
    marketteam: 'Marketing Team',
    asyncagent: 'Async Agent', fedwisdom: 'Fed. Wisdom',
    compliancedash: 'Compliance', certpanel: 'Certification', replaybrowser: 'Replay',
    matrixroom: 'Matrix Room', pricingcalc: 'Pricing', sdkplayground: 'SDK Playground',
    investordeck: 'Investor Deck', onboarding: 'Onboarding',
    trustscore: 'Trust Score', policyeditor: 'Policy Editor', auditexplorer: 'Audit Explorer',
    agentmarket: 'Marketplace', revenuemetrics: 'Revenue', apiexplorer: 'API Explorer',
    webhookmon: 'Webhooks', incidenttime: 'Incidents', capacityplan: 'Capacity', deploytrack: 'Deployments',
    agentcompare: 'Agent Compare', teamcapacity: 'Team Capacity', memorybreak: 'Memory Types', livetelemetry: 'Live Telemetry',
    workflowsim: 'Workflow Sim', errorprop: 'Error Cascade', costanalytics: 'Cost Analytics',
    evidencequality: 'Evidence Quality', agentmesh: 'Agent Mesh', doccluster: 'Doc Clusters',
    plugindeps: 'Plugin Deps', userjourney: 'User Journey',
    teamtopo: 'Topology', teamrun: 'Team Run', teamperf: 'Performance', learningrouter: 'Learning Router', fallbackchain: 'Fallback Chain',
    opscanvas: 'OpsDeck', objnodegraph: 'Node Graph', zombiepanel: 'Zombie Panel', taskdepmatrix: 'Dep Matrix', heartbeatmon: 'Heartbeat',
    objtimeline: 'Timeline', objcompare: 'Compare', objtemplates: 'Templates', budgettrack: 'Budget', objqueue: 'Queue',
    holoagent: 'Star Grid', holohierarchy: 'Hierarchy', holopipeline: 'Pipeline', holomesh: 'Mesh', holobattlefield: 'Battlefield',
    cogmap: 'Core Map', agentmesh3d: 'Agent Mesh', execsolar: 'Solar System', memlattice: 'Memory Lattice', shellhealth: 'Shell Health', delarc: 'Delegation Arc', topotrans: 'Topology', ops3dpreview: '3D Preview', ops3dcontrol: 'Control Room', ops3dnucleus: 'Nucleus', ops3dflight: 'Flight Path',
    opsfullpage: 'Full Page', opswallboard: 'Wallboard', opsnodedetail: 'Node Detail', opsobjdetail: 'Objective Detail', opsmetrics: 'Metric Strip', opsagentgrid: 'Agent Grid', opseventstream: 'Event Stream',
    mesharch: 'Architecture', meshroomlist: 'Room List', meshtimeline: 'Timeline', meshroomtypes: 'Room Types', meshfedmap: 'Federation', meshevents: 'Event Types', meshincident: 'Incident Room', meshbridges: 'Bridges', meshhive: 'Hive Wisdom', meshgateway: 'Gateway', meshmigrate: 'Migration', meshfullpage: 'Full Page',
    aqdash: 'Dashboard', aqinbox: 'Inbox', aqcalendar: 'Calendar', aqactions: 'Actions', aqdemo: 'The Demo', aqbrowser: 'Browser', aqevidence: 'Evidence',
    aqfullpage: 'Full Page', aqsmartcard: 'Smart Card', aqassistant: 'Assistant', aqpriority: 'Priority Matrix', aqdepgraph: 'Dependencies', aqanalytics: 'Analytics', aqdelegation: 'Delegation', aqintegrations: 'Integrations',
    codash: 'Dashboard', covoice: 'VoiceOps', coimage: 'ImageOps', copipeline: 'Pipeline', covideo: 'MediaOps', coteam: 'Team', cobundles: 'Bundles',
    orgfull: 'Full Page', orghierarchy: 'Hierarchy', orgmembers: 'Members', orgresources: 'Resources', orgcompliance: 'Compliance',
    divfull: 'Full Page', divcompare: 'Compare', divorgchart: 'Org Chart', divactivity: 'Activity', divbudget: 'Budget',
    deptfull: 'Full Page', deptteams: 'Teams', deptknowledge: 'Knowledge', deptmetrics: 'Metrics', deptrbac: 'RBAC',
    iqfull: 'Full Page', iqcompose: 'AI Compose', iqrules: 'Triage Rules', iqmulti: 'Multi-Inbox', iqanalytics: 'Analytics',
    cqfull: 'Full Page', cqweek: 'Week View', cqprep: 'Meeting Prep', cqconflicts: 'Conflicts', cqavail: 'Availability',
    bqfull: 'Full Page', bqsessions: 'Sessions', bqrecorder: 'Recorder', bqextract: 'Extraction', bqsecurity: 'Security',
    mqfull: 'Full Page', mqgrid: 'Gallery', mqlightbox: 'Lightbox', mqcollections: 'Collections', mqagent: 'Agent', mqtimeline: 'Timeline', mqanalytics: 'Analytics', mqsources: 'Sources',
    qminimal: 'Minimal', qconstellation: 'Constellation', qpulse: 'Pulse', qhud: 'HUD', qnebula: 'Nebula', qmatrix: 'Matrix',
  }
  const [time, setTime] = useState(new Date())
  const [rightOpen, setRightOpen] = useState(true)
  const [killArmed, setKillArmed] = useState(false)
  const [chatMsg, setChatMsg] = useState('')
  const [preset, setPreset] = useState('default')
  const DEF_TV = { blur:40, edgeLight:40, innerGlow:8, shadow:19, saturate:250, orbGlow:24, hoverLift:2, particleOp:19, shimmer:5, glowSpread:0, glowColor:'#a855f7', borderRadius:16, panelGap:8, gridOp:1, animSpeed:100, lightAngle:145, bgTint:0, edgeDim:0, orb1:'#38bdf8', orb2:'#a855f7', orb3:'#6366f1', orb4:'#30ff90' }
  const [tv, setTv] = useState(() => { try { const d = localStorage.getItem('glass_default'); return d ? {...DEF_TV,...JSON.parse(d)} : DEF_TV } catch { return DEF_TV } })
  const [slots, setSlots] = useState(() => { try { return JSON.parse(localStorage.getItem('glass_slots')||'{}') } catch { return {} } })
  const [defaultSlot, setDefaultSlot] = useState(() => localStorage.getItem('glass_default_slot')||'')
  const ut = (k) => (e) => setTv(p => ({...p, [k]: Number(e.target.value)}))
  const uc = (k) => (e) => setTv(p => ({...p, [k]: e.target.value}))
  const saveSlot = (i) => { const ns = {...slots, [i]:{...tv,name:slots[i]?.name||`Slot ${i+1}`}}; setSlots(ns); localStorage.setItem('glass_slots',JSON.stringify(ns)) }
  const loadSlot = (i) => { if(slots[i]) { setTv(s => ({...s,...slots[i]})); setPreset('') } }
  const setAsDefault = (i) => { const d = slots[i]||tv; localStorage.setItem('glass_default',JSON.stringify(d)); setDefaultSlot(String(i)); localStorage.setItem('glass_default_slot',String(i)) }
  const clearSlot = (i) => { const ns = {...slots}; delete ns[i]; setSlots(ns); localStorage.setItem('glass_slots',JSON.stringify(ns)); if(defaultSlot===String(i)){setDefaultSlot('');localStorage.removeItem('glass_default_slot');localStorage.removeItem('glass_default')} }
  const flyoutRef = useRef(null)

  useEffect(() => { const t = setInterval(() => setTime(new Date()), 1000); return () => clearInterval(t) }, [])
  useEffect(() => {
    const handler = (e) => { if (flyoutRef.current && !flyoutRef.current.contains(e.target)) setActiveGroup(null) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const M = "'JetBrains Mono','Fira Code',monospace"

  // SVG icon helper — real dashboard icons
  const Icon = ({name, size=16, color='rgba(255,255,255,0.6)'}) => {
    const s = {width:size,height:size,fill:'none',stroke:color,strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round'}
    const icons = {
      home: <svg viewBox="0 0 24 24" {...s}><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
      grid: <svg viewBox="0 0 24 24" {...s}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
      terminal: <svg viewBox="0 0 24 24" {...s}><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>,
      activity: <svg viewBox="0 0 24 24" {...s}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
      shield: <svg viewBox="0 0 24 24" {...s}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
      cpu: <svg viewBox="0 0 24 24" {...s}><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>,
      tool: <svg viewBox="0 0 24 24" {...s}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>,
      users: <svg viewBox="0 0 24 24" {...s}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
      inbox: <svg viewBox="0 0 24 24" {...s}><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>,
      database: <svg viewBox="0 0 24 24" {...s}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>,
      settings: <svg viewBox="0 0 24 24" {...s}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
      book: <svg viewBox="0 0 24 24" {...s}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>,
      radar: <svg viewBox="0 0 24 24" {...s}><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/><line x1="12" y1="2" x2="12" y2="4"/></svg>,
      folder: <svg viewBox="0 0 24 24" {...s}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>,
      network: <svg viewBox="0 0 24 24" {...s}><rect x="2" y="2" width="6" height="6" rx="1"/><rect x="16" y="2" width="6" height="6" rx="1"/><rect x="9" y="16" width="6" height="6" rx="1"/><line x1="5" y1="8" x2="12" y2="16"/><line x1="19" y1="8" x2="12" y2="16"/></svg>,
      building: <svg viewBox="0 0 24 24" {...s}><rect x="4" y="2" width="16" height="20" rx="1"/><line x1="9" y1="6" x2="9" y2="6.01"/><line x1="15" y1="6" x2="15" y2="6.01"/><line x1="9" y1="10" x2="9" y2="10.01"/><line x1="15" y1="10" x2="15" y2="10.01"/><line x1="9" y1="14" x2="9" y2="14.01"/><line x1="15" y1="14" x2="15" y2="14.01"/><line x1="9" y1="18" x2="15" y2="18"/></svg>,
      puzzle: <svg viewBox="0 0 24 24" {...s}><path d="M12 2a3 3 0 0 0-3 3c0 .6.2 1.2.5 1.7L7 9H4a2 2 0 0 0-2 2v3h2.5A2.5 2.5 0 0 1 7 16.5 2.5 2.5 0 0 1 4.5 19H2v3h20v-3h-2.5a2.5 2.5 0 0 1 0-5H22v-3a2 2 0 0 0-2-2h-3l-2.5-2.3c.3-.5.5-1.1.5-1.7a3 3 0 0 0-3-3z"/></svg>,
      globe: <svg viewBox="0 0 24 24" {...s}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
      store: <svg viewBox="0 0 24 24" {...s}><path d="M3 9h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z"/><path d="M3 9l1.5-5h15L21 9"/><line x1="12" y1="9" x2="12" y2="21"/></svg>,
    }
    return icons[name] || icons.grid
  }

  // Convert hex to rgba for glow
  const hexRgba = (hex, a) => { const h = hex.replace('#',''); const r = parseInt(h.substring(0,2),16)||0; const g = parseInt(h.substring(2,4),16)||0; const b = parseInt(h.substring(4,6),16)||0; return `rgba(${r},${g},${b},${a})` }
  const _gs = Math.min(tv.glowSpread, 80)
  const gl = (x={}) => ({ backdropFilter:`blur(${tv.blur}px) saturate(${tv.saturate/100})`, WebkitBackdropFilter:`blur(${tv.blur}px) saturate(${tv.saturate/100})`, background:`linear-gradient(${tv.lightAngle}deg,rgba(255,255,255,${Math.max(0.005,tv.edgeLight/2000)}) 0%,rgba(255,255,255,${Math.max(0.002,tv.bgTint/200)}) 100%)`, borderTop:`1px solid rgba(255,255,255,${tv.edgeLight/100})`, borderLeft:`1px solid rgba(255,255,255,${Math.max(0,tv.edgeLight/100-0.09)})`, borderRight:`1px solid rgba(255,255,255,${tv.edgeDim/100})`, borderBottom:`1px solid rgba(255,255,255,${tv.edgeDim/100})`, borderRadius:tv.borderRadius, boxShadow:`0 5px ${tv.shadow}px rgba(0,0,0,0.35),0 2px 4px rgba(0,0,0,0.2),inset 0 1px ${2+tv.innerGlow/3}px rgba(255,255,255,${tv.innerGlow/100}),inset 1px 0 ${1+tv.innerGlow/5}px rgba(255,255,255,${tv.innerGlow/200})${_gs>0?`,0 0 ${_gs}px ${hexRgba(tv.glowColor,Math.min(_gs/120,0.5))}`:''}`, position:'relative', overflow:'hidden', transition:`all ${tv.animSpeed/400}s cubic-bezier(0.4,0,0.2,1)`, ...x })
  const gc = (x={}) => gl({ borderRadius:12, padding:'12px 14px', cursor:'pointer', ...x })
  const Sh = () => <div style={{ position:'absolute',inset:0,borderRadius:'inherit',pointerEvents:'none',background:`linear-gradient(105deg,rgba(255,255,255,${tv.shimmer/100}) 0%,transparent 35%,transparent 65%,rgba(255,255,255,${tv.shimmer/500}) 100%)` }}/>
  const hoverGlow = _gs > 0 ? `,0 0 ${Math.min(_gs*1.2,60)}px ${hexRgba(tv.glowColor,0.12)}` : ',0 0 30px rgba(56,189,248,0.07)'
  const ho = { onMouseEnter:e=>{e.currentTarget.style.transform=`translateY(-${tv.hoverLift}px) scale(1.008)`;e.currentTarget.style.boxShadow=`0 ${tv.hoverLift*4}px 30px rgba(0,0,0,0.4)${hoverGlow},inset 0 1px 3px rgba(255,255,255,${tv.innerGlow/100})`;e.currentTarget.style.borderTopColor=`rgba(255,255,255,${Math.min(1,tv.edgeLight/100+0.1)})`}, onMouseLeave:e=>{e.currentTarget.style.transform='';e.currentTarget.style.boxShadow='';e.currentTarget.style.borderTopColor=''}, onMouseDown:e=>{e.currentTarget.style.transform='translateY(1px) scale(0.995)';e.currentTarget.style.boxShadow='0 1px 6px rgba(0,0,0,0.3),inset 0 2px 4px rgba(0,0,0,0.15)'}, onMouseUp:e=>{e.currentTarget.style.transform=`translateY(-${tv.hoverLift}px) scale(1.008)`;e.currentTarget.style.boxShadow=`0 ${tv.hoverLift*4}px 30px rgba(0,0,0,0.4)${hoverGlow},inset 0 1px 3px rgba(255,255,255,${tv.innerGlow/100})`} }
  const hb = (c,x={}) => gl({ borderRadius:10, padding:'5px 12px', cursor:'pointer', display:'flex', alignItems:'center', gap:5, fontSize:11, fontFamily:M, fontWeight:600, color:c||'rgba(255,255,255,0.7)', ...(c&&c!=='rgba(255,255,255,0.7)'?{borderTopColor:`${c}40`,background:`linear-gradient(${tv.lightAngle}deg,${c}10 0%,${c}03 100%)`}:{}), ...x })
  const ib = (x={}) => gl({ borderRadius:10, padding:'6px 8px', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', ...x })

  const Q = ({s=24}) => <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 740" width={s} height={s*(740/620)}><defs><linearGradient id="gq" x1="0" y1="0" x2="620" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0%" stopColor="#38bdf8"/><stop offset="100%" stopColor="#a855f7"/></linearGradient></defs><g transform="translate(96,30) scale(0.72)"><path d="M450.532 359.603L400.532 273C565.532 211.001 473.032 164 488.532 94.5C504.032 25 546.032 0 546.032 0C546.032 0 521.173 49.0536 522.532 85.5C524.38 135.078 577.449 175.548 576.032 227.5C573.947 303.958 450.532 359.603 450.532 359.603Z" fill="url(#gq)"/><path d="M125.528 359.603L175.528 273C10.5279 211.001 103.028 164 87.5279 94.5C72.0279 25 30.0279 0 30.0279 0C30.0279 0 54.8869 49.0536 53.5279 85.5C51.6792 135.078 -1.38893 175.548 0.0278679 227.5C2.113 303.958 125.528 359.603 125.528 359.603Z" fill="url(#gq)"/></g><g transform="translate(50,200)"><path d="M262.181 1.92871C284.097 2.34428 321.484 3.59138 348.179 7.35156C400.234 14.6836 431.354 36.4934 464.679 77.9629C511.474 136.194 506.182 266.278 506.179 266.352H506.035C506.405 278.968 508.307 382.893 472.884 441.409L537.178 497.719L529.178 566.719H427.178L377.932 517.592C368.718 520.411 358.808 522.563 347.994 524.086C321.446 527.825 284.325 529.078 262.361 529.501V529.719C262.361 529.719 258.937 529.716 253.178 529.646C247.426 529.716 244.003 529.719 243.994 529.719V529.501C222.03 529.078 184.909 527.825 158.361 524.086C106.307 516.754 75.1863 494.944 41.8611 453.475C-2.24106 398.594 -0.0773581 279.892 0.320081 266.352H0.181409C0.178448 266.279 -5.11349 136.194 41.6814 77.9629C75.0066 36.4934 106.127 14.6836 158.181 7.35156C184.877 3.59139 222.263 2.34428 244.179 1.92871V1.71875C244.188 1.71875 247.539 1.72075 253.18 1.78809C258.829 1.72067 262.181 1.71875 262.181 1.71875V1.92871ZM253.18 84.8887C211.412 85.2342 162.416 88.5837 138.181 112.352C112.356 137.68 106.629 202.685 106.68 265.086H106.861C106.732 327.871 112.361 393.586 138.361 419.086C162.56 442.819 211.449 446.192 253.178 446.546C269.601 446.407 287.132 445.8 303.832 443.668L234.178 374.181V316.719H330.511L389.933 368.762C395.717 338.812 396.569 301.457 396.494 265.086H396.68C396.771 202.685 394.005 137.68 368.179 112.352C343.945 88.5837 294.949 85.2342 253.18 84.8887Z" fill="url(#gq)"/></g></svg>

  // Mini CognitiveCore
  const CoreViz = () => {
    const [f,setF] = useState(0)
    useEffect(() => { const t = setInterval(() => setF(v=>v+1), 50); return () => clearInterval(t) }, [])
    const rings = [{r:30,c:'#38bdf8',s:0.3},{r:48,c:'#a855f7',s:-0.2},{r:66,c:'#6366f1',s:0.15},{r:84,c:'#30ff90',s:-0.1}]
    return <div style={{width:'100%',display:'flex',justifyContent:'center',padding:'8px 0'}}><svg viewBox="0 0 180 180" style={{width:170,height:170}}>{rings.map((ring,i)=><g key={i} transform={`rotate(${f*ring.s} 90 90)`}><circle cx={90} cy={90} r={ring.r} fill="none" stroke={ring.c} strokeWidth={0.5} opacity={0.15} strokeDasharray="3 5"/>{Array.from({length:4+i*2},(_,j)=>{const a=(j/(4+i*2))*Math.PI*2;return<circle key={j} cx={90+Math.cos(a)*ring.r} cy={90+Math.sin(a)*ring.r} r={2} fill={ring.c} opacity={0.4+Math.sin(f*0.05+j*0.8)*0.3}/>})}</g>)}<circle cx={90} cy={90} r={10} fill="#38bdf8" opacity={0.25+Math.sin(f*0.04)*0.1}/><circle cx={90} cy={90} r={4} fill="#fff" opacity={0.4+Math.sin(f*0.04)*0.15}/></svg></div>
  }

  const groups = [
    { id:'home', icon:'home', label:'Home', items:[{l:'Command',id:'command',i:'radar'},{l:'Dashboard',id:'dashboard',i:'grid'},{l:'Inbox',id:'inbox',i:'inbox',b:3},{l:'Comms',id:'comms',i:'globe'},{l:'Mission Control',id:'mc',i:'radar'},{l:'Activity',id:'activity',i:'activity'}] },
    { id:'work', icon:'terminal', label:'Work', items:[{l:'CLI',id:'cli',i:'terminal'},{l:'Terminal',id:'terminal',i:'terminal'},{l:'Bastion',id:'bastion',i:'database'},{l:'QuoxAgents',id:'infra',i:'cpu'},{l:'Files',id:'files',i:'folder'},{l:'Actions',id:'actions',i:'tool'}] },
    { id:'monitor', icon:'activity', label:'Monitoring', items:[{l:'NOC',id:'noc',i:'activity'},{l:'Grafana',id:'grafana',i:'activity',c:'#f46800'},{l:'Prometheus',id:'prom',i:'activity',c:'#e6522c'},{l:'Uptime Kuma',id:'uptime',i:'activity',c:'#10b981'},{l:'Proxmox',id:'proxmox',i:'cpu',c:'#e65100'},{l:'Wazuh SIEM',id:'wazuh',i:'shield',c:'#00a9e5'},{l:'Docker Fleet',id:'docker',i:'database',c:'#2496ed'}] },
    { id:'ai', icon:'cpu', label:'AI Studio', items:[{l:'Assistants',id:'assistants',i:'users'},{l:'Agents',id:'agents',i:'cpu'},{l:'Agentic Teams',id:'teams-ai',i:'network'},{l:'Tools',id:'tools',i:'tool'},{l:'Workflows',id:'workflows',i:'activity'},{l:'Prompts',id:'prompts',i:'folder'}] },
    { id:'gov', icon:'shield', label:'Governance', items:[{l:'Policies',id:'policies',i:'shield'},{l:'Evidence',id:'evidence',i:'folder'},{l:'VOLT',id:'volt',i:'database'},{l:'WARD',id:'ward',i:'shield'},{l:'Compliance',id:'compliance',i:'shield'}] },
    { id:'org', icon:'building', label:'Organisation', items:[{l:'Organisations',id:'orgs',i:'building'},{l:'Divisions',id:'divisions',i:'grid'},{l:'Teams',id:'teams',i:'users'},{l:'GitHub',id:'github',i:'globe',c:'#8b5cf6'}] },
    { id:'market', icon:'store', label:'Marketplace', items:[{l:'Browse',id:'market-browse',i:'grid'},{l:'Seller Dashboard',id:'seller',i:'building'},{l:'New Listing',id:'submit',i:'folder'}] },
    { id:'platform', icon:'settings', label:'Platform', items:[{l:'Topology',id:'topology',i:'network'},{l:'Memory',id:'memory',i:'database'},{l:'Plugins',id:'plugins',i:'puzzle'},{l:'Settings',id:'settings',i:'settings'}] },
  ]

  const hosts = [{n:'edge-01',c:12,m:26,r:'Docker',k:'#30ff90'},{n:'edge-02',c:8,m:19,r:'Docker',k:'#30ff90'},{n:'edge-03',c:23,m:34,r:'Docker',k:'#30ff90'},{n:'hyp-01',c:45,m:62,r:'Proxmox',k:'#e65100'},{n:'hyp-02',c:38,m:41,r:'Proxmox',k:'#e65100'},{n:'hyp-03',c:15,m:28,r:'Proxmox',k:'#e65100'},{n:'gw-01',c:5,m:8,r:'Bastion',k:'#f59e0b'},{n:'nas01',c:12,m:45,r:'NAS',k:'#06b6d4'}]
  const ags = [{n:'CommanderQ',r:'Orchestrator',c:'#38bdf8',s:94},{n:'WARDEN',r:'Security',c:'#ef4444',s:91},{n:'VULCAN',r:'Dev',c:'#a855f7',s:88},{n:'HYPERION',r:'Monitor',c:'#f59e0b',s:96}]

  const chat = [{from:'user',text:'Show fleet status'},{from:'ai',text:'All 10 hosts online. edge-03 at 23% CPU. hyp-01 running 12 VMs at 45%. No alerts.'},{from:'user',text:'Security concerns?'},{from:'ai',text:'WARDEN clean. Last sweep 2m ago. 0 threats. Wazuh: no anomalies 24h.'}]

  return (<>
    <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');.gcX *,.gcX *::before,.gcX *::after{box-sizing:border-box;margin:0;padding:0}html,body,#root{margin:0!important;padding:0!important;overflow:hidden!important;height:100%!important;width:100%!important}.gcX{position:absolute;top:0;left:0;right:0;bottom:0;font-family:'Inter',sans-serif;color:#efefef;background:#080b14;overflow:hidden}.gcX::before{content:none}@keyframes gcXd{0%{transform:translate(0,0)scale(1)}50%{transform:translate(-25px,15px)scale(1.03)}100%{transform:translate(10px,-10px)scale(0.98)}}@keyframes gcXf{0%{transform:translate(0,0)}25%{transform:translate(30px,-20px)}50%{transform:translate(-15px,25px)}75%{transform:translate(20px,10px)}100%{transform:translate(-25px,-15px)}}.gcX::after{content:none}.gbar{height:5px;border-radius:3px;background:rgba(255,255,255,0.06);overflow:hidden}.gbar>div{height:100%;border-radius:3px}.gdot{width:6px;height:6px;border-radius:50%;animation:gpX 2s ease-in-out infinite}@keyframes gpX{0%,100%{opacity:.5;box-shadow:0 0 4px currentColor}50%{opacity:1;box-shadow:0 0 10px currentColor}}.gcX ::-webkit-scrollbar{width:4px}.gcX ::-webkit-scrollbar-track{background:transparent}.gcX ::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.08);border-radius:2px}`}</style>

    <div className="gcX" style={{'--orb-i':tv.orbGlow/100}}>
      <div style={{position:'fixed',inset:0,pointerEvents:'none',zIndex:0,background:`radial-gradient(ellipse 600px 500px at 10% 20%,${tv.orb1}${Math.round(tv.orbGlow*2.55).toString(16).padStart(2,'0')} 0%,transparent 65%),radial-gradient(ellipse 500px 400px at 90% 15%,${tv.orb2}${Math.round(tv.orbGlow*0.7*2.55).toString(16).padStart(2,'0')} 0%,transparent 65%),radial-gradient(ellipse 550px 450px at 50% 85%,${tv.orb3}${Math.round(tv.orbGlow*0.54*2.55).toString(16).padStart(2,'0')} 0%,transparent 65%),radial-gradient(ellipse 400px 350px at 75% 55%,${tv.orb4}${Math.round(tv.orbGlow*0.42*2.55).toString(16).padStart(2,'0')} 0%,transparent 65%)`,animation:'gcXd 30s ease-in-out infinite alternate'}}/>
      <div style={{position:'fixed',inset:0,pointerEvents:'none',zIndex:0}}>{Array.from({length:25},(_,i)=>{const c=['#38bdf8','#a855f7','#6366f1','#30ff90','#06b6d4'];return<div key={i} style={{position:'absolute',left:`${((i*137.508*7.3)%100)}%`,top:`${((i*137.508*13.7)%100)}%`,width:2+(i%4),height:2+(i%4),borderRadius:'50%',backgroundColor:c[i%5],opacity:tv.particleOp/100,animation:`gcXf ${15+(i%5)*5}s ease-in-out ${-(i*1.3)}s infinite alternate`}}/>})}</div>

      {tv.gridOp>0&&<div style={{position:'fixed',inset:0,pointerEvents:'none',zIndex:0,backgroundImage:`linear-gradient(rgba(255,255,255,${tv.gridOp/100*0.012}) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,${tv.gridOp/100*0.012}) 1px,transparent 1px)`,backgroundSize:'50px 50px'}}/>}
      <div style={{position:'absolute',inset:0,zIndex:1,display:'grid',gridTemplateRows:'auto 1fr auto',padding:tv.panelGap,gap:tv.panelGap,overflow:'hidden'}}>

        {/* HEADER */}
        <div style={{...gl({borderRadius:14,padding:'7px 14px',display:'flex',justifyContent:'space-between',alignItems:'center'}),flexShrink:0,overflow:'hidden'}}>
          <Sh/>
          <div style={{display:'flex',alignItems:'center',gap:8,position:'relative',zIndex:1,overflow:'hidden',flexShrink:1,minWidth:0}}>
            <Q s={24}/>
            <div style={{width:1,height:18,background:'rgba(255,255,255,0.06)'}}/>
            <div style={hb('#30ff90')} {...ho}><Sh/><div className="gdot" style={{color:'#30ff90',backgroundColor:'#30ff90',position:'relative',zIndex:1}}/><span style={{position:'relative',zIndex:1,letterSpacing:'1px'}}>DEFCON GREEN</span></div>
            <div style={hb('#30ff90')} {...ho}><Sh/><div className="gdot" style={{color:'#30ff90',backgroundColor:'#30ff90',position:'relative',zIndex:1,width:4,height:4}}/><span style={{position:'relative',zIndex:1}}>LIVE</span></div>
            <div style={hb(killArmed?'#ef4444':'rgba(255,255,255,0.5)')} {...ho} onClick={()=>setKillArmed(k=>!k)}><Sh/><span style={{position:'relative',zIndex:1}}>⚡ KILL</span></div>
            <div style={{width:1,height:18,background:'rgba(255,255,255,0.06)'}}/>
            <div style={hb('#30ff90')}><Sh/><span style={{position:'relative',zIndex:1}}>✓ All Systems Operational</span></div>
            <div style={{width:1,height:18,background:'rgba(255,255,255,0.06)'}}/>
            <div style={hb('rgba(255,255,255,0.6)')}><Sh/><span style={{position:'relative',zIndex:1}}>◇ AIs Idle</span></div>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:6,position:'relative',zIndex:1}}>
            <span style={{fontSize:10,fontFamily:M,color:'#fff'}}>{time.toLocaleTimeString()}</span>
            <div style={ib()} {...ho}><Icon name="settings" size={14}/></div>
            <div style={ib()} {...ho}><Icon name="book" size={14}/></div>
            <div style={{...gl({width:26,height:26,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:700,cursor:'pointer'}), overflow:'hidden'}} {...ho}><Sh/><span style={{position:'relative',zIndex:1}}>A</span></div>
            <div style={ib()} {...ho} onClick={()=>setRightOpen(p=>!p)}><span style={{position:'relative',zIndex:1,fontSize:11,opacity:0.6}}>{rightOpen?'▷':'◁'}</span></div>
          </div>
        </div>

        {/* MIDDLE */}
        <div style={{display:'flex',gap:8,overflow:'hidden',minHeight:0}}>

          {/* ICON RAIL + FLYOUT */}
          <div ref={flyoutRef} style={{display:'flex',flexShrink:0,position:'relative',height:'100%'}}>
            <div style={{...gl({width:76,borderRadius:14,padding:'12px 4px',display:'flex',flexDirection:'column',alignItems:'center'}),height:'100%',overflow:'auto'}}>
              <Sh/>
              <div style={{position:'relative',zIndex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:2,flex:1,width:'100%'}}>
                {groups.map(grp => {
                  const isActive = activeGroup === grp.id
                  const hasChild = grp.items.some(it => it.id === activeItem)
                  return <div key={grp.id} style={{display:'flex',flexDirection:'column',alignItems:'center',gap:2,cursor:'pointer',padding:'6px 0',width:'100%'}} onClick={()=>setActiveGroup(activeGroup===grp.id?null:grp.id)} title={grp.label}>
                    <div style={gl({width:44,height:44,borderRadius:12,display:'flex',alignItems:'center',justifyContent:'center',...(isActive?{borderTopColor:'rgba(168,85,247,0.5)',borderLeftColor:'rgba(56,189,248,0.3)',boxShadow:'0 0 30px rgba(168,85,247,0.12),0 5px 19px rgba(0,0,0,0.35),inset 0 1px 2px rgba(168,85,247,0.12)',background:'linear-gradient(145deg,rgba(168,85,247,0.08) 0%,rgba(56,189,248,0.04) 100%)'}:hasChild?{borderTopColor:'rgba(255,255,255,0.25)'}:{})})} {...ho}><Sh/><div style={{position:'relative',zIndex:1}}><Icon name={grp.icon} size={20} color={isActive?'#a855f7':hasChild?'#fff':'rgba(255,255,255,0.6)'}/></div></div>
                    <span style={{fontSize:9,fontWeight:isActive?700:500,color:isActive?'#fff':hasChild?'#fff':'rgba(255,255,255,0.6)',letterSpacing:'0.3px',textAlign:'center',lineHeight:1}}>{grp.label}</span>
                  </div>
                })}
              </div>
            </div>

            {/* Flyout — SAME GLASS as everything else, white titles */}
            {activeGroup && <div style={{...gl({position:'absolute',left:84,top:0,width:240,borderRadius:14,padding:'14px 10px',zIndex:10,boxShadow:'0 10px 40px rgba(0,0,0,0.5),inset 0 1px 2px rgba(255,255,255,0.08)'}),maxHeight:'100%',overflow:'auto'}}>
              <Sh/>
              <div style={{position:'relative',zIndex:1}}>
                {(() => { const grp = groups.find(g=>g.id===activeGroup); if(!grp) return null; return <>
                  <div style={{fontSize:14,fontWeight:700,color:'#fff',padding:'2px 8px 14px',display:'flex',alignItems:'center',gap:8}}><Icon name={grp.icon} size={16} color="#fff"/>{grp.label}</div>
                  <div style={{display:'flex',flexDirection:'column',gap:6}}>
                    {grp.items.map(it => {
                      const isAct = activeItem===it.id
                      return <div key={it.id} style={gl({borderRadius:10,padding:'12px 14px',cursor:'pointer',display:'flex',alignItems:'center',gap:10,fontSize:14,fontWeight:isAct?700:500,color:isAct?'#fff':'#fff',...(isAct?{borderTopColor:'rgba(168,85,247,0.5)',borderLeftColor:'rgba(56,189,248,0.3)',background:'linear-gradient(145deg,rgba(168,85,247,0.1) 0%,rgba(56,189,248,0.04) 100%)',boxShadow:'0 0 25px rgba(168,85,247,0.08),0 3px 12px rgba(0,0,0,0.3),inset 0 1px 2px rgba(168,85,247,0.1)'}:{})})} onClick={()=>{setActiveItem(it.id);setActiveGroup(null)}} {...ho}><Sh/><div style={{position:'relative',zIndex:1}}><Icon name={it.i||'grid'} size={15} color={it.c||(isAct?'#fff':'rgba(255,255,255,0.8)')}/></div><span style={{position:'relative',zIndex:1,flex:1}}>{it.l}</span>{it.b&&<span style={{position:'relative',zIndex:1,...gl({borderRadius:5,padding:'1px 5px',fontSize:9,fontFamily:M,fontWeight:700,color:'#ef4444',background:'rgba(239,68,68,0.08)',borderTopColor:'rgba(239,68,68,0.25)'})}}>{it.b}</span>}</div>
                    })}
                  </div>
                </>})()}
              </div>
            </div>}
          </div>

          {/* MAIN */}
          <div style={{flex:1,display:'flex',flexDirection:'column',gap:8,minHeight:0,minWidth:0,overflow:'hidden'}}>
            <div style={{...gl({borderRadius:12,padding:'6px 14px',display:'flex',justifyContent:'space-between',alignItems:'center'}),flexShrink:0}}>
              <Sh/>
              <div style={{display:'flex',alignItems:'center',gap:6,position:'relative',zIndex:1}}>
                <span style={{fontSize:12,color:'#fff'}}>QuoxCORE</span>
                <span style={{fontSize:10,color:'rgba(255,255,255,0.6)'}}>›</span>
                <span style={{fontSize:12,fontWeight:600}}>Glass Concept</span>
                <a href="/3d-lab" style={{fontSize:10,color:'#8b5cf6',textDecoration:'none',padding:'2px 8px',borderRadius:4,background:'rgba(139,92,246,0.1)',border:'1px solid rgba(139,92,246,0.2)',fontWeight:600,letterSpacing:'0.03em'}}>3D LAB ▸</a>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:6,position:'relative',zIndex:1,flex:1,justifyContent:'flex-end',overflow:'hidden'}}>
                {/* Category dropdown */}
                <select value={tabCat} onChange={e=>{setTabCat(e.target.value);setMainTab(tabCategories[e.target.value].tabs[0])}} style={{
                  background:'rgba(255,255,255,0.04)',border:'1px solid rgba(255,255,255,0.15)',borderRadius:8,
                  padding:'4px 24px 4px 10px',color:'#38bdf8',fontSize:11,fontFamily:M,fontWeight:600,
                  cursor:'pointer',outline:'none',appearance:'none',WebkitAppearance:'none',
                  backgroundImage:'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\'%3E%3Cpath d=\'M0 0l5 6 5-6z\' fill=\'%2338bdf8\'/%3E%3C/svg%3E")',
                  backgroundRepeat:'no-repeat',backgroundPosition:'right 8px center',minWidth:110
                }}>
                  {Object.entries(tabCategories).map(([id,cat])=><option key={id} value={id} style={{background:'#0a0e1a',color:'#fff'}}>{cat.label}</option>)}
                </select>
                {/* Sub-tabs scrollable row */}
                <div style={{display:'flex',gap:3,flexWrap:'wrap',flex:1}}>
                  {(tabCategories[tabCat]?.tabs||[]).map(t=><div key={t} style={gl({borderRadius:6,padding:'3px 10px',cursor:'pointer',fontSize:10,fontWeight:mainTab===t?600:400,color:mainTab===t?'#38bdf8':'rgba(255,255,255,0.8)',whiteSpace:'nowrap',...(mainTab===t?{borderTopColor:'rgba(56,189,248,0.3)',background:'linear-gradient(145deg,rgba(56,189,248,0.06) 0%,transparent 100%)'}:{})})} onClick={()=>setMainTab(t)} {...ho}><span style={{position:'relative',zIndex:1}}>{tabLabels[t]||t}</span></div>)}
                </div>
              </div>
            </div>

            <div style={{...gl({flex:1,borderRadius:14,padding:14,backgroundColor:'rgba(8,11,20,0.85)'}),overflow:'auto',minHeight:0,WebkitOverflowScrolling:'touch',willChange:'transform',contain:'content'}}>
              <Sh/>
              <div style={{position:'relative',zIndex:1}}>
                {mainTab==='overview'&&<><div style={{display:'flex',gap:8,marginBottom:12}}>{[{l:'Agents',v:'9/9',c:'#30ff90'},{l:'Fleet',v:'100%',c:'#38bdf8'},{l:'Decisions',v:'342',s:'+12%',c:'#a855f7'},{l:'VOLT',v:'8,247',c:'#06b6d4'},{l:'Memory',v:'8.2K',c:'#ec4899'}].map((m,i)=><div key={i} style={gc({flex:1})} {...ho}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,color:'#fff',fontWeight:600,marginBottom:4}}>{m.l}</div><div style={{display:'flex',alignItems:'baseline',gap:4}}><span style={{fontSize:24,fontFamily:M,fontWeight:800,color:m.c,fontVariantNumeric:'tabular-nums'}}>{m.v}</span>{m.s&&<span style={{fontSize:10,color:'#30ff90',fontWeight:600}}>{m.s}</span>}</div></div></div>)}</div><div style={{display:'grid',gridTemplateColumns:rightOpen?'repeat(3,1fr)':'repeat(4,1fr)',gap:8}}>{hosts.map((z,i)=><div key={i} style={gc({padding:'11px 12px'})} {...ho}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}><span style={{fontSize:12,fontFamily:M,fontWeight:700}}>{z.n}</span><div className="gdot" style={{color:'#30ff90',backgroundColor:'#30ff90',width:5,height:5}}/></div><div style={{display:'inline-block',...gl({borderRadius:5,padding:'2px 7px',fontSize:9,fontFamily:M,fontWeight:600,color:z.k,background:`${z.k}06`,borderTopColor:`${z.k}25`}),marginBottom:5}}>{z.r}</div>{['c','m'].map(k=>{const v=k==='c'?z.c:z.m;return<div key={k} style={{marginTop:4}}><div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}><span style={{fontSize:9,fontFamily:M,color:'rgba(255,255,255,0.95)'}}>{k==='c'?'CPU':'MEM'}</span><span style={{fontSize:9,fontFamily:M,fontWeight:600,color:v>60?'#f59e0b':'rgba(255,255,255,0.6)'}}>{v}%</span></div><div className="gbar"><div style={{width:`${v}%`,backgroundColor:v>60?'#f59e0b':k==='c'?'#30ff90':'#38bdf8'}}/></div></div>})}</div></div>)}</div></>}
                {mainTab==='agents'&&<div><div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Agent Leaderboard</div>{ags.map((a,i)=><div key={i} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 0',borderBottom:i<ags.length-1?'1px solid rgba(255,255,255,0.04)':'none'}}><span style={{width:20,fontSize:14,fontFamily:M,fontWeight:800,color:i<3?['#ffd700','#c0c0c0','#cd7f32'][i]:'rgba(255,255,255,0.3)',textAlign:'center'}}>{i+1}</span><div style={{...gl({width:32,height:32,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,fontWeight:700,color:a.c,background:`${a.c}08`,borderTopColor:`${a.c}30`}),overflow:'hidden'}}>{a.n[0]}</div><div style={{flex:1}}><div style={{fontSize:14,fontWeight:600}}>{a.n}</div><div style={{fontSize:11,fontFamily:M,color:'rgba(255,255,255,0.95)'}}>{a.r}</div></div><div style={{width:80,height:6,borderRadius:3,background:'rgba(255,255,255,0.05)',overflow:'hidden'}}><div style={{height:'100%',width:`${a.s}%`,borderRadius:3,background:`linear-gradient(90deg,${a.c}50,${a.c})`}}/></div><span style={{fontSize:12,fontFamily:M,fontWeight:700,color:a.c,width:24}}>{a.s}</span></div>)}</div>}
                {mainTab==='fleet'&&<div><div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Fleet Health</div><div style={{display:'grid',gridTemplateColumns:rightOpen?'repeat(3,1fr)':'repeat(4,1fr)',gap:10}}>{hosts.map((z,i)=><div key={i} style={gc({padding:'14px'})} {...ho}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:14,fontFamily:M,fontWeight:700,marginBottom:6}}>{z.n}</div>{['c','m'].map(k=>{const v=k==='c'?z.c:z.m;return<div key={k} style={{marginTop:6}}><div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}><span style={{fontSize:11,fontFamily:M,color:'#fff'}}>{k==='c'?'CPU':'MEM'}</span><span style={{fontSize:11,fontFamily:M,fontWeight:600,color:v>60?'#f59e0b':'rgba(255,255,255,0.7)'}}>{v}%</span></div><div className="gbar" style={{height:6}}><div style={{width:`${v}%`,backgroundColor:v>60?'#f59e0b':k==='c'?'#30ff90':'#38bdf8'}}/></div></div>})}</div></div>)}</div></div>}
                {mainTab==='evidence'&&<div><div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Trust & Evidence</div><div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:16}}>{[{l:'✓ Verified',c:'#30ff90'},{l:'◆ Hash-Chained',c:'#06b6d4'},{l:'◎ WARD',c:'#06b6d4'},{l:'◈ IETF',c:'#38bdf8'},{l:'● Tamper-Evident',c:'#f59e0b'},{l:'✓ SOC 2',c:'#a855f7'},{l:'✓ HIPAA',c:'#a855f7'},{l:'✓ GDPR',c:'#30ff90'},{l:'✓ ISO 27001',c:'#38bdf8'}].map((b,i)=><div key={i} style={gl({borderRadius:10,padding:'7px 16px',fontSize:13,fontFamily:M,fontWeight:600,color:b.c,background:`${b.c}06`,borderTopColor:`${b.c}25`,cursor:'pointer'})} {...ho}><Sh/><span style={{position:'relative',zIndex:1}}>{b.l}</span></div>)}</div><div style={{fontSize:15,fontWeight:700,marginBottom:10}}>Recent VOLT Records</div>{[{h:'a7f3c2',d:'allow',a:'WARDEN',t:'2s'},{h:'d91e4b',d:'restart',a:'ops-agent',t:'8s'},{h:'f28a71',d:'approve',a:'CommanderQ',t:'15s'},{h:'c54d09',d:'block',a:'WARDEN',t:'1m'},{h:'8b2e63',d:'scale',a:'HYPERION',t:'3m'}].map((r,i)=><div key={i} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 0',borderBottom:i<4?'1px solid rgba(255,255,255,0.04)':'none'}}><div style={gl({borderRadius:6,padding:'2px 8px',fontSize:10,fontFamily:M,fontWeight:600,color:'#06b6d4'})}>{r.h}...</div><span style={{fontSize:13,fontWeight:600,flex:1}}>{r.d}</span><span style={{fontSize:12,fontFamily:M,color:'#fff'}}>{r.a}</span><span style={{fontSize:10,fontFamily:M,color:'rgba(255,255,255,0.6)'}}>{r.t}</span></div>)}</div>}
                {mainTab==='sankey'&&<SankeyFlow/>}
                {mainTab==='swimlane'&&<SwimlaneDiagram/>}
                {mainTab==='waterfall'&&<TraceWaterfall/>}
                {mainTab==='delegation'&&<DelegationRadar/>}
                {mainTab==='heatmap'&&<LayerHealthMatrix/>}
                {mainTab==='gauges'&&<GaugeCluster/>}
                {mainTab==='escalation'&&<EscalationLadder/>}
                {mainTab==='chain'&&<EvidenceChainBrowser/>}
                {mainTab==='neural'&&<NeuralNetwork/>}
                {mainTab==='radarsweep'&&<RadarSweep/>}
                {mainTab==='topology'&&<TopologyMap/>}
                {mainTab==='hexgrid'&&<HexGrid/>}
                {mainTab==='worldmap'&&<WorldMap/>}
                {mainTab==='oscilloscope'&&<Oscilloscope/>}
                {mainTab==='fleetheat'&&<FleetHeatmapViz/>}
                {mainTab==='orgtree'&&<OrgTree/>}
                {mainTab==='router'&&<RouterConfidence/>}
                {mainTab==='capability'&&<CapabilityMap/>}
                {mainTab==='connections'&&<ConnectionGraph/>}
                {mainTab==='approval'&&<ApprovalCard/>}
                {mainTab==='orbital'&&<OrbitalHUD/>}
                {mainTab==='shield'&&<SecurityShield/>}
                {mainTab==='commandstream'&&<CommandStream/>}
                {mainTab==='powergrid'&&<PowerGrid/>}
                {mainTab==='datastream'&&<div style={{position:'relative',height:300}}><DataStream/></div>}
                {mainTab==='circuit'&&<div style={{position:'relative',height:300}}><CircuitBoard/></div>}
                {mainTab==='glitch'&&<div style={{padding:20}}><GlitchText/><div style={{marginTop:20}}><GlitchText text="AGENTIC TEAMS" variant="decode" fontSize={32} glitchColor="#a855f7"/></div><div style={{marginTop:20}}><GlitchText text="SECURE BY DEFAULT" variant="typewriter" fontSize={24} color="#30ff90" glitchColor="#30ff90"/></div></div>}
                {mainTab==='dna'&&<DNAHelix/>}
                {mainTab==='threat'&&<ThreatLevel/>}
                {mainTab==='constellation'&&<MemoryConstellation/>}
                {mainTab==='matrix'&&<MatrixRain/>}
                {mainTab==='piechartd'&&<PieChart3D/>}
                {mainTab==='leaderboard'&&<AgentLeaderboard/>}
                {mainTab==='pipeline'&&<PipelineStageIndicator/>}
                {mainTab==='inbox'&&<InboxFeed/>}
                {mainTab==='starfield'&&<div style={{position:'relative',height:300,borderRadius:8,overflow:'hidden'}}><Starfield/></div>}
                {mainTab==='kitt'&&<div style={{padding:20}}><div style={{marginBottom:16}}><div style={{fontSize:11,fontFamily:M,color:'rgba(255,255,255,0.7)',marginBottom:8,letterSpacing:1}}>KITT SWEEP</div><KITTScanner width={600}/></div><div style={{marginBottom:16}}><div style={{fontSize:11,fontFamily:M,color:'rgba(255,255,255,0.7)',marginBottom:8,letterSpacing:1}}>SPECTRUM</div><KITTScanner width={600} variant="spectrum" color="#a855f7"/></div><div><div style={{fontSize:11,fontFamily:M,color:'rgba(255,255,255,0.7)',marginBottom:8,letterSpacing:1}}>BINARY</div><KITTScanner width={600} variant="binary" color="#30ff90"/></div></div>}
                {mainTab==='hashchain'&&<div style={{padding:20}}><HashChain/></div>}
                {mainTab==='flowdiagram'&&<FlowDiagram/>}
                {mainTab==='layerstack'&&<div style={{padding:10}}><LayerStack animate={true}/></div>}
                {mainTab==='agentswarm'&&<AgentSwarm/>}
                {mainTab==='statusgrid'&&<StatusGrid/>}
                {mainTab==='metriccard'&&<div style={{display:'flex',flexDirection:'column',gap:12,maxWidth:650}}><MetricCard variant="hero" value="8,247" label="VOLT Records" color="#06b6d4" trend="up" trendValue="+342"/><div style={{display:'flex',gap:12}}><MetricCard value="9" label="Active Agents" color="#a855f7" trend="flat" trendValue="0%"/><MetricCard value="142" label="Requests/min" color="#30ff90" trend="up" trendValue="+8%"/></div><MetricCard variant="compact" value="99.97" label="Uptime %" color="#38bdf8" trend="up" trendValue="+0.02%"/></div>}
                {mainTab==='conversation'&&<ConversationBubble/>}
                {mainTab==='particlevortex'&&<div style={{position:'relative',height:300}}><ParticleVortex/></div>}
                {mainTab==='cogcore'&&<div style={{display:'flex',justifyContent:'center'}}><CognitiveCore size={440}/></div>}
                {mainTab==='iris'&&<div style={{display:'flex',justifyContent:'center'}}><IrisAperture size={300}/></div>}
                {mainTab==='alertfall'&&<AlertWaterfall/>}
                {mainTab==='hologrid'&&<HoloGrid/>}
                {mainTab==='objectivechain'&&<div style={{padding:20}}><ObjectiveChainTimeline/></div>}
                {mainTab==='wisdom'&&<div style={{padding:10}}><WisdomStore/></div>}
                {mainTab==='observer'&&<div style={{padding:10}}><ObserverDashboard/></div>}
                {mainTab==='postmortem'&&<div style={{padding:10}}><PostMortemView/></div>}
                {mainTab==='advisor'&&<div style={{padding:10}}><AdvisorPanel/></div>}
                {mainTab==='guardian'&&<div style={{padding:10}}><GuardianAlert/></div>}
                {mainTab==='contentpipe'&&<div style={{padding:10}}><ContentPipeline/></div>}
                {mainTab==='mediagrid'&&<div style={{padding:10}}><MediaGrid/></div>}
                {mainTab==='cluster'&&<div style={{padding:10}}><ClusterTopology/></div>}
                {mainTab==='auditlake'&&<div style={{padding:10}}><AuditLake/></div>}
                {mainTab==='marketteam'&&<div style={{padding:10}}><MarketingTeamDashboard/></div>}
                {mainTab==='asyncagent'&&<div style={{padding:10}}><AsyncAgentCard/></div>}
                {mainTab==='fedwisdom'&&<div style={{padding:10}}><FederatedWisdomPanel/></div>}
                {mainTab==='compliancedash'&&<div style={{padding:10}}><ComplianceDashboard/></div>}
                {mainTab==='certpanel'&&<div style={{padding:10}}><CertificationPanel/></div>}
                {mainTab==='replaybrowser'&&<div style={{padding:10}}><ReplayBrowser/></div>}
                {mainTab==='matrixroom'&&<div style={{padding:10}}><MatrixRoomView/></div>}
                {mainTab==='pricingcalc'&&<div style={{padding:10}}><PricingCalculator/></div>}
                {mainTab==='sdkplayground'&&<div style={{padding:10}}><SDKPlayground/></div>}
                {mainTab==='investordeck'&&<div style={{padding:10}}><InvestorDeckSlide/></div>}
                {mainTab==='onboarding'&&<div style={{padding:10}}><OnboardingFlow/></div>}
                {mainTab==='trustscore'&&<div style={{padding:10}}><TrustScorecard/></div>}
                {mainTab==='policyeditor'&&<div style={{padding:10}}><PolicyEditor/></div>}
                {mainTab==='auditexplorer'&&<div style={{padding:10}}><AuditExplorer/></div>}
                {mainTab==='agentmarket'&&<div style={{padding:10}}><AgentMarketplace/></div>}
                {mainTab==='revenuemetrics'&&<div style={{padding:10}}><RevenueMetrics/></div>}
                {mainTab==='apiexplorer'&&<div style={{padding:10}}><APIExplorer/></div>}
                {mainTab==='webhookmon'&&<div style={{padding:10}}><WebhookMonitor/></div>}
                {mainTab==='incidenttime'&&<div style={{padding:10}}><IncidentTimeline/></div>}
                {mainTab==='capacityplan'&&<div style={{padding:10}}><CapacityPlanner/></div>}
                {mainTab==='deploytrack'&&<div style={{padding:10}}><DeploymentTracker/></div>}
                {mainTab==='agentcompare'&&<div style={{padding:10}}><AgentCapabilityComparison/></div>}
                {mainTab==='teamcapacity'&&<div style={{padding:10}}><TeamCapacityGauge/></div>}
                {mainTab==='memorybreak'&&<div style={{padding:10}}><MemoryTypeBreakdown/></div>}
                {mainTab==='livetelemetry'&&<div style={{padding:10}}><LiveTelemetry/></div>}
                {mainTab==='workflowsim'&&<div style={{padding:10}}><WorkflowSimulator/></div>}
                {mainTab==='errorprop'&&<div style={{padding:10}}><ErrorPropagationTree/></div>}
                {mainTab==='costanalytics'&&<div style={{padding:10}}><CostAnalytics/></div>}
                {mainTab==='evidencequality'&&<div style={{padding:10}}><EvidenceQualityScore/></div>}
                {mainTab==='agentmesh'&&<div style={{padding:10}}><AgentMeshLatency/></div>}
                {mainTab==='doccluster'&&<div style={{padding:10}}><DocumentCluster/></div>}
                {mainTab==='plugindeps'&&<div style={{padding:10}}><PluginDependencyResolver/></div>}
                {mainTab==='userjourney'&&<div style={{padding:10}}><UserJourneyMap/></div>}
                {mainTab==='teamtopo'&&<div style={{padding:10}}><TeamTopologyCard/></div>}
                {mainTab==='teamrun'&&<div style={{padding:10}}><TeamRunDashboard/></div>}
                {mainTab==='teamperf'&&<div style={{padding:10}}><TeamPerformanceHistory/></div>}
                {mainTab==='learningrouter'&&<div style={{padding:10}}><LearningRouterViz/></div>}
                {mainTab==='fallbackchain'&&<div style={{padding:10}}><FallbackChainViz/></div>}
                {mainTab==='opscanvas'&&<div style={{padding:10}}><OpsDeckCanvas/></div>}
                {mainTab==='objnodegraph'&&<div style={{padding:10}}><ObjectiveNodeGraph/></div>}
                {mainTab==='zombiepanel'&&<div style={{padding:10}}><ZombiePanelView/></div>}
                {mainTab==='taskdepmatrix'&&<div style={{padding:10}}><TaskDependencyMatrix/></div>}
                {mainTab==='heartbeatmon'&&<div style={{padding:10}}><HeartbeatMonitor/></div>}
                {mainTab==='objtimeline'&&<div style={{padding:10}}><ObjectiveTimeline/></div>}
                {mainTab==='objcompare'&&<div style={{padding:10}}><ObjectiveComparison/></div>}
                {mainTab==='objtemplates'&&<div style={{padding:10}}><ObjectiveTemplateGallery/></div>}
                {mainTab==='budgettrack'&&<div style={{padding:10}}><BudgetTracker/></div>}
                {mainTab==='objqueue'&&<div style={{padding:10}}><ObjectiveQueueView/></div>}
                {mainTab==='holoagent'&&<HoloAgentGrid/>}
                {mainTab==='holohierarchy'&&<HoloHierarchyGrid/>}
                {mainTab==='holopipeline'&&<HoloPipelineGrid/>}
                {mainTab==='holomesh'&&<HoloMeshGrid/>}
                {mainTab==='holobattlefield'&&<HoloBattlefield/>}
                {mainTab==='cogmap'&&<div style={{padding:10}}><CognitiveCoreMap/></div>}
                {mainTab==='agentmesh3d'&&<div style={{padding:10}}><AgentMeshConstellation/></div>}
                {mainTab==='execsolar'&&<div style={{padding:10}}><ExecutionSolarSystem/></div>}
                {mainTab==='memlattice'&&<div style={{padding:10}}><MemoryLatticeView/></div>}
                {mainTab==='shellhealth'&&<div style={{padding:10}}><CoreShellHealth/></div>}
                {mainTab==='delarc'&&<div style={{padding:10}}><DelegationArcDemo/></div>}
                {mainTab==='topotrans'&&<div style={{padding:10}}><TopologyTransition/></div>}
                {mainTab==='ops3dpreview'&&<div style={{padding:10}}><OpsDeck3DPreview/></div>}
                {mainTab==='ops3dcontrol'&&<div style={{padding:10}}><OpsDeck3DControlRoom/></div>}
                {mainTab==='ops3dnucleus'&&<div style={{padding:10}}><OpsDeck3DNucleus/></div>}
                {mainTab==='ops3dflight'&&<div style={{padding:10}}><OpsDeck3DFlightPath/></div>}
                {mainTab==='opsfullpage'&&<div style={{padding:10}}><OpsDeckFullPage/></div>}
                {mainTab==='opswallboard'&&<div style={{padding:10}}><OpsDeckWallboard/></div>}
                {mainTab==='opsnodedetail'&&<div style={{padding:10}}><OpsDeckNodeDetail/></div>}
                {mainTab==='opsobjdetail'&&<div style={{padding:10}}><OpsDeckObjectiveDetail/></div>}
                {mainTab==='opsmetrics'&&<div style={{padding:10}}><OpsDeckMetricStrip/></div>}
                {mainTab==='opsagentgrid'&&<div style={{padding:10}}><OpsDeckAgentGrid/></div>}
                {mainTab==='opseventstream'&&<div style={{padding:10}}><OpsDeckEventStream/></div>}
                {mainTab==='mesharch'&&<div style={{padding:10}}><MeshArchitecture/></div>}
                {mainTab==='meshroomlist'&&<div style={{padding:10}}><MeshRoomList/></div>}
                {mainTab==='meshtimeline'&&<div style={{padding:10}}><MeshTimeline/></div>}
                {mainTab==='meshroomtypes'&&<div style={{padding:10}}><MeshRoomTypes/></div>}
                {mainTab==='meshfedmap'&&<div style={{padding:10}}><MeshFederationMap/></div>}
                {mainTab==='meshevents'&&<div style={{padding:10}}><MeshEventTypes/></div>}
                {mainTab==='meshincident'&&<div style={{padding:10}}><MeshIncidentRoom/></div>}
                {mainTab==='meshbridges'&&<div style={{padding:10}}><MeshBridgeStatus/></div>}
                {mainTab==='meshhive'&&<div style={{padding:10}}><MeshHiveWisdom/></div>}
                {mainTab==='meshgateway'&&<div style={{padding:10}}><MeshGatewayFlow/></div>}
                {mainTab==='meshmigrate'&&<div style={{padding:10}}><MeshMigrationStatus/></div>}
                {mainTab==='meshfullpage'&&<div style={{padding:10}}><MeshFullPage/></div>}
                {mainTab==='aqdash'&&<div style={{padding:10}}><AssistantQDashboard/></div>}
                {mainTab==='aqinbox'&&<div style={{padding:10}}><AssistantQInbox/></div>}
                {mainTab==='aqcalendar'&&<div style={{padding:10}}><AssistantQCalendar/></div>}
                {mainTab==='aqactions'&&<div style={{padding:10}}><AssistantQActions/></div>}
                {mainTab==='aqdemo'&&<div style={{padding:10}}><AssistantQDemo/></div>}
                {mainTab==='aqbrowser'&&<div style={{padding:10}}><AssistantQBrowser/></div>}
                {mainTab==='aqevidence'&&<div style={{padding:10}}><AssistantQEvidence/></div>}
                {mainTab==='aqfullpage'&&<div style={{padding:10}}><ActionQFullPage/></div>}
                {mainTab==='aqsmartcard'&&<div style={{padding:10}}><ActionQSmartCard/></div>}
                {mainTab==='aqassistant'&&<div style={{padding:10}}><ActionQAssistant/></div>}
                {mainTab==='aqpriority'&&<div style={{padding:10}}><ActionQPriorityMatrix/></div>}
                {mainTab==='aqdepgraph'&&<div style={{padding:10}}><ActionQDependencyGraph/></div>}
                {mainTab==='aqanalytics'&&<div style={{padding:10}}><ActionQAnalytics/></div>}
                {mainTab==='aqdelegation'&&<div style={{padding:10}}><ActionQDelegation/></div>}
                {mainTab==='aqintegrations'&&<div style={{padding:10}}><ActionQIntegrations/></div>}
                {mainTab==='codash'&&<div style={{padding:10}}><ContentOpsDashboard/></div>}
                {mainTab==='covoice'&&<div style={{padding:10}}><ContentOpsVoice/></div>}
                {mainTab==='coimage'&&<div style={{padding:10}}><ContentOpsImage/></div>}
                {mainTab==='copipeline'&&<div style={{padding:10}}><ContentOpsPipeline/></div>}
                {mainTab==='covideo'&&<div style={{padding:10}}><ContentOpsVideo/></div>}
                {mainTab==='coteam'&&<div style={{padding:10}}><ContentOpsTeam/></div>}
                {mainTab==='cobundles'&&<div style={{padding:10}}><ContentOpsBundles/></div>}
                {mainTab==='orgfull'&&<div style={{padding:10}}><OrgFullPage/></div>}
                {mainTab==='orghierarchy'&&<div style={{padding:10}}><OrgHierarchyTree/></div>}
                {mainTab==='orgmembers'&&<div style={{padding:10}}><OrgMemberDirectory/></div>}
                {mainTab==='orgresources'&&<div style={{padding:10}}><OrgResourceAllocation/></div>}
                {mainTab==='orgcompliance'&&<div style={{padding:10}}><OrgComplianceOverview/></div>}
                {mainTab==='divfull'&&<div style={{padding:10}}><DivisionFullPage/></div>}
                {mainTab==='divcompare'&&<div style={{padding:10}}><DivisionComparisonChart/></div>}
                {mainTab==='divorgchart'&&<div style={{padding:10}}><DivisionOrgChart/></div>}
                {mainTab==='divactivity'&&<div style={{padding:10}}><DivisionActivityFeed/></div>}
                {mainTab==='divbudget'&&<div style={{padding:10}}><DivisionBudget/></div>}
                {mainTab==='deptfull'&&<div style={{padding:10}}><DepartmentFullPage/></div>}
                {mainTab==='deptteams'&&<div style={{padding:10}}><DepartmentTeamView/></div>}
                {mainTab==='deptknowledge'&&<div style={{padding:10}}><DepartmentKnowledge/></div>}
                {mainTab==='deptmetrics'&&<div style={{padding:10}}><DepartmentMetrics/></div>}
                {mainTab==='deptrbac'&&<div style={{padding:10}}><DepartmentRBAC/></div>}
                {mainTab==='iqfull'&&<div style={{padding:10}}><InboxQFullPage/></div>}
                {mainTab==='iqcompose'&&<div style={{padding:10}}><InboxQCompose/></div>}
                {mainTab==='iqrules'&&<div style={{padding:10}}><InboxQTriageRules/></div>}
                {mainTab==='iqmulti'&&<div style={{padding:10}}><InboxQMultiInbox/></div>}
                {mainTab==='iqanalytics'&&<div style={{padding:10}}><InboxQAnalytics/></div>}
                {mainTab==='cqfull'&&<div style={{padding:10}}><CalendarQFullPage/></div>}
                {mainTab==='cqweek'&&<div style={{padding:10}}><CalendarQWeekView/></div>}
                {mainTab==='cqprep'&&<div style={{padding:10}}><CalendarQMeetingPrep/></div>}
                {mainTab==='cqconflicts'&&<div style={{padding:10}}><CalendarQConflicts/></div>}
                {mainTab==='cqavail'&&<div style={{padding:10}}><CalendarQAvailability/></div>}
                {mainTab==='bqfull'&&<div style={{padding:10}}><BrowserQFullPage/></div>}
                {mainTab==='bqsessions'&&<div style={{padding:10}}><BrowserQSessionManager/></div>}
                {mainTab==='bqrecorder'&&<div style={{padding:10}}><BrowserQRecorder/></div>}
                {mainTab==='bqextract'&&<div style={{padding:10}}><BrowserQExtraction/></div>}
                {mainTab==='bqsecurity'&&<div style={{padding:10}}><BrowserQSecurity/></div>}
                {mainTab==='mqfull'&&<div style={{padding:10}}><MediaQFullPage/></div>}
                {mainTab==='mqgrid'&&<div style={{padding:10}}><MediaQGrid/></div>}
                {mainTab==='mqlightbox'&&<div style={{padding:10}}><MediaQLightbox/></div>}
                {mainTab==='mqcollections'&&<div style={{padding:10}}><MediaQCollections/></div>}
                {mainTab==='mqagent'&&<div style={{padding:10}}><MediaQAgent/></div>}
                {mainTab==='mqtimeline'&&<div style={{padding:10}}><MediaQTimeline/></div>}
                {mainTab==='mqanalytics'&&<div style={{padding:10}}><MediaQAnalytics/></div>}
                {mainTab==='mqsources'&&<div style={{padding:10}}><MediaQSources/></div>}
                {mainTab==='qminimal'&&<div style={{padding:10,display:'flex',justifyContent:'center'}}><CoreVizMinimal/></div>}
                {mainTab==='qconstellation'&&<div style={{padding:10,display:'flex',justifyContent:'center'}}><CoreVizConstellation/></div>}
                {mainTab==='qpulse'&&<div style={{padding:10,display:'flex',justifyContent:'center'}}><CoreVizPulse/></div>}
                {mainTab==='qhud'&&<div style={{padding:10,display:'flex',justifyContent:'center'}}><CoreVizHUD/></div>}
                {mainTab==='qnebula'&&<div style={{padding:10,display:'flex',justifyContent:'center'}}><CoreVizNebula/></div>}
                {mainTab==='qmatrix'&&<div style={{padding:10,display:'flex',justifyContent:'center'}}><CoreVizMatrix/></div>}
                {mainTab==='showcase'&&<div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,width:'100%'}}>
                  {/* Row 1: Glitch header full width */}
                  <div style={{gridColumn:'1/-1',...gc({padding:'10px 14px'})}}><Sh/><div style={{position:'relative',zIndex:1,textAlign:'center'}}><GlitchText text="QUOXCORE GLASS SHOWCASE" fontSize={28}/></div></div>
                  {/* Row 1b: Core Q Visualisers — Constellation + Pulse */}
                  <div style={{gridColumn:'1/3',...gc({padding:'10px'})}}><LazyPanel height={420}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>COMMANDERQ CORE: CONSTELLATION</div><div style={{display:'flex',justifyContent:'center'}}><CoreVizConstellation/></div></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={420}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>COMMANDERQ CORE: PULSE</div><div style={{display:'flex',justifyContent:'center'}}><CoreVizPulse/></div></div></LazyPanel></div>
                  {/* Row 2: Three gauges/metrics */}
                  <div style={gc({padding:'10px'})}><LazyPanel height={200}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>GAUGES</div><GaugeCluster/></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={200}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>RADAR</div><div style={{display:'flex',justifyContent:'center'}}><RadarSweep/></div></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={200}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>SHIELD</div><div style={{display:'flex',justifyContent:'center'}}><SecurityShield size={180}/></div></div></LazyPanel></div>
                  {/* Row 3: Full width command stream */}
                  <div style={{gridColumn:'1/-1',...gc({padding:'10px 14px'})}}><LazyPanel height={120}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>LIVE OPS FEED</div><CommandStream width={'100%'} maxVisible={4}/></div></LazyPanel></div>
                  {/* Row 4: Three sci-fi panels */}
                  <div style={gc({padding:'10px'})}><LazyPanel height={260}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>DNA HELIX</div><div style={{display:'flex',justifyContent:'center'}}><DNAHelix width={180} height={240} amplitude={45}/></div></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={260}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>MATRIX RAIN</div><MatrixRain columns={12} width={'100%'} height={240}/></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={260}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>ORBITAL HUD</div><div style={{display:'flex',justifyContent:'center'}}><OrbitalHUD width={240} height={240}/></div></div></LazyPanel></div>
                  {/* Row 5: KITT + Threat Level spanning */}
                  <div style={{gridColumn:'1/3',...gc({padding:'10px 14px'})}}><LazyPanel height={60}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>KITT SCANNER</div><KITTScanner width={'100%'}/></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={60}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>THREAT LEVEL</div><ThreatLevel width={'100%'} level={2}/></div></LazyPanel></div>
                  {/* Row 6: Power Grid + Memory + Pie */}
                  <div style={gc({padding:'10px'})}><LazyPanel height={200}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>POWER GRID</div><PowerGrid cellSize={18}/></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={200}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>MEMORY MAP</div><div style={{display:'flex',justifyContent:'center'}}><MemoryConstellation width={240} height={200}/></div></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={200}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>ALLOCATION</div><div style={{display:'flex',justifyContent:'center'}}><PieChart3D size={200}/></div></div></LazyPanel></div>
                  {/* Row 7: Leaderboard full width */}
                  <div style={{gridColumn:'1/-1',...gc({padding:'10px 14px'})}}><LazyPanel height={180}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>AGENT LEADERBOARD</div><AgentLeaderboard/></div></LazyPanel></div>
                  {/* Row 8: Pipeline full width */}
                  <div style={{gridColumn:'1/-1',...gc({padding:'8px 14px'})}}><LazyPanel height={60}><Sh/><div style={{position:'relative',zIndex:1}}><PipelineStageIndicator width={'100%'}/></div></LazyPanel></div>
                  {/* Row 9: Status + Iris + Metrics */}
                  <div style={gc({padding:'10px'})}><LazyPanel height={160}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>NOC STATUS</div><StatusGrid cols={2} services={[{name:'edge-01',status:'online',value:'CPU 12%',color:'#30ff90'},{name:'edge-02',status:'online',value:'CPU 8%',color:'#30ff90'},{name:'hyp-01',status:'warning',value:'CPU 94%',color:'#f59e0b'},{name:'gw-01',status:'online',value:'SSH OK',color:'#30ff90'}]}/></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={220}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>IRIS</div><div style={{display:'flex',justifyContent:'center'}}><IrisAperture size={200}/></div></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={160}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>METRICS</div><div style={{display:'flex',flexDirection:'column',gap:6}}><MetricCard variant="compact" value="1,247" label="Users" color="#38bdf8" trend="up" trendValue="+12%"/><MetricCard variant="compact" value="99.9%" label="Uptime" color="#30ff90" trend="up" trendValue="+0.1%"/><MetricCard variant="compact" value="342" label="Decisions" color="#a855f7" trend="up" trendValue="+8"/></div></div></LazyPanel></div>
                  {/* Row 10: Hash Chain full width */}
                  <div style={{gridColumn:'1/-1',...gc({padding:'10px 14px'})}}><LazyPanel height={120}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>VOLT HASH CHAIN</div><HashChain/></div></LazyPanel></div>
                  {/* Row 11: Trust Scorecard + Deployment Tracker */}
                  <div style={{gridColumn:'1/3',...gc({padding:'10px 14px'})}}><LazyPanel height={200}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>TRUST SCORECARD</div><TrustScorecard/></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={200}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>DEPLOYMENTS</div><DeploymentTracker/></div></LazyPanel></div>
                  {/* Row 12: QuoxMind — Observer + Advisor + Guardian */}
                  <div style={{gridColumn:'1/-1',...gc({padding:'10px 14px'})}}><LazyPanel height={200}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>QUOXMIND OBSERVER</div><ObserverDashboard/></div></LazyPanel></div>
                  <div style={{gridColumn:'1/3',...gc({padding:'10px 14px'})}}><LazyPanel height={200}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>PRE-FLIGHT ADVISOR</div><AdvisorPanel/></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={200}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>ASYNC AGENT</div><AsyncAgentCard/></div></LazyPanel></div>
                  <div style={{gridColumn:'1/-1',...gc({padding:'10px 14px'})}}><LazyPanel height={150}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>GUARDIAN ALERT</div><GuardianAlert/></div></LazyPanel></div>
                  {/* Row 13: Investor Deck + Compliance */}
                  <div style={{gridColumn:'1/-1',...gc({padding:'10px 14px'})}}><LazyPanel height={250}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>INVESTOR METRICS</div><InvestorDeckSlide/></div></LazyPanel></div>
                  <div style={{gridColumn:'1/-1',...gc({padding:'10px 14px'})}}><LazyPanel height={200}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>COMPLIANCE DASHBOARD</div><ComplianceDashboard/></div></LazyPanel></div>
                  {/* Row 14: Cost Analytics + Live Telemetry */}
                  <div style={{gridColumn:'1/3',...gc({padding:'10px 14px'})}}><LazyPanel height={280}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>COST ANALYTICS</div><CostAnalytics/></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={280}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>LIVE TELEMETRY</div><LiveTelemetry/></div></LazyPanel></div>
                  {/* Row 15: OpsDeck Canvas — full width */}
                  <div style={{gridColumn:'1/-1',...gc({padding:'10px 14px'})}}><LazyPanel height={300}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>OPSDECK CANVAS</div><OpsDeckCanvas/></div></LazyPanel></div>
                  {/* Row 16: Team Run + Objective Queue */}
                  <div style={{gridColumn:'1/3',...gc({padding:'10px 14px'})}}><LazyPanel height={340}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>TEAM RUN DASHBOARD</div><TeamRunDashboard/></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={340}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>OBJECTIVE QUEUE</div><ObjectiveQueueView/></div></LazyPanel></div>
                  {/* Row 17: HoloBattlefield — full width showpiece */}
                  <div style={{gridColumn:'1/-1',...gc({padding:'10px 14px'})}}><LazyPanel height={480}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>HOLO BATTLEFIELD: OPERATIONS VIEW</div><HoloBattlefield/></div></LazyPanel></div>
                  {/* Row 18: OpsDeck3D Preview — full width */}
                  <div style={{gridColumn:'1/-1',...gc({padding:'10px 14px'})}}><LazyPanel height={420}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>OPSDECK 3D: COGNITIVE CORE PREVIEW</div><OpsDeck3DPreview/></div></LazyPanel></div>
                  {/* Row 19: OpsDeck Full Page — evolved dashboard concept */}
                  <div style={{gridColumn:'1/-1',...gc({padding:'10px 14px'})}}><LazyPanel height={540}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>OPSDECK FULL PAGE: EVOLVED DASHBOARD CONCEPT</div><OpsDeckFullPage/></div></LazyPanel></div>
                  {/* Row 20: Mesh Timeline + Mesh Full Page */}
                  <div style={{gridColumn:'1/3',...gc({padding:'10px 14px'})}}><LazyPanel height={520}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>QUOX MESH: TIMELINE</div><MeshTimeline/></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={520}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>MESH MIGRATION</div><MeshMigrationStatus/></div></LazyPanel></div>
                  <div style={{gridColumn:'1/-1',...gc({padding:'10px 14px'})}}><LazyPanel height={500}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>QUOX MESH: FULL DASHBOARD CONCEPT</div><MeshFullPage/></div></LazyPanel></div>
                  {/* Row 21: Cognitive Core Map + Shell Health */}
                  <div style={{gridColumn:'1/3',...gc({padding:'10px 14px'})}}><LazyPanel height={520}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>COGNITIVE CORE MAP</div><CognitiveCoreMap/></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={520}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>SHELL HEALTH</div><CoreShellHealth/></div></LazyPanel></div>
                  {/* Row 22: AssistantQ Dashboard — full width */}
                  <div style={{gridColumn:'1/-1',...gc({padding:'10px 14px'})}}><LazyPanel height={400}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>ASSISTANT-Q: PERSONAL AI EXECUTIVE ASSISTANT</div><AssistantQDashboard/></div></LazyPanel></div>
                  {/* Row 23: AssistantQ Demo + Evidence */}
                  <div style={{gridColumn:'1/3',...gc({padding:'10px 14px'})}}><LazyPanel height={500}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>THE DEMO: END-TO-END INTEGRATION PROOF</div><AssistantQDemo/></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={500}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>VOLT EVIDENCE BUNDLE</div><AssistantQEvidence/></div></LazyPanel></div>
                  {/* Row 24: ContentOps Dashboard — full width */}
                  <div style={{gridColumn:'1/-1',...gc({padding:'10px 14px'})}}><LazyPanel height={350}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>CONTENTOPS STUDIO: BRANDED CONTENT AT SCALE</div><ContentOpsDashboard/></div></LazyPanel></div>
                  {/* Row 25: ContentOps Bundles + Team */}
                  <div style={{gridColumn:'1/3',...gc({padding:'10px 14px'})}}><LazyPanel height={400}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>CONTENTOPS BUNDLE PRICING</div><ContentOpsBundles/></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={400}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>CONTENT TEAM TOPOLOGY</div><ContentOpsTeam/></div></LazyPanel></div>
                  {/* Row 26: Action-Q Full Page — AI Productivity System */}
                  <div style={{gridColumn:'1/-1',...gc({padding:'10px 14px'})}}><LazyPanel height={520}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>ACTION-Q: AI-POWERED PERSONAL PRODUCTIVITY SYSTEM</div><ActionQFullPage/></div></LazyPanel></div>
                  {/* Row 27: Action-Q Smart Card + Assistant */}
                  <div style={{gridColumn:'1/3',...gc({padding:'10px 14px'})}}><LazyPanel height={400}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>ENHANCED TASK CARD</div><ActionQSmartCard/></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={400}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>ACTION-Q ASSISTANT</div><ActionQAssistant/></div></LazyPanel></div>
                  {/* Row 28: Priority Matrix + Dependency Graph */}
                  <div style={gc({padding:'10px'})}><LazyPanel height={380}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>PRIORITY MATRIX</div><ActionQPriorityMatrix/></div></LazyPanel></div>
                  <div style={{gridColumn:'2/4',...gc({padding:'10px 14px'})}}><LazyPanel height={380}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>DEPENDENCY GRAPH</div><ActionQDependencyGraph/></div></LazyPanel></div>
                  {/* Row 29: Analytics — full width */}
                  <div style={{gridColumn:'1/-1',...gc({padding:'10px 14px'})}}><LazyPanel height={360}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>PRODUCTIVITY ANALYTICS</div><ActionQAnalytics/></div></LazyPanel></div>
                  {/* Row 30: Delegation + Integrations */}
                  <div style={{gridColumn:'1/3',...gc({padding:'10px 14px'})}}><LazyPanel height={400}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>AGENT DELEGATION PANEL</div><ActionQDelegation/></div></LazyPanel></div>
                  <div style={gc({padding:'10px'})}><LazyPanel height={400}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>TASK SOURCES</div><ActionQIntegrations/></div></LazyPanel></div>
                  {/* Row 31: Org Full Page — Enterprise Workspace Reimagined */}
                  <div style={{gridColumn:'1/-1',...gc({padding:'10px 14px'})}}><LazyPanel height={540}><Sh/><div style={{position:'relative',zIndex:1}}><div style={{fontSize:10,fontWeight:700,color:'rgba(255,255,255,0.7)',marginBottom:4,fontFamily:M,letterSpacing:1}}>ORGANISATION MANAGEMENT: REIMAGINED</div><OrgFullPage/></div></LazyPanel></div>
                </div>}
                {mainTab==='settings'&&<div>
                  <div style={{fontSize:15,fontWeight:700,marginBottom:16}}>Theme Settings</div>
                  <div style={{display:'flex',gap:12}}>
                    {/* Sliders + Orb Colours */}
                    <div style={{flex:1,display:'flex',flexDirection:'column',gap:12}}>
                      <div style={gl({borderRadius:14,padding:16})}>
                        <Sh/>
                        <div style={{position:'relative',zIndex:1}}>
                          <div style={{fontSize:14,fontWeight:700,marginBottom:14}}>Glass Core</div>
                          {[
                            ['blur','Blur',0,100],['edgeLight','Edge Light',0,60],['innerGlow','Inner Glow',0,50],
                            ['shadow','Shadow Depth',0,80],['saturate','Saturate',100,400],
                          ].map(([k,l,min,max])=><div key={k} style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                            <span style={{width:90,fontSize:12,fontWeight:500}}>{l}</span>
                            <input type="range" min={min} max={max} value={tv[k]} onChange={ut(k)} style={{flex:1,height:4,accentColor:'#a855f7',background:'rgba(255,255,255,0.08)',borderRadius:2}}/>
                            <span style={{width:28,fontSize:11,fontFamily:M,fontWeight:600,textAlign:'right'}}>{tv[k]}</span>
                          </div>)}
                        </div>
                      </div>
                      <div style={gl({borderRadius:14,padding:16})}>
                        <Sh/>
                        <div style={{position:'relative',zIndex:1}}>
                          <div style={{fontSize:14,fontWeight:700,marginBottom:14}}>Light & Depth</div>
                          {[
                            ['lightAngle','Light Angle',0,360],['edgeDim','Edge Dim',0,40],['bgTint','BG Tint',0,50],
                            ['shimmer','Shimmer',0,30],['glowSpread','Outer Glow',0,100],
                          ].map(([k,l,min,max])=><div key={k} style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                            <span style={{width:90,fontSize:12,fontWeight:500}}>{l}</span>
                            <input type="range" min={min} max={max} value={tv[k]} onChange={ut(k)} style={{flex:1,height:4,accentColor:'#38bdf8',background:'rgba(255,255,255,0.08)',borderRadius:2}}/>
                            <span style={{width:28,fontSize:11,fontFamily:M,fontWeight:600,textAlign:'right'}}>{tv[k]}</span>
                          </div>)}
                          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:0}}>
                            <span style={{width:90,fontSize:12,fontWeight:500}}>Glow Colour</span>
                            <div style={{position:'relative',width:32,height:20,borderRadius:6,overflow:'hidden',...gl({borderRadius:6,padding:0})}}>
                              <input type="color" value={tv.glowColor} onChange={uc('glowColor')} style={{position:'absolute',inset:-6,width:'calc(100% + 12px)',height:'calc(100% + 12px)',border:'none',cursor:'pointer',background:'none'}}/>
                            </div>
                            <span style={{fontSize:10,fontFamily:M,color:'rgba(255,255,255,0.7)'}}>{tv.glowColor}</span>
                          </div>
                        </div>
                      </div>
                      <div style={gl({borderRadius:14,padding:16})}>
                        <Sh/>
                        <div style={{position:'relative',zIndex:1}}>
                          <div style={{fontSize:14,fontWeight:700,marginBottom:14}}>Animation & Layout</div>
                          {[
                            ['hoverLift','Hover Lift',0,10],['animSpeed','Anim Speed',20,200],
                            ['borderRadius','Border Radius',4,30],['panelGap','Panel Gap',2,16],
                            ['gridOp','Grid Lines',0,5],['particleOp','Particles',0,40],['orbGlow','Orb Glow',0,40],
                          ].map(([k,l,min,max])=><div key={k} style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                            <span style={{width:90,fontSize:12,fontWeight:500}}>{l}</span>
                            <input type="range" min={min} max={max} value={tv[k]} onChange={ut(k)} style={{flex:1,height:4,accentColor:'#30ff90',background:'rgba(255,255,255,0.08)',borderRadius:2}}/>
                            <span style={{width:28,fontSize:11,fontFamily:M,fontWeight:600,textAlign:'right'}}>{tv[k]}</span>
                          </div>)}
                        </div>
                      </div>
                      <div style={gl({borderRadius:14,padding:16})}>
                        <Sh/>
                        <div style={{position:'relative',zIndex:1}}>
                          <div style={{fontSize:14,fontWeight:700,marginBottom:14}}>Orb Colours</div>
                          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10}}>
                            {[['orb1','Top-Left'],['orb2','Top-Right'],['orb3','Bottom'],['orb4','Mid-Right']].map(([k,l])=><div key={k} style={{textAlign:'center'}}>
                              <div style={{position:'relative',width:40,height:40,margin:'0 auto 6px',borderRadius:10,overflow:'hidden',...gl({borderRadius:10})}}>
                                <input type="color" value={tv[k]} onChange={uc(k)} style={{position:'absolute',inset:-6,width:'calc(100% + 12px)',height:'calc(100% + 12px)',border:'none',cursor:'pointer',background:'none'}}/>
                              </div>
                              <div style={{fontSize:10,fontWeight:500,color:'rgba(255,255,255,0.8)'}}>{l}</div>
                              <div style={{fontSize:9,fontFamily:M,color:'rgba(255,255,255,0.6)',marginTop:2}}>{tv[k]}</div>
                            </div>)}
                          </div>
                        </div>
                      </div>
                    </div>
                    {/* Presets + Slots + Export */}
                    <div style={{width:260,display:'flex',flexDirection:'column',gap:12}}>
                      <div style={gl({borderRadius:14,padding:16})}>
                        <Sh/>
                        <div style={{position:'relative',zIndex:1}}>
                          <div style={{fontSize:14,fontWeight:700,marginBottom:12}}>Presets</div>
                          {[{n:'Default (Tuned)',id:'default'},{n:'Subtle',id:'subtle'},{n:'Heavy Glass',id:'heavy'},{n:'Minimal',id:'minimal'}].map(p=><div key={p.id} style={gl({borderRadius:10,padding:'10px 14px',cursor:'pointer',marginBottom:6,fontSize:13,fontWeight:preset===p.id?700:500,...(preset===p.id?{borderTopColor:'rgba(168,85,247,0.4)',background:'linear-gradient(145deg,rgba(168,85,247,0.08) 0%,rgba(56,189,248,0.03) 100%)'}:{})})} onClick={()=>{
                            setPreset(p.id)
                            if(p.id==='default') setTv({...DEF_TV})
                            if(p.id==='subtle') setTv({...DEF_TV,blur:20,edgeLight:20,innerGlow:4,shadow:10,saturate:150,orbGlow:12,hoverLift:1,particleOp:10,shimmer:3,glowSpread:0,bgTint:0,edgeDim:0})
                            if(p.id==='heavy') setTv({...DEF_TV,blur:60,edgeLight:50,innerGlow:20,shadow:40,saturate:300,orbGlow:35,hoverLift:4,particleOp:25,shimmer:10,glowSpread:30,bgTint:10,edgeDim:8,glowColor:'#a855f7'})
                            if(p.id==='minimal') setTv({...DEF_TV,blur:15,edgeLight:10,innerGlow:2,shadow:8,saturate:120,orbGlow:8,hoverLift:1,particleOp:5,shimmer:2,glowSpread:0,bgTint:0,edgeDim:0,borderRadius:8,panelGap:4})
                          }} {...ho}><Sh/><span style={{position:'relative',zIndex:1}}>{p.n}</span></div>)}
                        </div>
                      </div>
                      <div style={gl({borderRadius:14,padding:16})}>
                        <Sh/>
                        <div style={{position:'relative',zIndex:1}}>
                          <div style={{fontSize:14,fontWeight:700,marginBottom:12}}>Save Slots</div>
                          <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:6}}>
                            {Array.from({length:10},(_,i)=>{const has=!!slots[i];const isDef=defaultSlot===String(i);return<div key={i} style={{textAlign:'center'}}>
                              <div style={gl({borderRadius:8,width:38,height:38,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',fontSize:13,fontFamily:M,fontWeight:has?700:400,color:isDef?'#30ff90':has?'#a855f7':'rgba(255,255,255,0.6)',...(isDef?{borderTopColor:'rgba(48,255,144,0.4)',background:'linear-gradient(145deg,rgba(48,255,144,0.08) 0%,rgba(48,255,144,0.02) 100%)'}:has?{borderTopColor:'rgba(168,85,247,0.3)',background:'linear-gradient(145deg,rgba(168,85,247,0.06) 0%,rgba(56,189,248,0.02) 100%)'}:{})})} onClick={()=>has?loadSlot(i):saveSlot(i)} {...ho}>
                                <Sh/><span style={{position:'relative',zIndex:1}}>{i+1}</span>
                              </div>
                              <div style={{display:'flex',gap:2,justifyContent:'center',marginTop:4}}>
                                {has&&<div style={{fontSize:9,cursor:'pointer',color:'rgba(255,255,255,0.8)',padding:'1px 4px',borderRadius:3,background:'rgba(255,255,255,0.06)'}} onClick={(e)=>{e.stopPropagation();saveSlot(i)}} title="Overwrite">S</div>}
                                {has&&<div style={{fontSize:9,cursor:'pointer',color:isDef?'#30ff90':'rgba(255,255,255,0.8)',padding:'1px 4px',borderRadius:3,background:isDef?'rgba(48,255,144,0.08)':'rgba(255,255,255,0.06)'}} onClick={(e)=>{e.stopPropagation();setAsDefault(i)}} title="Set as default">D</div>}
                                {has&&<div style={{fontSize:9,cursor:'pointer',color:'#ef4444',padding:'1px 4px',borderRadius:3,background:'rgba(239,68,68,0.06)'}} onClick={(e)=>{e.stopPropagation();clearSlot(i)}} title="Clear">✕</div>}
                              </div>
                            </div>})}
                          </div>
                          <div style={{fontSize:11,fontFamily:M,color:'rgba(255,255,255,0.8)',marginTop:10,lineHeight:1.6}}>
                            Click empty slot to save. Click filled slot to load.<br/>
                            S = overwrite · D = set as default · ✕ = clear
                          </div>
                        </div>
                      </div>
                      <div style={gl({borderRadius:14,padding:16})}>
                        <Sh/>
                        <div style={{position:'relative',zIndex:1}}>
                          <div style={{fontSize:14,fontWeight:700,marginBottom:12}}>Export</div>
                          <div style={gl({borderRadius:10,padding:'10px 14px',cursor:'pointer',fontSize:13,fontWeight:600,color:'#a855f7',textAlign:'center'})} {...ho} onClick={()=>{
                            const css = `:root {\n  /* Glass Core */\n  --glass-blur: ${tv.blur}px;\n  --glass-saturate: ${tv.saturate/100};\n  --glass-edge-light: ${tv.edgeLight/100};\n  --glass-inner-glow: ${tv.innerGlow};\n  --glass-shadow: ${tv.shadow}px;\n  /* Light & Depth */\n  --glass-light-angle: ${tv.lightAngle}deg;\n  --glass-edge-dim: ${tv.edgeDim/100};\n  --glass-bg-tint: ${tv.bgTint/1000};\n  --glass-shimmer: ${tv.shimmer/100};\n  --glass-glow-spread: ${tv.glowSpread}px;\n  --glass-glow-color: ${tv.glowColor};\n  /* Animation & Layout */\n  --glass-hover-lift: ${tv.hoverLift}px;\n  --glass-anim-speed: ${tv.animSpeed/400}s;\n  --glass-border-radius: ${tv.borderRadius}px;\n  --glass-panel-gap: ${tv.panelGap}px;\n  --glass-grid-opacity: ${tv.gridOp/100};\n  --glass-particle-op: ${tv.particleOp/100};\n  --glass-orb-glow: ${tv.orbGlow/100};\n  /* Orb Colours */\n  --glass-orb1: ${tv.orb1};\n  --glass-orb2: ${tv.orb2};\n  --glass-orb3: ${tv.orb3};\n  --glass-orb4: ${tv.orb4};\n}`
                            navigator.clipboard?.writeText(css)
                          }}><Sh/><span style={{position:'relative',zIndex:1}}>📋 Copy CSS Variables</span></div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>}
              </div>
            </div>
          </div>

          {/* CHAT SIDEBAR */}
          {rightOpen&&<div style={{...gl({width:280,minWidth:280,maxWidth:280,borderRadius:14,padding:8,display:'flex',flexDirection:'column'}),flexShrink:0,overflow:'hidden'}}>
            <Sh/>
            <div style={{position:'relative',zIndex:1,display:'flex',flexDirection:'column',flex:1,minHeight:0}}>
              <div style={{padding:'4px 6px 6px',display:'flex',alignItems:'center',gap:6}}><Q s={16}/><span style={{fontSize:13,fontWeight:700,flex:1}}>CommanderQ</span><div className="gdot" style={{color:'#30ff90',backgroundColor:'#30ff90'}}/></div>
              <CoreViz/>
              <div style={{flex:1,overflow:'auto',display:'flex',flexDirection:'column',gap:6,padding:'0 4px'}}>
                {chat.map((msg,i)=><div key={i} style={{display:'flex',justifyContent:msg.from==='user'?'flex-end':'flex-start'}}><div style={{...gl({borderRadius:12,padding:'8px 12px',maxWidth:'90%',...(msg.from==='user'?{borderTopColor:'rgba(56,189,248,0.3)',background:'rgba(56,189,248,0.06)'}:{})}),overflow:'hidden'}}><Sh/>{msg.from==='ai'&&<div style={{fontSize:9,fontFamily:M,color:'#38bdf8',fontWeight:700,marginBottom:4,letterSpacing:'1px',position:'relative',zIndex:1}}>COMMANDERQ</div>}<div style={{fontSize:12,lineHeight:1.5,color:msg.from==='user'?'rgba(255,255,255,0.8)':'#efefef',position:'relative',zIndex:1}}>{msg.text}</div></div></div>)}
              </div>
              <div style={{padding:'6px 4px 2px'}}><div style={{...gl({borderRadius:10,padding:'6px 10px',display:'flex',alignItems:'center',gap:6}),overflow:'hidden'}}><Sh/><input value={chatMsg} onChange={e=>setChatMsg(e.target.value)} placeholder="Ask CommanderQ..." style={{flex:1,background:'transparent',border:'none',outline:'none',color:'#efefef',fontSize:12,fontFamily:"'Inter',sans-serif",position:'relative',zIndex:1}}/><div style={gl({borderRadius:6,padding:'4px 8px',cursor:'pointer',fontSize:10,color:'#38bdf8',fontWeight:600})} {...ho}><span style={{position:'relative',zIndex:1}}>↑</span></div></div></div>
            </div>
          </div>}
        </div>

        {/* FOOTER */}
        <div style={{...gl({borderRadius:14,padding:'7px 14px',display:'flex',justifyContent:'space-between',alignItems:'center'}),flexShrink:0,overflow:'hidden'}}>
          <Sh/>
          <div style={{display:'flex',alignItems:'center',gap:6,position:'relative',zIndex:1}}>
            <div style={hb('#fff',{color:'#fff'})}><Sh/><span style={{position:'relative',zIndex:1,fontWeight:600}}>QuoxCORE v2.0</span></div>
            <div style={hb('#fff',{color:'#fff'})}><Sh/><span style={{position:'relative',zIndex:1}}>10 hosts</span></div>
            <div style={hb('#fff',{color:'#fff'})}><Sh/><span style={{position:'relative',zIndex:1}}>9 agents</span></div>
            <div style={hb('#fff',{color:'#fff'})}><Sh/><span style={{position:'relative',zIndex:1}}>28 containers</span></div>
            {/* Mini sparklines */}
            {[{d:[3,5,4,6,5,7,6,8,7,9,8,10],c:'#30ff90',l:'CPU'},{d:[40,42,41,43,42,44,43,45,44,46,45,47],c:'#38bdf8',l:'MEM'}].map((sp,si)=><div key={si} style={hb(sp.c)}><Sh/><span style={{position:'relative',zIndex:1}}>{sp.l}</span><svg viewBox="0 0 48 16" style={{width:48,height:16,position:'relative',zIndex:1}}><polyline points={sp.d.map((v,i)=>`${i*4},${16-v*1.2}`).join(' ')} fill="none" stroke={sp.c} strokeWidth={1.5} opacity={0.8}/></svg></div>)}
          </div>
          <div style={{display:'flex',alignItems:'center',gap:6,position:'relative',zIndex:1}}>
            {[{l:'AEE',c:'#38bdf8'},{l:'AOCL',c:'#a855f7'},{l:'VOLT',c:'#30ff90'},{l:'WARD',c:'#06b6d4'}].map(p=><div key={p.l} style={hb(p.c)}><Sh/><span style={{position:'relative',zIndex:1,letterSpacing:'1px'}}>{p.l}</span></div>)}
            <div style={hb('#30ff90')}><Sh/><div className="gdot" style={{color:'#30ff90',backgroundColor:'#30ff90',width:5,height:5,position:'relative',zIndex:1}}/><span style={{position:'relative',zIndex:1}}>Connected</span></div>
          </div>
        </div>
      </div>
    </div>
  </>)
}
