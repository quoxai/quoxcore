'use strict';
/**
 * QUOXON-MIRROR: the [SELF-KNOWLEDGE] block (implant registry + this org's server Mirror + LUCID
 * situation) for POST /chat/stream turns. POST /chat already applies it via assembleServerContext;
 * /chat/stream (quox chat, the TUI, streamed dashboard chat) never did, so CommanderQ on that path
 * saw no Mirror at all. Memory context already reaches the stream path, so only self-knowledge is
 * added here. Plugin turns never get it (SEC-PLUGIN-TRUST C1). Never throws.
 */
const { applySelfKnowledgeImplant } = require('./quoxSelfKnowledgeImplant.js');
const { skipServerContext } = require('./pluginAgentTurn.js');

async function injectStreamSelfKnowledge({ context, orgId, agentId, body, build }) {
  const ctx = context && typeof context === 'object' ? context : {};
  if (!orgId || skipServerContext(body || {})) return ctx;
  try {
    const block = await build({ orgId, agentId });
    return applySelfKnowledgeImplant(ctx, block);
  } catch (err) {
    console.warn(`[ChatStream] self-knowledge injection failed, proceeding without it: ${err.message}`);
    return ctx;
  }
}

module.exports = { injectStreamSelfKnowledge };
