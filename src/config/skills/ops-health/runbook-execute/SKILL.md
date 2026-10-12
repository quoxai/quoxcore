---
name: runbook-execute
license: LicenseRef-SkillRights-Reserved-1.0
category: ops/health
version: 1.0.0
edition: stable
author: quox-core
description: Walks a named runbook's steps in sequence, logging per-step status and gating any step tagged requires_approval via a HITL inbox item before proceeding.
tags: [runbook-automation, hitl-gate, step-execution, ops-procedure, approval-workflow]
best_for_agents: [nova]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Runbook Execute

## When to apply

Use this skill when an agent has been asked to execute a named operational runbook — a documented, ordered sequence of steps for a known procedure (e.g. service restart, failover initiation, backup verification, certificate rotation). Apply when the runbook already exists in the Quox runbook registry; if no matching runbook is found, do not improvise steps — surface the missing-runbook condition instead. This skill is the canonical path for any procedure that needs an audit trail of each step's outcome and human sign-off on risky sub-operations.

## Inputs

- `runbook_name` (string) — Name or slug of the runbook to execute (must match an entry in the Quox runbook registry). Required.
- `runbook_version` (string, optional) — Pin to a specific version. Default: latest published version.
- `context` (object, optional) — Key-value substitution map for template variables in the runbook steps (e.g. `{ "target_host": "docker01", "service": "collector" }`). Variables in step definitions are referenced as `{{context.target_host}}`.
- `dry_run` (boolean, optional) — If `true`, log what each step would do without executing external actions. Default: `false`.
- `approver_user_id` (string, optional) — User ID to route HITL approval requests to. If omitted, the HITL request is broadcast to the org's on-call inbox.
- `timeout_per_step_ms` (number, optional) — Maximum wall-clock time for any single step before it is marked `timed_out`. Default: `60000`.

## Steps

1. Look up `runbook_name` (and `runbook_version` if provided) in the Quox runbook registry (currently served from the collector's `/api/runbooks/<name>` endpoint). If not found, abort with `error: "runbook_not_found"` and list available runbook names for context.
2. Resolve `context` variables: substitute all `{{context.<key>}}` placeholders in each step definition with values from the `context` input map. If a required variable is missing, abort with `error: "missing_context_variable"` naming the first unresolved placeholder.
3. Emit an AEE envelope marking the runbook execution as started (`quox.skill.runbook_execute.started`, status `in_progress`). Record `execution_id` (ULID), `runbook_name`, `runbook_version`, `started_at`.
4. Iterate over each step in the runbook definition in order. For each step:
   a. Check `requires_approval: true` on the step definition. If set AND `dry_run` is `false`, create a HITL inbox item (via the collector's `/api/hitl/items` endpoint) with: the step description, `context` substituted preview, `approver_user_id` (or on-call broadcast), and a deadline of `timeout_per_step_ms`. Block until the HITL item is either `approved` or `rejected`.
      - If `rejected`: mark the step `skipped_by_operator`, log the rejection reason, and abort the runbook with `status: "halted_by_operator"`. Do not execute any remaining steps.
      - If `dry_run: true`: skip the HITL gate and log `[dry-run] approval would be requested here`.
   b. Execute the step action: the step definition specifies an `action_type` (`shell_command`, `http_call`, `agent_delegate`, or `log_only`). Execute accordingly, respecting `timeout_per_step_ms`.
   c. Record the step result: `{ step_index, step_name, action_type, status, output_preview, duration_ms, started_at, finished_at }`. Status is one of `success`, `failed`, `timed_out`, `skipped_by_operator`.
   d. If the step's `on_failure` policy is `abort` (default) and the step status is `failed` or `timed_out`, stop iteration and set the runbook's overall status to `failed`.
   e. If `on_failure` is `continue`, log the failure and proceed to the next step.
5. After all steps complete (or execution is halted), emit an AEE envelope marking the runbook as finished (`quox.skill.runbook_execute.finished`) with overall `status` and `step_results`. Attach a VOLT evidence record with `evidence_type: runbook_execution` containing the full step log.

## Outputs

- `execution_id` (string) — ULID for this execution instance, for cross-referencing in audit logs.
- `runbook_name` (string) — The resolved runbook name.
- `runbook_version` (string) — The version that was executed.
- `status` (`"success"` | `"failed"` | `"halted_by_operator"` | `"dry_run_complete"`) — Overall execution outcome.
- `step_results` (array) — Ordered list of `{ step_index, step_name, action_type, status, output_preview, duration_ms, started_at, finished_at, approval_decision? }`.
- `steps_total` (number) — Total number of steps in the runbook.
- `steps_completed` (number) — Steps that reached `success` or `skipped_by_operator`.
- `steps_failed` (number) — Steps that ended in `failed` or `timed_out`.
- `started_at` (string) — ISO 8601 UTC timestamp when execution began.
- `finished_at` (string) — ISO 8601 UTC timestamp when execution concluded.
- `dry_run` (boolean) — Whether this was a dry-run pass.

## Failure modes

- **Runbook not found:** Abort immediately with `error: "runbook_not_found"`, include a list of available runbook names returned by the registry. Do not attempt to infer steps.
- **Missing context variable:** Abort before any step executes with `error: "missing_context_variable"`, naming each unresolved `{{context.<key>}}` placeholder in the runbook. Prompt the caller to supply missing values.
- **HITL approval rejected:** Halt the runbook at the rejected step. Set overall `status: "halted_by_operator"`. The `step_results` entry for the gated step includes `approval_decision: "rejected"` and the rejection reason if the approver supplied one. Subsequent steps are not executed.
- **Step timeout:** Mark the step `timed_out`, increment `steps_failed`. If `on_failure` is `abort` (the default), halt the runbook with `status: "failed"`. Emit a VOLT evidence record flagging the timed-out step for post-mortem.
- **HITL service unreachable:** If the collector's HITL endpoint returns a non-2xx response or is unreachable, abort the runbook with `error: "hitl_service_unavailable"`. Never bypass the approval gate due to a connectivity issue — fail safe.

## Notes

The runbook registry is currently backed by the collector's `/api/runbooks` endpoint, which stores runbook definitions as versioned JSON documents. When a new runbook needs to be registered, it must be authored in the registry separately before this skill can execute it. The `context` substitution at Step 2 is intentionally done before any step executes so that a bad variable reference fails fast rather than mid-execution. The VOLT evidence attachment at Step 5 satisfies the `ops:runbook-audit` policy track when enabled for the org, providing a tamper-evident record of what ran, who approved risky steps, and what each step produced.
