---
name: backup-verify
license: LicenseRef-SkillRights-Reserved-1.0
category: infra
version: 1.0.0
edition: stable
author: quox-core
description: Verify a backup completed successfully and is restorable — checks PBS/TrueNAS reports, optionally performs a mount-and-checksum dry-run, and surfaces schedule drift.
tags: [backup, pbs, truenas, restore-verification, schedule-drift, data-integrity]
best_for_agents: [janus, regula]
required_tools: []
required_capabilities: [ssh.exec, hitl.request]
related_skills:
  - { skill_name: proxmox-vm-action, relation: composes }
delegate_targets: []
policy_satisfies: [ops:backup-audit, compliance:rpo-verification]
policy_required: []
kind: procedural
---

# Backup Verify

## When to apply

Use this skill when an operator or compliance agent needs to confirm that a recent backup completed without errors and can be restored. Typical triggers: a scheduled post-backup integrity check fires, a DR drill requires restore validation, or an operator asks "is the latest backup for `<host>` healthy?" Apply before any restore operation and as part of recurring RPO/RTO compliance checks. The dry-run restore step is optional but required to satisfy `compliance:rpo-verification` policy.

## Inputs

- `backup_source` (string) — Identifier for the backup target: a PBS datastore name, a TrueNAS pool/dataset path, or a host ID whose backups are tracked. Required.
- `backup_type` (string) — One of `pbs` (Proxmox Backup Server), `truenas`, or `custom`. Determines which API/CLI is used. Required.
- `expected_schedule` (string, optional) — Cron expression describing the expected backup cadence (e.g. `0 2 * * *`). When provided, the skill checks that the latest backup timestamp does not exceed the schedule interval by more than 20%. If omitted, schedule-drift checks are skipped.
- `dry_run_restore` (boolean, optional) — If `true`, mount the latest snapshot and compute a SHA-256 checksum of the top-level directory tree without writing data to the live system. Default: `false`. Gate via HITL if the target is a production datastore.
- `snapshot_limit` (number, optional) — Number of recent snapshots to inspect for integrity markers. Default: `1`. Maximum: `10`.
- `hitl_requester` (string, optional) — Identifier of the user or agent requesting HITL approval for the dry-run. Default: calling agent ID.

## Steps

1. Resolve the backup API endpoint for `<backup_source>` based on `backup_type`:
   - `pbs`: connect via SSH through the bastion to the PBS host; run `proxmox-backup-client list` or query the PBS REST API at `/api2/json/admin/datastore/<datastore>/snapshots`.
   - `truenas`: SSH through the bastion to the TrueNAS host; run `zfs list -t snapshot -o name,creation,used,refer -s creation <pool/dataset>` and check replication task logs via the TrueNAS API.
   - `custom`: use `backup_source` as a directory path on the target host; list contents and inspect a manifest file if present.
2. Fetch the `snapshot_limit` most recent snapshots. For each snapshot, record: `snapshot_id`, `created_at`, `size_bytes`, `status` (success/failed/partial, as reported by the backup system), and any error messages from the backup job log.
3. Evaluate **completion status**: the latest snapshot must have `status: success`. If it has `status: failed` or `partial`, record the failure and surface the backup system error message verbatim (truncated to 2 KB).
4. **Schedule-drift check** (if `expected_schedule` is provided): parse the cron expression to compute the expected interval in seconds. Compare the gap between the latest snapshot's `created_at` and `now`. If the gap exceeds `interval * 1.2`, flag as `schedule_drifted: true` with the exact overage in seconds.
5. **Integrity markers check**: for PBS snapshots, verify the `.fidx`/`.didx` index files are present and the `verify` status in the PBS datastore is `ok` (run `proxmox-backup-client verify` if not already present). For TrueNAS, confirm the ZFS checksum flag is enabled and no `cksum_errors` are recorded on the dataset.
6. **Dry-run restore** (if `dry_run_restore: true`):
   - If the backup source is a production datastore, submit a HITL approval request before proceeding. Include: `backup_source`, `snapshot_id`, and a plain-language description of the dry-run scope. Pause until approved or 15-minute timeout. If denied or timed out, skip the dry-run and record `dry_run_status: "skipped"`.
   - Mount the latest snapshot to a temporary path: for PBS use `proxmox-backup-client mount`; for TrueNAS use `zfs clone` to a scratch dataset.
   - Compute a SHA-256 checksum of the top-level directory tree using `find <mount_point> -type f -exec sha256sum {} \; | sort | sha256sum`. Record the resulting digest as `restore_checksum`.
   - Unmount and destroy the temporary mount/clone immediately after checksum is recorded.
   - Record `dry_run_status: "passed"` if the mount, checksum, and unmount all succeeded without errors.
7. Emit an AOCL envelope (`quox.skill.backup_verify.completed`) recording all check results, schedule drift, and dry-run outcome.
8. Emit a VOLT evidence record with `evidence_type: backup_integrity_check`, including the snapshot ID, completion status, schedule drift result, and dry-run checksum (if performed).
9. Return the structured result (see Outputs).

## Outputs

- `backup_source` (string) — The backup target that was verified.
- `backup_type` (string) — The backup system used.
- `latest_snapshot_id` (string) — Identifier of the most recent snapshot inspected.
- `latest_snapshot_at` (string) — ISO 8601 UTC creation timestamp of the latest snapshot.
- `completion_status` (`"success"` | `"failed"` | `"partial"`) — Outcome of the latest backup job.
- `schedule_drifted` (boolean | null) — `true` if the backup is overdue beyond the 20% tolerance; `null` if `expected_schedule` was not provided.
- `drift_seconds` (number | null) — Overage in seconds when `schedule_drifted` is `true`; `null` otherwise.
- `integrity_ok` (boolean) — Whether integrity markers (index files, ZFS checksums) passed.
- `dry_run_status` (`"passed"` | `"failed"` | `"skipped"` | `"not_requested"`) — Outcome of the optional dry-run restore.
- `restore_checksum` (string | null) — SHA-256 digest of the mounted snapshot tree; `null` if dry-run was not performed.
- `snapshots_inspected` (number) — Count of snapshots examined.
- `errors` (string[]) — Any non-fatal warnings or partial failures collected during the check.
- `verified_at` (string) — ISO 8601 UTC timestamp when verification completed.

## Failure modes

- **Backup system unreachable via SSH:** Return `completion_status: "failed"`, `errors: ["Backup system <host> unreachable"]`. Emit VOLT evidence. Do not retry automatically.
- **Latest snapshot status is failed or partial:** Record the backup system error verbatim in `errors`. Set `integrity_ok: false`. Emit VOLT evidence. Surface to the calling agent for escalation.
- **Integrity marker check fails (corrupt index, ZFS checksum errors):** Set `integrity_ok: false`, populate `errors` with the specific corruption detail. Emit VOLT evidence with `evidence_type: backup_corruption_detected`. This is a high-severity finding — the calling agent should escalate immediately.
- **Dry-run mount fails:** Set `dry_run_status: "failed"`, record the mount error in `errors`. The backup may still be valid at the index level but cannot be confirmed restorable. Emit VOLT evidence.
- **HITL denied or timed out for dry-run:** Set `dry_run_status: "skipped"`. The rest of the verification (steps 2–5) still completes and is returned.

## Notes

For PBS datastores, ensure the PBS host is accessible from the bastion and the calling agent's SSH key is authorised. For TrueNAS, the TrueNAS API key must be stored in the agent's credential vault — never passed as a literal in workflow definitions. The dry-run restore in Step 6 intentionally avoids writing to the live system: the ZFS clone and mount are created in a scratch namespace and destroyed immediately. For large datasets, the checksum step can take several minutes; the caller should set an appropriate task timeout in the parent workflow. Schedule-drift results and VOLT evidence records collectively satisfy the `ops:backup-audit` and `compliance:rpo-verification` policy tracks when those tracks are enabled for the org.
