---
name: vault-secret-rotate
license: LicenseRef-SkillRights-Reserved-1.0
category: security
version: 1.0.0
edition: stable
author: quox-core
description: Rotate a named secret in the Quox org-scoped vault, emit VOLT evidence with SHA256-prefix fingerprints of old and new values, and guarantee that secret plaintext never appears in any log, AEE envelope, or VOLT payload.
tags: [secret-rotation, vault, credential-hygiene, security, volt-evidence, fingerprint]
best_for_agents: [horus, auditus]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: ["security:secret-rotation"]
policy_required: []
kind: procedural
---

# Vault Secret Rotate

## When to apply

Apply this skill whenever a named secret in the Quox org-scoped vault must be replaced with a new value — on a scheduled rotation cadence, after a suspected exposure event, on credential expiry, or as part of a post-incident remediation runbook. Typical callers: HORUS executing an automated 90-day rotation policy, AUDITUS fulfilling a compliance-driven rotation mandate, or a workflow triggered by a VOLT evidence record flagging an aged credential. Do not apply outside an active workflow execution context — the AEE `corr` id is required for the evidence trail.

## Inputs

- `secret_name` (string) — The name of the secret in the org-scoped vault (e.g. `db/prod/password`, `api/stripe/key`). Required.
- `new_value` (string) — The new plaintext secret value. Required. This value MUST be sourced from the agent's secure credential context or a trusted generator — never embedded as a literal in a workflow definition. It is consumed in memory and never written to any log.
- `rotation_reason` (string, optional) — Human-readable explanation for the rotation (e.g. `scheduled-90d`, `post-incident`, `compliance-mandate`). Included in the VOLT evidence payload. Default: `unspecified`.
- `notify_dependents` (boolean, optional) — If `true`, emit a rotation-notification AEE event to registered consumers of this secret so they can reload their credential. Default: `false`.
- `dry_run` (boolean, optional) — If `true`, validate that the secret exists and compute fingerprints, but do not write the new value. Useful for pre-flight checks. Default: `false`.

## Steps

1. Validate that `secret_name` is non-empty and matches the vault naming convention (`<namespace>/<env>/<identifier>`). Abort with `error: invalid_secret_name` if the format is not met.
2. Fetch the current secret value from the org-scoped vault using `secret_name`. Compute `old_fingerprint` as the first 8 hex characters of `SHA256(current_value)`. Store the raw value only in ephemeral memory — never in any variable that is serialised, logged, or included in an AEE payload.
3. If the vault returns `not_found`, abort with `error: secret_not_found` and surface the secret name for operator review. Do not create secrets via this skill — use the vault provisioning flow instead.
4. Compute `new_fingerprint` as the first 8 hex characters of `SHA256(new_value)`. Verify that `new_fingerprint` differs from `old_fingerprint`; if they are identical, abort with `error: identical_value` to prevent a no-op rotation being recorded as compliant.
5. If `dry_run` is `true`, return `{ dry_run: true, old_fingerprint, new_fingerprint, secret_name }` and stop. No vault write occurs.
6. Write the new secret value to the org-scoped vault under `secret_name`, incrementing the vault version counter. Record the new `vault_version` from the vault response.
7. Zero-fill the ephemeral variables holding `current_value` and `new_value` immediately after the write completes. The raw values must not persist beyond this step.
8. Emit a VOLT evidence record with `evidence_type: secret_rotation`, fields: `{ secret_name, old_fingerprint, new_fingerprint, vault_version, rotation_reason, rotated_at }`. The VOLT body MUST NOT include the plaintext old or new values — only fingerprints.
9. Attach an AEE envelope to the current execution context (field `quox.skill.vault_secret_rotate`, `corr` inherited from caller) referencing the VOLT evidence record id.
10. If `notify_dependents` is `true`, emit an AEE event of type `secret.rotated` to all registered consumers for `secret_name`, carrying only `{ secret_name, vault_version, rotated_at }` — no fingerprints, no values.

## Outputs

- `secret_name` (string) — The rotated secret's name.
- `old_fingerprint` (string) — SHA256-prefix (8 hex chars) of the previous secret value.
- `new_fingerprint` (string) — SHA256-prefix (8 hex chars) of the new secret value.
- `vault_version` (integer) — The vault version number assigned to the new value.
- `rotation_reason` (string) — The reason recorded in the VOLT evidence.
- `rotated_at` (string) — ISO 8601 UTC timestamp of the vault write.
- `volt_evidence_id` (string) — The ULID of the emitted VOLT evidence record.
- `dependents_notified` (boolean) — Whether consumer notification was attempted.

## Failure modes

- **SECRET_NOT_FOUND:** The vault has no entry for `secret_name`. Return `error: secret_not_found` with the secret name. Do not create the secret. Surface to the operator for provisioning review.
- **IDENTICAL_VALUE:** The SHA256 fingerprint of `new_value` matches `old_fingerprint`. Return `error: identical_value`. This prevents a no-op rotation from being recorded as a completed compliance event, which would produce a misleading audit trail.
- **VAULT_WRITE_FAILURE:** The vault service returned an error during the write. Return `error: vault_write_failure` with the vault error code. The old secret remains active; do not emit a VOLT success record. Retry is the caller's responsibility.
- **VOLT_EMIT_FAILURE:** The VOLT evidence endpoint rejected the record. The vault write has already completed. Return `error: volt_emit_failure` and include the new `vault_version` so the operator can manually record evidence. The rotation is functionally complete but the audit trail is incomplete.
- **PLAINTEXT_LEAK_GUARD:** If any serialisation or logging path would include the raw secret value, the skill must abort with `error: plaintext_leak_guard` before writing. This is a hard invariant — a failed rotation is always preferable to a logged plaintext secret.

## Notes

The SHA256-prefix fingerprint approach (`first8(SHA256(value))`) is intentionally short — it is sufficient to confirm identity for audit purposes while providing no meaningful dictionary attack surface for an attacker who reads the VOLT ledger. Full SHA256 hashes are not stored to reduce the incentive for hash-cracking attempts against weak secrets. The org-scoped vault is addressed exclusively by secret name and version; there is no path or folder hierarchy exposed to this skill. All vault interactions use the agent's scoped service account, which must have `vault:write` permission for the target secret namespace. WARD policy `security:secret-rotation` is satisfied by a successful VOLT emission — downstream compliance checks query the VOLT ledger, not this skill directly.
