/**
 * Validation Registry — maps TBId → ValidationAgent
 */

import { ValidationAgent, TBId } from './types.js';
import { tb1EchoBaseline } from './agents/tb-1-echo-baseline.js';
import { tb2PolicyGated } from './agents/tb-2-policy-gated.js';
import { tb3EchoCrystal } from './agents/tb-3-echo-crystal.js';
import { tb4BudgetBound } from './agents/tb-4-budget-bound.js';
import { tb5TriggerInterleave } from './agents/tb-5-trigger-interleave.js';
import { tb6CrossTenant } from './agents/tb-6-cross-tenant.js';

const ALL_AGENTS: ValidationAgent[] = [
  tb1EchoBaseline,
  tb2PolicyGated,
  tb3EchoCrystal,
  tb4BudgetBound,
  tb5TriggerInterleave,
  tb6CrossTenant,
];

const BY_ID: Map<TBId, ValidationAgent> = new Map(
  ALL_AGENTS.map(a => [a.id, a])
);

export function getAgent(id: TBId): ValidationAgent | undefined {
  return BY_ID.get(id);
}

export function getAllAgents(): ValidationAgent[] {
  return [...ALL_AGENTS];
}

export function listAgentMeta() {
  return ALL_AGENTS.map(a => ({
    id: a.id,
    name: a.name,
    description: a.description,
    surfacesCovered: a.surfacesCovered,
  }));
}
