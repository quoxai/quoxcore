---
name: aocl-correlation-trace
license: LicenseRef-SkillRights-Reserved-1.0
category: observability/trace
version: 1.0.0
edition: stable
author: quox-core
description: Given a root correlation id, Quox walks all parent and child correlation links to build the complete causal tree of AOCL envelopes, annotated with depth and layer traversal order.
tags: [aocl, causality-tree, envelope-correlation, parent-child-walk, trace-reconstruction, root-cause, causal-graph]
best_for_agents: [insight]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# AOCL Correlation Trace

## When to apply

Use this skill when you have a single correlation id and need to understand the full causal history of the execution it belongs to — not just the envelopes that share that exact `corr`, but every ancestor and descendant envelope linked via `reply_to` chains. Typical triggers: a failed workflow run needs root-cause analysis spanning multiple delegated subtasks; a governance review requires proof that a particular action was authorised by a specific upstream policy envelope; an agent loop is suspected of spawning unintended child executions that need to be mapped. Apply this skill after `aocl-trace-query` if initial inspection reveals parent or child `corr` references that need to be followed.

## Inputs

- `root_corr_id` (string) — The starting correlation id. The walk begins by retrieving all envelopes for this corr, then expands outward along `reply_to` links to discover parents, and inward along child `corr` references to discover descendants. Required.
- `direction` (`"both"` | `"ancestors"` | `"descendants"`) — Which direction to walk. Default: `"both"`.
- `max_depth` (number, optional) — Maximum number of hops to follow in either direction. Default: `10`. Hard ceiling: `50`. Prevents runaway walks in deeply nested delegation chains.
- `layer_filter` (array of strings, optional) — Restrict which envelopes are included in the output tree. Same valid values as `aocl-trace-query`. Summary counts always reflect the full walk; this filter affects only the returned envelope records.
- `include_payload` (boolean, optional) — Include full `payload` objects in returned envelopes. Default: `false`.

## Steps

1. Validate `root_corr_id` is a non-empty string and `direction` is one of `"both"`, `"ancestors"`, `"descendants"`. If either check fails, emit an argument error and halt.
2. Call `aocl-trace-query` with `corr_id = root_corr_id`, `include_payload = include_payload`. This retrieves the seed envelope set for the root corr.
3. If `direction` includes `"ancestors"`: identify the envelope in the seed set with `reply_to = null` (the root of this corr). If its `id` or `corr` links to a parent envelope in a different corr (i.e. the current corr was itself spawned by an upstream action), extract the parent `corr` from that link and call `aocl-trace-query` recursively for the parent corr. Repeat until `reply_to` is null and no further parent corr is referenced, or `max_depth` is reached.
4. If `direction` includes `"descendants"`: scan all envelopes in the seed set for outbound references — fields where a child workflow or agent invocation recorded a child `corr` in its payload or metadata. For each discovered child `corr`, call `aocl-trace-query` recursively. Repeat until no new corr references are found, or `max_depth` is reached.
5. Deduplicate: if the same `corr` is discovered via multiple paths, merge its envelope list rather than duplicating the node.
6. Assemble the causal tree structure: each node represents one `corr` and contains its `envelopes` (filtered by `layer_filter` if set), `depth` (relative to `root_corr_id`, negative for ancestors, positive for descendants), `parent_corr` (string or null), and `child_corrs` (array of strings).
7. Compute summary statistics for the full tree: total envelope count, unique layer set, depth range, walk duration. Emit output (see Outputs) and record an AEE envelope tagged `quox.skill.aocl_correlation_trace` on the root corr.

## Outputs

- `root_corr_id` (string) — The starting correlation id as provided.
- `tree` (array of node objects) — All discovered corr nodes, ordered breadth-first from root. Each node:
  - `corr` (string) — Correlation id for this node.
  - `depth` (number) — 0 for root, negative for ancestors, positive for descendants.
  - `parent_corr` (string | null) — The corr this node was spawned from, or null for the top-level ancestor.
  - `child_corrs` (array of strings) — Corrs directly spawned by this node.
  - `envelope_count` (number) — Total envelopes for this corr (before layer filter).
  - `envelopes` (array) — Envelope records matching `layer_filter` (or all if no filter). Each record: `id`, `ts`, `layer`, `from`, `to`, `intent`, `reply_to`, and optionally `payload`.
  - `earliest_ts` (string) — ISO 8601 UTC timestamp of the first envelope in this corr.
  - `latest_ts` (string) — ISO 8601 UTC timestamp of the last envelope in this corr.
- `total_corr_count` (number) — Total distinct corr nodes in the tree.
- `total_envelope_count` (number) — Total envelopes across all nodes (before layer filter).
- `depth_range` (object) — `min` (deepest ancestor depth) and `max` (deepest descendant depth).
- `max_depth_reached` (boolean) — `true` if the walk was stopped by `max_depth` before all links were exhausted.
- `walk_latency_ms` (number) — Total time to complete all underlying `aocl-trace-query` calls.

## Failure modes

- **Unknown root_corr_id:** No envelopes found for the provided `root_corr_id`. Return a `tree` with a single node at depth 0 with `envelope_count: 0`. This is not an error — surface a warning in the output noting the corr may have been pruned from the store's retention window.
- **max_depth exceeded:** The walk reaches `max_depth` before the chain terminates naturally. Set `max_depth_reached: true` and return all nodes discovered up to that point. Include a note in the result indicating that the tree may be incomplete; the caller should increase `max_depth` or query specific child corrs manually.
- **Circular corr reference detected:** A child corr links back to an ancestor corr already in the tree, forming a cycle. Halt that branch of the walk, record the offending link in a `cycle_warnings` array on the output, and continue with other branches. Never enter an infinite walk loop.
- **Partial trace store availability:** One or more underlying `aocl-trace-query` calls fail (store shard unreachable). Record each failure as a `failed_corr_lookups` entry with the corr id and error reason. Return all successfully retrieved nodes and set `partial: true` on the output so the caller knows the tree is incomplete.
- **Oversized tree:** The computed tree exceeds an internal memory budget (sum of all envelope payloads over 20 MB). When `include_payload: true` triggers this, automatically retry the walk with `include_payload: false`, add a `payload_omitted_due_to_size: true` flag to the output, and warn the caller to re-query specific corrs individually if payload inspection is needed.

## Notes

This skill depends on `aocl-trace-query` as its underlying envelope-retrieval primitive — every corr node in the tree is populated by a call to that skill. The quality and completeness of the causal tree is therefore bounded by the trace store's retention policy and indexing coverage. The `reply_to` field on individual envelopes within a corr links one envelope to another within the same corr; cross-corr parent links are discovered from metadata recorded by the quoxflow execution engine when it spawns a delegated subtask. If a child corr was created outside quoxflow (e.g. a direct API call), its parent link may not be recorded and it will not appear in the descendant walk. In that case, a manual `aocl-trace-query` with the child `corr_id` is required. For large fleet-wide governance audits, prefer bounded `direction: "descendants"` walks from a known root workflow corr rather than unbounded `"both"` walks, to keep walk latency predictable.
