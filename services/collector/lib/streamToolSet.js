'use strict';
/**
 * CLI-QUOXON Q2: the tool set the /chat/stream OpenAI branch gives the governed
 * tool loop. Mirrors POST /chat (server.js handleCollectorChat) so a stream turn
 * can never hold MORE tools than a non-stream turn for the same agent/org:
 *
 *   agent grant (getToolsWithConnectors)
 *   -> QuoxHat P2 manifest (enforced org: tools = manifest, hatManifest arms the
 *      executeTool membership gate; fail-CLOSED to zero tools when the hat cannot
 *      be resolved for an enforced org)
 *   -> provider cap (skipped for an enforced manifest, which is sized to fit, and for
 *      offerBounded callers: a D3 per-turn offer bounds what the model sees instead)
 *
 * Deps are injected so this stays unit-testable; server.js passes the same
 * functions handleCollectorChat uses.
 */
async function resolveStreamToolSet(
  { agent, orgId, userId, conversationId, prompt, provider, providerKeys, toolCap, offerBounded = false },
  { getToolsWithConnectors, resolveHatForTurn, buildTurnManifest, buildFailClosedManifest, applySmartToolCap, checkManifestCompat, storeAuditEnvelope, searchToolsFn, embedText, log = console },
) {
  let tools = [];
  try {
    const t = await getToolsWithConnectors(String(agent || '').toLowerCase(), orgId || null);
    tools = Array.isArray(t) ? t : [];
  } catch (e) {
    log.warn?.(`[ChatStream] tool grant for '${agent}' failed, none listed: ${e && e.message}`);
    return { tools: [], hatManifest: null, hat: null };
  }

  let hatManifest = null;
  let hat = null;
  try {
    const hatTurn = await resolveHatForTurn({ orgId, userId, conversationId, agent });
    if (hatTurn && hatTurn.hat) {
      const manifest = buildTurnManifest({ agentTools: tools, hat: hatTurn.hat, loadedBundles: hatTurn.binding?.loaded_bundles || [], agent });
      if (manifest) {
        const enforced = hatTurn.enforcement === 'enforce';
        if (enforced && offerBounded && manifest.authzToolNames instanceof Set) {
          // QUOXON-PARITY: the pool is what the hat AUTHORIZES (the set executeTool enforces),
          // presentation first. The presentation manifest carries no authority (hatManifest.js
          // P-B); under a D3 offer it only ordered a view the offer now focuses per turn.
          const shown = new Set(manifest.tools.map((t) => t.name));
          tools = [...manifest.tools, ...tools.filter((t) => !shown.has(t.name) && manifest.authzToolNames.has(t.name))];
        } else if (enforced) tools = manifest.tools;
        hatManifest = {
          enforced,
          toolNames: manifest.toolNames,
          authzToolNames: manifest.authzToolNames,
          grantToolNames: manifest.grantToolNames,
          authzMode: manifest.authzMode,
          authorizedAgents: manifest.authorizedAgents,
          delegationScoped: manifest.delegationScoped,
          hatKey: manifest.hatKey,
          hatId: manifest.hatId,
          revision: manifest.revision,
          digest: manifest.digest,
        };
        hat = { key: manifest.hatKey, revision: manifest.revision };
        // Same content-free witness receipt POST /chat emits per hat-resolved turn.
        storeAuditEnvelope({
          type: 'event', from: 'system.quoxhat', to: 'system.tools',
          intent: 'quoxhat.manifest.resolved',
          corr: conversationId || `CHAT_${Date.now()}`,
          org_id: orgId,
          payload: {
            hat_key: manifest.hatKey, hat_revision: manifest.revision, hat_source: hatTurn.source,
            manifest_digest: manifest.digest, manifest_size: manifest.tools.length, enforced,
            hat_id: manifest.hatId, definition_digest: hatTurn.hat.digest || null,
            agent, conversation_id: conversationId || null, loaded_bundles: manifest.loadedBundles, path: 'chat_stream',
          },
        });
      }
    } else if (!hatTurn) {
      const fc = buildFailClosedManifest(orgId);
      if (fc) { hatManifest = fc; tools = []; }
    }
  } catch (e) {
    const fc = buildFailClosedManifest(orgId);
    if (fc) { hatManifest = fc; tools = []; }
    log.warn?.(`[QUOXHAT] stream manifest resolution failed (${fc ? 'FAIL-CLOSED: enforced org, tools denied' : 'legacy grant continues'}): ${e && e.message}`);
  }

  if (hatManifest && hatManifest.enforced) {
    if (offerBounded) return { tools, hatManifest, hat }; // the D3 offer sizes what the provider sees
    try {
      const c = checkManifestCompat(provider, tools.length);
      if (!c.compatible) log.error?.(`[QUOXHAT-P6] stream: enforced manifest (${tools.length} tools) vs provider '${provider}': ${(c.reasons || []).join('; ')}`);
    } catch { /* telemetry only */ }
  } else if (tools.length > 0 && offerBounded) {
    // QUOXON-PARITY: a D3 offer (lib/turnToolSelection.js) bounds what reaches the model
    // (<= 3x its cap, under the OpenAI 128 limit), so the CANDIDATE POOL stays the whole
    // grant on every provider. Pre-truncating here made more_tools blind to the rest
    // (ollama saw 18 of quox's tools, openai 128) while the Claude path saw them all.
  } else if (tools.length > 0) {
    try {
      const capped = Number.isInteger(toolCap) && toolCap > 0
        ? await applySmartToolCap(tools, provider, prompt, { searchToolsFn, embedText, providerKeys }, toolCap)
        : await applySmartToolCap(tools, provider, prompt, { searchToolsFn, embedText, providerKeys });
      tools = capped.tools;
    } catch (e) {
      log.warn?.(`[ChatStream] tool cap failed, sending the uncapped grant would risk a provider 400; sending none: ${e && e.message}`);
      tools = [];
    }
  }
  return { tools, hatManifest, hat };
}

module.exports = { resolveStreamToolSet };
