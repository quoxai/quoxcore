---
name: log-secret-scan
license: LicenseRef-SkillRights-Reserved-1.0
category: security
version: 1.0.0
edition: stable
author: quox-core
description: Grep a specified log range for high-confidence secret patterns such as sk-, Bearer tokens, and AKIA AWS keys, emitting VOLT findings with surrounding line context but with every matched secret value replaced by a redacted placeholder.
tags: [secret-scanning, log-audit, credential-leak, redaction, volt-evidence, security-posture]
best_for_agents: [auditus]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Log Secret Scan

## When to apply

Apply when AUDITUS needs to audit a log file or log stream for accidentally leaked credentials, API keys, or bearer tokens. Typical triggers: a post-incident review suspects a key was written to logs, a scheduled compliance sweep requires evidence that no secrets appear in log storage, or a pipeline failure produced verbose debug output that may contain credential material. This skill reads log lines, detects high-confidence secret patterns, and emits VOLT findings — it never stores, prints, or forwards the matched plaintext secret. The redaction invariant is absolute: the matched secret value MUST be replaced with `[REDACTED:<pattern-name>]` in every output surface.

## Inputs

- `log_source` (string) — Path to a log file, a Docker container log reference (`container:<name>`), or a journald unit name (`unit:<service>`). Required.
- `start_line` (integer, optional) — First line number to include in the scan. Default: `1`.
- `end_line` (integer or `"end"`, optional) — Last line number to include, or `"end"` to scan to the last available line. Default: `"end"`.
- `patterns` (array of strings, optional) — Pattern names to enable. Valid values: `sk-` (OpenAI / Anthropic keys), `Bearer` (HTTP Authorization tokens), `AKIA` (AWS access key IDs), `ghp_` (GitHub personal access tokens), `password=` (inline credential assignments). Default: all five patterns are enabled.
- `context_lines` (integer, optional) — Number of surrounding lines to capture before and after a matched line for context. Capped at `5`. Default: `2`. Captured context lines are included verbatim only if they do not themselves contain a secret match — matched context lines are also redacted before inclusion.
- `max_findings` (integer, optional) — Maximum number of findings to return. Scan stops after this limit is reached. Default: `200`.

## Steps

1. Validate `log_source`: confirm the file path exists or the container/unit reference is resolvable. Abort with `error: log_source_not_found` if the source cannot be opened.
2. Apply `start_line` and `end_line` bounds to produce the effective scan window. If `end_line` is `"end"`, read until EOF. If `start_line > end_line`, abort with `error: invalid_line_range`.
3. Compile the enabled pattern set into a set of regular expressions. Each pattern is matched against the full line content. Patterns are applied independently — a single line can produce multiple findings if it matches more than one pattern.
4. Iterate over each line in the scan window. For each line that matches at least one enabled pattern: identify every individual match within the line, record the pattern name for each, then construct a redacted copy of the line by replacing each matched segment with `[REDACTED:<pattern-name>]`. The original matched value MUST NOT be stored, returned, or included in any output field at this step or any subsequent step. This is a critical security invariant with no exceptions.
5. Capture `context_lines` surrounding lines for each finding. Apply redaction to any context line that also matches an enabled pattern before including it. Context lines that pass cleanly through redaction are included verbatim to aid investigation.
6. Assemble each finding as: `{ line_number, pattern_names[], redacted_line, context_before[], context_after[], log_source }`. Increment the finding counter; stop scanning if `max_findings` is reached and set `scan_truncated: true` in the output.
7. After scanning completes, emit one VOLT evidence record with `evidence_type: log_secret_finding` for each individual finding. Each VOLT record contains the finding object from step 6 — redacted content only. No plaintext secret values appear anywhere in the VOLT payload.
8. Attach an AEE envelope to the current execution context (`corr` inherited from caller) tagging the full scan invocation as `quox.skill.log_secret_scan`. Include the summary counts in the AEE metadata, not the individual finding records.

## Outputs

- `findings` (array of objects) — Each entry: `{ line_number, pattern_names, redacted_line, context_before, context_after, log_source }`. All secret values are replaced with `[REDACTED:<pattern-name>]`.
- `summary` (object) — `{ log_source, lines_scanned, findings_count, scan_truncated, patterns_active, scan_at }`.
- `volt_evidence_ids` (array of strings) — ULIDs of all emitted VOLT evidence records, one per finding.

## Failure modes

- **LOG_SOURCE_NOT_FOUND:** The file path does not exist, the container name is unknown, or the unit name is not registered with journald. Abort with `error: log_source_not_found`; do not emit any VOLT records for an unverifiable source.
- **INVALID_LINE_RANGE:** `start_line` is greater than `end_line`, or `start_line` is less than 1. Abort with `error: invalid_line_range` before reading any log content.
- **SCAN_TRUNCATED:** The number of findings reached `max_findings` before the end of the scan window. Set `scan_truncated: true` in the summary. The findings returned are the first `max_findings` matches by line number. The caller should re-invoke with a narrower line range or a higher `max_findings` limit to cover the remainder.
- **VOLT_EMIT_PARTIAL_FAILURE:** One or more VOLT evidence records failed to write after the scan completed. Return the findings normally but set `volt_partial_failure: true` in the summary and list the failed finding `line_number` values in `volt_failed_lines`. The audit trail is incomplete for those findings; operator intervention is required.
- **REDACTION_GUARD_FAILURE:** If at any point a serialisation path would write a raw matched secret to an output field, VOLT payload, or AEE envelope, the skill MUST abort immediately with `error: redaction_guard_failure`. Partial findings already emitted are valid; no further output is produced. This guard exists because a scan result containing a live credential in its output is more dangerous than no scan result at all.

## Notes

The `[REDACTED:<pattern-name>]` format is deliberately machine-parseable so downstream VOLT queries can count findings by pattern type without re-reading raw log content. Pattern names are fixed identifiers from the enabled set (`sk-`, `Bearer`, `AKIA`, `ghp_`, `password=`) and do not vary by match content. The `context_lines` cap of 5 is a security control: wide context windows increase the probability that a secret visible a few lines away from the match site survives into the output. AUDITUS is the designated agent for this skill because it holds the `logs:read` and `volt:write` capabilities required for the scan-and-evidence flow. If a scan finds zero matches, a VOLT record with `evidence_type: log_secret_finding` and `findings_count: 0` is still emitted, confirming the sweep ran and was clean — absence of findings is itself an auditable outcome.
