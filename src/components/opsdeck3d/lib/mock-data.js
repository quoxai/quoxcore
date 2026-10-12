/**
 * Mock data for Cognitive Core 3D — extracted from CognitiveCore3DView.jsx
 *
 * All hardcoded data arrays live here. Later each export gets replaced
 * by a real API call or registry import, one by one.
 */

// ─── Mock Implants Data ─────────────────────────────────
export const MOCK_IMPLANTS = [
  // Sensory & Limbic layer (Free tier)
  { id: 'quox-sense', name: 'QuoxSense', inspiredBy: 'Sensory cortex', health: 95, color: '#ef4444', layer: 'sensory', tier: 'free', locked: false },
  { id: 'quox-memory', name: 'QuoxMemory', inspiredBy: 'Hippocampus', health: 88, color: '#9d4edd', layer: 'sensory', tier: 'free', locked: false },
  { id: 'quox-temporal', name: 'QuoxTemporal', inspiredBy: 'Temporal lobe', health: 97, color: '#06b6d4', layer: 'sensory', tier: 'free', locked: false },
  { id: 'quox-focus', name: 'QuoxFocus', inspiredBy: 'Parietal attention', health: 91, color: '#f472b6', layer: 'sensory', tier: 'free', locked: false },
  { id: 'quox-value', name: 'QuoxValue', inspiredBy: 'Orbitofrontal cortex', health: 85, color: '#3b82f6', layer: 'sensory', tier: 'free', locked: false },
  { id: 'quox-guard', name: 'QuoxGuard', inspiredBy: 'Amygdala', health: 96, color: '#22c55e', layer: 'sensory', tier: 'free', locked: false },
  // Cortical layer (Pro tier)
  { id: 'quox-insight', name: 'QuoxInsight', inspiredBy: 'Association cortex', health: 45, color: '#f59e0b', layer: 'cortical', tier: 'pro', locked: true },
  { id: 'quox-executive', name: 'QuoxExecutive', inspiredBy: 'Prefrontal cortex', health: 92, color: '#8b5cf6', layer: 'cortical', tier: 'pro', locked: true },
  { id: 'quox-predict', name: 'QuoxPredict', inspiredBy: 'Predictive processing', health: 87, color: '#fb7185', layer: 'cortical', tier: 'pro', locked: true },
  // Consolidative layer (Complete tier)
  { id: 'quox-reflect', name: 'QuoxReflect', inspiredBy: 'Default mode network', health: 94, color: '#a855f7', layer: 'consolidative', tier: 'complete', locked: true },
  { id: 'quox-dream', name: 'QuoxDream', inspiredBy: 'Sleep consolidation', health: 90, color: '#7c3aed', layer: 'consolidative', tier: 'complete', locked: true },
  { id: 'quox-learn', name: 'QuoxLearn', inspiredBy: 'Synaptic plasticity', health: 0, color: '#3b82f6', layer: 'consolidative', tier: 'complete', locked: true },
]

// ─── Mock Agents Data ────────────────────────────────────
export const MOCK_AGENTS = [
  { id: 'quox', name: 'QUOX', role: 'orchestrator', color: '#38bdf8', state: 'active', description: 'Orchestrator — routes and delegates', tools: ['task_routing', 'delegation'], capabilities: ['orchestration'] },
  { id: 'sentinel', name: 'WARDEN', role: 'manager', color: '#3090ff', state: 'executing', description: 'Security operations', tools: ['ssh_exec', 'security_audit'], capabilities: ['security'] },
  { id: 'cipher', name: 'CIPHER', role: 'manager', color: '#9d4edd', state: 'thinking', description: 'Network operations', tools: ['ssh_exec', 'dns_lookup'], capabilities: ['network'] },
  { id: 'nova', name: 'DAEDALUS', role: 'manager', color: '#30ff90', state: 'executing', description: 'DevOps and deployment', tools: ['docker_exec', 'deploy'], capabilities: ['devops'] },
  { id: 'prism', name: 'PRISM', role: 'analyst', color: '#4285f4', state: 'thinking', description: 'Analysis and classification', tools: ['query_metrics'], capabilities: ['analytics'] },
  { id: 'atlas', name: 'HYPERION', role: 'specialist', color: '#ff8c00', state: 'idle', description: 'Infrastructure management', tools: ['ssh_exec'], capabilities: ['infrastructure'] },
  { id: 'metrics', name: 'METRICS', role: 'specialist', color: '#e6522c', state: 'idle', description: 'Monitoring and metrics', tools: ['query_metrics'], capabilities: ['monitoring'] },
  { id: 'insight', name: 'INSIGHT', role: 'specialist', color: '#f46800', state: 'idle', description: 'Dashboards and visualisation', tools: ['dashboard_query'], capabilities: ['visualization'] },
  { id: 'scholar', name: 'SCHOLAR', role: 'specialist', color: '#20b2aa', state: 'reading', description: 'Research and documentation', tools: ['web_search'], capabilities: ['research'] },
  { id: 'beacon', name: 'VIGIL', role: 'specialist', color: '#00c853', state: 'idle', description: 'Health and uptime', tools: ['health_check'], capabilities: ['monitoring'] },
  { id: 'forge', name: 'VULCAN', role: 'specialist', color: '#8b5cf6', state: 'idle', description: 'Code and file operations', tools: ['file_write'], capabilities: ['development'] },
  { id: 'corey', name: 'COREY', role: 'specialist', color: '#00d4aa', state: 'idle', description: 'Self-awareness and reflection', tools: ['reflect'], capabilities: ['cognition'] },
  { id: 'keeper', name: 'KEEPER', role: 'specialist', color: '#14b8a6', state: 'idle', description: 'Backup and restoration', tools: ['memory_save'], capabilities: ['memory'] },
  { id: 'tester', name: 'TESTER', role: 'specialist', color: '#22c55e', state: 'idle', description: 'Testing and QA', tools: ['run_tests'], capabilities: ['testing'] },
  { id: 'imagesq', name: 'ImagesQ', role: 'specialist', color: '#f59e0b', state: 'idle', description: 'Image generation', tools: ['generate_image'], capabilities: ['creative'] },
  { id: 'perplexity', name: 'PERPLEXITY', role: 'specialist', color: '#1fb8cd', state: 'idle', description: 'Web research', tools: ['web_search'], capabilities: ['research'] },
]

// ─── Agent Position Map (mirrors AgentMesh layout) ──────
export const AGENT_POSITIONS = (() => {
  const pos = {}
  const roles = { orchestrator: [], manager: [], analyst: [], specialist: [] }
  MOCK_AGENTS.forEach(a => {
    const bucket = roles[a.role] || roles.specialist
    bucket.push(a)
  })
  roles.orchestrator.forEach(a => { pos[a.id] = [0, 2, 0]; pos[`${a.id}_color`] = a.color })
  const managers = [...roles.manager, ...roles.analyst]
  managers.forEach((a, i) => {
    const angle = (i / Math.max(managers.length, 1)) * Math.PI * 2
    pos[a.id] = [Math.cos(angle) * 11, Math.sin(angle * 2.3) * 0.5, Math.sin(angle) * 11]
    pos[`${a.id}_color`] = a.color
  })
  roles.specialist.forEach((a, i) => {
    const angle = (i / Math.max(roles.specialist.length, 1)) * Math.PI * 2
    const yOffset = 0.5 + Math.sin(i * 1.7) * 1.5
    pos[a.id] = [Math.cos(angle) * 15, yOffset, Math.sin(angle) * 15]
    pos[`${a.id}_color`] = a.color
  })
  return pos
})()

// ─── Mock Objectives Data ────────────────────────────────
export const MOCK_OBJECTIVES = [
  {
    id: 'obj-1', title: 'Deploy v2.4 to Production', status: 'running', accentColor: '#6366f1',
    tasks: [
      { id: 't1', title: 'Run test suite', status: 'completed', agentId: 'tester' },
      { id: 't2', title: 'Build Docker images', status: 'completed', agentId: 'nova' },
      { id: 't3', title: 'Security audit', status: 'running', agentId: 'sentinel' },
      { id: 't4', title: 'Deploy to staging', status: 'running', agentId: 'nova' },
      { id: 't5', title: 'Smoke test endpoints', status: 'pending', agentId: 'tester' },
      { id: 't6', title: 'Deploy to production', status: 'pending', agentId: 'nova' },
    ],
  },
  {
    id: 'obj-2', title: 'Investigate Memory Leak', status: 'running', accentColor: '#22c55e',
    tasks: [
      { id: 't7', title: 'Profile heap usage', status: 'completed', agentId: 'metrics' },
      { id: 't8', title: 'Identify leak source', status: 'running', agentId: 'corey' },
      { id: 't9', title: 'Apply fix', status: 'pending', agentId: 'forge' },
      { id: 't10', title: 'Verify fix', status: 'pending', agentId: 'tester' },
    ],
  },
  {
    id: 'obj-3', title: 'SSL Cert Renewal', status: 'completed', accentColor: '#10b981',
    tasks: [
      { id: 't11', title: 'Check expiry', status: 'completed', agentId: 'beacon' },
      { id: 't12', title: 'Renew cert', status: 'completed', agentId: 'nova' },
      { id: 't13', title: 'Verify renewal', status: 'completed', agentId: 'tester' },
    ],
  },
]

// ─── Mock Memories Data ─────────────────────────────────
export const MOCK_MEMORIES = [
  { id: 'm1', type: 'entity', content: 'edge-01 — Docker host, 203.0.113.101', age: 0.1 },
  { id: 'm2', type: 'entity', content: 'hyp-01 — Proxmox node, 203.0.113.10', age: 0.3 },
  { id: 'm3', type: 'entity', content: 'gw-01 — SSH bastion, 198.51.100.247', age: 0.5 },
  { id: 'm4', type: 'entity', content: 'nginx — Reverse proxy on edge-01', age: 0.7 },
  { id: 'm5', type: 'fact', content: 'Auth service runs on port 3101', age: 0.1 },
  { id: 'm6', type: 'fact', content: 'Collector caches keys for 30s', age: 0.3 },
  { id: 'm7', type: 'fact', content: 'QuoxFlow uses 429 tests', age: 0.5 },
  { id: 'm8', type: 'fact', content: 'n8n fully decoupled March 2026', age: 0.8 },
  { id: 'm9', type: 'decision', content: 'OAuth preferred over API keys', age: 0.2 },
  { id: 'm10', type: 'decision', content: 'QuoxFlow is default workflow engine', age: 0.6 },
  { id: 'm11', type: 'preference', content: 'User prefers terse responses', age: 0.15 },
  { id: 'm12', type: 'preference', content: 'UK English, no emojis', age: 0.2 },
  { id: 'm13', type: 'openLoop', content: 'SSL cert renewal due for quox.ai', age: 0.1 },
  { id: 'm14', type: 'openLoop', content: 'Backup coverage audit pending', age: 0.3 },
  { id: 'm15', type: 'openLoop', content: 'GPU setup for dev machine', age: 0.4 },
  { id: 'm16', type: 'entity', content: 'quox-dashboard — React + Docker', age: 0.4 },
  { id: 'm17', type: 'fact', content: 'Frontend dist baked into Docker image', age: 0.2 },
  { id: 'm18', type: 'error', content: 'Collector restart does not pick up code changes', age: 0.6 },
]

// ─── Searchable Entity List (derived) ────────────────────
export const SEARCHABLE_ENTITIES = [
  ...MOCK_AGENTS.map(a => ({ id: a.id, name: a.name, type: 'agent', color: a.color })),
  ...MOCK_OBJECTIVES.map(o => ({ id: o.id, name: o.title, type: 'objective', color: o.accentColor || '#6366f1' })),
  ...MOCK_MEMORIES.map(m => ({ id: m.id, name: m.content, type: 'memory', color: '#ec4899' })),
]
