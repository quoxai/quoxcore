---
name: proxmox-vm-action
license: LicenseRef-SkillRights-Reserved-1.0
category: infra
version: 1.0.0
edition: stable
author: quox-core
description: Perform a Proxmox VM lifecycle action (start, stop, reboot, migrate, snapshot) with pre-flight cluster checks, per-step AOCL envelopes, and HITL gating for destructive operations.
tags: [proxmox, vm-lifecycle, cluster, migration, snapshot, hitl]
best_for_agents: [janus]
required_tools: []
required_capabilities: [ssh.exec, hitl.request]
related_skills:
  - { skill_name: backup-verify, relation: composes }
delegate_targets: []
policy_satisfies: [ops:change-control, infra:vm-audit]
policy_required: [hitl:destructive-action]
kind: procedural
---

# Proxmox VM Action

## When to apply

Use this skill when an operator or automation needs to perform a lifecycle action on a Proxmox virtual machine: starting a stopped VM, stopping or rebooting a running VM, live-migrating a VM to another node, or taking a named snapshot. Apply pre-flight checks before every invocation; never issue the action without first confirming cluster state and resource headroom. For `stop`, `destroy`, and `migrate` actions, HITL approval is mandatory.

## Inputs

- `cluster` (string) — Proxmox cluster name or primary node hostname to target. Required.
- `vmid` (number) — Proxmox VM ID. Required.
- `action` (string) — One of `start`, `stop`, `reboot`, `migrate`, `snapshot`. Required.
- `target_node` (string, optional) — Destination node hostname; required when `action` is `migrate`.
- `snapshot_name` (string, optional) — Snapshot label; required when `action` is `snapshot`. Must be alphanumeric + hyphens, max 40 characters.
- `force_stop` (boolean, optional) — For `stop` action: issue a hard power-off instead of graceful ACPI shutdown. Default: `false`. Treated as a destructive variant — requires HITL approval even if the VM is already non-responsive.
- `hitl_requester` (string, optional) — Identifier of the user or agent requesting HITL approval. Default: calling agent ID.

## Steps

1. Resolve the Proxmox API endpoint for `<cluster>` via SSH through the bastion (`gw-01`). Confirm the API is reachable: `pvesh get /version`.
2. Fetch current VM status: `pvesh get /nodes/<node>/qemu/<vmid>/status/current`. Record `status`, `node`, `cpu`, `mem`, `maxmem`, `uptime`.
3. **Pre-flight checks** — abort with a structured error if any check fails:
   - For `start`: confirm VM is in `stopped` state; confirm target node has sufficient free memory (at least `maxmem` + 10% headroom).
   - For `stop` or `reboot`: confirm VM is in `running` state.
   - For `migrate`: confirm target node exists in the cluster (`pvesh get /nodes`), confirm target node has sufficient CPU and RAM, and confirm no active migration is already in progress for this VM.
   - For `snapshot`: confirm VM disk is not locked (`lock` field absent or empty).
4. **HITL gate** — if `action` is `stop`, `migrate`, or `snapshot` with `force_stop: true`, submit a HITL approval request to the operator's inbox before proceeding. Include: `vmid`, `action`, `current_status`, `node`, and a plain-language risk summary. Pause execution until approval is received or timeout (default 15 minutes) expires. If timeout expires without approval, abort and emit a VOLT evidence record with `evidence_type: hitl_timeout`.
5. Emit an AOCL envelope (`quox.skill.proxmox_vm_action.preflight_passed`) recording all pre-flight check results and the HITL decision (approved/skipped).
6. Issue the action via the Proxmox API:
   - `start`: `pvesh create /nodes/<node>/qemu/<vmid>/status/start`
   - `stop`: `pvesh create /nodes/<node>/qemu/<vmid>/status/stop` (append `--forceStop 1` if `force_stop` is true)
   - `reboot`: `pvesh create /nodes/<node>/qemu/<vmid>/status/reboot`
   - `migrate`: `pvesh create /nodes/<node>/qemu/<vmid>/migrate --target <target_node> --online 1`
   - `snapshot`: `pvesh create /nodes/<node>/qemu/<vmid>/snapshot --snapname <snapshot_name>`
7. Poll the task status returned by the API every 5 seconds until the task is complete or failed (max poll duration: 5 minutes for start/stop/reboot/snapshot; 30 minutes for migrate).
8. Emit a final AOCL envelope (`quox.skill.proxmox_vm_action.completed` or `.failed`) with task duration, final VM status, and any error message.
9. Return the structured result (see Outputs). Emit a VOLT evidence record with `evidence_type: vm_lifecycle_action` regardless of outcome.

## Outputs

- `vmid` (number) — The VM ID acted upon.
- `action` (string) — The action that was performed.
- `pre_flight_passed` (boolean) — Whether all pre-flight checks passed.
- `hitl_approved` (boolean | null) — `true` if HITL was approved, `false` if denied, `null` if HITL was not required.
- `task_id` (string | null) — Proxmox task ID (UPID) for the issued action; `null` if action was not issued.
- `task_status` (`"ok"` | `"failed"` | `"timeout"`) — Final task outcome.
- `vm_status_after` (string | null) — VM state after the action completes; `null` if task failed or timed out.
- `duration_ms` (number) — Wall-clock time from action issue to task completion.
- `error` (string | null) — Human-readable error message on failure; `null` on success.
- `started_at` (string) — ISO 8601 UTC timestamp when the action was issued.
- `completed_at` (string) — ISO 8601 UTC timestamp when the task resolved.

## Failure modes

- **Pre-flight check fails:** Return `pre_flight_passed: false` with a structured reason. Do not issue the action. Emit a VOLT evidence record documenting the blocked attempt.
- **HITL denied or timed out:** Abort without issuing the action. Emit VOLT evidence with `evidence_type: hitl_denied` or `hitl_timeout`. Return `task_id: null` and `task_status: "failed"`.
- **Proxmox API unreachable:** Return `error: "Proxmox API unreachable on <cluster>"`. Do not retry automatically; surface to operator.
- **Task fails mid-execution (e.g. live migration interrupted):** Record `task_status: "failed"`, capture the Proxmox task log via `pvesh get /nodes/<node>/tasks/<upid>/log`, and attach a truncated excerpt (max 2 KB) to the error field. Emit VOLT evidence.
- **Poll timeout:** If the task does not complete within the max poll duration, return `task_status: "timeout"`. The action may or may not have succeeded on the Proxmox side — the operator must verify manually.

## Notes

All Proxmox API commands are issued via `pvesh` over SSH through the bastion; direct HTTPS to the Proxmox API is blocked by CORS from the browser. The `migrate` action always requests a live migration (`--online 1`); offline migration is not supported by this skill. Snapshot names must be unique within a VM's snapshot tree — the skill does not overwrite existing snapshots. For bulk VM operations across a cluster, call this skill once per `vmid` in a QuoxFlow parallel branch. The HITL gate at Step 4 satisfies the `hitl:destructive-action` policy requirement; disabling HITL for destructive actions requires an explicit org-level policy override.
