/**
 * Server-Side Context Assembler — MEM-INJECT Phase 2
 *
 * Before: `buildMemoryImplant` (TRUST-GATE-1.12b) was only ever called from
 * inside `handleCollectorChat` — meaning `/api/internal/agents/invoke`'s
 * no_tools fast path (used by quoxflow's assistant-invoke, the objective
 * decomposer, teams, and `delegate_to_agent`) built its system prompt from
 * whatever `context` the caller passed in, with ZERO memory implant and
 * ZERO self-knowledge implant — the biggest hole in MEM-INJECT.
 *
 * After: `assembleServerContext` runs both `buildMemoryImplant` and
 * `buildSelfKnowledgeImplant` together (in parallel) and is called from
 * BOTH `handleCollectorChat` and the `/api/internal/agents/invoke` fast
 * path, so workflow/objective/team/delegated runs get identical server-side
 * injection to the browser chat surface.
 *
 * Never throws — each half degrades to '' independently on failure.
 */

const { buildMemoryImplant } = require('./memoryImplant.js');
const { buildSelfKnowledgeImplant } = require('./quoxSelfKnowledgeImplant.js');

async function assembleServerContext({
  agentId,
  prompt,
  orgId,
  userId,
  // memoryImplant.js deps (optional overrides — see its defaults)
  memoryServiceUrl,
  serviceKey,
  fetchFn,
  timeoutMs,
  // quoxSelfKnowledgeImplant.js deps
  loadCognitiveImplants,
  getCollectorMirrorCompact,
} = {}) {
  const [memoryContext, selfKnowledgeContext] = await Promise.all([
    buildMemoryImplant({
      orgId, userId, agentId, prompt,
      ...(memoryServiceUrl !== undefined ? { memoryServiceUrl } : {}),
      ...(serviceKey !== undefined ? { serviceKey } : {}),
      ...(fetchFn !== undefined ? { fetchFn } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    }).catch(err => {
      // Belt-and-braces — buildMemoryImplant already catches its own errors.
      console.error(`[ServerContext] memory implant failed, proceeding without it: ${err.message}`);
      return '';
    }),
    buildSelfKnowledgeImplant({
      agentId, orgId, loadCognitiveImplants, getCollectorMirrorCompact,
    }).catch(err => {
      // Belt-and-braces — buildSelfKnowledgeImplant already catches its own errors.
      console.error(`[ServerContext] self-knowledge implant failed, proceeding without it: ${err.message}`);
      return '';
    }),
  ]);

  return { memoryContext, selfKnowledgeContext };
}

module.exports = {
  assembleServerContext,
};
