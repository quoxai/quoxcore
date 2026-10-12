/**
 * QSKL-6.4a — ToolPresenceLookup interface
 *
 * Decoupled lookup interface so the pre-flight check (skill-required-tools-check.ts)
 * can resolve tool presence without taking a hard dependency on any particular
 * registry implementation.
 *
 * The `inMemoryToolPresenceLookup` factory is the default "safe-to-test" impl.
 * It matches purely on `name`.
 *
 * TODO(toolsmith): replace with a registry-backed impl that honours
 * version_constraint and must_satisfy_policy claims once the tool registry
 * (Toolsmith) ships. The swap site is wherever the executor wires the adapter.
 */

import type { RequiredToolSpec } from './skill-required-tools-types.js';

// ─── Public Interface ─────────────────────────────────────────────────────────

export interface ToolPresenceLookup {
  isPresent(spec: RequiredToolSpec): Promise<boolean> | boolean;
}

// ─── In-memory implementation ─────────────────────────────────────────────────

/**
 * Static in-memory impl. Useful for tests and as default until a real
 * registry-backed impl ships. Matches purely on `name`.
 *
 * TODO(toolsmith): replace with a registry-backed impl that honours
 * version_constraint and must_satisfy_policy claims.
 */
export function inMemoryToolPresenceLookup(knownToolNames: Iterable<string>): ToolPresenceLookup {
  const set = new Set(knownToolNames);
  return {
    isPresent: (spec) => set.has(spec.name),
  };
}
