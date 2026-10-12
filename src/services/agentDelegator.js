/**
 * Agent Delegator Service
 *
 * The core delegation engine that routes queries to specialized agents.
 * Instead of executing hardcoded JavaScript handlers, this service:
 * 1. Identifies the appropriate agent based on query content
 * 2. Loads the agent's manifest and generates self-knowledge context
 * 3. Makes an LLM call with the agent's persona injected
 * 4. Returns the response with proper attribution
 *
 * This enables true multi-agent behavior where QUOX orchestrates and
 * specialized agents (WARDEN, DAEDALUS, CIPHER, etc.) handle domain queries.
 *
 * Custom agents from the DB (tool_definitions / agent_tool_assignments) are
 * also supported. They are fetched from the collector relay endpoint, cached
 * for 5 minutes, and scored alongside core agents. When a custom agent wins,
 * the request is sent directly to the collector's /chat/claude endpoint which
 * handles custom agent prompts and tool resolution via the auth service.
 */

import { getAssistant, generateSelfKnowledge, listAssistants, getRuntimeAssistantConfig } from './entityRegistry.js'
import { getRecommendedAgent as getBasicRecommendedAgent, getAllAgents } from '../config/agentRegistry.js'
import { OUTAGE_DOWN } from '../config/outagePattern.js'
import { getBuiltInTeams, getTeamMemberIds } from '../config/teams/index.js'
import { logDelegationRouted, logDelegationFallback } from './delegationAudit'
import { getFullIndex } from './mirrorIndex.js'
import { DEFAULT_LLM_CONFIG } from './llmService.js'
import { routeQuerySync as semanticRouteQuery, isModelReady, getRouterStats } from './semanticRouter.js'

// Collector endpoint for agent delegation (handles DB prompts + tools).
//
// GTM-A1/B1: the core-agent path used to POST to its own `API_BASE = '/webhook'`,
// i.e. '/webhook/chat'. nginx defines /webhook/voice-status, /webhook/speak,
// /webhook/transcribe and /webhook/telegram/ but has never had a /webhook/chat
// location, so the POST fell through to the SPA static handler and came back as
// a 405 HTML page. Both paths now use the collector's canonical /chat handler,
// which is already proxied by `location /collector/` and which accepts the
// caller's system_prompt (it merges it with the entity prompt).
const COLLECTOR_BASE = '/collector'

/**
 * NOTE: Tool detection and execution has been moved to the proper tool registry system.
 * Tools should be:
 * 1. Defined in tool_definitions table
 * 2. Installed per-org via tool_installations
 * 3. Assigned to agents via agent_tool_assignments
 *
 * The hardcoded TOOL_PATTERNS were removed as they bypassed the registry.
 * See: /services/auth/routes/tool-catalog.js for proper tool management.
 *
 * For workflow-based tools, see workflowEngine.js
 */

// ========================================================================
// Custom Agent Cache
// Fetches DB-defined agents from collector relay → auth internal API
// ========================================================================
let _customAgentsCache = []
let _customAgentsCacheExpiry = 0
const CUSTOM_AGENTS_CACHE_TTL = 300000 // 5 minutes

/**
 * Refresh the custom agents cache from the collector relay endpoint.
 * Safe to call frequently — only fetches when cache is expired.
 */
export async function refreshCustomAgents() {
  if (_customAgentsCacheExpiry > Date.now()) return _customAgentsCache

  try {
    const resp = await fetch(`${COLLECTOR_BASE}/api/agents/custom`, {
      signal: AbortSignal.timeout(5000)
    })
    if (!resp.ok) {
      console.warn(`[AgentDelegator] Custom agents fetch returned ${resp.status}`)
      return _customAgentsCache
    }

    const { agents } = await resp.json()
    _customAgentsCache = (agents || []).map(a => ({
      id: a.agentId,
      name: a.name,
      description: a.description || '',
      capabilities: a.domains || [],
      tools: (a.capabilities || []).map(c => c.replace(/_/g, ' ')),
      level: a.level || 2,
      llm: a.llm || null,
      isCustom: true
    }))
    _customAgentsCacheExpiry = Date.now() + CUSTOM_AGENTS_CACHE_TTL
    if (_customAgentsCache.length > 0) {
      console.log(`[AgentDelegator] Cached ${_customAgentsCache.length} custom agent(s): ${_customAgentsCache.map(a => a.id).join(', ')}`)
    }
  } catch (err) {
    console.warn(`[AgentDelegator] Custom agents fetch failed:`, err.message)
  }

  return _customAgentsCache
}

/**
 * Get cached custom agents (synchronous — returns whatever is cached).
 * Call refreshCustomAgents() first if you need fresh data.
 */
export function getCustomAgents() {
  return _customAgentsCache
}

/**
 * Check if an agent ID is a custom (DB-defined) agent
 */
function isCustomAgent(agentId) {
  return _customAgentsCache.some(a => a.id === agentId)
}

/**
 * Configuration for agent delegation behavior
 */
export const DELEGATION_CONFIG = {
  enabled: true,
  minimumScore: 5,           // Minimum score to delegate (vs staying with Quox)
  explicitMentionBonus: 50,  // Score bonus when agent is mentioned by name
  capabilityMatchBonus: 10,  // Score per capability keyword match
  toolMatchBonus: 5,         // Score per tool name match
  workflowMatchBonus: 8,     // Score per workflow match
  suggestionOverlapBonus: 2, // Score per suggestion word overlap
  logDelegations: true,      // Log delegation decisions
  attributeResponses: true   // Prefix responses with [AGENT_NAME]
}

/**
 * Score an agent against a query using multiple signals
 * @param {string} query - The user query
 * @param {Object} agent - Agent definition from registry
 * @returns {number} - Score (higher = better match)
 */
function scoreAgentMatch(query, agent) {
  const q = query.toLowerCase()
  let score = 0

  // 1. Explicit agent mention (highest priority)
  // Word-boundary match, not substring — see the same fix in selectAgent()
  // below: a plain q.includes(agentId) let "architecture" false-positive
  // match the 'architect' agent id.
  const agentName = (agent.name || agent.identity?.name || '').toLowerCase()
  const agentId = agent.id?.toLowerCase()
  const nameMentioned = agentName && new RegExp(`\\b${escapeRegex(agentName)}\\b`, 'i').test(q)
  const idMentioned = agentId && new RegExp(`\\b${escapeRegex(agentId)}\\b`, 'i').test(q)
  if (nameMentioned || idMentioned) {
    score += DELEGATION_CONFIG.explicitMentionBonus
  }

  // 2. Domain/capability keyword matching
  const capabilities = Array.isArray(agent.capabilities) ? agent.capabilities :
                       (agent.capabilities?.domains || agent.capabilities?.intents || [])
  for (const cap of capabilities) {
    const capLower = (typeof cap === 'string' ? cap : '').toLowerCase()
    if (capLower && q.includes(capLower)) {
      score += DELEGATION_CONFIG.capabilityMatchBonus
    }
  }

  // 3. Tool name matching
  const tools = agent.tools || agent.capabilities?.toolCapabilities || []
  for (const tool of tools) {
    const toolName = tool.replace(/_/g, ' ').toLowerCase()
    if (q.includes(toolName)) {
      score += DELEGATION_CONFIG.toolMatchBonus
    }
  }

  // 4. Workflow matching
  const workflows = agent.workflows || agent.capabilities?.workflows || []
  for (const wf of workflows) {
    const wfName = wf.replace(/-/g, ' ').toLowerCase()
    if (q.includes(wfName)) {
      score += DELEGATION_CONFIG.workflowMatchBonus
    }
  }

  // 5. Suggestion phrase overlap
  // Suggestions can be plain strings (flat-map agents) or objects with a `text` field
  // (entity-manifest agents like JANUS / ARGUS). Normalise to string before tokenising.
  const suggestions = agent.suggestions || []
  for (const suggestion of suggestions) {
    const text = typeof suggestion === 'string' ? suggestion : (suggestion?.text || '')
    if (!text) continue
    // M1 fix: Changed from >3 to >2 to include 3-char terms like dns, vpn, sla, ssh
    const suggestionWords = text.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    const queryWords = q.split(/\s+/)
    const overlap = suggestionWords.filter(w => queryWords.includes(w)).length
    score += overlap * DELEGATION_CONFIG.suggestionOverlapBonus
  }

  // 6. Domain-specific keyword matching (from agentRegistry patterns)
  const domainKeywords = getDomainKeywords(agent.id)
  for (const keyword of domainKeywords) {
    if (matchesDomainKeyword(q, keyword)) {
      score += 8
    }
  }

  // 7. Team membership boost — if query mentions a team, boost its members
  const teams = getBuiltInTeams()
  for (const [teamId, team] of Object.entries(teams)) {
    const teamName = (team.displayName || '').toLowerCase()
    if (q.includes(teamId) || (teamName && q.includes(teamName))) {
      const memberIds = getTeamMemberIds(teamId)
      if (memberIds.includes(agent.id)) {
        score += 12
      }
    }
  }

  return score
}

/**
 * Get domain-specific keywords for an agent
 * Based on the patterns in agentRegistry.getRecommendedAgent()
 */
function getDomainKeywords(agentId) {
  const keywordMap = {
    sentinel: ['security', 'threat', 'security audit', 'firewall', 'breach', 'malware', 'auth failure', 'authentication failure', 'security policy', 'security investigation'],
    cipher: ['network', 'ping', 'connectiv', 'bandwidth', 'port', 'dns', 'traffic', 'vpn', 'route', 'latency'],
    nova: ['deploy', 'docker', 'container', 'ci/cd', 'ansible', 'automat', 'pipeline', 'build', 'release', 'backup', 'restore', 'migration', 'scp', 'rsync', 'ssh_exec', 'volume'],
    atlas: ['vm', 'proxmox', 'cluster', 'snapshot', 'migrat', 'qemu', 'virtual', 'hypervisor'],
    metrics: ['prometheus', 'metric', 'promql', 'alert', 'scrape', 'target', 'cpu', 'memory', 'disk usage'],
    insight: ['grafana', 'dashboard', 'visuali', 'chart', 'graph', 'panel'],
    scholar: ['research', 'troubleshoot', 'how to', 'best practice', 'document', 'why', 'explain'],
    // A keyword may be a RegExp: bare 'down' matched "jot this down",
    // "download" and "markdown" as substrings (AQ-9D, see OUTAGE_DOWN).
    beacon: ['uptime', 'availab', 'sla', 'status page', OUTAGE_DOWN, 'downtime', 'outage', 'health check'],
    // QUOXIFY pass 1: FORGE already HOLDS the qlarity_* tools (governed
    // headless-browser inspection) but had no keyword that would ever route a
    // runtime-page question to it, so the capability was unreachable by
    // delegation. These are deliberately inspection-shaped ("why does the page
    // look wrong") and avoid browser-q's automation vocabulary (screenshot,
    // navigate, scrape, fill form) so the two do not fight over routing.
    forge: ['github', 'github issue', 'github issues', 'pull request', 'pull requests', 'PR', 'CI', 'actions', 'workflow run', 'release', 'commit', 'merge', 'branch', 'repository', 'repo', 'computed style', 'pseudo-element', 'pseudo element', 'console error', 'console errors', 'inspect the page', 'inspect a page', 'why is the page', 'page is blank', 'layout is broken', 'css not applying', 'style not applying', 'z-index', 'stacking context', 'runtime state of the page', 'what does the page say'],

    // QUOXIFY pass 1 (DEVSUITE phase 14). Keyword sets chosen to avoid
    // collisions with agents that already own a word: 'dependency' belongs to
    // ROADY (stream deps), so NUCLEUS uses code-shaped phrasings instead.
    // NUCLEUS owns FIND-AND-EXPLAIN. It deliberately does NOT claim
    // 'what imports' / 'blast radius': BOB already answers those via
    // bob_preflight (they are in its suggestions), and duplicating them just
    // makes routing a coin toss. Nor 'dependency', which is ROADY's (stream
    // deps). Note the delegator matches keywords as SUBSTRINGS, so short
    // words are dangerous: 'port' inside 'imports'/'export' already routes
    // those queries to CIPHER, which is why the phrasings here are long.
    nucleus: ['where is', 'where does', 'codebase', 'code base', 'call site', 'call sites', 'defined in', 'definition of', 'source code', 'find the function', 'find the component', 'how does this code', 'how is this implemented', 'read the code', 'repobrain', 'file:line', 'which file', 'search the code'],

    'loop-q': ['loop', 'loops', 'qloop', 'running loop', 'loop session', 'loop sessions', 'witnessed turn', 'witnessed turns', 'turn record', 'halt the loop', 'stop the loop', 'loop stuck', 'going in circles', 'loop budget', 'what is the loop doing', 'agentic loop'],
    archivist: ['file', 'document', 'summarize', 'compare', 'extract', 'folder', 'upload', 'contradiction', 'quiz'],
    prism: ['classif', 'analyze', 'summar', 'validat', 'cross-check', 'pattern', 'categorize'],
    corey: ['topology', 'implant', 'cognitive', 'memory lattice', 'introspection', 'self-awareness', 'reflection map'],
    tester: ['test', 'tests', 'testing', 'validate', 'validation', 'working', 'verify', 'qa', 'quality', 'smoke test', 'regression', 'pass', 'fail', 'test coverage', 'code coverage'],
    netwatch: ['mikrotik', 'routeros', 'router', 'dhcp', 'ip conflict', 'firewall rule', 'switch', 'vlan', 'bridge', 'nat', 'pppoe', 'capsman', 'wireless'],
    meshnet: ['tailscale', 'tailnet', 'mesh', 'meshnet', 'magicDNS', 'magic dns', 'derp', 'relay', 'subnet router', 'exit node', 'pre-auth', 'preauth', 'tailscale key', 'tailscale device', 'tailscale acl', 'tailscale peer', 'wireguard mesh'],
    dockeragent: ['docker fleet', 'fleet container', 'docker host', 'container fleet', 'compose stack', 'docker scan', 'docker01', 'docker02', 'docker03', 'docker04', 'container action', 'container logs', 'dockula', 'fleet scan', 'system-df', 'fleet stacks'],
    quoxcode: ['terminal', 'shell', 'bash', 'command line', 'cli', 'vim', 'tmux', 'pane', 'workspace'],
    imagesq: ['image', 'picture', 'photo', 'draw', 'illustration', 'visual', 'generate image', 'create image', 'edit image'],
    gemini: ['review', 'second opinion', 'sanity check', 'cross-check', 'independent review', 'another perspective', 'content generation', 'synthesize', 'synthesis', 'large context', 'analyze logs', 'review code', 'code review', 'proofread', 'draft', 'write a report'],
    perplexity: ['search the web', 'web search', 'look up', 'find online', 'current', 'latest', 'recent news', 'fact check', 'fact-check', 'verify claim', 'is it true', 'cite sources', 'citations', 'academic papers', 'scholarly', 'what changed in'],
    'browser-q': ['screenshot', 'webpage', 'browser', 'scrape', 'extract data', 'web page', 'navigate', 'fill form', 'monitor website', 'web automation', 'login to', 'capture page', 'website'],
    auditus: ['compliance', 'compliant', 'non-compliant', 'compliance report', 'compliance score', 'compliance status', 'compliance posture', 'soc2', 'soc 2', 'hipaa', 'gdpr', 'iso 27001', 'iso27001', 'eu ai act', 'volt certification', 'volt certif', 'volt verify', 'volt bundle', 'volt evidence', 'volt run', 'ward chain', 'ward witness', 'ward verify', 'ward integrity', 'ward source', 'aee envelope', 'audit trail', 'aocl policy', 'aocl layer', 'aocl decision', 'aocl', 'volt', 'ward', 'policy enforcement', 'framework coverage', 'coverage gap', 'framework', 'governance', 'tamper evident', 'hash chain', 'evidence chain', 'evidence integrity', 'evidence bundle', 'scheduled report', 'compliance job', 'certification tier', 'certif', 'regulatory', 'attestation', 'conformity', 'posture'],
    janus: ['bastion', 'gateway', 'fleet', 'fleet-wide', 'fleet wide', 'ssh', 'ssh key', 'ssh keys', 'passwordless', 'authorized_keys', 'authorized keys', 'ssh-copy-id', 'gw-01', 'host registry', 'add host', 'remove host', 'remove a host', 'unreachable', 'reachable', 'reachability', 'audit trail', 'audit log', 'audit events', 'audit review', 'who ran', 'who logged', 'command history', 'key rotation', 'rotate key', 'deploy key', 'revoke key', 'host group', 'pve-cluster', 'run on all', 'run on group', 'fleet status', 'fleet health', 'fleet summary', 'bastion host', 'jump host', 'permission denied', 'failed login', 'failed command'],
    argus: ['wazuh', 'siem', 'alert triage', 'alert rule', 'rule level', 'mitre', 'att&ck', 'ioc', 'log analysis', 'cve', 'vulnerab', 'cvss', 'exploit', 'package vulnerab', 'security update', 'patch order', 'fim', 'file integrity', 'syscheck', 'tamper', 'rootkit', 'file changed', 'checksum', 'sca', 'cis benchmark', 'wazuh sca', 'policy fail', 'control fail', 'wazuh agent', 'wazuh manager', 'enrol agent', 'enroll agent', 'agent disconnect', 'never_connected', 'active response', 'block source ip', 'isolate host', 'intrusion'],
    regula: ['settings', 'setting', 'preference', 'preferences', 'configure', 'configuration', 'config', 'toggle', 'enable', 'disable', 'plugin', 'plugins', 'extension', 'addon', 'activate', 'deactivate', 'vault', 'credential', 'credentials', 'api key', 'integration key', 'secret', 'backup', 'backups', 'restore', 'retention', 'schedule', 'licence', 'license', 'trial', 'expire', 'tier', 'appearance', 'theme', 'wallpaper', 'background mode', 'voice settings', 'voice config', 'notification channel', 'telegram channel', 'slack channel', 'email channel', 'notification routing', 'jump host', 'service alert', 'alert rule', 'cookie', 'cookies', 'privacy', 'telemetry', 'opt in', 'opt out', 'reset settings', 'export settings', 'import settings', 'dashboard preference', 'defaults', 'what does this setting', 'what happens if i disable', 'recommend settings', 'walk me through my settings'],
    // X-PLUGIN phase 11: HERALD had NO keyword entry at all, so no query could
    // ever route to it by delegation. Its tools were reachable from the /x view
    // and from an explicit mention, and from nowhere else.
    //
    // DELIBERATELY OMITTED: the bare letter 'x'. Keywords match as SUBSTRINGS
    // (see the NUCLEUS comment above), so 'x' would match "text", "next",
    // "fix", "index", "example" and route a large fraction of all traffic here.
    // This is the same trap agentRegistry.js's comment above the xtwitter entry
    // documents for agent ids. The phrasings below are long enough to mean what
    // they say.
    // 'post' alone is likewise out: it matches "postgres" and "post-mortem".
    xtwitter: ['tweet', 'tweets', 'tweeted', 'twitter', 'post to x', 'posting to x', 'post on x', 'publish to x', 'send a tweet', 'draft a tweet', 'thread on x', 'x thread', 'retweet', 'mentions', 'mentioned us', 'x account', 'x post', 'x posts', 'x api', 'x credentials', 'x budget', 'social post', '@quox_ai'],
    // Social publishers (2026-09-19): xtwitter was the only tuned one; the rest
    // relied on weak generic scoring. Phrases only (substring match) — no bare
    // 'insta'/'meta'/'post' that would collide with instance/metadata/postgres.
    facebook: ['facebook', 'facebook page', 'facebook post', 'post to facebook', 'posting to facebook', 'publish to facebook', 'facebook comment', 'facebook comments', 'meta page', 'fb page'],
    instagram: ['instagram', 'instagram post', 'instagram story', 'instagram reel', 'post to instagram', 'posting to instagram', 'publish to instagram', 'instagram caption', 'ig post', 'ig story'],
    tiktok: ['tiktok', 'tik tok', 'tiktok post', 'tiktok video', 'tiktok clip', 'post to tiktok', 'posting to tiktok', 'publish to tiktok', 'tiktok caption'],
    linkedin: ['linkedin', 'linked in', 'linkedin post', 'post to linkedin', 'posting to linkedin', 'publish to linkedin', 'linkedin article', 'linkedin update', 'linkedin company page'],
    youtube: ['youtube', 'you tube', 'youtube video', 'upload to youtube', 'youtube upload', 'youtube description', 'youtube title', 'youtube channel', 'youtube short'],

    roady: ['roadmap', 'stream', 'streams', 'priority', 'priorities', 'tier 1', 'tier 2', 'tier 3', 'phase', 'phases', 'what should i work on', 'what to work on', 'work on next', 'active streams', 'blocked streams', 'completed streams', 'depends on', 'dependency', 'dependencies', 'plan doc', 'plan document', 'stream plan', 'sprint', 'backlog', 'progress', 'phases done', 'effort', 'roadmap status', 'roadmap stats', 'strategic', 'which stream', 'show stream', 'move priority', 'update stream', 'add stream'],
    concierge: ['discord', 'discord pro', 'discord bot', 'discord channel', 'discord channels', 'discord binding', 'discord bindings', 'bind a channel', 'bind channel', 'unbind', 'unbind channel', 'channel bound', 'channel binding', 'bot not responding', 'bot is not responding', 'bot went quiet', 'bot isn\'t responding', 'bot silent', 'discord mode', 'binding mode', 'echo mode', 'quoxchat mode', 'roundtable mode', 'team mode', 'bridge mode', 'discord daemon', 'qdp', 'discord webhook', 'discord persona', 'view channel permission', 'bot permission', 'discord role permission'],
    // AQ-9D: NotesQ capture phrases. Overlapping entries are deliberate so a
    // capture ("jot this down", "write that down") outscores any single stray
    // keyword elsewhere; 'jot' is short so it matches on word boundaries.
    notesq: ['jot', 'jot down', 'jot this', 'jot that', 'write this down', 'write that down', 'write it down', 'take a note', 'make a note', 'note this', 'note that', 'my notes', 'notebook', 'meeting notes', 'save this to my notes', 'save to notes', 'notesq', 'a note'],
    // ContactsQ: people and address-book phrases only. Bare 'email', 'call',
    // 'text' and 'note' are deliberately absent so inboxq, notesq and the
    // voice/calendar agents keep their own domains.
    contactsq: ['contactsq', 'address book', 'my contacts', 'a contact', 'contact card', 'contact details', 'phone number for', 'phone number of', 'email address for', 'email address of', 'who is', 'do not call', 'do-not-call', 'dnc list', 'stop contacting', 'best way to reach', 'best channel', 'ring ', 'text ', 'gdpr', 'dsar', 'erase my data', 'erase this contact', 'right to erasure'],
    // INBOXQ-2 (per INBOXQ_AGENT_DESIGN.md section D): no customer-specific
    // words here (e.g. a sender name), core config stays generic.
    inboxq: ['inbox', 'email', 'emails', 'mailbox', 'sender', 'newsletter', 'unsubscribe', 'junk', 'spam', 'block sender', 'folder', 'file this', 'triage', 'sort my inbox', 'screened'],
    // AQ-9B L2-C1b: Calendar-Q. Deliberately phrases rather than the bare
    // words 'day'/'week' (substring match risk per the NUCLEUS comment
    // above - 'day' alone would route "today's status" and "yesterday's
    // logs" here too), except where the brief's own term is already long
    // enough to be safe ('calendar', 'agenda', 'clash').
    'calendar-q': ['calendar', 'agenda', 'schedule', 'scheduled', 'meeting', 'meetings', 'clash', 'clashes', 'double-booked', 'double booked', 'free/busy', 'free or busy', 'am i free', 'am i busy', 'what\'s on my calendar', 'whats on my calendar', 'this week\'s agenda', 'today\'s agenda', 'calendar layer', 'calendar layers', 'calendar coverage', 'calendar connection'],
    // GITQ Stream A: the GitQ onboarding concierge. Keywords are deliberately
    // onboarding/credential/indexing-specific and avoid forge's operational Git
    // vocabulary (issue/PR/CI/release) so routing does not steal Vulcan's work.
    gitq: ['connect my github', 'connect github', 'connect gitlab', 'connect gitea', 'connect a git provider', 'connect my git', 'connect my repository', 'onboard', 'onboarding', 'add a provider token', 'connect a provider token', 'provider token', 'set up my repos', 'index my repo', 'index this repo', 'index the repo', 'index the ', 'index a repo', 'reindex', 'which repos can you see', 'is my credential working', 'what git providers', 'connect my org']
  }
  // PSDK-3: Check plugin-registered keywords too
  return keywordMap[agentId] || _pluginKeywords.get(agentId) || []
}

// PSDK-3: Runtime keyword registration for plugin agents
const _pluginKeywords = new Map()
export function registerPluginKeywords(agentId, keywords) {
  _pluginKeywords.set(agentId, keywords)
}
export function unregisterPluginKeywords(agentId) {
  _pluginKeywords.delete(agentId)
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchesDomainKeyword(query, keyword) {
  if (keyword instanceof RegExp) return keyword.test(query)
  const normalized = (keyword || '').toLowerCase()
  if (!normalized) return false

  // Avoid accidental substring matches for tiny tokens like "PR".
  if (/^[a-z0-9]{1,3}$/i.test(normalized)) {
    return new RegExp(`\\b${escapeRegex(normalized)}\\b`, 'i').test(query)
  }

  return query.includes(normalized)
}

/**
 * Semantic routing confidence threshold.
 * Above this, semantic result is used directly without keyword fallback.
 */
const SEMANTIC_CONFIDENCE_THRESHOLD = 0.35
const SEMANTIC_OVERRIDE_CONFIDENCE_THRESHOLD = 0.55

/**
 * Select the best agent for a query.
 *
 * Uses a cascading approach:
 *   1. Check for explicit agent mention (e.g. "ask WARDEN")
 *   2. Try semantic routing (utterance-based similarity matching)
 *   3. Fall back to keyword scoring if semantic confidence is too low
 *
 * @param {string} query - The user query
 * @param {Object} options - Optional configuration
 * @param {boolean} [options.semantic] - Force semantic mode (transformer embeddings)
 * @returns {{ agentId: string, score: number, scores: Object, method: string }}
 */
export function selectAgent(query, options = {}) {
  const q = query.toLowerCase()

  // ── 1. Explicit agent mention (highest priority, always wins) ────────
  let agents
  try { agents = listAssistants() } catch { agents = getAllAgents() }
  if (_customAgentsCache.length > 0) {
    agents = [...agents, ..._customAgentsCache]
  }

  for (const agent of agents) {
    const agentName = (agent.name || agent.identity?.name || '').toLowerCase()
    const agentId = agent.id?.toLowerCase()
    // Word-boundary match, not substring: a plain q.includes(agentId) let
    // "explain the architecture of kubernetes" false-positive-match the
    // 'architect' agent (architecture contains architect as a prefix) and
    // silently swallow an unrelated query as an explicit mention — the
    // highest-priority, always-wins routing path. \b anchors require the
    // full name/id to appear as its own token.
    const nameMatches = agentName && new RegExp(`\\b${escapeRegex(agentName)}\\b`, 'i').test(q)
    const idMatches = agentId && new RegExp(`\\b${escapeRegex(agentId)}\\b`, 'i').test(q)
    if (agentId && agentId !== 'quox' && (nameMatches || idMatches)) {
      if (DELEGATION_CONFIG.logDelegations) {
        console.log(`[AgentDelegator] Explicit mention: ${agent.id}`)
      }
      return {
        agentId: agent.id,
        score: DELEGATION_CONFIG.explicitMentionBonus,
        scores: { [agent.id]: DELEGATION_CONFIG.explicitMentionBonus },
        shouldDelegate: true,
        method: 'explicit',
      }
    }
  }

  // ── 2. Semantic routing (utterance similarity) ───────────────────────
  // Read user preference for semantic mode
  let useSemantic = options.semantic
  if (useSemantic === undefined) {
    try {
      const settings = JSON.parse(localStorage.getItem('quox-settings') || '{}')
      useSemantic = settings.semanticRouting ?? false
    } catch {
      useSemantic = false
    }
  }

  const semanticResult = semanticRouteQuery(query, { semantic: useSemantic })
  const scores = {}
  for (const agent of agents) {
    scores[agent.id] = scoreAgentMatch(query, agent)
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const [bestId, bestScore] = sorted[0] || ['quox', 0]

  // If semantic routing is confident enough, use it. A confident verdict for
  // quox is a routing decision too (HITL/approval prompts route to the
  // orchestrator, which owns create_inbox_item); discarding it here let the
  // keyword fallback delegate those turns away.
  if (semanticResult.confidence >= SEMANTIC_CONFIDENCE_THRESHOLD) {
    const shouldPreferKeyword =
      semanticResult.confidence < SEMANTIC_OVERRIDE_CONFIDENCE_THRESHOLD &&
      bestId !== semanticResult.agentId &&
      bestScore >= DELEGATION_CONFIG.minimumScore

    if (shouldPreferKeyword) {
      if (DELEGATION_CONFIG.logDelegations) {
        console.log(
          `[AgentDelegator] Keyword override: ${bestId} (score: ${bestScore}) over semantic ` +
          `${semanticResult.agentId} (confidence: ${semanticResult.confidence.toFixed(3)}, method: ${semanticResult.method})`
        )
      }

      return {
        agentId: bestId,
        score: bestScore,
        scores,
        shouldDelegate: bestId !== 'quox',
        method: 'keyword-override',
        semanticCandidate: semanticResult.agentId,
        confidence: semanticResult.confidence,
        gap: semanticResult.gap,
      }
    }

    // Convert confidence (0-1) to score scale for compatibility
    const score = Math.round(semanticResult.confidence * 100)

    if (DELEGATION_CONFIG.logDelegations) {
      console.log(`[AgentDelegator] Semantic route: ${semanticResult.agentId} (confidence: ${semanticResult.confidence.toFixed(3)}, gap: ${semanticResult.gap.toFixed(3)}, method: ${semanticResult.method})`)
    }

    return {
      agentId: semanticResult.agentId,
      score,
      scores,
      shouldDelegate: semanticResult.agentId !== 'quox',
      method: semanticResult.method,
      confidence: semanticResult.confidence,
      gap: semanticResult.gap,
      alternatives: semanticResult.alternatives,
    }
  }

  // ── 3. Keyword scoring fallback ──────────────────────────────────────
  if (DELEGATION_CONFIG.logDelegations) {
    console.log(`[AgentDelegator] Keyword fallback for "${query.slice(0, 50)}...": ${bestId} (score: ${bestScore})`)
  }

  return {
    agentId: bestScore >= DELEGATION_CONFIG.minimumScore ? bestId : 'quox',
    score: bestScore,
    scores,
    shouldDelegate: bestScore >= DELEGATION_CONFIG.minimumScore && bestId !== 'quox',
    method: 'keyword',
  }
}

/**
 * Build the system prompt for a delegated agent
 * @param {Object} agent - Agent manifest from entityRegistry
 * @returns {string} - Full system prompt with identity and context
 */
function buildAgentSystemPrompt(agent) {
  // Get self-knowledge markdown
  let selfKnowledge = ''
  try {
    selfKnowledge = generateSelfKnowledge(agent.id)
  } catch (err) {
    console.warn(`[AgentDelegator] Could not generate self-knowledge for ${agent.id}:`, err)
  }

  // Build personality section
  const personality = agent.identity?.personality || {}
  const personalitySection = personality.tone ? `
## Your Personality
- **Tone:** ${personality.tone}
- **Style:** ${personality.style || 'professional'}
- **Traits:** ${(personality.traits || []).join(', ')}
${personality.catchphrases?.length ? `\nSignature phrases you may use:\n${personality.catchphrases.map(p => `- "${p}"`).join('\n')}` : ''}
` : ''

  // Build rules section
  const rules = agent.rules || {}
  const rulesSection = rules.always?.length ? `
## Your Rules
**ALWAYS:**
${rules.always.map(r => `- ${r}`).join('\n')}

**NEVER:**
${(rules.never || []).map(r => `- ${r}`).join('\n')}
${rules.escalateTo ? `\n**Escalate to ${rules.escalateTo.agent?.toUpperCase() || 'QUOX'} when:**\n${(rules.escalateTo.when || []).map(t => `- ${t}`).join('\n')}` : ''}
` : ''

  // Combine into full system prompt
  const agentName = agent.identity?.name || agent.name || agent.id.toUpperCase()
  const tagline = agent.identity?.tagline || agent.tagline || ''

  return `You are ${agentName}, ${tagline}.

${selfKnowledge}

${personalitySection}

${rulesSection}

${agent.context?.systemPromptAdditions || ''}

---
Respond in character as ${agentName}. Your responses should reflect your personality and domain expertise.
`.trim()
}

/**
 * DEPRECATED: Tool detection moved to proper tool registry system.
 *
 * Tools should be invoked through:
 * 1. Agent-assigned tools from tool_installations table
 *
 * This stub remains for backward compatibility during migration.
 * @deprecated Use tool registry system instead
 */
export function detectToolInvocation(query) {
  // Return no match - tool detection is now handled by the proper registry
  return { shouldExecute: false, toolId: null, params: {}, agentId: null }
}

/**
 * DEPRECATED: Tool execution moved to proper tool registry system.
 *
 * For tools, use the tool-catalog.js execution endpoints.
 *
 * This stub remains for backward compatibility during migration.
 * @deprecated Use tool catalog API instead
 */
export async function executeAgentTool(toolId, params, agentId, context = {}) {
  console.warn(`[AgentDelegator] executeAgentTool is deprecated. Use tool catalog API instead.`)
  return {
    success: false,
    error: 'Tool execution has been moved to the proper tool registry system. Use tool catalog API.'
  }
}

/**
 * DEPRECATED: Tool result formatting removed.
 * Each tool formats its own output appropriately.
 * @deprecated Use tool catalog responses
 */

/**
 * Read a chat response honestly.
 *
 * An error body is not data. Calling response.json() before checking the
 * status turns "the endpoint is not routed" into "SyntaxError: Unexpected
 * token '<'", which told the user nothing and rendered as a permanently
 * empty chat bubble (GTM-A1/B1, live audit 2026-09-16).
 *
 * Check the status, then the content type, and only then parse.
 *
 * @param {Response} response - the fetch response
 * @param {string} label - what was being called, for the error text
 * @returns {Promise<Object>} the parsed JSON body
 * @throws {Error} with a message naming the actual failure
 */
async function readChatResponse(response, label) {
  if (!response.ok) {
    let detail = ''
    try {
      detail = (await response.text() || '').replace(/\s+/g, ' ').trim().slice(0, 160)
    } catch { /* body already consumed or unreadable: the status still stands */ }
    const statusText = response.statusText ? ` ${response.statusText}` : ''
    const err = new Error(
      `${label} returned HTTP ${response.status}${statusText}${detail ? `: ${detail}` : ''}`
    )
    err.httpStatus = response.status
    throw err
  }

  const contentType = response.headers?.get?.('content-type') || ''
  if (contentType && !contentType.includes('json')) {
    const err = new Error(
      `${label} returned ${contentType} instead of JSON (HTTP ${response.status})`
    )
    err.httpStatus = response.status
    throw err
  }

  try {
    return await response.json()
  } catch {
    const err = new Error(
      `${label} returned a body that is not valid JSON (HTTP ${response.status})`
    )
    err.httpStatus = response.status
    throw err
  }
}

/**
 * Delegate a query to an agent and get the response
 * @param {string} query - The user query
 * @param {Object} context - Context including sessionId, etc.
 * @returns {Promise<Object>} - Delegation result
 */
export async function delegateToAgent(query, context = {}) {
  const { sessionId, voiceMode = 'hal', memoryContext = '' } = context

  // NOTE: Tool invocation is now handled through the proper tool registry system.
  // Tools are assigned to agents and invoked via the tool catalog API.

  // Refresh custom agent cache (non-blocking if still fresh)
  await refreshCustomAgents()

  // 1. Select the best agent
  const selection = selectAgent(query)

  if (!selection.shouldDelegate) {
    // Don't delegate - let Quox handle it
    logDelegationFallback(query, selection.scores, context.corr)
    return {
      delegated: false,
      agentId: 'quox',
      reason: 'no-suitable-agent'
    }
  }

  const agentId = selection.agentId

  // MR-4: Mirror-aware health check — warn if system is degraded
  let mirrorWarning = null
  try {
    const mirror = await getFullIndex()
    if (mirror?.core?.health < 50) {
      mirrorWarning = `System health is ${mirror.core.health}% — responses may be degraded.`
    }
    // Check if the agent's key implants are healthy
    const agentImplantMap = {
      sentinel: 'quox-guard', cipher: 'quox-guard', nova: 'quox-executive',
      atlas: 'quox-executive', metrics: 'quox-insight', beacon: 'quox-guard',
      prism: 'quox-insight', corey: 'quox-sense', auditus: 'quox-guard',
    }
    const implantId = agentImplantMap[agentId]
    // QMH-5/1: 'unreachable' and 'down' are the new honest equivalents of
    // the legacy single-axis 'offline'. Any of them implies the agent's
    // backing implant cannot answer queries right now.
    const implantStatus = implantId ? mirror?.implants?.[implantId]?.status : null
    if (implantStatus === 'offline' || implantStatus === 'unreachable' || implantStatus === 'down') {
      mirrorWarning = `${mirror.implants[implantId].name} implant is ${implantStatus} — ${agentId.toUpperCase()} may have reduced capability.`
    }
  } catch { /* Mirror unavailable — non-blocking */ }

  // ====================================================================
  // Custom agent path — send directly to the canonical collector chat endpoint
  // The collector handles custom agent prompts + tool resolution via
  // the auth service internal API (getToolsForAgentAsync).
  // ====================================================================
  if (isCustomAgent(agentId)) {
    const customAgent = _customAgentsCache.find(a => a.id === agentId)
    const agentName = customAgent?.name || agentId.toUpperCase()
    const customAgentLlm = customAgent?.llm || DEFAULT_LLM_CONFIG

    if (DELEGATION_CONFIG.logDelegations) {
      console.log(`[AgentDelegator] Delegating to custom agent ${agentName} (${agentId})`)
    }

    try {
      const response = await fetch(`${COLLECTOR_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(180000),
        body: JSON.stringify({
          prompt: query,
          session_id: sessionId,
          voice_mode: voiceMode,
          selected_agent: agentId,
          provider: customAgentLlm.provider,
          model: customAgentLlm.model,
          memory_context: memoryContext,
          delegated_from: 'quox'
        })
      })

      const data = await readChatResponse(response, `${agentName} chat endpoint`)
      let responseText = data.result || data.error || 'No response received.'

      if (DELEGATION_CONFIG.attributeResponses && !responseText.startsWith(`[${agentName}]`)) {
        responseText = `[${agentName}] ${responseText}`
      }

      logDelegationRouted(query, agentId, selection.score, selection.scores, context.corr)

      return {
        delegated: true,
        agentId,
        agentName,
        response: responseText,
        score: selection.score,
        sessionId: data.session_id,
        voiceSummary: data.voice_summary,
        cost: data.cost_usd || 0,
        raw: data
      }
    } catch (err) {
      console.error(`[AgentDelegator] Custom agent delegation to ${agentId} failed:`, err)
      return {
        delegated: false,
        agentId,
        agentName,
        error: err.message,
        reason: 'api-error',
        userMessage: `${agentName} could not answer: ${err.message}`
      }
    }
  }

  // ====================================================================
  // Core agent path — load manifest from entityRegistry, send to collector
  // ====================================================================

  // 2. Load agent manifest
  const agent = getAssistant(agentId)
  if (!agent) {
    console.warn(`[AgentDelegator] Agent ${agentId} not found in registry`)
    return {
      delegated: false,
      agentId: 'quox',
      reason: 'agent-not-found'
    }
  }

  // 3. Build agent-specific system prompt
  const systemPrompt = buildAgentSystemPrompt(agent)

  if (DELEGATION_CONFIG.logDelegations) {
    const agentName = agent.identity?.name || agent.name || agentId
    console.log(`[AgentDelegator] Delegating to ${agentName} with ${systemPrompt.length} char system prompt`)
  }

  // 4. Make the LLM call with agent context
  const agentName = agent.identity?.name || agent.name || agentId.toUpperCase()

  try {
    const agentLlm = getRuntimeAssistantConfig(agentId)?.llm || DEFAULT_LLM_CONFIG
    const response = await fetch(`${COLLECTOR_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: query,
        session_id: sessionId,
        voice_mode: voiceMode,
        selected_agent: agentId,
        system_prompt: systemPrompt,
        memory_context: memoryContext,
        provider: agentLlm.provider,
        model: agentLlm.model,
        // Flag this as a delegated call
        delegated_from: 'quox'
      })
    })

    const data = await readChatResponse(response, `${agentName} chat endpoint`)

    // 5. Format response with agent attribution
    let responseText = data.result || data.error || 'No response received.'

    if (DELEGATION_CONFIG.attributeResponses && !responseText.startsWith(`[${agentName}]`)) {
      responseText = `[${agentName}] ${responseText}`
    }

    logDelegationRouted(query, agentId, selection.score, selection.scores, context.corr)

    return {
      delegated: true,
      agentId,
      agentName,
      response: mirrorWarning ? `> ⚠ ${mirrorWarning}\n\n${responseText}` : responseText,
      score: selection.score,
      sessionId: data.session_id,
      voiceSummary: data.voice_summary,
      cost: data.cost_usd || 0,
      mirrorWarning: mirrorWarning || null,
      raw: data
    }
  } catch (err) {
    console.error(`[AgentDelegator] Delegation to ${agentId} failed:`, err)
    return {
      delegated: false,
      agentId,
      agentName,
      error: err.message,
      reason: 'api-error',
      // Carried to the chat surface so a failed delegation reads as an error
      // rather than an empty bubble (GTM-A1/B1).
      userMessage: `${agentName} could not answer: ${err.message}`
    }
  }
}

/**
 * Generate a directory of all agents with their capabilities
 * Useful for Quox's self-awareness about available agents
 */
export function generateAgentDirectory() {
  const agents = listAssistants()
  const directory = []

  for (const agent of agents) {
    const id = agent.id
    const name = agent.identity?.name || agent.name || id
    const role = agent.hierarchy?.role || agent.role || 'specialist'
    const level = agent.hierarchy?.level ?? agent.level ?? 1
    const domain = agent.domain || agent.capabilities?.domains?.[0] || 'general'
    const description = agent.identity?.description || agent.description || ''
    const capabilities = agent.capabilities?.domains ||
                        (Array.isArray(agent.capabilities) ? agent.capabilities : [])
    const collaboratesWith = agent.hierarchy?.collaboratesWith || []
    const reportsTo = agent.hierarchy?.reportsTo || agent.reportsTo

    directory.push({
      id,
      name,
      role,
      level,
      domain,
      description,
      capabilities: capabilities.slice(0, 5),
      collaboratesWith,  // FLAT hierarchy - collaboration instead of management
      reportsTo,
      suggestions: agent.suggestions || []
    })
  }

  return directory
}

/**
 * Generate Quox's awareness of all agents for system prompt injection
 * This helps Quox know who it can delegate to and what each agent handles
 * FLAT hierarchy - all agents report directly to QUOX
 */
export function generateQuoxAgentAwareness() {
  const directory = generateAgentDirectory()

  // Count agents (excluding quox)
  const coreAgents = directory.filter(a => a.id !== 'quox')

  let awareness = `## Your Agent Team

You are CommanderQ, the master orchestrator. You directly coordinate ${coreAgents.length} specialized agents.
All agents report to you - there is no manager sub-hierarchy.

### Core Agents (Level 1)

`

  // Sort by role: managers first, then analysts, then specialists
  const roleOrder = { manager: 0, analyst: 1, specialist: 2 }
  coreAgents.sort((a, b) => {
    const aOrder = roleOrder[a.role] ?? 99
    const bOrder = roleOrder[b.role] ?? 99
    if (aOrder !== bOrder) return aOrder - bOrder
    return a.name.localeCompare(b.name)
  })

  // List all agents with their domains and capabilities
  for (const agent of coreAgents) {
    const roleLabel = agent.role === 'manager' ? '[Domain Expert]' :
                      agent.role === 'analyst' ? '[Analyst]' : '[Specialist]'
    awareness += `**${agent.name}** ${roleLabel} - ${agent.domain}\n`
    awareness += `> ${agent.description.slice(0, 100)}${agent.description.length > 100 ? '...' : ''}\n`
    awareness += `- Capabilities: ${agent.capabilities.join(', ')}\n`
    if (agent.collaboratesWith?.length > 0) {
      awareness += `- Collaborates with: ${agent.collaboratesWith.join(', ')}\n`
    }
    awareness += `\n`
  }

  // Include custom agents if any are cached
  if (_customAgentsCache.length > 0) {
    awareness += `### Custom Agents (DB-defined)\n\n`
    for (const agent of _customAgentsCache) {
      awareness += `**${agent.name}** [Custom L${agent.level}] - ${(agent.capabilities || []).join(', ') || 'general'}\n`
      awareness += `> ${(agent.description || '').slice(0, 100)}\n`
      awareness += `- Domains: ${(agent.capabilities || []).join(', ')}\n\n`
    }
  }

  awareness += `## Delegation Guidelines

All delegation flows through you (QUOX). Agents do not delegate to each other directly.

When a user query matches an agent's domain, delegate to that agent:
- Security queries → WARDEN
- DevOps/deployments → DAEDALUS
- Network queries → CIPHER
- Analysis tasks → PRISM
- VM/Proxmox queries → HYPERION
- Metrics/monitoring → METRICS
- Dashboards → INSIGHT
- Research → SCHOLAR
- Uptime/SLA → VIGIL
- GitHub operations → VULCAN
- File operations → ARCHIVIST
- Core introspection → COREY
- Testing/QA → TESTER
- Image generation → NANOBANANA
- Code review/synthesis/second opinion → GEMINI
- Web research/fact-checking/citations → PERPLEXITY
${_customAgentsCache.map(a => `- ${(a.capabilities || []).join('/')} queries → ${a.name}`).join('\n')}

When delegating, acknowledge it: "Routing to [AGENT] for [domain] expertise..."

### Agentic Teams
${Object.entries(getBuiltInTeams()).map(([id, t]) => `- **${t.displayName}** (\`${id}\`): ${getTeamMemberIds(id).join(', ')}`).join('\n')}

When a user mentions a team, prioritize agents that are members of that team.

If unsure which agent should handle a query, you (QUOX) handle it as the orchestrator.
`

  return awareness
}

/**
 * Check if a query should be delegated (quick check without making API call)
 * @param {string} query - The user query
 * @returns {{ shouldDelegate: boolean, agentId: string, score: number }}
 */
export function shouldDelegate(query) {
  const selection = selectAgent(query)
  return {
    shouldDelegate: selection.shouldDelegate,
    agentId: selection.agentId,
    score: selection.score
  }
}

// Export the enhanced agent selector
export const getRecommendedAgent = (query) => selectAgent(query).agentId

/**
 * Get delegation system stats (includes semantic router info).
 */
export function getDelegationStats() {
  return {
    semanticRouter: getRouterStats(),
    semanticModelReady: isModelReady(),
    customAgentCount: _customAgentsCache.length,
  }
}

export default {
  delegateToAgent,
  selectAgent,
  shouldDelegate,
  getRecommendedAgent,
  generateAgentDirectory,
  generateQuoxAgentAwareness,
  refreshCustomAgents,
  getCustomAgents,
  getDelegationStats,
  // DEPRECATED: Tool detection stubs (kept for backward compatibility)
  detectToolInvocation,
  executeAgentTool,
  DELEGATION_CONFIG
}
