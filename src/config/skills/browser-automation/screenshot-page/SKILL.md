---
name: screenshot-page
license: LicenseRef-SkillRights-Reserved-1.0
category: browser/automation
version: 1.0.0
edition: stable
author: quox-core
description: Opens a URL in a sandboxed Chromium instance, captures a full-page screenshot via the Quox browser-q runtime, and returns the evidence artifact path, pixel dimensions, and page load timing.
tags: [screenshot, browser-automation, page-capture, visual-evidence, playwright, headless-chromium, full-page]
best_for_agents: [browser-q]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Screenshot Page

## When to apply

Use this skill whenever an agent or operator needs a visual record of a web page at a specific point in time. Typical triggers: a compliance check requires a rendered screenshot before and after a configuration change, a workflow step needs to confirm that a deployment landing page is live, or a user asks "show me what this URL looks like right now." This skill is preferred over DOM inspection when pixel-accurate rendering evidence is required and when the target page relies on JavaScript for layout or content. Apply after the target service is confirmed reachable; pair with `service-health-check` if liveness is uncertain.

## Inputs

- `url` (string) — Fully qualified HTTP/HTTPS URL to capture. Required.
- `viewport_width` (number, optional) — Browser viewport width in pixels. Default: `1920`.
- `viewport_height` (number, optional) — Browser viewport height in pixels. Default: `1080`.
- `full_page` (boolean, optional) — When `true`, capture the entire scrollable page height rather than just the visible viewport. Default: `true`.
- `wait_until` (string, optional) — Playwright navigation wait condition. Accepted values: `load`, `domcontentloaded`, `networkidle`. Default: `networkidle`.
- `timeout_ms` (number, optional) — Navigation and render timeout in milliseconds. Default: `30000`.
- `corr` (string, optional) — AEE correlation ID inherited from the parent execution context. When provided, the screenshot evidence artifact is tagged with this ID so all captures within a session remain linked.

## Steps

1. Validate `url` — confirm it is a well-formed HTTP or HTTPS URL. Reject data URIs, javascript: schemes, and file:// paths to prevent sandbox escape.
2. Launch a disposable Playwright Chromium instance within the browser-q sandbox. Set viewport to `viewport_width` × `viewport_height`. The Chromium process receives a temporary empty profile directory; no cookies, credentials, or prior state carry over between skill invocations.
3. Navigate to `url` with the configured `wait_until` condition and a hard cap of `timeout_ms`. Record `navigation_start_at` (ISO 8601 UTC) immediately before the navigation call.
4. Record `navigation_end_at` once the wait condition is satisfied. Compute `load_time_ms = navigation_end_at − navigation_start_at`.
5. If `full_page` is `true`, extend the viewport height to the full document scroll height before capture. If the document height exceeds 20 000 px, cap at 20 000 px and record a `truncated: true` flag in the output to signal that the page was clipped.
6. Capture the screenshot as a lossless PNG. Persist the file to the org's evidence store via `evidence_artifact_ref`. The stored path follows the pattern `evidence/<org_id>/<corr>/<ulid>.png`.
7. Emit an AEE envelope with `intent: quox.skill.screenshot_page` and `corr` from the input (or generate a new ULID if not provided). Tag the envelope with the `evidence_artifact_ref` so the AOCL trace layer links the capture to the parent session.
8. Emit a VOLT evidence record with `evidence_type: browser_screenshot`, including `url`, `dimensions`, `load_time_ms`, `full_page`, and the `evidence_artifact_ref`.
9. Close and discard the Chromium process and temporary profile directory. No browser state persists after this step.

## Outputs

- `url` (string) — The captured URL.
- `evidence_artifact_ref` (string) — Path in the org evidence store where the PNG is persisted (e.g. `evidence/<org_id>/<corr>/<ulid>.png`).
- `width_px` (number) — Actual captured width in pixels.
- `height_px` (number) — Actual captured height in pixels (post full-page expansion if applicable).
- `full_page` (boolean) — Whether the capture used full-page mode.
- `truncated` (boolean) — `true` if the page height exceeded 20 000 px and was clipped; `false` otherwise.
- `load_time_ms` (number) — Time in milliseconds from navigation start to wait condition satisfied.
- `navigation_start_at` (string) — ISO 8601 UTC timestamp.
- `navigation_end_at` (string) — ISO 8601 UTC timestamp.
- `corr` (string) — AEE correlation ID used for this capture.

## Failure modes

- **Page navigation timeout:** Raised when the page does not satisfy `wait_until` within `timeout_ms`. Set `status: "failed"`, `error: "Navigation timed out after <timeout_ms>ms waiting for <wait_until>"`. Close the browser process. Surface to the calling agent; do not auto-retry, as the timeout may indicate a persistent service degradation.
- **Sandbox kill:** The browser-q sandbox enforces a hard memory and CPU budget per invocation. If the Chromium process is killed by the sandbox before the screenshot completes, set `status: "failed"`, `error: "Browser sandbox terminated process during render"`. Emit a VOLT evidence record with `evidence_type: sandbox_kill` for observability. The caller should investigate whether the target page is unusually resource-intensive.
- **Invalid URL scheme:** Raised at Step 1 if `url` is not an HTTP/HTTPS URL. Set `status: "failed"`, `error: "URL scheme not permitted: <scheme>"`. This is a hard validation failure; no browser is launched.
- **Evidence store write failure:** If the PNG cannot be persisted to the evidence store (storage unavailable, quota exceeded), set `status: "failed"`, `error: "Evidence store write failed: <reason>"`. The screenshot binary is discarded; do not log it to a local temp directory as a fallback, as this would break the auditability guarantee.
- **TLS certificate error:** If the target URL presents an invalid or expired certificate, Playwright will abort navigation. Set `status: "failed"`, `error: "TLS certificate verification failed for <hostname>"`. Never configure Chromium to ignore certificate errors in production invocations.

## Notes

The browser-q agent uses a single shared Playwright browser pool with per-invocation isolated contexts. The pool size is governed by the agent's `browser_concurrency` setting (default 3). If the pool is exhausted the skill queues until a slot is free, subject to the overall `timeout_ms` budget. For bulk screenshot jobs (e.g. capturing 50 pages for a visual regression audit), callers should set a generous `timeout_ms` and use a QuoxFlow parallel-map node rather than sequential invocations. The VOLT `browser_screenshot` evidence type is indexed by the org's evidence query API, allowing downstream skills and workflows to retrieve and compare screenshots by `corr`, `url`, or time range. Screenshots should never be used as the sole source of truth for structured data extraction; use the `extract-table` skill when tabular data is required from the same page.
