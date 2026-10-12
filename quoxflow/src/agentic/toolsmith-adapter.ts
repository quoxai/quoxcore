/**
 * QSKL-6.2 — ToolsmithAdapter interface + stubToolsmithAdapter
 *
 * Interface for the Toolsmith service adapter. The stub returns NOT_SHIPPED
 * for all operations; it will be swapped for the real client once Toolsmith
 * ships. All call sites go through the interface so no other file needs
 * to change when the swap happens.
 *
 * NOTE: the stub does NOT file HITL — that is the caller's responsibility
 * (wired in slice 5). This adapter is intentionally pure.
 */

import type { RequiredToolSpec } from './skill-required-tools-types.js';

// Re-export so callers can reference the spec type from one place if needed.
export type { RequiredToolSpec };

// ─── Result Types ─────────────────────────────────────────────────────────────

export interface ToolsmithBuildOk {
  ok: true;
  toolName: string;
  version: string;
}
export interface ToolsmithBuildErr {
  ok: false;
  reason: 'NOT_SHIPPED' | 'POLICY_VIOLATION' | 'BUILD_FAILED';
  detail?: string;
}
export type ToolsmithBuildResult = ToolsmithBuildOk | ToolsmithBuildErr;

export interface ToolsmithDraftOk {
  ok: true;
  draftSkillId: string;
}
export interface ToolsmithDraftErr {
  ok: false;
  reason: 'NOT_SHIPPED' | 'NO_DOCS' | string; // string for forward-compat with real adapter errors
  detail?: string;
}
export type ToolsmithDraftResult = ToolsmithDraftOk | ToolsmithDraftErr;

// ─── Hint Type ────────────────────────────────────────────────────────────────

export interface BuildToolHint {
  name: string;
  version?: string;
  policy?: string[];
}

// ─── Adapter Interface ────────────────────────────────────────────────────────

export interface ToolsmithAdapter {
  buildToolFromSkill(skillId: string, hint: BuildToolHint): Promise<ToolsmithBuildResult>;
  draftSkillFromTool(toolName: string, version: string): Promise<ToolsmithDraftResult>;
}

// ─── Stub Implementation ──────────────────────────────────────────────────────

// TODO(toolsmith): swap this stub for the real Toolsmith client once Toolsmith ships.
// When swapping, no other call site needs to change — the wiring in server.ts
// constructs the adapter and passes it through AppConfig + executor setter.
export const stubToolsmithAdapter: ToolsmithAdapter = {
  async buildToolFromSkill(_skillId, _hint) {
    return { ok: false, reason: 'NOT_SHIPPED', detail: 'Toolsmith service not yet deployed' };
  },
  async draftSkillFromTool(_toolName, _version) {
    return { ok: false, reason: 'NOT_SHIPPED', detail: 'Toolsmith service not yet deployed' };
  },
};
