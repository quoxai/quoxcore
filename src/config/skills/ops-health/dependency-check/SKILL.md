---
name: dependency-check
license: LicenseRef-SkillRights-Reserved-1.0
category: ops/health
version: 1.0.0
edition: stable
author: quox-core
description: Inspects a project's dependency manifest for outdated, deprecated, or security-flagged packages and emits a prioritised remediation report with upgrade commands.
tags: [dependency-audit, package-security, vulnerability-scan, outdated-packages, remediation-report]
best_for_agents: [nova]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Dependency Check

## When to apply

Use this skill when an agent or operator needs to audit a project's third-party dependencies for security vulnerabilities, deprecated packages, or versions significantly behind their latest stable release. Typical triggers: a CVE advisory references a package the project uses, a scheduled weekly dependency audit fires, or a developer asks "are we safe to deploy?" before a release. Apply to `package.json` (npm/yarn), `requirements.txt` / `pyproject.toml` (Python), or `go.mod` (Go) manifests.

## Inputs

- `manifest_path` (string) — Absolute path to the dependency manifest file on the target host. Required. Examples: `/app/package.json`, `/srv/api/requirements.txt`, `/opt/quoxcore/quoxflow/go.mod`.
- `ecosystem` (`"npm"` | `"python"` | `"go"`, optional) — Package ecosystem. If omitted, inferred from the manifest filename.
- `severity_threshold` (`"critical"` | `"high"` | `"medium"` | `"low"`, optional) — Minimum severity level to include in the report. Default: `"high"`. Packages flagged below this threshold are counted but not listed individually.
- `include_outdated` (boolean, optional) — Whether to include packages that are outdated but not security-flagged. Default: `true`.
- `host` (string, optional) — Target host identifier if the manifest lives on a remote machine (resolved via the agent registry's SSH bastion config). Default: local execution.

## Steps

1. Resolve the target host: if `host` is provided, establish an SSH session via the bastion at `gw-01` using the agent's registered key. Otherwise execute locally.
2. Read the manifest file at `manifest_path`. If the file does not exist or is not readable, abort and emit a `manifest_not_found` error.
3. Determine `ecosystem`: if not supplied, inspect the filename — `package.json` → `npm`, `requirements.txt` or `pyproject.toml` → `python`, `go.mod` → `go`.
4. Run the ecosystem-appropriate audit command in the manifest's directory:
   - **npm:** `npm audit --json` (reads `package-lock.json` if present; falls back to `npm audit --package-lock-only` to generate one).
   - **python:** `pip-audit --format json -r requirements.txt` (or `pip-audit --format json` for pyproject.toml).
   - **go:** `govulncheck -json ./...` from the module root.
5. Parse the command's JSON output and extract individual vulnerability records. For each record capture: `package_name`, `installed_version`, `patched_version` (if known), `severity`, `cve_ids` (array), `advisory_url`.
6. If `include_outdated` is `true`, additionally run the version-check command (`npm outdated --json`, `pip list --outdated --format json`, or `go list -m -u -json all`) and merge results — marking packages that are outdated-but-unvulnerable separately from security-flagged ones.
7. Filter results to those meeting `severity_threshold` and above for detailed listing. Count but suppress detail for entries below the threshold.
8. Build the remediation report: group packages by severity, generate the appropriate upgrade command for each (e.g. `npm install <pkg>@<patched_version>`, `pip install --upgrade <pkg>==<patched_version>`), and flag any package with no available patch as `no_fix_available`.
9. Emit an AEE envelope tagging this audit to the parent execution context (`quox.skill.dependency_check`). If any `critical` or `high` vulnerabilities were found, also emit a VOLT evidence record with `evidence_type: dependency_vulnerability` listing the CVE IDs.

## Outputs

- `ecosystem` (string) — Resolved ecosystem (`npm`, `python`, or `go`).
- `manifest_path` (string) — The path that was audited.
- `total_packages_scanned` (number) — Total direct + transitive packages evaluated.
- `vulnerabilities` (array) — Objects with `{ package_name, installed_version, patched_version, severity, cve_ids, advisory_url, remediation_command }`, filtered to `severity_threshold` and above.
- `outdated_only` (array) — Packages that are behind latest stable but not security-flagged (only when `include_outdated: true`). Each entry: `{ package_name, installed_version, latest_version, upgrade_command }`.
- `no_fix_available` (array) — Package names where a vulnerability exists but no patched version is released yet.
- `counts` (object) — `{ critical, high, medium, low, outdated_only, suppressed }` — `suppressed` is the count of entries below `severity_threshold`.
- `audit_ran_at` (string) — ISO 8601 UTC timestamp.
- `host` (string | null) — The host where the audit ran, or `null` for local.

## Failure modes

- **Manifest not found:** Abort with `error: "manifest_not_found"`, `manifest_path` echoed back. Do not attempt to create or fetch a manifest — surface the missing-file condition for the operator to resolve.
- **Audit tool not installed:** If `npm audit`, `pip-audit`, or `govulncheck` is absent, emit `error: "audit_tool_missing"` with the expected tool name and install instructions. Do not silently skip the audit.
- **SSH connection failure (remote host):** Emit `error: "ssh_connection_failed"`, include the host identifier and the bastion hop address. The skill does not retry automatically.
- **Malformed audit output:** If the tool's JSON output cannot be parsed (e.g. it printed a warning before the JSON block), surface `error: "audit_output_parse_failure"` and include the first 512 characters of raw output for diagnosis.

## Notes

The `pip-audit` tool must be installed in the target environment (`pip install pip-audit`); it is not part of the standard Python distribution. For Go, `govulncheck` requires Go 1.18+ and is installed separately (`go install golang.org/x/vuln/cmd/govulncheck@latest`). When running on a remote host via SSH, the audit command executes on the remote machine — the manifest is not transferred locally. VOLT evidence emitted at Step 9 satisfies the `compliance:dependency-audit` policy track when enabled. This skill does not apply patches; it only reports and provides commands. Actual patching should be done via a follow-up human-approved step or a dedicated `dependency-patch` workflow gated on HITL approval.
