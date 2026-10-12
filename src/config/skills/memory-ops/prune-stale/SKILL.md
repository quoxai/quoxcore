---
name: prune-stale
license: LicenseRef-SkillRights-Reserved-1.0
category: memory/operations
version: 1.0.0
edition: stable
author: quox-core
description: Identify Quox memory entries that have exceeded their configured decay horizon and produce a prune proposal with byte savings and confidence-weighted retention scores, without performing any deletion.
tags: [memory-pruning, decay-horizon, retention-scoring, prune-proposal, housekeeping, memory-ops, stale-detection]
best_for_agents: [keeper]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Prune Stale

## When to apply

Use this skill when an agent or scheduled maintenance workflow needs to identify memory entries that have aged past their configured decay horizon. Typical triggers: the memory service approaches a storage quota threshold, a scheduled weekly housekeeping workflow fires, or a user asks the agent to audit memory health. Apply this skill to produce a candidate prune list for review — it does not delete anything. Deletion is a separate operation that must be explicitly approved and executed through the memory service's deletion endpoint, outside the scope of this skill.

## Inputs

- `org_id` (string) — Organisation identifier. Required for tenant isolation; sourced from the caller's JWT claims.
- `user_id` (string, optional) — Restrict the scan to a single user's memories within the org. When omitted, scans org-wide memories if the caller has org-admin permission.
- `decay_horizons` (object, optional) — Override the default decay horizon per memory type. Keys are memory type names (`fact`, `preference`, `decision`, `constraint`, `observation`, `entity`, `error/fix`); values are durations in days. When a key is absent, the system default for that type is used. Example: `{ "observation": 30, "decision": 365 }`.
- `min_confidence_to_retain` (number, optional) — Rows with a `confidence_score` at or above this threshold are flagged as high-confidence candidates for retention even if they are past their decay horizon. Default: `0.8`. Range: `0.0`–`1.0`.
- `min_access_count_to_retain` (number, optional) — Rows accessed at least this many times are flagged as frequently-used candidates for retention regardless of age. Default: `5`.
- `dry_run` (boolean, optional) — When `true`, the skill runs the full analysis and returns the proposal but emits no VOLT evidence record. Useful for exploratory audits that should not appear in the compliance trail. Default: `false`.

## Steps

1. Load the decay horizon configuration for the org: merge system defaults with any `decay_horizons` overrides supplied in inputs. Record the resolved horizon per type so the proposal can reference it.
2. Query the memory service (port 3103) for all rows belonging to `org_id` (and `user_id` if set). Retrieve: `id`, `type`, `tags`, `created_at`, `last_accessed_at`, `access_count`, `confidence_score`, `content_byte_length` (or `length(content)` if a pre-computed field is absent).
3. For each row, compute `age_days = (now_utc − created_at) / 86400` and `idle_days = (now_utc − last_accessed_at) / 86400`. Compare `age_days` against the resolved decay horizon for the row's `type`.
4. Classify each row into one of three buckets:
   - `PROPOSE_PRUNE` — past its decay horizon AND `confidence_score < min_confidence_to_retain` AND `access_count < min_access_count_to_retain`.
   - `RETAIN_HIGH_CONFIDENCE` — past its decay horizon but `confidence_score >= min_confidence_to_retain`.
   - `RETAIN_FREQUENTLY_USED` — past its decay horizon but `access_count >= min_access_count_to_retain`.
   Rows within their decay horizon are excluded from the proposal entirely.
5. Compute the composite retention score for every row in the `RETAIN_*` buckets using the formula: `0.5 × confidence_score + 0.3 × normalised_access_frequency + 0.2 × normalised_recency`. Normalise `access_count` and `last_accessed_at` to [0, 1] relative to the full scanned set.
6. For the `PROPOSE_PRUNE` bucket, sum `content_byte_length` to compute `estimated_bytes_freed`. Format this as both a raw byte count and a human-readable string (e.g. `"14.2 MB"`).
7. Sort the `PROPOSE_PRUNE` list by `age_days` descending (oldest first), then by `confidence_score` ascending (lowest confidence first) as a tiebreaker. This ordering means the most obviously stale rows appear at the top of the list.
8. Construct the prune proposal object (see Outputs). Explicitly mark the proposal with `action_required: "human_approval"` to make it unambiguous that no deletion has occurred and that a separate approved execution step is needed before any data is removed.
9. Unless `dry_run` is `true`, attach an AEE envelope (`quox.skill.prune_stale`, corr inherited from caller) and emit a VOLT evidence record with `evidence_type: prune_proposal`. Include the proposal summary (row counts, byte savings, scan timestamp) but not the full row list, to keep the evidence record compact.
10. Return the full proposal output to the calling agent.

## Outputs

- `proposal_id` (string) — ULID generated at scan time. Used to correlate this proposal with any subsequent approval and deletion operation.
- `action_required` (string) — Always `"human_approval"`. This field is present to make the non-destructive nature of the skill explicit in every consumer.
- `scanned_at` (string) — ISO 8601 UTC timestamp of the scan.
- `rows_scanned` (number) — Total memory rows evaluated.
- `propose_prune` (object[]) — Candidate rows for deletion. Each entry: `id`, `type`, `tags[]`, `age_days`, `idle_days`, `confidence_score`, `access_count`, `content_byte_length`.
- `retain_high_confidence` (object[]) — Rows past decay horizon but kept due to confidence score. Each entry includes `retention_score`.
- `retain_frequently_used` (object[]) — Rows past decay horizon but kept due to access frequency. Each entry includes `retention_score`.
- `estimated_bytes_freed` (object) — `{ raw_bytes: number, human_readable: string }`.
- `decay_horizons_applied` (object) — The resolved horizon per type used during the scan.

## Failure modes

- **Memory service unreachable (port 3103):** Return a structured error with `code: MEMORY_SERVICE_UNAVAILABLE`. Do not attempt to produce a partial proposal from cached data — a partial scan would produce an inaccurate byte-savings estimate and could lead to a flawed approval decision downstream.
- **No stale rows found:** Return a valid proposal with `propose_prune: []` and `estimated_bytes_freed: { raw_bytes: 0, human_readable: "0 B" }`. This is an expected outcome for a healthy, recently-pruned memory store and should not be treated as an error.
- **Missing confidence scores:** If a row has no `confidence_score` stored, treat it as `0.5` for classification and log a count of affected rows in the proposal metadata. A high proportion of unscored rows indicates the memory ingestion pipeline is not recording confidence, which should be escalated separately.
- **Decay horizon config missing for a type:** If a memory type has rows but no configured decay horizon (neither system default nor override), skip those rows and list the affected type under `skipped_types` in the proposal. Do not silently assign an arbitrary horizon — unknown horizon means unknown risk.
- **Scan exceeds 30 seconds:** Abort the scan, return a partial proposal with `scan_truncated: true` and the number of rows processed before timeout. The calling agent should schedule a narrower scan (e.g. single memory type or single user) rather than retrying the full scan immediately.

## Notes

This skill is strictly read-only and non-destructive. It produces a proposal — it does not delete, archive, or modify any memory row. The `proposal_id` in the output is intended to be passed to a separate deletion workflow that requires explicit operator approval before execution. Implementing approval-gated deletion as a distinct step ensures that automated housekeeping cannot silently remove memories that a human might consider important, and it provides a clear audit trail: the VOLT evidence record for the proposal can be cross-referenced against any subsequent deletion evidence record. When scheduling this skill in a recurring workflow, consider running it during low-traffic windows to minimise contention on the memory service's SQLite write lock.
