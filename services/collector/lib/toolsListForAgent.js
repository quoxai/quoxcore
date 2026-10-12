/**
 * Tool-list resolution for GET /api/v1/tools/list.
 *
 * This route is the MCP path's ONLY source of tools. quoxmcp is spawned as a
 * STDIO subprocess by the Claude CLI (lib/claudeCliDispatcher.js), calls
 * CollectorClient.listTools(agentId), and registers exactly what comes back.
 * The `agentTools` array the dispatcher computed with getToolsWithConnectors()
 * never reaches it.
 *
 * The route used to call getToolsForAgentAsync() alone, which does not merge
 * connector tools, so every agent driven through the MCP path was offered ZERO
 * connector tools regardless of the org's vault credentials. GRIPE said "no
 * github_create_issue tool is connected for this org" while the connector
 * bridge resolved github_create_issue for that exact org one function over
 * (2026-08-23). Honest about its own tool list, wrong about the org.
 *
 * Extracted from server.js rather than inlined so the auth condition and the
 * degrade-to-core behaviour are testable without booting a 25k-line server.
 */

/**
 * @param {object} req  Express request
 * @returns {boolean} true when the caller presented the INTERNAL_SERVICE_KEY
 *
 * Deliberately narrower than requireServiceOrUserAuth(): this route has no
 * auth gate at all (the dashboard tool catalogue reads it anonymously), so the
 * connector merge is gated on the one caller that needs it — quoxmcp, which
 * always carries the internal service key. A user JWT never got connector
 * tools from this route either, so nothing regresses by not accepting one.
 */
function hasInternalServiceKey(req) {
  const presented = req && req.headers && req.headers['x-service-key'];
  const expected = process.env.INTERNAL_SERVICE_KEY;
  if (!expected || !presented) return false;
  // Length-safe constant-time compare (Buffer.compare on unequal lengths
  // throws in timingSafeEqual, so check length first and always compare).
  const a = Buffer.from(String(presented));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return require('node:crypto').timingSafeEqual(a, b);
}

/**
 * Resolve the tool list for one agent.
 *
 * @param {object} params
 * @param {string} params.agentId
 * @param {string} params.orgId              caller-supplied org (may be empty)
 * @param {boolean} params.serviceAuthenticated
 * @param {object} deps { getToolsForAgentAsync, getToolsWithConnectors }
 * @returns {Promise<Array>} tool definitions
 */
async function resolveAgentToolList({ agentId, orgId, serviceAuthenticated }, deps) {
  const id = agentId || 'quox';
  const { getToolsForAgentAsync, getToolsWithConnectors } = deps;

  if (orgId && serviceAuthenticated) {
    try {
      return await getToolsWithConnectors(id, orgId);
    } catch (err) {
      // A vault or connector outage must degrade the agent to its core tools.
      // quoxmcp holds whatever it gets for the WHOLE session (see its
      // listTools catch), so a throw here would strand the agent at 0 tools
      // for every turn that follows, not just this one.
      console.warn(`[tools/list] connector merge failed for agent=${id} org=${orgId}: ${err.message} — serving core tools`);
    }
  }

  return getToolsForAgentAsync(id);
}

module.exports = { resolveAgentToolList, hasInternalServiceKey };
