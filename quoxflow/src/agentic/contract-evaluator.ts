/**
 * RSP-CONTRACT Phase 1b — Responsibility Contract observe-mode evaluator.
 *
 * Given (orgId, agentId, action), fetches the EFFECTIVE contract for that
 * agent from the collector's internal resolve endpoint (RSP-CONTRACT Phase
 * 1a — see quox-dashboard/services/collector/routes/agentContracts.js) and
 * checks whether `action` would violate it:
 *   - hits a `forbidden_actions` clause item, OR
 *   - `allowed_actions` is non-empty AND `action` is not in it.
 *
 * OBSERVE-MODE ONLY (Phase 1b): this module never blocks, denies, or alters
 * anything. It is a pure read + evaluate that returns a result describing
 * what WOULD happen under enforcement. The caller (control-pipeline.ts)
 * attaches the result to the aocl.policy.evaluated envelope for audit visibility.
 *
 * Best-effort / never-throw: this runs on the hot path for every agent
 * action. If the collector is unreachable, the org/agent has no contract
 * configured, or anything else goes wrong, evaluate() degrades to
 * `{ checked: false, would_violate: false, contract_clause: null }` — it
 * must be completely invisible when contracts aren't configured.
 *
 * RSP_CONTRACT_ENFORCE env flag: default/only supported value in Phase 1b
 * is "observe" (or unset). A future Phase 2 will read this flag to add a
 * blocking branch when would_violate is true — see the TODO in
 * control-pipeline.ts at the wire point. This module does not implement
 * blocking; it only ever reports.
 */

import { Node } from '../core/workflow.js';

export interface ContractClauseItem {
  id: string;
  description: string;
  [key: string]: unknown;
}

export type ContractClauseType = 'forbidden_actions' | 'allowed_actions';

export interface MatchedContractClause {
  type: ContractClauseType;
  /** The matched clause item, or null when the violation is "not in the allowlist" (no single item matched). */
  item: ContractClauseItem | null;
}

export interface ContractCheckResult {
  /** True once a contract was actually fetched and evaluated. False on any no-op/degrade path. */
  checked: boolean;
  /** True if `action` would violate the resolved contract. Always false when checked is false. */
  would_violate: boolean;
  contract_clause: MatchedContractClause | null;
}

export interface ContractEvaluatorOptions {
  collectorUrl?: string;
  serviceKey?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const NOOP_RESULT: ContractCheckResult = {
  checked: false,
  would_violate: false,
  contract_clause: null,
};

/**
 * Matches a clause item's `id` against an action string. Supports exact
 * match, a bare `*` wildcard (matches anything), and a trailing-`*` prefix
 * wildcard (e.g. `shell.*` matches `shell.exec`).
 */
function matchesAction(item: ContractClauseItem, action: string): boolean {
  if (!item || typeof item.id !== 'string') return false;
  if (item.id === '*') return true;
  if (item.id.endsWith('*')) return action.startsWith(item.id.slice(0, -1));
  return item.id === action;
}

/**
 * Derives the agent identity and the intended "action" for a workflow node.
 * Mirrors the agent-id resolution patterns already used across quoxflow's
 * agent-facing executors (agent:invoke's agent_id, assistant:invoke's
 * assistant_id, agentic.executor's agent/agentId/agent_id fallback chain).
 * The action identifier is the node's type — the concrete operation the
 * pipeline is about to perform — consistent with how PolicyEvaluator scopes
 * policies by nodeType (src/policy/evaluator.ts).
 *
 * Returns `agentId: undefined` for node types with no agent association
 * (e.g. flow:condition, tool:call) — evaluate() no-ops in that case since
 * there is no agent to resolve a contract for.
 */
export function resolveNodeAgentAction(node: Node): { agentId: string | undefined; action: string } {
  const config = (node.config ?? {}) as Record<string, unknown>;
  const agentId =
    (typeof config.agent_id === 'string' && config.agent_id) ||
    (typeof config.assistant_id === 'string' && config.assistant_id) ||
    (typeof config.agentId === 'string' && config.agentId) ||
    (typeof config.agent === 'string' && config.agent) ||
    undefined;

  return { agentId: agentId || undefined, action: node.type };
}

export class ContractEvaluator {
  private collectorUrl: string;
  private serviceKey: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(options?: ContractEvaluatorOptions) {
    this.collectorUrl = options?.collectorUrl || process.env.COLLECTOR_URL || 'http://collector:9848';
    this.serviceKey = options?.serviceKey || process.env.INTERNAL_SERVICE_KEY || '';
    this.timeoutMs = options?.timeoutMs ?? 3000;
    this.fetchImpl = options?.fetchImpl || fetch;
  }

  /**
   * Best-effort, NEVER throws. See module doc for the degrade contract.
   */
  async evaluate(params: { orgId?: string; agentId?: string; action?: string }): Promise<ContractCheckResult> {
    try {
      const { orgId, agentId, action } = params;
      if (!orgId || !agentId || !action) return NOOP_RESULT;

      const url = `${this.collectorUrl}/orgs/${encodeURIComponent(orgId)}/agent-contracts/${encodeURIComponent(agentId)}/resolve`;

      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { 'X-Service-Key': this.serviceKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) return NOOP_RESULT;

      const body = (await response.json().catch(() => null)) as { data?: Record<string, unknown> } | null;
      const resolved = body?.data as
        | { clauses?: Record<string, { items?: ContractClauseItem[] }> }
        | undefined;
      if (!resolved || !resolved.clauses) return NOOP_RESULT;

      const forbidden = resolved.clauses.forbidden_actions?.items ?? [];
      const allowed = resolved.clauses.allowed_actions?.items ?? [];

      const forbiddenMatch = forbidden.find((item) => matchesAction(item, action));
      if (forbiddenMatch) {
        return {
          checked: true,
          would_violate: true,
          contract_clause: { type: 'forbidden_actions', item: forbiddenMatch },
        };
      }

      if (allowed.length > 0) {
        const allowedMatch = allowed.find((item) => matchesAction(item, action));
        if (!allowedMatch) {
          return {
            checked: true,
            would_violate: true,
            contract_clause: { type: 'allowed_actions', item: null },
          };
        }
      }

      return { checked: true, would_violate: false, contract_clause: null };
    } catch {
      // Never throw into the AOCL pipeline — collector unreachable, malformed
      // response, timeout, whatever. Degrade silently.
      return NOOP_RESULT;
    }
  }
}
