/**
 * QSKL-HARDEN HRD-1 — Two-layer skill override merge
 *
 * Shared allowlist + merge function used by every read surface that serves a
 * skill to a consumer (REST GET/list routes, agentic skill_view). Canonical
 * `quox_skills` rows are never mutated — merging happens here, at the serve
 * layer, every time a skill is read.
 *
 * Precedence (last wins): system default (the canonical row) -> org override
 * -> user override. Only fields in OVERRIDABLE_FIELDS may be overridden;
 * anything else supplied to an upsert is rejected by the caller (route /
 * skill_manage validation), not here — this module assumes it's been given
 * pre-validated override payloads and focuses purely on merge semantics.
 */

import type { SkillOverrideRow, SkillOverridesStore } from '../store/skill-overrides-store.js';

/**
 * v1 allowlist. Deliberately excludes any behavioural field (required_tools,
 * allowlists, dangerous-pattern lists) — those stay author-authoritative.
 * `default_params` is the one field that can influence runtime behaviour;
 * per plan OQ2 it's included but callers should re-scan the merged view with
 * the firewall and should not accept new keys beyond what the skill already
 * declares (enforced by callers, e.g. the merge-then-scan order in skill_view).
 */
export const OVERRIDABLE_FIELDS = [
  'description',
  'notes',
  'display_category',
  'default_params',
] as const;

export type OverridableField = (typeof OVERRIDABLE_FIELDS)[number];

export function isOverridableField(field: string): field is OverridableField {
  return (OVERRIDABLE_FIELDS as readonly string[]).includes(field);
}

/** Fields present in a payload that are NOT in the allowlist. */
export function findNonOverridableFields(fields: Record<string, unknown>): string[] {
  return Object.keys(fields).filter(f => !isOverridableField(f));
}

export interface OverrideAppliedMetadata {
  scope: 'org' | 'user' | 'org+user';
  fields: string[];
}

export interface MergedSkillView<T extends Record<string, unknown>> {
  merged: T;
  override_applied: OverrideAppliedMetadata | null;
}

/**
 * Pure merge function: system default -> org override -> user override.
 * No I/O — callers fetch the override rows first (see mergeSkillOverridesForRead
 * below for the store-backed convenience wrapper).
 */
export function mergeSkillOverrides<T extends Record<string, unknown>>(
  systemDefault: T,
  orgOverride: SkillOverrideRow | null,
  userOverride: SkillOverrideRow | null
): MergedSkillView<T> {
  const merged: Record<string, unknown> = { ...systemDefault };
  const appliedFields = new Set<string>();
  let orgApplied = false;
  let userApplied = false;

  if (orgOverride) {
    for (const [field, value] of Object.entries(orgOverride.overrides)) {
      if (!isOverridableField(field)) continue; // defense-in-depth; route/store should have rejected already
      merged[field] = value;
      appliedFields.add(field);
      orgApplied = true;
    }
  }

  if (userOverride) {
    for (const [field, value] of Object.entries(userOverride.overrides)) {
      if (!isOverridableField(field)) continue;
      merged[field] = value;
      appliedFields.add(field);
      userApplied = true;
    }
  }

  let scope: OverrideAppliedMetadata['scope'] | null = null;
  if (orgApplied && userApplied) scope = 'org+user';
  else if (userApplied) scope = 'user';
  else if (orgApplied) scope = 'org';

  return {
    merged: merged as T,
    override_applied: scope ? { scope, fields: Array.from(appliedFields) } : null,
  };
}

/**
 * Convenience wrapper: fetches both override rows from the store and merges.
 * Used by both the REST read routes and skillViewHandler so there is exactly
 * one code path for "read a skill with overrides applied".
 */
export async function mergeSkillOverridesForRead<T extends Record<string, unknown>>(
  systemDefault: T,
  params: {
    overridesStore: SkillOverridesStore | undefined;
    orgId: string;
    skillName: string;
    userId?: string | null;
  }
): Promise<MergedSkillView<T>> {
  if (!params.overridesStore) {
    return { merged: systemDefault, override_applied: null };
  }

  const { org, user } = await params.overridesStore.getForMerge({
    orgId: params.orgId,
    skillName: params.skillName,
    userId: params.userId ?? null,
  });

  return mergeSkillOverrides(systemDefault, org, user);
}
