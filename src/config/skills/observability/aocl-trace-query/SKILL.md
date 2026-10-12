---
name: aocl-trace-query
license: LicenseRef-SkillRights-Reserved-1.0
category: observability/trace
version: 1.0.0
edition: stable
author: quox-core
description: Queries the Quox AOCL trace store by correlation id or time window, returning a layer-ordered list of envelopes grouped by correlation chain.
tags: [aocl, trace-query, envelope-inspection, layer-inspection, corr-id, time-window, audit-trail]
best_for_agents: [metrics, insight, prism]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# AOCL Trace Query

## When to apply

Use this skill whenever an agent or operator needs to retrieve the raw envelope record for a known execution event. Typical triggers: a workflow run produced an unexpected result and the operator needs to inspect the full AOCL layer sequence; a scheduled observability sweep pulls recent envelopes for anomaly detection; a governance audit requires the ordered record of every envelope crossing the Execute or Verify layers within a given time range. This skill is the correct first step before any causal analysis — retrieve the raw envelopes first, then reason about their relationships.

## Inputs

- `corr_id` (string, optional) — Correlation id of the target envelope chain. When provided, the query returns all envelopes sharing this `corr` value, ordered by `ts` ascending. Mutually exclusive with `time_window`.
- `time_window` (object, optional) — Object with `from` (ISO 8601 UTC) and `to` (ISO 8601 UTC) defining the inclusive time range to scan. Returns all envelopes whose `ts` falls within the range, grouped by `corr`, each group ordered by `ts` ascending. Mutually exclusive with `corr_id`.
- `layer_filter` (array of strings, optional) — Restrict results to specific AOCL layers. Valid values: `Ingress`, `Identity`, `Policy`, `Context`, `Execute`, `Verify`, `Assemble`. Default: all layers.
- `intent_filter` (string, optional) — Wildcard-style prefix filter applied to the `intent` field (e.g. `quox.workflow.*`). Default: no filter.
- `limit` (number, optional) — Maximum number of envelopes to return. Default: `500`. Hard ceiling: `5000`.
- `include_payload` (boolean, optional) — When `true`, each envelope in the result includes its full `payload` object. When `false`, `payload` is omitted to reduce response size. Default: `false`.

## Steps

1. Validate inputs: exactly one of `corr_id` or `time_window` must be provided. If both or neither are present, emit an argument error (see Failure modes) and halt.
2. If `corr_id` is provided, query the AOCL trace store with a single-key lookup on `corr = corr_id`. Apply `layer_filter` and `intent_filter` as secondary predicates. Order results by `ts` ascending.
3. If `time_window` is provided, query the trace store with a range scan on `ts >= time_window.from AND ts <= time_window.to`. Apply `layer_filter` and `intent_filter`. Order the full result set by `ts` ascending, then group into a map keyed by `corr`, preserving the global ordering within each group.
4. Enforce the `limit` ceiling: if the raw result count exceeds `limit`, truncate and record `truncated: true` with `total_available` in the output.
5. If `include_payload` is `false`, strip the `payload` field from every envelope before building the output.
6. Compute per-group statistics: for each distinct `corr`, record `envelope_count`, `earliest_ts`, `latest_ts`, and the set of distinct `layer` values seen. Attach these as a `summary` object alongside each group.
7. Construct the output (see Outputs) and emit it. Record the query parameters, result count, and execution latency in an AEE envelope tagged `quox.skill.aocl_trace_query` on the parent corr.

## Outputs

- `query_mode` (`"corr_id"` | `"time_window"`) — Which input path was used.
- `groups` (array of objects) — Each object represents one correlation chain and contains:
  - `corr` (string) — The correlation id.
  - `summary` (object) — `envelope_count`, `earliest_ts`, `latest_ts`, `layers_seen` (array of distinct layer strings).
  - `envelopes` (array) — Ordered envelope records. Each record: `id`, `ts`, `layer`, `from`, `to`, `intent`, `reply_to`, and optionally `payload`.
- `total_envelope_count` (number) — Total envelopes returned across all groups.
- `truncated` (boolean) — `true` if results were capped at `limit`.
- `total_available` (number | null) — Estimated total matching envelopes when `truncated` is `true`; `null` otherwise.
- `query_latency_ms` (number) — Time taken to execute the trace store query.

## Failure modes

- **Missing or ambiguous input:** Both `corr_id` and `time_window` provided, or neither provided. Emit `error: "Exactly one of corr_id or time_window is required"` and halt. Do not attempt a partial query.
- **Unknown corr_id:** `corr_id` provided but no matching envelopes found in the trace store. Return an empty `groups` array with `total_envelope_count: 0`. This is not an error — the corr may be valid but older than the store's retention window. Note the possibility in output metadata.
- **Time window too wide:** `time_window` spans a range that would return more than the hard ceiling of `5000` envelopes. Set `truncated: true`, return the first `limit` envelopes ordered by `ts` ascending, and include `total_available`. The caller should narrow the window or use `corr_id` lookup for precision.
- **Invalid layer_filter value:** One or more entries in `layer_filter` do not match the seven canonical AOCL layer names. Emit `error: "Unknown layer name(s): <list>"` and halt rather than silently ignoring the filter. This prevents callers from believing a filtered result is complete when the filter was misspelled.
- **Trace store unavailable:** The backing persistence layer (Postgres mirror or collector endpoint) is unreachable. Emit `error: "AOCL trace store unavailable: <reason>"` and surface to the calling agent. Do not fall back to in-memory state, which is neither complete nor durable.

## Notes

This skill is a read-only primitive. It makes no changes to the trace store and emits no VOLT evidence records of its own — the AEE envelope at Step 7 is observability metadata only and does not constitute a governance event. For causal analysis across parent and child correlation links, use the `aocl-correlation-trace` skill, which calls this skill internally as its envelope-retrieval primitive. When querying large time windows for periodic sweeps, set `include_payload: false` and apply `layer_filter` to the layers of interest (`Execute`, `Verify`) to keep response sizes tractable. The trace store mirrors data from both the collector Postgres database and the quoxflow execution engine; queries return the merged, deduplicated view.
