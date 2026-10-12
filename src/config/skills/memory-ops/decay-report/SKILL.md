---
name: decay-report
license: LicenseRef-SkillRights-Reserved-1.0
category: memory/operations
version: 1.0.0
edition: stable
author: quox-core
description: Compute distribution of memory ages and access frequency across Quox memory types and emit a tierable report covering decay health, hotspot patterns, and per-type retention risk.
tags: [memory-analytics, decay-distribution, access-frequency, retention-risk, memory-ops, observability, tierable-report]
best_for_agents: [keeper]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Decay Report

## When to apply

Use this skill when an agent, operator, or automated monitoring workflow needs a structured view of memory health across the organisation. Typical triggers: a weekly observability digest is scheduled to run, an operator asks "how is our memory store ageing?", a memory quota alert fires and the operator wants to understand which types are growing fastest, or a governance audit requires evidence of memory lifecycle management. Apply before any decision to adjust decay horizons or trigger a prune cycle — this report provides the distribution data needed to calibrate those decisions.

## Inputs

- `org_id` (string) — Organisation identifier. Required for tenant isolation; sourced from the caller's JWT claims.
- `user_id` (string, optional) — Restrict the report to a single user's memories within the org. When omitted, covers all users in the org if the caller has org-admin permission.
- `memory_types` (string[], optional) — Limit the report to a subset of types: `fact`, `preference`, `decision`, `constraint`, `observation`, `entity`, `error/fix`. Default: all types.
- `age_buckets_days` (number[], optional) — Day boundaries for age distribution buckets. Default: `[7, 30, 90, 180, 365]`, which creates buckets `0–7d`, `8–30d`, `31–90d`, `91–180d`, `181–365d`, and `>365d`.
- `access_buckets` (number[], optional) — Access-count boundaries for frequency distribution buckets. Default: `[0, 1, 5, 20, 100]`, creating buckets `0`, `1`, `2–5`, `6–20`, `21–100`, and `>100`.
- `include_samples` (boolean, optional) — When `true`, include up to 3 representative row samples per age bucket per type. Samples are the rows with the lowest composite retention score in each bucket, giving the operator a concrete sense of what is at risk. Default: `false`.

## Steps

1. Query the memory service (port 3103) for all rows matching `org_id`, optional `user_id`, and `memory_types`. Retrieve: `id`, `type`, `tags`, `created_at`, `last_accessed_at`, `access_count`, `confidence_score`, `content_byte_length` (or `length(content)`).
2. Record the report generation timestamp (`generated_at`) in ISO 8601 UTC. Compute `age_days` and `idle_days` for every row relative to `generated_at`.
3. For each memory type, build the age distribution: assign each row to the appropriate age bucket defined by `age_buckets_days`. Record `count` and `total_bytes` per bucket. Also record `median_age_days` and `p95_age_days` for the type overall.
4. For each memory type, build the access-frequency distribution: assign each row to the appropriate access bucket defined by `access_buckets`. Record `count` per bucket.
5. Compute per-type retention risk: load the configured decay horizon for each type. Calculate what fraction of rows have already exceeded their horizon (`decay_exceeded_pct`). Classify each type's risk tier:
   - `GREEN` — fewer than 10 % of rows past decay horizon.
   - `AMBER` — 10 %–40 % of rows past decay horizon.
   - `RED` — more than 40 % of rows past decay horizon.
6. Identify access hotspots: rows with `access_count` in the top 5 % of the full scanned set. Record the count and top-5 tags appearing across those rows. This surfaces topics the organisation accesses frequently, which is useful for capacity planning and cache-warming decisions.
7. If `include_samples` is `true`, select up to 3 rows per age bucket per type with the lowest composite retention score (`0.5 × confidence_score + 0.3 × normalised_access_frequency + 0.2 × normalised_recency`). Include `id`, `type`, `tags`, `age_days`, `idle_days`, `access_count`, and `confidence_score` for each sample — never include raw `content` in the report.
8. Assemble the full report object (see Outputs).
9. Attach an AEE envelope (`quox.skill.decay_report`, corr inherited from caller). Emit a VOLT evidence record with `evidence_type: decay_distribution` containing the per-type risk tiers, `generated_at`, and row counts. The full distribution arrays are stored in the report output, not in the VOLT record, to keep evidence compact.
10. Return the report to the calling agent.

## Outputs

- `report_id` (string) — ULID generated at report time. Use to correlate this report with any subsequent prune proposal or decay-horizon adjustment.
- `generated_at` (string) — ISO 8601 UTC timestamp.
- `rows_analysed` (number) — Total memory rows included in the analysis.
- `total_bytes` (number) — Sum of `content_byte_length` across all scanned rows.
- `per_type` (object[]) — One entry per memory type containing:
  - `type` (string) — Memory type name.
  - `row_count` (number) — Total rows of this type.
  - `total_bytes` (number) — Storage used by this type.
  - `decay_horizon_days` (number) — Configured horizon for this type.
  - `decay_exceeded_pct` (number) — Percentage of rows past their horizon.
  - `risk_tier` (`"GREEN"` | `"AMBER"` | `"RED"`) — Decay health classification.
  - `median_age_days` (number) — Median age in days.
  - `p95_age_days` (number) — 95th-percentile age in days.
  - `age_distribution` (object[]) — Bucket label, count, and total_bytes per age bucket.
  - `access_distribution` (object[]) — Bucket label and count per access-frequency bucket.
  - `samples` (object[] | null) — Representative low-retention-score samples when `include_samples` is `true`; `null` otherwise.
- `hotspots` (object) — `{ top_tags: string[], hotspot_row_count: number, hotspot_threshold_access_count: number }`.
- `summary_tiers` (object) — Aggregate counts: `{ green: number, amber: number, red: number }` across all types.

## Failure modes

- **Memory service unreachable (port 3103):** Return a structured error with `code: MEMORY_SERVICE_UNAVAILABLE`. Do not attempt to generate a partial report — an incomplete distribution would misrepresent risk tiers and could lead to incorrect decay-horizon decisions.
- **Empty memory store:** Return a valid report with all counts at zero and every type classified as `GREEN`. This is expected for a newly provisioned org and should not be treated as an error. The `generated_at` timestamp and row count of zero are sufficient evidence for a compliance audit showing the store was checked.
- **Missing confidence scores on a significant portion of rows:** If more than 20 % of rows lack a `confidence_score`, emit a warning in the report metadata (`low_confidence_coverage: true`). Risk tier calculations proceed using `0.5` as the default, but the caller should be aware that retention-score samples may be unreliable.
- **Custom age buckets out of order:** If the caller supplies `age_buckets_days` that are not strictly ascending, return a structured validation error with `code: INVALID_INPUT` and a message listing the offending values. Do not silently reorder — the caller's intent may differ from the corrected order.
- **Report generation exceeds 60 seconds:** Abort, return a structured error with `code: REPORT_TIMEOUT` and the count of rows processed. The caller should retry with a narrower `memory_types` filter or a scoped `user_id` rather than repeating the full org-wide scan.

## Notes

This skill is strictly read-only. It makes no changes to the memory store. The risk tiers (`GREEN`, `AMBER`, `RED`) are advisory signals intended to guide human decisions about whether to run a prune cycle or adjust decay horizons — they do not trigger any automated action. For organisations with very large memory stores (millions of rows), consider running this report against a single memory type per invocation and aggregating results in the calling workflow, rather than issuing a full org scan in a single call. The VOLT evidence record emitted at step 9 satisfies the `memory:lifecycle-audit` policy track when that track is enabled for the org, providing a durable timestamp showing that decay health was reviewed.
