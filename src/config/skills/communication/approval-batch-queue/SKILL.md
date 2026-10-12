---
name: approval-batch-queue
license: LicenseRef-SkillRights-Reserved-1.0
category: communication
version: 1.0.0
edition: stable
author: quox-core
description: Group pending approval items by similarity and SLA deadline, then emit a single batch-approval inbox card and a VOLT evidence record so reviewers can act on related items together.
tags: [approvals, batching, sla, inbox-card, volt-evidence, hitl, workflow-efficiency]
best_for_agents: [action-q]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Approval Batch Queue

## When to apply

Use this skill when multiple pending approval items accumulate in the Quox inbox and issuing one card per item would overwhelm the reviewer. Apply it on a scheduled basis (e.g. every 15 minutes for the `approvals` lane) or when the pending count for a given similarity cluster exceeds a configurable threshold. This skill is appropriate for items whose approval decision is unlikely to differ based on slight contextual variations — routine deployments, recurring spend approvals, and standard access grants are good candidates. Do not batch items tagged `critical` urgency, items with active SLA breach warnings, or items that require individual evidence review before a decision can be made. The output of this skill is a single inbox card that links to all constituent items; it does not close or supersede the underlying items until the batch decision is recorded.

## Inputs

- `pending_items` (array of object) — List of pending approval items to consider for batching. Each item must include `{ id, title, urgency_tier, sla_deadline_at, item_type, org_id, requested_by }`. Required. Minimum 2 items.
- `org_id` (string) — Identifier of the org whose batching policy governs the operation. Required.
- `similarity_key` (string, optional) — Field name to use as the primary clustering key (e.g. `"item_type"`, `"requested_by"`, `"workflow_id"`). Default: `"item_type"`.
- `max_batch_size` (number, optional) — Maximum number of items in a single batch card. Default: `20`.
- `sla_buffer_minutes` (number, optional) — Items whose `sla_deadline_at` is within this many minutes of now are excluded from batching and escalated individually. Default: `60`.
- `corr` (string, optional) — AOCL correlation id inherited from the calling context. Passed into the emitted AEE envelope.

## Steps

1. Validate `pending_items`. Reject any item missing `id`, `urgency_tier`, or `sla_deadline_at`. Record rejected item ids in `items_rejected` with reason `"missing_required_fields"`. Proceed with the remaining valid items.

2. Filter out ineligible items. Remove any item where `urgency_tier` is `"critical"` or where `sla_deadline_at` is within `sla_buffer_minutes` of the current timestamp. Record filtered-out item ids in `items_escalated_individually` so callers can dispatch them via standard single-item routing.

3. Cluster the remaining items by `similarity_key`. Items that share the same value for the chosen key form a cluster. If a cluster has only one item after filtering, pass that item through to `items_escalated_individually` — a single-item batch offers no efficiency benefit.

4. Enforce `max_batch_size`. If any cluster exceeds `max_batch_size`, split it into sub-batches of at most `max_batch_size` items each, ordered by `sla_deadline_at` ascending so the soonest-due items appear first in each sub-batch.

5. For each resulting batch, compute the batch's effective SLA deadline as the earliest `sla_deadline_at` among its members. Record the `urgency_tier` of the batch as the highest urgency present (`critical > high > normal > low`), excluding critical items already filtered in Step 2.

6. Construct the batch-approval inbox card payload for each batch: `{ batch_id: <new ULID>, item_ids: [...], item_count: N, cluster_key: <similarity_key value>, effective_urgency_tier: <computed>, effective_sla_deadline_at: <earliest>, org_id, requested_by_list: [<unique requestors>] }`.

7. Emit a VOLT evidence record for each batch with `evidence_type: "approval_batch"`, attaching the `batch_id`, `item_ids`, `cluster_key`, and `effective_sla_deadline_at`. This record satisfies the audit trail requirement for batched approvals.

8. Emit an AEE envelope for each batch card: `intent: "quox.hitl.batch_approval"`, `payload: { inbox_lane: "approvals", priority: <effective_urgency_tier>, corr: <corr>, batch_id: <batch_id>, item_count: N }`.

9. Return the full output object (see Outputs).

## Outputs

- `batches` (array of object) — Each entry describes one emitted batch card: `{ batch_id, item_ids, item_count, cluster_key, effective_urgency_tier, effective_sla_deadline_at, volt_evidence_id, aee_envelope_emitted }`.
- `items_escalated_individually` (array of string) — Item ids excluded from batching (critical urgency, SLA-breach-imminent, or singleton clusters) that must be routed as individual items.
- `items_rejected` (array of `{ id, reason }`) — Items that failed input validation.
- `batch_count` (number) — Total number of batch cards emitted.
- `total_items_batched` (number) — Sum of items across all emitted batches.

## Failure modes

- **Fewer than two eligible items:** If filtering and validation leave fewer than two items eligible for batching, return `error: "insufficient_items_to_batch"` and populate `items_escalated_individually` with all remaining items so they are not lost. Do not emit any batch card.
- **All items are critical or SLA-imminent:** If every item in `pending_items` is filtered out at Step 2, return `error: "all_items_require_individual_routing"` and populate `items_escalated_individually` with the full input list. This is not a failure of the calling workflow — it is an expected outcome when all pending approvals are time-sensitive.
- **VOLT evidence emission failure:** If the VOLT record cannot be written, set `volt_evidence_id: null` on the affected batch and surface `warn: "volt_evidence_not_written"`. The batch card should still be emitted — the absence of a VOLT record is a compliance gap but must not block reviewer access to the items.
- **AEE envelope emission failure:** Set `aee_envelope_emitted: false` on the affected batch and include `warn: "aee_envelope_emit_failed"`. The batch output object is still returned so the caller can retry envelope emission without re-running the full batching logic.
- **similarity_key not present on items:** If the chosen `similarity_key` field is absent on all items, fall back to clustering by `"item_type"`, set `similarity_key_fallback: true` in the output, and record the original key that was requested. Never abort — a fallback cluster is always preferable to no batching at all.

## Notes

The `approval_batch` VOLT evidence type is the audit anchor for this operation. Any reviewer who approves or rejects a batch card must record their decision against the `batch_id`, which allows the evidence layer to resolve the decision back to every constituent item id. Downstream consumers of the batch decision must be aware that a single batch card approval does not individually close each item — they must use the `item_ids` list to dispatch per-item closure events. The `sla_buffer_minutes` default of 60 minutes reflects the SLA windows for the `high` tier (4h) and `normal` tier (24h); adjust it down for orgs with tighter SLA commitments. Items of `urgency_tier: low` with SLA windows of 72h are ideal batching candidates and will generally survive the SLA filter unless they have been sitting in the queue for over 71 hours without attention.
