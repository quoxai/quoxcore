/**
 * Crystal Canonical Hash — REPLAY-ONLY .B2 (signing path)
 *
 * Computes a deterministic sha256 hash of a Crystal's action-snapshot
 * (`draft.actionLogSnapshot`, stored inside `workflowJson.action_log_snapshot`
 * on the canonical row — see skill-library-store.ts). This hash is the
 * value quoxflow sends to auth's signing oracle
 * (`POST /api/internal/crystals/sign`, shipped in .B1a) — the private key
 * never leaves auth, quoxflow only ever handles the hash + the resulting
 * signature.
 *
 * Algorithm ported from the reference canonical-JSON implementation at
 * quox-dashboard/services/ward/lib/crypto.js (`canonicalize`/`payloadHash`):
 * recursive stable key-sort at every nesting level, no whitespace, UTF-8,
 * NFC-normalised strings. Deterministic regardless of key insertion order —
 * same logical snapshot always produces the same hash.
 *
 * PURE — no I/O, no store/DB access. Slice B3's verify-on-replay path
 * reuses this exact algorithm to re-derive the hash from a replayed
 * snapshot and compare it against the stored `canonical_hash` /
 * `signature`. Do not change this algorithm without a coordinated B2+B3
 * migration (it would invalidate every previously-signed Crystal).
 */

import { createHash } from 'node:crypto';

/**
 * Recursive stable-key-sort canonical JSON serialisation.
 * Keys are sorted lexicographically at every nesting level; no whitespace.
 */
export function canonicalizeSnapshot(snapshot: unknown): string {
  return stableStringify(snapshot);
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));

  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs = keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]));
    return '{' + pairs.join(',') + '}';
  }

  // Functions/symbols/bigint should never appear in a JSON-derived snapshot —
  // fall back to a stable string form rather than throwing.
  return JSON.stringify(String(value));
}

/**
 * sha256 hex digest (64 chars, lowercase) of the canonical JSON form of a
 * Crystal's action-snapshot. This is the exact value passed as `hash` to
 * auth's `POST /api/internal/crystals/sign`.
 */
export function hashSnapshot(snapshot: unknown): string {
  return createHash('sha256').update(canonicalizeSnapshot(snapshot), 'utf8').digest('hex');
}
