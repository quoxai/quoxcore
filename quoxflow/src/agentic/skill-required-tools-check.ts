/**
 * QSKL-6.3 — RequiredTools pre-flight check
 *
 * Pure decision function — no side effects, no logging, no envelopes.
 * Resolves each required tool spec against the provided resolver, then
 * returns a structured result with the action to take.
 *
 * Edition rules:
 *   experimental + missing → TRY_TOOLSMITH
 *   stable      + missing → BLOCK_HITL
 *
 * Wiring into skill-patch-flow.ts and skills-actions.ts is slice 4.
 */

import type { RequiredToolSpec } from './skill-required-tools-types.js';

// ─── Public Types ─────────────────────────────────────────────────────────────

export type SkillEdition = 'experimental' | 'stable';

export type RequiredToolsAction = 'PROCEED' | 'BLOCK_HITL' | 'TRY_TOOLSMITH';

export interface RequiredToolsCheckResult {
  satisfied: boolean;
  missing: RequiredToolSpec[];
  action: RequiredToolsAction;
}

/**
 * Resolver function called once per RequiredToolSpec.
 * May return a boolean synchronously or a Promise<boolean>.
 * If the resolver throws, the spec is treated as missing (unsatisfied).
 */
export type ToolResolver = (spec: RequiredToolSpec) => Promise<boolean> | boolean;

export interface RequiredToolsCheckOptions {
  requiredTools: RequiredToolSpec[] | undefined | null;
  edition: SkillEdition;
  resolve: ToolResolver;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export async function checkRequiredTools(
  opts: RequiredToolsCheckOptions,
): Promise<RequiredToolsCheckResult> {
  const { requiredTools, edition, resolve } = opts;

  // Rule 1: no tools required → always PROCEED
  if (requiredTools == null || requiredTools.length === 0) {
    return { satisfied: true, missing: [], action: 'PROCEED' };
  }

  const missing: RequiredToolSpec[] = [];

  for (const spec of requiredTools) {
    let resolved: boolean;
    try {
      resolved = await resolve(spec);
    } catch {
      // Rule 4: resolver throws → treat as missing
      resolved = false;
    }
    if (!resolved) {
      missing.push(spec);
    }
  }

  // Rule 2: all resolved → PROCEED
  if (missing.length === 0) {
    return { satisfied: true, missing: [], action: 'PROCEED' };
  }

  // Rule 3: at least one missing → edition-aware action
  const action: RequiredToolsAction =
    edition === 'experimental' ? 'TRY_TOOLSMITH' : 'BLOCK_HITL';

  return { satisfied: false, missing, action };
}
