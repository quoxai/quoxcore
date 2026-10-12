---
name: slack-thread-summarise
license: LicenseRef-SkillRights-Reserved-1.0
category: communication
version: 1.0.0
edition: stable
author: quox-core
description: Pull a Slack thread's messages and produce a concise summary covering decisions, action items, blockers, and unresolved questions with speaker attributions and a permalink.
tags: [slack, summarisation, thread, action-items, decisions, async-comms]
best_for_agents: [archivist]
required_tools:
  - { name: http_call, version_constraint: ">=1.0.0" }
required_capabilities: [slack.read]
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Slack Thread Summarise

## When to apply

Use this skill when an agent needs to distill a Slack thread into an actionable brief — surfacing what was decided, what still needs doing, what is blocked, and what remains unresolved, without requiring the reader to scroll the full thread. Apply when a `channel_id` and `thread_ts` are available and the calling agent has `slack.read` capability. Do not apply when the thread has fewer than three messages — paraphrase inline instead.

## Inputs

- `channel_id` (string) — Slack channel ID (e.g. `C0123ABC`). Required.
- `thread_ts` (string) — Timestamp of the parent message that anchors the thread (e.g. `"1715001234.000100"`). Required.
- `workspace_domain` (string) — Slack workspace domain used to construct the permalink (e.g. `"quoxai"`). Required.
- `max_messages` (number, optional) — Cap on messages fetched from the thread. Default: `200`.
- `include_reactions` (boolean, optional) — Whether to include emoji reactions as sentiment signals in the summary. Default: `false`.

## Steps

1. Fetch the thread replies via the Slack API `conversations.replies` endpoint:
   ```
   GET https://slack.com/api/conversations.replies
   Query params: channel=<channel_id>, ts=<thread_ts>, limit=<max_messages>, inclusive=true
   Header: Authorization: Bearer <slack_bot_token from vault>
   ```
   On non-2xx or `"ok": false`, abort with `error: "slack_fetch_failed"` and include the Slack `error` field.

2. Extract the `messages` array. Map each entry to:
   `{ author: messages[i].user, ts: messages[i].ts, text: messages[i].text }`.
   Strip bot messages (`bot_id` present) unless the bot text contains a decision marker (e.g. "approved", "merged", "deployed").

3. Construct the thread permalink:
   ```
   https://<workspace_domain>.slack.com/archives/<channel_id>/p<thread_ts_no_dot>
   ```
   (Remove the `.` from `thread_ts` to form the Slack permalink token.)

4. Analyse the cleaned message list and extract:
   - **Decisions made** — statements expressing a resolved choice (look for "we'll", "decided", "agreed", "going with", "approved").
   - **Action items** — tasks assigned to a named person or role (look for "will", "to do", "action:", "@<user> please", "you should").
   - **Blockers raised** — obstacles explicitly called out (look for "blocked", "waiting on", "can't proceed", "dependency on").
   - **Unresolved questions** — open questions without a subsequent answer (look for "?", "anyone know", "still unclear").

5. Produce the summary object retaining speaker attributions (use `author` field from Step 2). Do not fabricate or infer items not present in the thread text.

6. Return the structured output.

## Outputs

- `thread_permalink` (string) — Direct Slack link to the thread.
- `message_count` (number) — Total messages included in the analysis (after bot-strip).
- `participants` (array of string) — Unique `author` user IDs or display names seen in the thread.
- `decisions` (array of `{ author, text }`) — Each resolved decision with the user who stated it.
- `action_items` (array of `{ assignee, text, raised_by }`) — Tasks extracted, with the person they were assigned to and who raised them.
- `blockers` (array of `{ raised_by, text }`) — Blockers or dependencies flagged.
- `unresolved_questions` (array of `{ asked_by, text }`) — Open questions without a clear resolution in the thread.
- `summary_prose` (string) — A two-to-four sentence narrative pulling together the above, suitable for pasting into a doc or briefing note.

## Failure modes

- **Slack fetch failed:** Abort with `error: "slack_fetch_failed"`, include the raw Slack API error string. Do not return a partial summary.
- **Thread not found or empty:** If `messages` is empty or contains only the parent with no replies, return `error: "thread_empty"` and note the `thread_ts` and `channel_id` for debugging.
- **Token missing from vault:** If the Slack bot token cannot be retrieved, abort with `error: "slack_token_unavailable"`. Never prompt the user to paste a token inline.
- **max_messages exceeded:** If the thread has more messages than `max_messages`, summarise the available window and include `truncated: true` plus `messages_skipped` count in the output so the caller knows coverage is partial.

## Notes

Slack bot token must be stored in the Quox secret vault under key `slack.bot_token` and fetched via the vault tool — never hardcoded or passed as a plain-text input field. The `workspace_domain` is used only for permalink construction and is not a secret. Speaker attributions use raw Slack user IDs by default; callers may resolve IDs to display names via the Slack `users.info` API as a post-processing step if needed.
