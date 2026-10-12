---
name: pr-create
license: LicenseRef-SkillRights-Reserved-1.0
category: github
version: 1.0.0
edition: stable
author: quox-core
description: Open a pull request for a branch — generate title and body from commit messages, include a test plan, link related issues, and set reviewers based on CODEOWNERS or recent contributor conventions.
tags: [pull-request, git, commit-messages, codeowners, reviewers, issue-linking]
best_for_agents: [forge]
required_tools: []
required_capabilities: []
related_skills:
  - { skill_id: code-review, relation: composes }
  - { skill_id: release-notes-draft, relation: related }
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# PR Create

## When to apply

Use this skill when an agent or developer has pushed commits to a feature or fix branch and needs a well-formed pull request opened against a target branch. Apply when the branch has at least one commit ahead of `base_branch` and no open PR already exists for it. Do not apply if the branch is behind `base_branch` by more than 50 commits — rebase first.

## Inputs

- `repo_name` (string) — Repository identifier in `owner/repo` format. Required.
- `head_branch` (string) — The branch to be merged (source). Required.
- `base_branch` (string, optional) — Target branch. Default: `main`.
- `commits` (array of objects) — List of commit objects for the branch, each with `sha`, `message`, and `author`. Required.
- `codeowners_content` (string, optional) — Raw text of the CODEOWNERS file at repo root or `.github/CODEOWNERS`. Used to resolve reviewers. Default: empty.
- `linked_issue_numbers` (array of numbers, optional) — Issue numbers to reference in the PR body. Default: empty.
- `draft` (boolean, optional) — Whether to open the PR as a draft. Default: `false`.

## Steps

1. Parse `commits` to extract the conventional commit types present: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`, `build`. Identify any commits with a `!` breaking-change marker or a `BREAKING CHANGE:` footer.
2. Generate `pr_title`:
   - If there is exactly one commit, derive the title directly from its message (strip the type prefix if it follows Conventional Commits format).
   - If there are multiple commits, synthesise a one-line summary (≤72 characters) that captures the dominant change type and subject. Prefer the most impactful type in order: breaking-change > `feat` > `fix` > others.
   - Prefix with `[WIP]` if `draft` is `true`.
3. Generate `pr_body` with these sections in order:
   a. **Summary** — 2–5 sentences describing what changes and why, derived from commit messages and any `BREAKING CHANGE:` footers.
   b. **Changes** — Bulleted list grouped by commit type, with each bullet being the commit subject (no SHA).
   c. **Test plan** — Bulleted checklist of verification steps inferred from commit messages (e.g. if commits touch auth, include "Verify login flow still works end-to-end"). Include at least one manual and one automated test step.
   d. **Related issues** — For each number in `linked_issue_numbers`, emit `Closes #<n>`. If `linked_issue_numbers` is empty, omit this section.
   e. **Breaking changes** — If any breaking-change commits exist, list them explicitly under a `⚠️ Breaking Changes` heading.
4. Resolve reviewers from `codeowners_content`: find CODEOWNERS entries that match any file path mentioned in commit messages. Extract the GitHub handles listed for those paths. Deduplicate. If `codeowners_content` is empty, set `reviewers` to an empty array and note the limitation.
5. Emit the structured output object.

## Outputs

- `pr_title` (string) — Generated pull request title.
- `pr_body` (string) — Full Markdown body ready to submit to the GitHub API.
- `reviewers` (array of strings) — GitHub handles to assign as reviewers.
- `draft` (boolean) — Whether the PR should be opened as a draft.
- `linked_issues` (array of numbers) — Issue numbers included in the body.

## Failure modes

- **No commits provided or array is empty:** Return an error with message `"Cannot create PR: no commits found on head_branch"`. Do not emit a partial output.
- **All commits are merge commits:** If every commit message begins with `Merge`, skip them when generating title and body and note `"Warning: only merge commits found; title and summary may be incomplete"` in the output.
- **CODEOWNERS parse error:** If `codeowners_content` is present but malformed (e.g. unparseable glob patterns), set `reviewers: []` and include `"Warning: CODEOWNERS could not be parsed; reviewers not set"` in `pr_body`.

## Notes

This skill generates content only — it does not post to GitHub. The caller must submit `pr_title`, `pr_body`, `reviewers`, and `draft` to the GitHub REST API `POST /repos/{owner}/{repo}/pulls` endpoint using an authenticated tool. When `linked_issue_numbers` is provided, the `Closes #<n>` tokens in `pr_body` will auto-close the referenced issues on merge only if the PR targets the repository's default branch.
