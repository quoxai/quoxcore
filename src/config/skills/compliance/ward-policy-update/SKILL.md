---
name: ward-policy-update
license: LicenseRef-SkillRights-Reserved-1.0
category: compliance
version: 1.0.0
edition: stable
author: quox-core
description: Update a WARD policy rule by diffing the change against the policy schema, surfacing affected resources, and routing to human approval when the diff loosens any constraint.
tags: [ward, policy, governance, policy-mutation, approval-gate, audit]
best_for_agents: [regula]
required_tools: []
required_capabilities: [ward.policy.read, ward.policy.write, hitl.inbox.write]
related_skills:
  - { skill_id: volt-evidence-attach, relation: composes }
delegate_targets: []
policy_satisfies: [governance:policy-mutation-audit]
policy_required: []
kind: procedural
---

# WARD Policy Update

## When to apply

Use this skill when an operator, agent, or automated compliance workflow needs to modify an existing WARD policy rule — for example, changing an allowed-IP range, adding a new resource exemption, adjusting a severity threshold, or tightening an obligation list. Do not use this skill to create a brand-new policy from scratch (use `ward-policy-create`) or to delete a policy (use `ward-policy-archive`). Apply this skill whenever a policy mutation must be tracked, diffed, and, if it loosens any constraint, reviewed by a human before taking effect.

## Inputs

- `policy_id` (string) — The WARD policy identifier to update. Required. Example: `"ward:policy:hipaa-phi-egress-block"`.
- `proposed_ruleset` (object) — The full new ruleset body as a JSON object conforming to the WARD policy schema. Required. Must include all existing fields, not just the changed ones (full-document replace semantics).
- `change_rationale` (string) — Human-readable explanation of why this change is being made (max 1000 characters). Required. Stored in the audit record regardless of outcome.
- `requested_by` (string) — Agent ID or user identity initiating the update. Required.
- `skip_approval_if_tightening_only` (boolean, optional) — If `true` and the diff contains only constraint-tightening changes (no loosening), bypass the HITL approval step and apply immediately. Default: `false`.
- `dry_run` (boolean, optional) — If `true`, compute and return the diff and affected-resource list without writing any changes or opening an approval request. Default: `false`.

## Steps

1. Fetch the current policy document from the WARD policy store using `policy_id`. If the policy does not exist, abort with `error: "policy_not_found"`.
2. Validate `proposed_ruleset` against the WARD policy JSON schema (`ward-schema-v2`). If validation fails, abort with `error: "schema_validation_failed"` and include the validation error detail. Do not proceed with an invalid ruleset.
3. Compute a structured diff between the current ruleset and `proposed_ruleset`:
   - Identify every changed field with its `before` and `after` value.
   - Classify each change as `tightening` (adds a constraint, reduces allowed scope) or `loosening` (removes a constraint, widens allowed scope).
4. Run an affected-resource scan: query the WARD resource index for all resources currently governed by this policy and return the list as `affected_resources` (resource IDs + types).
5. Determine the approval path:
   - If the diff contains any `loosening` change → **approval required**. Open a HITL inbox item via `hitl.inbox.write` with the diff, `change_rationale`, `affected_resources`, and a link to the proposed ruleset. Record the `approval_request_id`.
   - If all changes are `tightening` and `skip_approval_if_tightening_only` is `true` → skip HITL, proceed to step 7.
   - If all changes are `tightening` and `skip_approval_if_tightening_only` is `false` → still open a HITL item (for audit completeness) but mark it `advisory` rather than `blocking`.
6. If `dry_run` is `true`, return the diff, affected-resource list, approval path decision, and `approval_request_id` (if opened) — then stop. Do not write any policy changes.
7. Wait for HITL approval if the item is `blocking`. On rejection, abort with `error: "policy_update_rejected"` and include the reviewer's rejection note. On timeout (default 24 h), escalate to the org's policy-admin group.
8. Write the new ruleset to the WARD policy store, stamping `last_modified_at`, `last_modified_by`, `change_rationale`, and `approval_request_id` into the policy metadata.
9. Attach the diff as a VOLT evidence record via `volt-evidence-attach` with `artefact_type: "json_blob"` and `retention_policy: "long-term"`. Record the returned `evidence_id` in the policy metadata as `last_change_evidence_id`.
10. Emit an AEE envelope with intent `quox.policy.updated`, referencing `policy_id`, `evidence_id`, and `approval_request_id`.

## Outputs

- `policy_id` (string) — The policy that was updated (or evaluated, if dry_run).
- `diff` (array) — List of changed fields: `{ field, before, after, classification }` where `classification` is `"tightening"` or `"loosening"`.
- `affected_resources` (array) — Resource IDs and types governed by this policy.
- `approval_required` (boolean) — Whether the diff triggered an approval gate.
- `approval_request_id` (string | null) — HITL inbox item ID, or `null` if no approval was requested.
- `evidence_id` (string | null) — VOLT evidence ID for the diff artefact. `null` for dry runs.
- `applied_at` (string | null) — ISO 8601 UTC timestamp when the new ruleset was written. `null` for dry runs and pending-approval states.

## Failure modes

- **Policy not found:** Abort with `error: "policy_not_found"`, echoing `policy_id`. Do not create a new policy — use `ward-policy-create`.
- **Schema validation failed:** Abort with `error: "schema_validation_failed"` and include the structured validation error. The proposed ruleset must conform to `ward-schema-v2` before any further steps run.
- **Policy update rejected:** If the HITL reviewer explicitly rejects the change, abort with `error: "policy_update_rejected"` and include `rejection_note` from the reviewer. Record the rejection in the VOLT evidence chain.
- **HITL timeout:** If the approval window expires (default 24 h) and no escalation group is configured, abort with `error: "approval_timeout"`. Do not auto-apply a loosening change after timeout.

## Notes

This skill always writes a VOLT evidence record for every non-dry-run execution, regardless of whether the change was tightening or loosening — the audit trail is unconditional. The `skip_approval_if_tightening_only` flag is intended for automated compliance-hardening pipelines (e.g., a nightly script that closes known-bad exemptions); it must be explicitly set by the calling workflow and is logged in the audit record. Policy schema reference: `/opt/quoxcore/ward/schema/ward-schema-v2.json`.
