/**
 * QuoxMind Cognitive Implant Suite — Configuration
 *
 * 14 cognitive implants tracked in this registry, split by `kind`:
 *   - 12 are `kind: 'faculty'` — the QuoxMind product's own named modules,
 *     organised into 3 tiers (Free / Pro / Complete), each with its own
 *     /solutions/quoxmind/<name> page on the website. This is "the twelve
 *     QuoxMind faculties" referenced elsewhere in the codebase and website.
 *   - 2 are `kind: 'product'` — quox-nucleus (RepoBrain) and quox-brain2
 *     (Qortex). Both are modelled here as cognitive implants because the
 *     Cognitive Topology visualiser and Mirror self-awareness index track
 *     ALL 14 as live nodes, but each is a standalone, independently priced
 *     and independently licensed plugin (see quox-nucleus.json,
 *     quox-brain2.json) with its own top-level promo page. Neither is
 *     gated by quoxmind-pro/quoxmind-complete (see getLockedImplants() in
 *     cognitiveTopologyService.js) — they are products in their own right,
 *     not QuoxMind tier faculties.
 * QN Phase 3: added quox-brain2, renamed quox-nucleus display name to RepoBrain.
 * Each implant is inspired by neuroscience and represents a distinct
 * cognitive function within the QuoxMind architecture.
 *
 * Stream QMB Phase QMB-1. Faculty/product split: TRUST-GATE implant-count
 * reconciliation.
 *
 * To add a new implant:
 * 1. Add entry to COGNITIVE_IMPLANTS with unique id (quox-<name>)
 * 2. Define gridPosition, dataSource, metrics, tier, inspiredBy, kind
 * 3. Add a data fetcher function in cognitiveTopologyService.js
 * 4. Update fetchAllImplantData() to include the new implant
 * 5. The UI auto-renders based on this config
 */

export const COGNITIVE_IMPLANTS = {
  // ═══════════════════════════════════════════════════════════════════
  // CORE — The central cognitive nucleus (always present)
  // ═══════════════════════════════════════════════════════════════════

  'quox-sense': {
    id: 'quox-sense',
    name: 'QuoxSense',
    type: 'core',
    kind: 'faculty',
    tier: 'free',
    inspiredBy: 'Sensory cortex',
    description: 'Perceives the operational environment — events, alerts, state changes, telemetry — and structures them into observations.',
    howToGrow: 'Connect more services and enable event streams. The more Quox can see, the stronger this implant becomes.',
    gridPosition: { row: 1, col: 2, rowSpan: 2, colSpan: 1 },
    connectedTo: [],
    dataSource: {
      service: 'senseMetrics',
      method: 'getSenseStats',
    },
    metrics: [
      { key: 'signalCount', label: 'Signals (24h)', format: 'number', primary: true },
      { key: 'activeServices', label: 'Active Services', format: 'number' },
      { key: 'eventRate', label: 'Events/min', format: 'number' },
    ],
    // QMH-5/2: per-license card copy. tierBehavior[currentTier] is shown
    // on the topology card so the user sees what THIS org's license gives
    // them, not a generic description that ignores license state.
    tierBehavior: {
      free: 'Captures durable signals from every connected service into the implant_signals table.',
      pro: 'Same as Free — sensing is a core capability, no premium gate.',
      complete: 'Same as Free — sensing is a core capability, no premium gate.',
    },
    requiredPlugins: [],
    color: 'var(--m-hal-red)',
  },

  'quox-nucleus': {
    id: 'quox-nucleus',
    name: 'RepoBrain',
    type: 'core',
    // Standalone product (see licenseValidator PLUGIN_TIERS 'quox-nucleus':
    // 'tier_b' and quox-nucleus.json, $50 one-time) — not one of the twelve
    // QuoxMind faculties, not gated by quoxmind-pro/complete.
    kind: 'product',
    tier: 'free',
    inspiredBy: 'Corpus callosum + cerebral cortex',
    description: 'Understands its own codebase — structure, connections, definitions, flows. Grounded self-awareness from actual code, not inference.',
    howToGrow: 'Index more repos. Install more plugins (their code gets indexed too). The more Quox knows about itself, the stronger this implant becomes.',
    gridPosition: { row: 5, col: 2 },
    connectedTo: ['quox-sense'],
    dataSource: {
      service: 'nucleusMetrics',
      method: 'getNucleusStats',
    },
    metrics: [
      { key: 'indexedFiles', label: 'Indexed Files', format: 'number', primary: true },
      { key: 'connections', label: 'Import Connections', format: 'number' },
      { key: 'repoCount', label: 'Repos Indexed', format: 'number' },
      { key: 'cacheHitRate', label: 'Cache Hit Rate', format: 'percent' },
      { key: 'avgQueryMs', label: 'Avg Query', format: 'duration' },
    ],
    tierBehavior: {
      free: 'Indexes your repos via RepoBrain. `repobrain query "..."` runs grounded code searches.',
      pro: 'Same as Free — codebase awareness is a core capability.',
      complete: 'Same as Free — codebase awareness is a core capability.',
    },
    requiredPlugins: [],
    color: 'var(--m-hal-cyan)',
  },

  // ═══════════════════════════════════════════════════════════════════
  // FREE TIER — Ships with Quox Core
  // ═══════════════════════════════════════════════════════════════════

  'quox-memory': {
    id: 'quox-memory',
    name: 'QuoxMemory',
    type: 'peripheral',
    kind: 'faculty',
    tier: 'free',
    inspiredBy: 'Hippocampus',
    description: 'Retains and recalls facts, episodes, entities, decisions, preferences, and history across sessions.',
    howToGrow: 'Use Quox regularly. Successful operations, confirmed preferences, and retained context increase memory density.',
    gridPosition: { row: 1, col: 1 },
    connectedTo: ['quox-sense'],
    dataSource: {
      service: 'memoryMetrics',
      method: 'getMemoryLatticeStats',
    },
    metrics: [
      { key: 'healthScore', label: 'Health Score', format: 'percent', primary: true },
      { key: 'totalMemories', label: 'Total Memories', format: 'number' },
      { key: 'entities', label: 'Entities', format: 'number' },
      { key: 'recentActivity', label: 'Recent Activity', format: 'number' },
    ],
    breakdown: [
      { key: 'episodic', label: 'Episodic' },
      { key: 'semantic', label: 'Semantic' },
      { key: 'learned', label: 'Learned' },
    ],
    tierBehavior: {
      free: 'Episodic + semantic memory persisted server-side via the memory service.',
      pro: 'Adds priority-aware memory retrieval driven by QuoxValue scoring.',
      complete: 'Adds dream-cycle consolidation: duplicates merged, contradictions flagged, themes elevated.',
      upsell: 'Upgrade to Complete to enable nightly memory consolidation.',
    },
    requiredPlugins: [],
    fallbackState: 'basic',
    color: 'var(--m-agent-cipher)',
  },

  'quox-temporal': {
    id: 'quox-temporal',
    name: 'QuoxTemporal',
    type: 'peripheral',
    kind: 'faculty',
    tier: 'free',
    inspiredBy: 'Temporal lobe',
    description: 'Understands time, sequence, recency, rhythm, duration, deadlines, and the significance of timing.',
    howToGrow: 'Run objectives over days and weeks. Temporal patterns emerge from operational history and recurring cadences.',
    gridPosition: { row: 1, col: 3 },
    connectedTo: ['quox-sense'],
    dataSource: {
      service: 'temporalMetrics',
      method: 'getTemporalStats',
    },
    metrics: [
      { key: 'recentEvents', label: 'Recent Events', format: 'number', primary: true },
      { key: 'avgDuration', label: 'Avg Duration', format: 'duration' },
      { key: 'patternsDetected', label: 'Patterns', format: 'number' },
    ],
    tierBehavior: {
      free: 'Records task durations and surfaces p50/p95 latencies from real execution data.',
      pro: 'Same as Free — temporal awareness is a core capability.',
      complete: 'Same as Free — temporal awareness is a core capability.',
    },
    requiredPlugins: [],
    color: 'var(--m-info)',
  },

  'quox-focus': {
    id: 'quox-focus',
    name: 'QuoxFocus',
    type: 'peripheral',
    kind: 'faculty',
    tier: 'free',
    inspiredBy: 'Parietal attention network',
    description: 'Allocates cognitive attention to what matters most, managing signal-to-noise across the system.',
    howToGrow: 'Long workflows, multiple simultaneous objectives, and cross-project context expand attention capacity.',
    gridPosition: { row: 2, col: 1 },
    connectedTo: ['quox-sense'],
    dataSource: {
      service: 'focusMetrics',
      method: 'getContextHorizonStats',
    },
    metrics: [
      { key: 'contextUtilization', label: 'Context Used', format: 'percent', primary: true },
      { key: 'activeProjects', label: 'Active Projects', format: 'number' },
      // QMH-5/2: open-loop tracking is gated to Pro+. Free orgs always see
      // 0 because addOpenLoop() refuses without the license — the UI now
      // renders this as "🔒 Pro" instead of an honest-looking zero.
      { key: 'openLoops', label: 'Open Loops', format: 'number', requiresPlugin: 'quoxmind-pro' },
      { key: 'recentEntities', label: 'Recent Entities', format: 'number' },
    ],
    tierBehavior: {
      free: 'Tracks current focus and recent entities via server-side WSM.',
      pro: 'Adds open-loop tracking: unresolved threads, deadlines, and follow-ups carried across sessions.',
      complete: 'Adds open-loop tracking and wisdom-fed prioritisation.',
      upsell: 'Upgrade to Pro to track open loops automatically.',
    },
    requiredPlugins: [],
    color: 'var(--m-accent)',
  },

  'quox-value': {
    id: 'quox-value',
    name: 'QuoxValue',
    type: 'peripheral',
    kind: 'faculty',
    tier: 'free',
    inspiredBy: 'Orbitofrontal cortex',
    description: 'Assigns importance, relevance, and priority to competing concerns based on goals and organisational context.',
    howToGrow: 'Set priorities, confirm preferences, and provide feedback. Value calibration improves with explicit guidance.',
    gridPosition: { row: 2, col: 3 },
    connectedTo: ['quox-sense'],
    dataSource: {
      service: 'valueMetrics',
      method: 'getValueStats',
    },
    metrics: [
      { key: 'totalCapabilities', label: 'Capabilities', format: 'number', primary: true },
      { key: 'assistants', label: 'Agents', format: 'number' },
      { key: 'tools', label: 'Tools', format: 'number' },
      { key: 'workflows', label: 'Workflows', format: 'number' },
    ],
    tierBehavior: {
      free: 'Sorts pending work by deterministic priority score (severity + urgency keywords + dueBy).',
      pro: 'Adds priority-driven delegation: highest-scoring work routes to the right agent first.',
      complete: 'Adds wisdom-fed prioritisation: past outcomes adjust future scoring weights.',
      upsell: 'Upgrade to Pro for priority-driven delegation; Complete adds wisdom-fed scoring.',
    },
    requiredPlugins: [],
    color: 'var(--ui-blue)',
  },

  'quox-guard': {
    id: 'quox-guard',
    name: 'QuoxGuard',
    type: 'peripheral',
    kind: 'faculty',
    tier: 'free',
    inspiredBy: 'Amygdala',
    description: 'Detects threats, enforces policies, monitors for risk, and intervenes when operations are dangerous.',
    howToGrow: 'Consistent success, human confirmations, and stable operation increase reliability. Enables higher autonomy levels.',
    gridPosition: { row: 3, col: 3 },
    connectedTo: ['quox-sense'],
    dataSource: {
      service: 'guardMetrics',
      method: 'getReliabilityStats',
    },
    metrics: [
      { key: 'uptimePercent', label: 'Uptime', format: 'percent', primary: true },
      { key: 'servicesUp', label: 'Services Up', format: 'ratio' },
      { key: 'alertsActive', label: 'Active Alerts', format: 'number' },
    ],
    tierBehavior: {
      free: 'Authority ceiling L2 — Quox can pause and escalate but never auto-abort.',
      pro: 'Authority ceiling L3 — Quox can abort an individual task autonomously.',
      complete: 'Authority ceiling L4 — Quox can abort a whole objective autonomously when policy demands.',
      upsell: 'Upgrade to Pro for L3 task aborts; Complete unlocks L4 objective aborts.',
    },
    requiredPlugins: [],
    color: 'var(--m-agent-sentinel)',
  },

  // QN Phase 3: Qortex added as the 14th implant.
  'quox-brain2': {
    id: 'quox-brain2',
    name: 'Qortex',
    type: 'peripheral',
    // Standalone product (see licenseValidator PLUGIN_TIERS 'quox-brain2':
    // 'tier_b' and quox-brain2.json, $29 one-time) — not one of the twelve
    // QuoxMind faculties, not gated by quoxmind-pro/complete.
    kind: 'product',
    tier: 'free',
    inspiredBy: 'Associative memory graph (hippocampal-cortical indexing)',
    description: 'Builds a self-feeding, provenanced knowledge graph from connected sources — dev sessions, notes, vaults, team conversations — that every agent can search and cite directly.',
    howToGrow: 'Connect a source once (a folder, Obsidian vault, Notion, team conversations). The graph keeps indexing and cross-linking on its own as more material lands.',
    gridPosition: { row: 5, col: 3 },
    connectedTo: ['quox-memory', 'quox-nucleus'],
    dataSource: {
      service: 'quoxbrain',
      method: 'getBrainStats',
    },
    metrics: [
      { key: 'noteCount', label: 'Indexed Notes', format: 'number', primary: true },
      { key: 'sourceCount', label: 'Connected Sources', format: 'number' },
      { key: 'growthStatus', label: 'Growth Stage', format: 'ratio' },
      { key: 'milestoneRemaining', label: 'To Next Milestone', format: 'number' },
    ],
    tierBehavior: {
      free: 'Indexes connected sources into a governed knowledge graph. Agents query it via quoxbrain_search.',
      pro: 'Same as Free — associative recall is a core capability.',
      complete: 'Same as Free — associative recall is a core capability.',
    },
    requiredPlugins: [],
    color: 'var(--m-agent-quox)',
  },

  // ═══════════════════════════════════════════════════════════════════
  // PRO TIER — Strategic intelligence
  // ═══════════════════════════════════════════════════════════════════

  'quox-insight': {
    id: 'quox-insight',
    name: 'QuoxInsight',
    type: 'peripheral',
    kind: 'faculty',
    tier: 'pro',
    inspiredBy: 'Association cortex',
    description: 'Recognises significance, detects patterns, synthesises information, and interprets meaning in events and memory.',
    howToGrow: 'Run more objectives. Each success and failure teaches pattern recognition. Cross-agent operations reveal correlations.',
    gridPosition: { row: 3, col: 1 },
    connectedTo: ['quox-sense', 'quox-memory'],
    dataSource: {
      service: 'insightMetrics',
      method: 'getInsightStats',
    },
    metrics: [
      { key: 'successRate', label: 'Success Rate', format: 'percent', primary: true },
      { key: 'totalRuns', label: 'Total Runs', format: 'number' },
      { key: 'avgDuration', label: 'Avg Duration', format: 'duration' },
    ],
    breakdown: [
      { key: 'successful', label: 'Successful' },
      { key: 'failed', label: 'Failed' },
      { key: 'running', label: 'Running' },
    ],
    tierBehavior: {
      free: 'Locked. Pattern correlation across implants requires QuoxMind Pro.',
      pro: 'Cross-pattern correlation every 5 minutes — clusters signals into actionable insight.',
      complete: 'Cross-pattern correlation every 30 seconds — near real-time anomaly detection.',
      upsell: 'Upgrade to Pro to unlock pattern correlation; Complete tightens the cadence to 30s.',
    },
    requiredPlugins: [],
    color: 'var(--m-success)',
  },

  'quox-executive': {
    id: 'quox-executive',
    name: 'QuoxExecutive',
    type: 'peripheral',
    kind: 'faculty',
    tier: 'pro',
    inspiredBy: 'Prefrontal cortex',
    description: 'Directs purposeful action — objective decomposition, task sequencing, agent delegation, and behavioural inhibition.',
    howToGrow: 'Run objectives with diverse agent teams. Delegation accuracy improves with the learning router over time.',
    gridPosition: { row: 4, col: 2 },
    connectedTo: ['quox-sense', 'quox-insight', 'quox-predict'],
    dataSource: {
      service: 'executiveMetrics',
      method: 'getExecutiveStats',
    },
    metrics: [
      { key: 'totalAgents', label: 'Total Agents', format: 'number', primary: true },
      { key: 'activeAgents', label: 'Active', format: 'number' },
      { key: 'capabilities', label: 'Capabilities', format: 'number' },
    ],
    breakdown: [
      { key: 'orchestrators', label: 'Orchestrators' },
      { key: 'specialists', label: 'Specialists' },
    ],
    tierBehavior: {
      free: 'Locked. Objective decomposition and multi-agent coordination require QuoxMind Pro.',
      pro: 'Decomposes objectives into tasks and routes work via the bandit learning router.',
      complete: 'Adds wisdom-fed decomposition: past outcomes shape sub-task structure and agent picks.',
      upsell: 'Upgrade to Pro to unlock executive coordination.',
    },
    requiredPlugins: [],
    color: 'var(--m-agent-scholar)',
  },

  'quox-predict': {
    id: 'quox-predict',
    name: 'QuoxPredict',
    type: 'peripheral',
    kind: 'faculty',
    tier: 'pro',
    inspiredBy: 'Predictive processing',
    description: 'Estimates likely outcomes, forecasts execution success, anticipates failures, and provides pre-flight intelligence.',
    howToGrow: 'Accumulated wisdom from past objectives improves prediction accuracy. More history means better forecasts.',
    gridPosition: { row: 4, col: 1 },
    connectedTo: ['quox-insight', 'quox-memory'],
    dataSource: {
      service: 'predictMetrics',
      method: 'getPredictStats',
    },
    metrics: [
      { key: 'wisdomCount', label: 'Wisdom Entries', format: 'number', primary: true },
      { key: 'avgConfidence', label: 'Avg Confidence', format: 'percent' },
      { key: 'predictedSuccess', label: 'Predicted Success', format: 'percent' },
    ],
    tierBehavior: {
      free: 'Locked. Outcome prediction and mandatory advisor directives require QuoxMind Pro.',
      pro: 'Forecasts objective success probability and emits MANDATORY DIRECTIVES the executive must follow.',
      complete: 'Same as Pro — predictions feed dream-cycle wisdom for ever-improving accuracy.',
      upsell: 'Upgrade to Pro to unlock pre-flight predictions and mandatory advisory directives.',
    },
    requiredPlugins: [],
    color: 'var(--m-coral)',
  },

  // ═══════════════════════════════════════════════════════════════════
  // COMPLETE TIER — Self-improvement
  // ═══════════════════════════════════════════════════════════════════

  'quox-reflect': {
    id: 'quox-reflect',
    name: 'QuoxReflect',
    type: 'peripheral',
    kind: 'faculty',
    tier: 'complete',
    inspiredBy: 'Default mode network',
    description: 'Evaluates past actions — what worked, what failed, what was unexpected, and what should change next time.',
    howToGrow: 'Every completed objective triggers reflection. Failures teach more than successes. Quality improves with volume.',
    gridPosition: { row: 4, col: 3 },
    connectedTo: ['quox-insight', 'quox-executive'],
    dataSource: {
      service: 'reflectMetrics',
      method: 'getReflectStats',
    },
    metrics: [
      { key: 'policyCount', label: 'Policies', format: 'number', primary: true },
      { key: 'agentRoles', label: 'Agent Roles', format: 'number' },
      { key: 'memoryDomains', label: 'Memory Domains', format: 'number' },
    ],
    tierBehavior: {
      free: 'Locked. Reflection on every objective requires QuoxMind Complete.',
      pro: 'Post-mortem on failed objectives only — successful runs are not analysed for improvement.',
      complete: 'Reflects on every objective regardless of outcome — successes and failures both feed learning.',
      upsell: 'Upgrade to Complete so Quox learns from every objective, not only the failed ones.',
    },
    requiredPlugins: [],
    color: 'var(--m-agent-vault)',
  },

  'quox-dream': {
    id: 'quox-dream',
    name: 'QuoxDream',
    type: 'peripheral',
    kind: 'faculty',
    tier: 'complete',
    inspiredBy: 'Sleep consolidation',
    description: 'Consolidates memory — merges duplicates, resolves contradictions, elevates patterns, and converts experience into knowledge.',
    howToGrow: 'Long-lived instances, successful backups, and maintained history anchor consolidation. Time and volume compound.',
    gridPosition: { row: 3, col: 2 },
    connectedTo: ['quox-memory', 'quox-reflect'],
    dataSource: {
      service: 'dreamMetrics',
      method: 'getDreamStats',
    },
    metrics: [
      { key: 'sessionCount', label: 'Sessions', format: 'number', primary: true },
      { key: 'lastSync', label: 'Last Sync', format: 'timeago' },
      { key: 'storageUsed', label: 'Storage Used', format: 'bytes' },
    ],
    tierBehavior: {
      free: 'Locked. Memory consolidation cycles require QuoxMind Complete.',
      pro: 'Locked. Memory consolidation cycles require QuoxMind Complete.',
      complete: 'Runs every 6 hours: deduplicates memory, resolves contradictions, elevates patterns into wisdom.',
      upsell: 'Upgrade to Complete to enable nightly memory consolidation.',
    },
    requiredPlugins: [],
    color: 'var(--m-color-forge)',
  },

  'quox-learn': {
    id: 'quox-learn',
    name: 'QuoxLearn',
    type: 'peripheral',
    kind: 'faculty',
    tier: 'complete',
    inspiredBy: 'Synaptic plasticity',
    description: 'Adapts behaviour based on experience — changes decomposition, delegation, prediction, and communication over time.',
    howToGrow: 'Upload files, documents, and datasets. Premium enables content search and entity extraction across all data.',
    gridPosition: { row: 2, col: 2 },
    connectedTo: ['quox-dream', 'quox-reflect', 'quox-memory'],
    dataSource: {
      service: 'learnMetrics',
      method: 'getLearnStats',
    },
    metrics: [
      { key: 'totalFiles', label: 'Knowledge Items', format: 'number', primary: true },
      { key: 'storagePercent', label: 'Storage Used', format: 'percent' },
      { key: 'recentlyAccessed', label: 'Recently Used', format: 'number' },
    ],
    breakdown: [
      { key: 'images', label: 'Images' },
      { key: 'documents', label: 'Documents' },
    ],
    tierBehavior: {
      free: 'Round-robin agent selection — each domain rotates through agents in order.',
      pro: 'Epsilon-greedy bandit router — agent picks adapt to per-agent quality and latency observed in agent_performance.',
      complete: 'Same as Pro — bandit router unlocked at Pro+ (QMH-4e).',
      upsell: 'Upgrade to Pro for the learning router that adapts to which agents do their best work for which kind of task.',
    },
    requiredPlugins: [],
    color: 'var(--ui-blue)',
  },
}

/**
 * Get implants organized by grid position for layout
 */
export function getImplantsGrid() {
  const grid = {}
  Object.values(COGNITIVE_IMPLANTS).forEach((implant) => {
    const key = `${implant.gridPosition.row}-${implant.gridPosition.col}`
    grid[key] = implant
  })
  return grid
}

/**
 * Get all peripheral implants (non-core)
 */
export function getPeripheralImplants() {
  return Object.values(COGNITIVE_IMPLANTS).filter((i) => i.type !== 'core')
}

/**
 * Get the cognitive core (QuoxSense is the perceptual core)
 */
export function getCognitiveCore() {
  return COGNITIVE_IMPLANTS['quox-sense']
}

/**
 * Calculate connector paths between implants
 */
export function getConnectorPaths() {
  const paths = []
  Object.values(COGNITIVE_IMPLANTS).forEach((implant) => {
    if (implant.connectedTo) {
      implant.connectedTo.forEach((targetId) => {
        if (COGNITIVE_IMPLANTS[targetId]) {
          paths.push({
            from: implant.id,
            to: targetId,
            fromPos: implant.gridPosition,
            toPos: COGNITIVE_IMPLANTS[targetId].gridPosition,
          })
        }
      })
    }
  })
  return paths
}

/**
 * Get implants by tier
 */
export function getImplantsByTier(tier) {
  return Object.values(COGNITIVE_IMPLANTS).filter((i) => i.tier === tier)
}

/**
 * Get all tier names
 */
export function getTiers() {
  return ['free', 'pro', 'complete']
}

/**
 * Get the twelve QuoxMind faculties (kind: 'faculty') — the named modules
 * that make up the QuoxMind product's Free/Pro/Complete tiers. Excludes
 * quox-nucleus and quox-brain2, which are standalone products (kind:
 * 'product') tracked in this registry for topology/Mirror purposes but
 * not gated by quoxmind-pro/quoxmind-complete.
 */
export function getFaculties() {
  return Object.values(COGNITIVE_IMPLANTS).filter((i) => i.kind === 'faculty')
}

/**
 * Get the standalone products modelled as cognitive implants
 * (quox-nucleus / RepoBrain, quox-brain2 / Qortex). Each has its own
 * price, licence gate, and top-level promo page — not one of the twelve
 * QuoxMind faculties.
 */
export function getStandaloneProducts() {
  return Object.values(COGNITIVE_IMPLANTS).filter((i) => i.kind === 'product')
}
