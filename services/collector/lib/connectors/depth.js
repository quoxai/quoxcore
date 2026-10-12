/**
 * CONNFAC P7.3 — per-connector depth rungs.
 *
 * The breadth metric (spec count) says nothing about whether a connector is a
 * governed Quox integration or a curl wrapper. Depth is scored on the rungs
 * that apply to a connector:
 *
 *   CREDENTIALED — the vault knows how to hold its credential (credentialType)
 *   APPROVABLE   — every write tool crosses the mandatory HITL gate
 *                  (requiresApproval, derived from write:true for declarative
 *                  specs in declarativeRuntime). null = no writes, rung N/A.
 *   AGENTIC      — a named agent OWNS it via CONNECTOR_FAMILIES. quox's
 *                  all-families orchestrator grant is access, not ownership.
 *   SCHEDULABLE  — exposed to the workflow builder. FALSE platform-wide:
 *                  6.5 Phase 3 (dual-surface catalogs) is not built.
 *   EVIDENCED    — per-call AEE emission from the connector bridge. FALSE
 *                  platform-wide: the bridge emits none today.
 *
 * The last two are honest global gaps, reported per connector so the number
 * moves the day the capability ships instead of being quietly assumed.
 *
 * AGENT_OWNERS mirrors agentTools.CONNECTOR_FAMILIES inverted. It is data
 * here (agentTools' module init has real side effects, so scripts must not
 * require it); test/connectorDepth.test.js child-processes agentTools and
 * fails on any drift between the two.
 */

const AGENT_OWNERS = {
  github: ['forge', 'gripe', 'bob'],
  linkedin: ['linkedin'],
  twitter: ['xtwitter'],
  youtube: ['youtube'],
  tailscale: ['meshnet'],
  facebook_pages: ['facebook'],
  instagram: ['instagram'],
  tiktok: ['tiktok'],
}

const PLATFORM_GAPS = {
  schedulable: 'workflow-builder catalog integration not built (6.5 Phase 3 open)',
  evidenced: 'connector bridge emits no per-call AEE envelopes yet',
}

/**
 * @param {object} entry - CONNECTOR_REGISTRY entry ({ id, credentialType, ... })
 * @param {object} opts
 * @param {Array}  opts.tools - the connector's built tools
 *   ({ name, write, requiresApproval }); metadata only, never executed.
 * @returns {{credentialed:boolean, approvable:boolean|null, agentic:boolean,
 *   owned_by:string[], schedulable:boolean, evidenced:boolean, rungs:number}}
 */
function deriveDepth(entry, { tools = [] } = {}) {
  const writes = tools.filter((t) => t && t.write === true)
  const credentialed = Boolean(entry?.credentialType)
  const approvable = writes.length === 0
    ? null
    : writes.every((t) => t.requiresApproval === true)
  const ownedBy = AGENT_OWNERS[entry?.id] || []
  const agentic = ownedBy.length > 0
  const schedulable = false
  const evidenced = false

  const rungs = [credentialed, approvable, agentic, schedulable, evidenced]
    .filter((v) => v === true).length

  return { credentialed, approvable, agentic, owned_by: ownedBy, schedulable, evidenced, rungs }
}

module.exports = { deriveDepth, AGENT_OWNERS, PLATFORM_GAPS }
