/**
 * NOC Outcome Recorder (NQ-5)
 *
 * Lightweight recorder for NOC tool execution outcomes.
 * Stores results in the collector's SQLite database for QuoxMind analysis.
 * Non-blocking — recording failures never affect tool execution.
 */

let _db = null
let _tableReady = false

/**
 * Set the database reference (called from server.js init).
 */
function setDatabase(db) {
  _db = db
}

/**
 * Ensure the noc_tool_outcomes table exists.
 */
function ensureTable() {
  if (_tableReady || !_db) return
  try {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS noc_tool_outcomes (
        id TEXT PRIMARY KEY,
        org_id TEXT,
        tool_name TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 1,
        duration_ms INTEGER DEFAULT 0,
        error TEXT,
        agent_id TEXT,
        user_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_noc_outcomes_tool ON noc_tool_outcomes(tool_name);
      CREATE INDEX IF NOT EXISTS idx_noc_outcomes_org ON noc_tool_outcomes(org_id);
      CREATE INDEX IF NOT EXISTS idx_noc_outcomes_created ON noc_tool_outcomes(created_at);
    `)
    _tableReady = true
  } catch (err) {
    console.warn('[NOC Outcomes] Table creation failed:', err.message)
  }
}

/**
 * NOC tool name prefixes that should be recorded.
 */
const NOC_TOOL_PREFIXES = [
  'docker_fleet_', 'docker_status', 'docker_extended',
  'proxmox_', 'prometheus_', 'grafana_',
  'security_audit', 'ssl_certificates',
  'metrics_query', 'alerts_manage',
  'fleet_status', 'fleet_',
  'ssh_exec', 'network_check',
  'mikrotik_', 'tailscale_',
  'wazuh_', 'uptime_',
]

/**
 * Check if a tool name is a NOC tool.
 */
function isNocTool(toolName) {
  if (!toolName) return false
  return NOC_TOOL_PREFIXES.some(prefix => toolName.startsWith(prefix))
}

/**
 * Record the outcome of a NOC tool execution.
 * Non-blocking — silently drops if DB unavailable.
 *
 * @param {string} toolName - Tool identifier
 * @param {boolean} success - Whether the tool succeeded
 * @param {number} durationMs - Execution time in ms
 * @param {object} opts - Additional context
 */
function recordNocOutcome(toolName, success, durationMs, opts = {}) {
  if (!_db || !isNocTool(toolName)) return

  try {
    ensureTable()
    if (!_tableReady) return

    const id = `NOC_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    _db.prepare(`
      INSERT INTO noc_tool_outcomes (id, org_id, tool_name, success, duration_ms, error, agent_id, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      opts.orgId || null,
      toolName,
      success ? 1 : 0,
      durationMs || 0,
      opts.error ? String(opts.error).substring(0, 500) : null,
      opts.agentId || null,
      opts.userId || null
    )
  } catch (err) {
    // Non-blocking — never fail tool execution due to recording
  }
}

/**
 * Valid time windows for stats aggregation (mirrors the agh-chain
 * leaderboard convention — see lib/chainGuards/honestyRollup.js).
 */
const STATS_WINDOW_MS = {
  '1h': 3600e3,
  '24h': 24 * 3600e3,
  '7d': 7 * 24 * 3600e3,
  '30d': 30 * 24 * 3600e3,
}

const VALID_STATS_WINDOWS = Object.keys(STATS_WINDOW_MS)

/**
 * List recent NOC tool outcomes, optionally filtered.
 * Read-only consumer for the previously write-only noc_tool_outcomes table.
 *
 * @param {object} filters
 * @param {string} [filters.tool] - exact tool_name match
 * @param {string} [filters.agent] - exact agent_id match
 * @param {string} [filters.orgId] - exact org_id match
 * @param {boolean} [filters.success] - filter by success/failure
 * @param {string} [filters.since] - ISO timestamp lower bound (created_at >=)
 * @param {number} [filters.limit] - max rows (default 50)
 * @param {number} [filters.offset] - pagination offset (default 0)
 */
function listOutcomes(filters = {}) {
  const empty = { count: 0, total: 0, outcomes: [] }
  if (!_db) return empty

  ensureTable()
  if (!_tableReady) return empty

  const { tool, agent, orgId, success, since } = filters
  const limit = Math.min(Math.max(parseInt(filters.limit, 10) || 50, 1), 500)
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0)

  const clauses = []
  const params = []
  if (tool) { clauses.push('tool_name = ?'); params.push(tool) }
  if (agent) { clauses.push('agent_id = ?'); params.push(agent) }
  if (orgId) { clauses.push('org_id = ?'); params.push(orgId) }
  if (typeof success === 'boolean') { clauses.push('success = ?'); params.push(success ? 1 : 0) }
  if (since) { clauses.push('created_at >= ?'); params.push(since) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''

  try {
    const total = _db.prepare(`SELECT COUNT(*) as c FROM noc_tool_outcomes ${where}`).get(...params).c

    const rows = _db.prepare(`
      SELECT id, org_id, tool_name, success, duration_ms, error, agent_id, user_id, created_at
      FROM noc_tool_outcomes
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset)

    const outcomes = rows.map(r => ({ ...r, success: !!r.success }))
    return { count: outcomes.length, total, outcomes }
  } catch (err) {
    console.warn('[NOC Outcomes] listOutcomes failed:', err.message)
    return empty
  }
}

/**
 * Per-tool success rate / avg duration / error counts over a rolling window.
 * Turns "which tools are failing / slow / flaky" into queryable ops signal.
 *
 * @param {object} opts
 * @param {string} [opts.window] - one of VALID_STATS_WINDOWS (default '24h')
 * @param {string} [opts.tool] - restrict to a single tool
 * @param {string} [opts.agent] - restrict to a single agent
 * @param {string} [opts.orgId] - restrict to a single org
 */
function getStats(opts = {}) {
  const window = VALID_STATS_WINDOWS.includes(opts.window) ? opts.window : '24h'
  const empty = { window, tools: [], computed_at: new Date().toISOString() }
  if (!_db) return empty

  ensureTable()
  if (!_tableReady) return empty

  const sinceIso = new Date(Date.now() - STATS_WINDOW_MS[window]).toISOString()
  const clauses = ['created_at >= ?']
  const params = [sinceIso]
  if (opts.tool) { clauses.push('tool_name = ?'); params.push(opts.tool) }
  if (opts.agent) { clauses.push('agent_id = ?'); params.push(opts.agent) }
  if (opts.orgId) { clauses.push('org_id = ?'); params.push(opts.orgId) }
  const where = `WHERE ${clauses.join(' AND ')}`

  try {
    const rows = _db.prepare(`
      SELECT
        tool_name,
        COUNT(*) as total,
        SUM(success) as successes,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as errors,
        AVG(duration_ms) as avg_duration_ms,
        MAX(duration_ms) as max_duration_ms
      FROM noc_tool_outcomes
      ${where}
      GROUP BY tool_name
      ORDER BY total DESC
    `).all(...params)

    const tools = rows.map(r => ({
      tool_name: r.tool_name,
      total: r.total,
      successes: r.successes || 0,
      errors: r.errors || 0,
      success_rate: r.total > 0 ? (r.successes || 0) / r.total : 1,
      avg_duration_ms: r.avg_duration_ms != null ? Math.round(r.avg_duration_ms) : 0,
      max_duration_ms: r.max_duration_ms || 0,
    }))

    return { window, since: sinceIso, tools, computed_at: new Date().toISOString() }
  } catch (err) {
    console.warn('[NOC Outcomes] getStats failed:', err.message)
    return empty
  }
}

module.exports = {
  setDatabase,
  recordNocOutcome,
  isNocTool,
  NOC_TOOL_PREFIXES,
  listOutcomes,
  getStats,
  VALID_STATS_WINDOWS,
}
