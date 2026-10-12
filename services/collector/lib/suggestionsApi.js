/**
 * suggestionsApi.js — Quox Brain suggestions route handlers
 *
 * Mounts:
 *   GET  /api/suggestions/list?orgId=:id   → ranked top-3 active suggestions
 *   POST /api/suggestions/dismiss           → write 7-day dismissal
 *
 * Context gathering is intentionally simple: we query the local SQLite DB
 * (envelopes, objectives) and build a ctx object for runAllRules. Data that
 * doesn't exist yet (e.g. tool cost rows) returns empty arrays gracefully.
 */

const { runAllRules } = require('./quoxBrainRules/index');
const {
  initSuggestionDismissals,
  dismissSuggestion,
  filterDismissed,
} = require('./suggestionDismissals');

const TOP_N = 3;

/**
 * Initialize the dismissals table. Call once at server startup with the
 * shared DB instance.
 *
 * @param {import('better-sqlite3').Database} db
 */
function initSuggestionsApi(db) {
  initSuggestionDismissals(db);
}

// ── Context builders ────────────────────────────────────────────────────────
// Each builder queries the SQLite DB and returns data needed by the rules.
// They fail gracefully (return []) if the table doesn't exist yet.

function safeAll(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function safeGet(db, sql, params = []) {
  try {
    return db.prepare(sql).get(...params);
  } catch {
    return null;
  }
}

/**
 * Build the rule context for a given org.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} orgId
 * @param {string} tier  e.g. 'tier_free' | 'tier_b' | 'tier_a'
 */
function buildContext(db, orgId, tier) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  // --- recentRuns (from envelopes table: workflow execution intents) ---
  const recentRuns = safeAll(db, `
    SELECT
      json_extract(payload, '$.workflow_id')   AS workflow_id,
      json_extract(payload, '$.workflow_name') AS workflow_name,
      json_extract(payload, '$.status')        AS status,
      ts AS started_at
    FROM envelopes
    WHERE org_id = ?
      AND ts >= ?
      AND (intent = 'quox.workflow.completed' OR intent = 'quox.workflow.failed' OR intent = 'quox.workflow.run')
    ORDER BY ts DESC
    LIMIT 200
  `, [orgId, sevenDaysAgo]);

  // --- crystals (from envelopes: crystal created/promoted) ---
  const crystals = safeAll(db, `
    SELECT
      json_extract(payload, '$.source_workflow_id') AS source_workflow_id,
      json_extract(payload, '$.id')                  AS id
    FROM envelopes
    WHERE org_id = ?
      AND intent IN ('quox.crystal.created', 'quox.crystal.promoted', 'quox.crystal.canonicalised')
  `, [orgId]);

  // --- agents (from envelopes: distinct agent ids seen) ---
  const agentRows = safeAll(db, `
    SELECT DISTINCT
      json_extract(payload, '$.agent_id')   AS id,
      json_extract(payload, '$.agent_name') AS name
    FROM envelopes
    WHERE org_id = ?
      AND json_extract(payload, '$.agent_id') IS NOT NULL
  `, [orgId]);
  const agents = agentRows.filter((a) => a.id);

  // --- recentInvocations (agent usage in last 30d) ---
  const recentInvocations = safeAll(db, `
    SELECT
      json_extract(payload, '$.agent_id') AS agent_id,
      ts AS invoked_at
    FROM envelopes
    WHERE org_id = ?
      AND ts >= ?
      AND json_extract(payload, '$.agent_id') IS NOT NULL
      AND intent LIKE 'quox.agent.%'
  `, [orgId, thirtyDaysAgo]);

  // --- objectives (open objectives) ---
  const objectives = safeAll(db, `
    SELECT
      json_extract(payload, '$.id')         AS id,
      json_extract(payload, '$.title')      AS title,
      json_extract(payload, '$.status')     AS status,
      min(ts)                               AS created_at
    FROM envelopes
    WHERE org_id = ?
      AND intent = 'quox.objective.created'
    GROUP BY json_extract(payload, '$.id')
  `, [orgId]);

  // Mark objectives as open/closed based on latest event
  const closedObjectiveIds = new Set(
    safeAll(db, `
      SELECT DISTINCT json_extract(payload, '$.id') AS id
      FROM envelopes
      WHERE org_id = ?
        AND intent IN ('quox.objective.closed', 'quox.objective.completed')
    `, [orgId]).map((r) => r.id),
  );

  const openObjectives = objectives.map((o) => ({
    ...o,
    status: closedObjectiveIds.has(o.id) ? 'closed' : 'open',
  }));

  // --- progressEnvelopes (objective activity in last 48h) ---
  const progressEnvelopes = safeAll(db, `
    SELECT
      json_extract(payload, '$.id') AS objective_id,
      ts
    FROM envelopes
    WHERE org_id = ?
      AND ts >= ?
      AND intent LIKE 'quox.objective.%'
  `, [orgId, fortyEightHoursAgo]);

  // --- toolCosts (tool cost tracking from envelopes) ---
  // We compute today's cost vs 7d average per tool from tool execution envelopes
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartIso = todayStart.toISOString();

  const toolCostRows = safeAll(db, `
    SELECT
      json_extract(payload, '$.tool_name')  AS tool_name,
      json_extract(payload, '$.workflow_id') AS workflow_id,
      json_extract(payload, '$.cost_usd')   AS cost_usd,
      ts
    FROM envelopes
    WHERE org_id = ?
      AND ts >= ?
      AND intent = 'quox.tool.executed'
      AND json_extract(payload, '$.cost_usd') IS NOT NULL
  `, [orgId, sevenDaysAgo]);

  const toolCostMap = new Map();
  for (const row of toolCostRows) {
    const key = row.tool_name;
    if (!key) continue;
    if (!toolCostMap.has(key)) {
      toolCostMap.set(key, { tool_name: key, workflow_id: row.workflow_id, costs_7d: [], today_costs: [] });
    }
    const entry = toolCostMap.get(key);
    entry.costs_7d.push(Number(row.cost_usd) || 0);
    if (row.ts >= todayStartIso) {
      entry.today_costs.push(Number(row.cost_usd) || 0);
    }
  }

  const toolCosts = Array.from(toolCostMap.values()).map((t) => ({
    tool_name: t.tool_name,
    workflow_id: t.workflow_id,
    today_cost: t.today_costs.reduce((a, b) => a + b, 0),
    avg_7d_cost: t.costs_7d.length > 0 ? t.costs_7d.reduce((a, b) => a + b, 0) / 7 : 0,
  }));

  // --- crystalCandidates (workflows near canonicalisation) ---
  const crystalCandidates = safeAll(db, `
    SELECT
      json_extract(payload, '$.id')                  AS id,
      json_extract(payload, '$.name')                AS name,
      json_extract(payload, '$.consecutive_success') AS consecutive_success,
      'candidate'                                    AS status
    FROM envelopes
    WHERE org_id = ?
      AND intent = 'quox.crystal.candidate.updated'
      AND json_extract(payload, '$.consecutive_success') >= 2
  `, [orgId]);

  return {
    orgId,
    tier,
    recentRuns,
    crystals,
    agents,
    recentInvocations,
    objectives: openObjectives,
    progressEnvelopes,
    toolCosts,
    crystalCandidates,
    windowMs: 7 * 24 * 60 * 60 * 1000,
  };
}

// ── Route handlers ──────────────────────────────────────────────────────────

/**
 * GET /api/suggestions/list?orgId=:id&tier=:tier
 *
 * Returns top-3 active (non-dismissed) suggestions ranked by score.
 */
function handleListSuggestions(db) {
  return async (req, res) => {
    const orgId = req.query.orgId || req.query.org_id || '';
    const tier = req.query.tier || 'tier_free';

    if (!orgId) {
      return res.status(400).json({ error: 'missing_org_id', message: 'orgId is required' });
    }

    try {
      const ctx = buildContext(db, orgId, tier);
      const allSuggestions = runAllRules(ctx);
      const active = filterDismissed(db, orgId, allSuggestions);
      const top = active.slice(0, TOP_N);

      return res.json({ suggestions: top, total: active.length });
    } catch (err) {
      console.error('[Suggestions] List error:', err.message);
      return res.status(500).json({ error: 'internal_error', message: err.message });
    }
  };
}

/**
 * POST /api/suggestions/dismiss
 * Body: { orgId, userId, suggestionId }
 */
function handleDismissSuggestion(db) {
  return async (req, res) => {
    const { orgId, org_id, userId, user_id, suggestionId, suggestion_id } = req.body || {};
    const resolvedOrgId = orgId || org_id || '';
    const resolvedUserId = userId || user_id || '';
    const resolvedSuggestionId = suggestionId || suggestion_id || '';

    if (!resolvedOrgId || !resolvedSuggestionId) {
      return res.status(400).json({
        error: 'missing_fields',
        message: 'orgId and suggestionId are required',
      });
    }

    try {
      dismissSuggestion(db, {
        orgId: resolvedOrgId,
        userId: resolvedUserId,
        suggestionId: resolvedSuggestionId,
      });
      return res.json({ ok: true, dismissed: resolvedSuggestionId });
    } catch (err) {
      console.error('[Suggestions] Dismiss error:', err.message);
      return res.status(500).json({ error: 'internal_error', message: err.message });
    }
  };
}

/**
 * Mount suggestion routes onto an Express app.
 *
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {Function} requireAuth  — auth middleware factory (call with no args)
 */
function mountSuggestionsRoutes(app, db, requireAuth) {
  initSuggestionsApi(db);

  app.get('/api/suggestions/list', requireAuth(), handleListSuggestions(db));
  app.post('/api/suggestions/dismiss', requireAuth(), handleDismissSuggestion(db));
}

module.exports = {
  initSuggestionsApi,
  mountSuggestionsRoutes,
  buildContext,         // exported for testing
  handleListSuggestions,
  handleDismissSuggestion,
};
