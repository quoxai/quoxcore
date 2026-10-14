/**
 * Agent registry list: the registered specialist roster (entity JSONs loaded by
 * entityAssistantLoader), NOT the AGENT_TOOLS keys (those include C-suite
 * persona ids that are not registered specialists).
 *
 * Pure-ish and dependency-injected so it is unit-testable.
 */

function firstSentence(text, max = 200) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const m = s.match(/^.*?[.!?](?=\s|$)/);
  const sentence = m ? m[0] : s;
  return sentence.length > max ? sentence.slice(0, max - 1) + '…' : sentence;
}

/**
 * @param {object} deps
 * @param {Array<object>} deps.assistants entity JSON objects
 * @param {object} deps.agentTools AGENT_TOOLS map (id -> tool names)
 * @param {object} [deps.governed] AGENT_REQUIRES_PLUGIN map (id -> plugin id)
 * @param {Function} [deps.checkPluginLicense] (orgId, pluginId) -> {licensed}
 * @param {string} [deps.orgId] from the authenticated user only
 */
async function buildAgentRegistryList({ assistants, agentTools = {}, governed = {}, checkPluginLicense, orgId }) {
  const rows = [];
  for (const a of assistants || []) {
    if (!a || !a.id) continue;
    const id = String(a.id);
    const requires = governed[id] || a.ownership?.plugin || null;
    let entitled = null;
    if (requires && governed[id] && orgId && typeof checkPluginLicense === 'function') {
      try {
        const r = await checkPluginLicense(orgId, governed[id]);
        // A failed-closed check could not run; that is unknown, never "false".
        entitled = r && r.failClosed ? null : !!(r && r.licensed);
      } catch {
        entitled = null;
      }
    }
    rows.push({
      agent_id: id,
      name: a.identity?.name || id,
      role: a.hierarchy?.role || null,
      level: a.hierarchy?.level ?? null,
      requires_plugin: requires,
      description: firstSentence(a.identity?.description),
      tool_count: (agentTools[id] || agentTools[id.toLowerCase()] || []).length,
      entitled,
    });
  }
  rows.sort((x, y) => (x.agent_id < y.agent_id ? -1 : x.agent_id > y.agent_id ? 1 : 0));
  return { agents: rows, count: rows.length };
}

module.exports = { buildAgentRegistryList, firstSentence };
