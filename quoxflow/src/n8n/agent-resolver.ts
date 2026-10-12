/**
 * n8n LangChain "sub-connection" resolver
 *
 * n8n's LangChain-family nodes (Agent, Chain, Chat Model, Memory, Tool, ...)
 * do not connect via n8n's normal `connections.main` edges at all. Instead a
 * capability node (a Chat Model, a Memory buffer, a Tool) points AT the
 * node it configures, using an `ai_*`-typed connection keyed under the
 * PROVIDER's own entry in `connections` — e.g. for a real sample:
 *
 *   connections["OpenAI Chat Model"].ai_languageModel[0][0]
 *     === { node: "AI Agent", type: "ai_languageModel", index: 0 }
 *
 * i.e. "OpenAI Chat Model provides ai_languageModel TO AI Agent" — the
 * opposite direction from how `main` reads. `workflow-converter.ts`'s
 * plain edge-conversion loop only ever looks at `connections.main`, so
 * these are invisible to it; resolving "what feeds this Agent/Chain node"
 * requires scanning every entry in `connections` for an ai_*-typed link
 * whose target is the node in question. That's what this module does.
 *
 * Deliberately kept separate from workflow-converter.ts's node-to-node
 * `main` edge conversion — this is graph *resolution* (read-only, no
 * QuoxFlow config produced here), not config construction. The composers
 * that turn a resolved AiCluster into an actual `agent:invoke` /
 * `assistant:invoke` node config live in workflow-converter.ts alongside
 * every other build*Config function, for the same reason connectors don't
 * live there: same-shape work, different concern.
 */

import { N8nConnections, N8nNode } from './types.js';

export interface AiClusterMember {
  nodeName: string;
  n8nType: string;
}

export interface AiCluster {
  /** ai_languageModel — the chat/completion model backing this Agent/Chain. First one found wins; a second is dropped silently (n8n itself only expects one, this hasn't been observed in real samples). */
  languageModel?: AiClusterMember;
  /** ai_memory — e.g. memoryBufferWindow. First one wins, same reasoning as languageModel. */
  memory?: AiClusterMember;
  /** ai_tool — zero or more. Out of scope to map onto QuoxFlow action types (see workflow-converter.ts's buildAgentInvokeConfig); resolved here so the composer can at least name them in a warning. */
  tools: AiClusterMember[];
  /** ai_outputParser — out of scope this pass (see task notes); resolved for completeness/inspection only, not consumed by any composer yet. */
  outputParser?: AiClusterMember;
  /**
   * Any other ai_* role pointing at this node (ai_embedding, ai_document,
   * ai_textSplitter, ...) — the RAG/vector-store family, explicitly out of
   * scope. Captured here only so a caller CAN inspect what's attached;
   * no composer reads this field.
   */
  other: Record<string, AiClusterMember[]>;
}

function emptyCluster(): AiCluster {
  return { tools: [], other: {} };
}

/**
 * Given the name of an Agent/Chain node and the workflow's full
 * `connections` object, find every node feeding it via an ai_* link,
 * grouped by role.
 */
export function resolveAiCluster(
  targetNodeName: string,
  connections: N8nConnections | undefined,
  nodesByName: Map<string, N8nNode>
): AiCluster {
  const cluster = emptyCluster();
  if (!connections) return cluster;

  for (const [sourceName, connMap] of Object.entries(connections)) {
    if (!connMap) continue;

    for (const [connType, edges] of Object.entries(connMap)) {
      if (connType === 'main' || !connType.startsWith('ai_')) continue;
      if (!Array.isArray(edges)) continue;

      for (const outputGroup of edges) {
        if (!Array.isArray(outputGroup)) continue;

        for (const conn of outputGroup) {
          if (!conn || conn.node !== targetNodeName) continue;

          const member: AiClusterMember = {
            nodeName: sourceName,
            n8nType: nodesByName.get(sourceName)?.type ?? 'unknown',
          };

          switch (connType) {
            case 'ai_languageModel':
              if (!cluster.languageModel) cluster.languageModel = member;
              break;
            case 'ai_memory':
              if (!cluster.memory) cluster.memory = member;
              break;
            case 'ai_tool':
              cluster.tools.push(member);
              break;
            case 'ai_outputParser':
              if (!cluster.outputParser) cluster.outputParser = member;
              break;
            default:
              (cluster.other[connType] ??= []).push(member);
          }
        }
      }
    }
  }

  return cluster;
}

/**
 * True when a named n8n node has no `main` connections at all — neither as
 * a source nor as a target of any other node's `main` output. Used to
 * decide whether an ai_* provider node (a Chat Model, a Memory buffer) can
 * be safely folded into a composed agent:invoke/assistant:invoke node and
 * dropped from the output workflow, rather than surviving as an orphaned,
 * un-runnable standalone node. Every model/memory provider observed across
 * the real vault samples used for this pass has ai_*-only connections
 * (confirmed: `OpenAI Chat Model` and `Window Buffer Memory` in the
 * WhatsApp RAG sample both have no `main` key at all) — this check exists
 * as a safety guard for the (unobserved but not impossible) case of a
 * provider node that's also wired into the plain node graph.
 */
export function hasNoMainConnections(nodeName: string, connections: N8nConnections | undefined): boolean {
  if (!connections) return true;

  const ownMain = connections[nodeName]?.main;
  if (Array.isArray(ownMain) && ownMain.some(group => Array.isArray(group) && group.length > 0)) {
    return false;
  }

  for (const connMap of Object.values(connections)) {
    const mainEdges = connMap?.main;
    if (!Array.isArray(mainEdges)) continue;
    for (const group of mainEdges) {
      if (!Array.isArray(group)) continue;
      if (group.some(conn => conn?.node === nodeName)) return false;
    }
  }

  return true;
}
