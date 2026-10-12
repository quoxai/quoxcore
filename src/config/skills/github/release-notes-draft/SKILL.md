---
name: release-notes-draft
license: LicenseRef-SkillRights-Reserved-1.0
category: github
version: 1.0.0
edition: stable
author: quox-core
description: Draft release notes for a tag — group commits by type, highlight breaking changes, surface unique contributors, and link the previous tag for a diff URL.
tags: [release-notes, changelog, git-tags, breaking-changes, contributors, semantic-versioning]
best_for_agents: [forge]
required_tools: []
required_capabilities: []
related_skills:
  - { skill_id: pr-create, relation: related }
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Release Notes Draft

## When to apply

Use this skill when a new version tag has been pushed to a repository and release notes need to be generated for GitHub Releases, a CHANGELOG file, or an internal announcement. Apply after CI has passed on the tag. If fewer than 2 commits exist between the new tag and the previous tag, emit a minimal stub noting the commit count — do not fabricate detail.

## Inputs

- `repo_name` (string) — Repository identifier in `owner/repo` format. Required.
- `new_tag` (string) — The tag being released (e.g. `v2.4.0`). Required.
- `previous_tag` (string, optional) — The immediately preceding tag to diff against. Default: the most recent tag before `new_tag` if inferable, otherwise empty.
- `commits` (array of objects) — All commits between `previous_tag` and `new_tag`, each with `sha`, `message`, `author_login`, and `pr_number` (nullable). Required.
- `repo_url` (string) — HTTPS URL of the repository (e.g. `https://github.com/quoxai/quox-dashboard`). Required.

## Steps

1. Parse each commit `message` to detect Conventional Commits type prefix (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`, `build`). Commits without a recognised prefix are grouped under `other`. Identify commits with a `!` marker or `BREAKING CHANGE:` footer as breaking changes.
2. Group commits into sections:
   - **Breaking Changes** — commits with `!` or `BREAKING CHANGE:` footer. Always listed first if present.
   - **New Features** — `feat` commits.
   - **Bug Fixes** — `fix` commits.
   - **Performance** — `perf` commits.
   - **Documentation** — `docs` commits.
   - **Internal** — `chore`, `refactor`, `test`, `ci`, `build`, `other` commits grouped together under a collapsible section.
3. For each commit in a visible section (Breaking Changes, New Features, Bug Fixes, Performance, Documentation), format it as:
   `- <subject line> ([#<pr_number>](<pr_link>) by @<author_login>)` if `pr_number` is non-null, or `- <subject line> (<sha_short> by @<author_login>)` otherwise. Strip the type prefix from the subject when displaying.
4. Collect unique `author_login` values across all commits except merge commits. List them in the **Contributors** section as `@<login>` handles, sorted alphabetically.
5. If `previous_tag` is non-empty, generate a full-diff URL: `<repo_url>/compare/<previous_tag>...<new_tag>`.
6. Assemble the final Markdown document using the structure in the Outputs section.
7. Emit the structured output object.

## Outputs

- `release_notes_markdown` (string) — Full Markdown document ready to paste into GitHub Releases or a CHANGELOG. Sections are ordered: Breaking Changes (if any), New Features, Bug Fixes, Performance, Documentation, Internal (collapsed), Contributors, Full Changelog link.
- `has_breaking_changes` (boolean) — `true` if any breaking-change commits were found.
- `contributor_logins` (array of strings) — Unique author logins from all non-merge commits.
- `full_diff_url` (string | null) — Compare URL between `previous_tag` and `new_tag`, or `null` if `previous_tag` is empty.
- `commit_count` (number) — Total number of commits included.

## Failure modes

- **Empty commits array:** Return `release_notes_markdown` containing only a header and `"No commits found between <previous_tag> and <new_tag>."`. Set `commit_count: 0`, `has_breaking_changes: false`, `contributor_logins: []`.
- **All commits are merge commits:** After filtering out merge commits (message begins with `Merge`), if no commits remain, treat as empty per above rule and note `"All commits were merge commits."` in the document.
- **Invalid tag format:** If `new_tag` does not match the pattern `v?[0-9]+\.[0-9]+(\.[0-9]+)?(-[a-zA-Z0-9.]+)?`, add a warning line at the top of `release_notes_markdown`: `> ⚠️ Tag format is non-standard; verify before publishing.`

## Notes

The `Internal` section should be collapsed by default in the Markdown output using a `<details><summary>Internal Changes</summary>` HTML block, as chore/ci/refactor commits are noise for end-users. Breaking changes must always be visible and never collapsed regardless of count. The `full_diff_url` gives reviewers a quick link to every line changed in the release — always include it when `previous_tag` is available.
