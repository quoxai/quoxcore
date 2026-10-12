---
name: issue-triage
license: LicenseRef-SkillRights-Reserved-1.0
category: github
version: 1.0.0
edition: stable
author: quox-core
description: Triage a new GitHub issue — classify type, assign priority p0–p3, label with affected components, and suggest an assignee from recent contributors to the relevant files.
tags: [issue-triage, bug-classification, priority-assignment, component-labeling, contributor-routing]
best_for_agents: [forge]
required_tools: []
required_capabilities: []
related_skills:
  - { skill_id: release-notes-draft, relation: related }
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Issue Triage

## When to apply

Use this skill when a new issue has been filed on a GitHub repository and an agent needs to classify and route it without manual intervention. Apply immediately on issue creation webhooks, or as a batch step when reviewing a backlog of unlabelled issues. Do not apply to issues already labelled and assigned — triage only unlabelled or unassigned issues to avoid overwriting human decisions.

## Inputs

- `issue_number` (number) — GitHub issue number. Required.
- `issue_title` (string) — Title of the issue as submitted. Required.
- `issue_body` (string) — Full body text of the issue. Required.
- `repo_name` (string) — Repository identifier in `owner/repo` format. Required.
- `recent_contributors` (array of objects) — List of recent contributors, each with `login`, `files_touched` (array of strings), and `commit_count`. Used to suggest an assignee. Required.
- `existing_labels` (array of strings, optional) — Labels already on the issue. Default: empty.
- `component_map` (object, optional) — Mapping of file path prefixes to component names (e.g. `{ "src/auth": "auth", "src/config/skills": "skills" }`). Used for component labeling. Default: empty.

## Steps

1. **Classify type** by analysing `issue_title` and `issue_body` for keywords and structure:
   - `bug` — describes unexpected behaviour, includes error messages, stack traces, or steps to reproduce.
   - `feat` — requests a new capability, uses language like "add", "support", "allow", "would be great if".
   - `question` — asks how something works, no clear defect or feature request.
   - `wontfix` — describes behaviour that is intentional, already closed, or out of scope per documented constraints. Use sparingly; flag this classification in `triage_notes` for human confirmation.
2. **Assign priority** based on type and signal words:
   - `p0` — production outage, data loss, security vulnerability, or the word "urgent"/"critical"/"down" in the title.
   - `p1` — significant functional regression affecting multiple users, no known workaround.
   - `p2` — notable bug or valuable feature request with a workaround available.
   - `p3` — minor cosmetic issue, documentation gap, or nice-to-have enhancement.
3. **Label components**: compare file paths or module names mentioned in `issue_body` against `component_map`. Emit a `component:<name>` label for each match. If `component_map` is empty, emit a `component:unknown` label and note it in `triage_notes`.
4. **Suggest assignee**: from `recent_contributors`, find contributors whose `files_touched` overlap with the components identified in Step 3. Rank by `commit_count` descending and select the top match. If no overlap exists, return the contributor with the highest overall `commit_count`. If `recent_contributors` is empty, set `suggested_assignee` to `null`.
5. Emit the structured output object.

## Outputs

- `classification` (`"bug"` | `"feat"` | `"question"` | `"wontfix"`) — Issue type.
- `priority` (`"p0"` | `"p1"` | `"p2"` | `"p3"`) — Assigned priority level.
- `labels` (array of strings) — Labels to apply, including `type:<classification>`, `priority:<priority>`, and any `component:<name>` labels.
- `suggested_assignee` (string | null) — GitHub login of the recommended assignee, or `null` if undetermined.
- `triage_notes` (string) — One or two sentences explaining the classification rationale, especially for `wontfix` or `p0` decisions.

## Failure modes

- **Ambiguous classification:** If `issue_body` contains signals for both `bug` and `feat` (e.g. "the feature is broken"), prefer `bug` and note the ambiguity in `triage_notes`. Do not emit two classifications.
- **Empty issue body:** If `issue_body` is blank or fewer than 10 characters, classify as `question`, set `priority: "p3"`, set `labels: ["type:question", "priority:p3", "needs-more-info"]`, and set `triage_notes` to `"Issue body is empty or too short to triage accurately; requesting more detail."`.
- **No matching contributor:** If `recent_contributors` has entries but none overlap with identified components, fall back to the highest `commit_count` contributor and note `"Assignee selected by overall commit volume; no component-specific contributor found."` in `triage_notes`.

## Notes

The `wontfix` classification should be rare and always accompanied by a `triage_notes` explanation referencing the specific documented constraint or prior decision. The caller is responsible for posting the resulting `labels` and `suggested_assignee` to the GitHub Issues API. Priority `p0` issues should also trigger a notification to the on-call channel — this skill emits the classification but does not send notifications directly.
