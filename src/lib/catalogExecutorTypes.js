/**
 * catalogExecutorTypes.js — Executor-type derivation for catalog entries.
 *
 * Derives executor_type from a tool's subcategory + reference URL.
 * Used by:
 *   - ToolDetailView (CTA gating + button copy)
 *   - ToolCard / ToolsView (deployable indicator on cards)
 *   - Quartermaster search results (via auth-side mirror in toolCatalogIndex.js)
 *
 * When a new executor type ships (e.g. POWERS-API for http_api), update isDeployable().
 */

/**
 * Derive executor_type from a catalog entry.
 *
 * Returns one of:
 *   'mcp_hosted'   — MCP server with a cloneable GitHub repo
 *   'mcp_endpoint' — MCP server exposed as a remote endpoint
 *   'http_api'     — Public/REST API reference entry. No executor exists for
 *                    this type (POWERS-API never shipped) — discovery-only,
 *                    never actionable/deployable. See TOOLS-FINISH T2.
 *   'catalog'      — Legacy concept, no deploy path
 *   'native'       — In-process tool, not deployable
 *   'toolsmith'    — Toolsmith-authored tool, not deployable via catalog
 *   null           — Browse-only; no deploy path available
 *
 * @param {object|null} tool
 * @returns {string|null}
 */
export function deriveExecutorType(tool) {
  if (!tool) return null;

  // Hand-curated entries with explicit executor_type already set (original 69)
  if (tool.executor_type) return tool.executor_type;

  const ref = tool.reference;
  const sub = tool.subcategory;

  // MCP servers — three detection paths:
  //   1. densified catalog uses subcategory='mcp-server'
  //   2. hand-curated original entries use subcategory='mcp'
  //   3. some hand-curated entries (e.g. Slack Messaging, GitHub MCP Tool) use
  //      function-domain subcategories ('communication', 'dev') but their reference
  //      URL contains 'mcp' (slack-mcp-server, github-mcp-server, etc.) — those
  //      are real MCP servers and should be deployable
  const isGithubRef = ref?.includes('github.com/');
  const refLooksLikeMcpRepo = isGithubRef && /\/[^/]*mcp[^/]*$|\/[^/]*mcp[^/]*\//i.test(ref);
  if (isGithubRef && (sub === 'mcp-server' || sub === 'mcp' || refLooksLikeMcpRepo)) {
    return 'mcp_hosted';
  }

  // Public APIs → http_api. No executor for this type ships (POWERS-API never
  // started); the bulk of the densified public-api catalog entries were removed
  // (TOOLS-FINISH T2). Any remaining/hand-curated public-api entry is classified
  // here purely for discovery display — it is never actionable or deployable.
  if (sub === 'public-api') {
    return 'http_api';
  }

  // Otherwise — browse only, no deploy path yet
  return null;
}

/**
 * Returns whether the tool can be deployed RIGHT NOW (today's executor support).
 *
 * http_api has no executor and never will via this path — POWERS-API was
 * never built; the http_api catalog entries were cut (TOOLS-FINISH T2).
 *
 * @param {object|null} tool
 * @returns {boolean}
 */
export function isDeployable(tool) {
  const type = deriveExecutorType(tool);
  if (!type) return false;
  if (type === 'http_api') return false;           // no executor — discovery only, permanently
  if (type === 'catalog') return false;            // legacy concept, no deploy path
  if (type === 'native' || type === 'toolsmith') return false; // in-process tools, not "deployed"
  return type === 'mcp_hosted' || type === 'mcp_endpoint';
}

/**
 * CTA button copy based on detected executor type.
 * Returns null when no CTA should be shown.
 *
 * http_api never returns copy — there is no deploy affordance to promise
 * (TOOLS-FINISH T2 removed the dead "coming with POWERS-API" CTA).
 *
 * @param {object|null} tool
 * @returns {string|null}
 */
export function ctaCopyFor(tool) {
  const type = deriveExecutorType(tool);
  switch (type) {
    case 'mcp_hosted':
    case 'mcp_endpoint':
      return 'Deploy as Power';
    default:
      return null;
  }
}

/**
 * TRUST-GATE-1.7 — Is this catalog entry actionable for an install/enable
 * affordance TODAY (as opposed to browse/discovery only)?
 *
 * Two independent paths make a catalog entry actionable:
 *   1. It's deployable via the POWERS wizard right now (isDeployable === true —
 *      mcp_hosted / mcp_endpoint executor types). TOOLS-FINISH T1: callers
 *      (ToolsView catalog grid, ToolDetailView) route this path to the
 *      DeployPowerWizard (seeded with the entry's reference URL), NOT to the
 *      install-to-scope endpoint — that endpoint only knows about rows that
 *      already exist in `tool_definitions` and 404s on JSON-only entries.
 *   2. It already has a real backing row in the auth service's
 *      `tool_definitions` table — i.e. it was loaded via the DB-backed
 *      catalog API (`fromCatalogApi`), carries a `tool_definition_id`, or is
 *      a user-registered tool (`user_installed`). Install-to-scope operates
 *      on rows that exist in `tool_definitions` (including ones the POWERS
 *      wizard itself just created).
 *
 * Every other catalog entry is discovery-only: no install/enable affordance
 * should be presented as live. `http_api` entries in particular have no
 * executor at all (POWERS-API never shipped) and are permanently excluded —
 * see TOOLS-FINISH T2, which also removed the bulk of the JSON-only
 * public-api catalog entries outright rather than leave a dead CTA.
 *
 * @param {object|null} tool
 * @returns {boolean}
 */
export function isCatalogEntryActionable(tool) {
  if (!tool) return false;
  if (isDeployable(tool)) return true;
  return !!(tool.fromCatalogApi || tool.tool_definition_id || tool.user_installed);
}

/**
 * Human-readable reason a catalog entry's install/enable affordance is
 * disabled. Returns null when the entry IS actionable (no explanation needed).
 *
 * @param {object|null} tool
 * @returns {string|null}
 */
export function catalogInertReason(tool) {
  if (isCatalogEntryActionable(tool)) return null;
  const type = deriveExecutorType(tool);
  if (type === 'http_api') {
    return 'Discovery only — no HTTP API executor exists or is planned. Not installable.';
  }
  return 'Reference / discovery only — no install pipeline for this catalog entry yet.';
}
