---
name: volt-evidence-attach
license: LicenseRef-SkillRights-Reserved-1.0
category: compliance
version: 1.0.0
edition: stable
author: quox-core
description: Attach an evidence artefact to a VOLT envelope chain, anchoring its hash and provenance in the immutable evidence store and returning the evidence_id for downstream WARD policy evaluation.
tags: [volt, evidence, chain-of-custody, provenance, immutable-audit, compliance]
best_for_agents: [sentinel]
required_tools: []
required_capabilities: [volt.write, evidence.store]
related_skills:
  - { skill_id: ward-policy-update, relation: composes }
delegate_targets: []
policy_satisfies: [compliance:evidence-chain-of-custody]
policy_required: []
kind: procedural
---

# VOLT Evidence Attach

## When to apply

Use this skill whenever an agent or operator needs to anchor an artefact — log excerpt, screenshot, command output, uploaded file, or JSON blob — into the VOLT evidence chain so its hash and provenance are immutably recorded. Apply before any WARD policy evaluation that requires substantiating evidence, before closing a compliance finding, or when an audit trail must prove that a specific artefact was present at a specific point in time. This skill does not validate the artefact's content; it records that the artefact existed and was presented.

## Inputs

- `artefact_type` (`"file"` | `"log_excerpt"` | `"screenshot"` | `"command_output"` | `"json_blob"`) — Class of artefact being attached. Required.
- `artefact_content` (string | base64) — The artefact body. For files and screenshots, supply base64-encoded bytes. For log excerpts and command output, supply the raw text (max 1 MB). For json_blob, supply a serialised JSON string. Required.
- `artefact_filename` (string, optional) — Human-readable name for display in the evidence store. If omitted, derived from `artefact_type` + ISO timestamp.
- `execution_context_id` (string) — The AEE execution or task ID this artefact belongs to. Required. Used to link the evidence record to its parent execution envelope.
- `description` (string, optional) — Free-text description of what the artefact proves or demonstrates (max 500 characters).
- `tags` (array of strings, optional) — Free-form labels for filtering in the evidence store.
- `retention_policy` (`"standard"` | `"long-term"` | `"indefinite"`, optional) — Evidence retention class. Default: `"standard"` (90 days). `"long-term"` is 7 years. `"indefinite"` requires WARD policy approval.

## Steps

1. Validate inputs: confirm `artefact_type` is one of the allowed values and `artefact_content` is non-empty. If `execution_context_id` is absent, abort with `error: "missing_execution_context"`.
2. Compute the SHA-256 hash of `artefact_content` (after base64-decode for binary types). Store as `artefact_hash`.
3. Resolve the submitting agent identity from the active AEE envelope — capture `submitted_by_agent`, `submitted_by_org_id`, and `submitted_at` (ISO 8601 UTC).
4. Construct the VOLT evidence record:
   ```json
   {
     "evidence_type": "artefact",
     "artefact_type": "<artefact_type>",
     "artefact_hash": "<sha256>",
     "artefact_filename": "<resolved>",
     "description": "<description>",
     "execution_context_id": "<execution_context_id>",
     "submitted_by_agent": "<agent>",
     "submitted_by_org_id": "<org_id>",
     "submitted_at": "<iso_ts>",
     "retention_policy": "<retention_policy>",
     "tags": ["<tags>"]
   }
   ```
5. Write the record to the VOLT evidence store via `volt.evidence.write`. On success, the store returns an `evidence_id` (ULID) and a `chain_position` (monotonically increasing integer for this execution context).
6. Persist the artefact body to the evidence object store keyed by `evidence_id`. For `"indefinite"` retention, additionally trigger the WARD approval flow before acknowledging persistence.
7. Emit an AEE envelope with intent `quox.evidence.attached`, referencing `evidence_id` and `execution_context_id`, so downstream nodes receive the evidence identifier without re-querying the store.
8. Return `evidence_id`, `artefact_hash`, `chain_position`, and `submitted_at` to the caller.

## Outputs

- `evidence_id` (string, ULID) — Unique identifier for the evidence record in the VOLT store. Pass to WARD policy evaluation steps.
- `artefact_hash` (string) — SHA-256 hex digest of the artefact content, verifiable by any consumer.
- `chain_position` (number) — Monotonically increasing index of this record within the execution context's evidence chain.
- `submitted_at` (string) — ISO 8601 UTC timestamp of record creation.
- `artefact_filename` (string) — Resolved filename used in the evidence store.

## Failure modes

- **Missing execution context:** Abort with `error: "missing_execution_context"`. The evidence record cannot be created without a parent execution envelope — surface this to the operator for resolution.
- **Artefact too large:** If `artefact_content` exceeds 1 MB for text types or 50 MB for binary types, emit `error: "artefact_too_large"` with the actual size in bytes. Do not truncate silently.
- **VOLT store unavailable:** Emit `error: "volt_store_unavailable"` and do NOT return a partial `evidence_id`. A partial write that isn't acknowledged is worse than no write — the caller must retry.
- **Retention policy requires approval:** For `"indefinite"` retention, if WARD approval is not granted within 60 seconds, downgrade retention to `"long-term"`, emit a `retention_downgraded` warning, and proceed.

## Notes

The `evidence_id` returned by this skill is the canonical reference for all downstream WARD policy checks — pass it directly to `ward-policy-update` or any approval workflow that needs to cite the artefact. The VOLT chain is append-only; there is no skill to delete or modify an evidence record post-write. If an artefact was attached in error, use the `volt-evidence-redact` skill (marks the record as redacted without removing the hash). This skill satisfies the `compliance:evidence-chain-of-custody` policy track when enabled in the org's WARD ruleset.
