---
name: code-review
license: LicenseRef-SkillRights-Reserved-1.0
category: github
version: 1.0.0
edition: stable
author: quox-core
description: Review a pull request diff — flag style, security, and correctness issues, propose concrete inline comments, summarise risk level, and recommend approve or request-changes.
tags: [code-review, pull-request, security-scan, correctness, inline-comments, risk-assessment]
best_for_agents: [forge]
required_tools: []
required_capabilities: []
related_skills:
  - { skill_id: pr-create, relation: composes }
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Code Review

## When to apply

Use this skill when an agent needs to perform a structured code review on an open pull request. Apply when a PR has been opened or updated and automated review is requested, when a team member asks for a second opinion before merging, or when a workflow step gates merging on agent sign-off. This skill does not replace human review for high-risk or security-sensitive changes — it prepares a structured analysis for human reviewers.

## Inputs

- `pr_diff` (string) — Full unified diff of the pull request. Required.
- `pr_title` (string) — Title of the pull request. Required.
- `pr_description` (string, optional) — Body text of the pull request, including any linked issues or context. Default: empty.
- `repo_name` (string) — Repository identifier in `owner/repo` format. Required.
- `pr_number` (number) — Pull request number. Required.
- `base_branch` (string, optional) — Target branch being merged into. Default: `main`.
- `language` (string, optional) — Primary programming language of changed files. Used to apply language-specific style rules. Default: inferred from file extensions.

## Steps

1. Parse `pr_diff` into a list of changed files, each with its hunk context. Track added lines (+) and removed lines (-) separately.
2. For each changed file, apply three analysis passes in sequence:
   a. **Style pass** — Check naming conventions, line length, trailing whitespace, import ordering, and formatting consistency with unchanged surrounding code.
   b. **Correctness pass** — Check for off-by-one errors, null/undefined dereferences, missing error handling, incorrect type assumptions, and logic that contradicts the stated `pr_description`.
   c. **Security pass** — Check for hardcoded credentials, SQL/shell injection vectors, missing input validation, insecure deserialization, unsafe file operations, and overly permissive access control.
3. For each finding, construct an inline comment with: file path, line number(s), severity (`info` | `warning` | `critical`), category (`style` | `correctness` | `security`), a one-sentence diagnosis, and a concrete suggested fix or alternative code snippet.
4. Deduplicate findings that repeat the same root issue across multiple files into a single top-level comment.
5. Compute `risk_level`:
   - `low` — no `critical` findings, at most 3 `warning` findings
   - `medium` — 1–3 `critical` findings or 4+ `warning` findings
   - `high` — 4+ `critical` findings or any security finding involving credentials or injection
6. Determine `recommendation`:
   - `approve` — `risk_level` is `low` and no `critical` findings
   - `request_changes` — any `critical` finding or `risk_level` is `medium` or `high`
   - `comment` — no findings but pr_description is ambiguous or context is missing
7. Emit the structured output object.

## Outputs

- `inline_comments` (array) — List of comment objects, each with `file`, `line`, `severity`, `category`, `diagnosis`, `suggestion`.
- `summary` (string) — 2–4 sentence human-readable summary of the review, calling out the most significant finding.
- `risk_level` (`"low"` | `"medium"` | `"high"`) — Computed risk classification.
- `recommendation` (`"approve"` | `"request_changes"` | `"comment"`) — Reviewer verdict.
- `finding_counts` (object) — Counts broken down by severity: `{ critical, warning, info }`.

## Failure modes

- **Diff too large to parse:** If `pr_diff` exceeds 50 KB, emit a `warning`-level inline comment on the first file advising the author to split the PR, set `risk_level: "high"`, and `recommendation: "request_changes"`. Do not attempt partial analysis.
- **No language detected:** If file extensions are unrecognised and `language` is not provided, skip the style pass and note the limitation in `summary`. Still run correctness and security passes on the raw diff text.
- **Conflicting hunks:** If the diff contains conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`), immediately set `risk_level: "high"`, `recommendation: "request_changes"`, and add a `critical` inline comment flagging the unresolved conflict.

## Notes

Security findings involving credentials or tokens must always be `critical` regardless of context — even test files. The skill does not post comments to GitHub directly; callers must use a GitHub API tool to submit `inline_comments` to the PR review endpoint. When `pr_description` references a linked issue (e.g. `Fixes #42`), include the issue number in the `summary` output to preserve traceability.
