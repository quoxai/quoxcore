#!/usr/bin/env node
/**
 * index-tools — ops runner that builds the real tool-RAG index (TOOL-RETRIEVAL P2/P3).
 *
 * Run inside the collector container (has the env + backends):
 *   docker exec quox-collector node scripts/index-tools.js
 *
 * Embeds every tool's name+description into the Qdrant `tool-index` collection
 * (lib/toolIndex.js) so query-aware retrieval (server.js's applyOpenAiToolCap
 * smart-truncation) has something real to search. Resolves a platform-wide
 * embedding key the same way server.js's own resolveCredentials does (vault
 * waterfall, org_id 'default') — no org-specific BYOK key required, matching
 * quoxchat's own honest-absent posture if neither is configured.
 *
 * Re-run whenever the tool registry changes (new tool added/removed/reworded).
 * Idempotent — stable point ids mean this always upserts in place.
 */
const { TOOL_DEFS } = require('../lib/agentTools.js');
const { embedText } = require('../routes/quoxchat.js');
const { indexTools } = require('../lib/toolIndex.js');
const { buildInternalServiceHeaders } = require('../lib/internalServiceHeaders.js');

const AUTH_BASE_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`;

async function resolveCredentials(orgId, providers) {
  try {
    const resp = await fetch(`${AUTH_BASE_URL}/api/setup/internal/resolve`, {
      method: 'POST',
      headers: buildInternalServiceHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ org_id: orgId || 'default', providers }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

(async () => {
  const resolved = await resolveCredentials('default', ['openai', 'gemini']);
  const providerKeys = {};
  if (resolved?.providers) {
    for (const [provider, data] of Object.entries(resolved.providers)) {
      if (data?.key) providerKeys[`${provider}_api_key`] = data.key;
    }
  }
  console.log(`[index-tools] platform key resolved: openai=${!!providerKeys.openai_api_key} gemini=${!!providerKeys.gemini_api_key}`);

  const result = await indexTools(TOOL_DEFS, {
    embedText,
    providerKeys,
    qdrantUrl: process.env.QDRANT_URL || 'http://qdrant:6333',
  });

  console.log('\n=== TOOL-INDEX ' + new Date().toISOString() + ' ===');
  console.log(JSON.stringify(result, null, 2));
  if (result.reason === 'no_embedding_key') {
    console.error('No embedding key resolved (platform vault has neither openai nor gemini configured) — index NOT built.');
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error('index-tools failed:', e.message); process.exit(1); });
