---
name: form-fill
license: LicenseRef-SkillRights-Reserved-1.0
category: browser/automation
version: 1.0.0
edition: stable
author: quox-core
description: Fills and submits a named HTML form on a Quox browser-q rendered page using a provided field map, captures before and after screenshots as VOLT evidence, and never stores credentials in the skill body.
tags: [form-submission, browser-automation, playwright, credential-vault, form-fill, evidence-capture, web-interaction]
best_for_agents: [browser-q]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Form Fill

## When to apply

Use this skill when an agent needs to programmatically complete and submit an HTML form on a rendered web page. Typical triggers: a workflow automates a configuration change through a vendor portal that exposes no API, an operator asks the agent to submit a structured report through a web form, or a compliance workflow needs to register a new entry in a third-party system. This skill is appropriate for forms that are fully rendered in the browser DOM — not for API endpoints where a direct HTTP POST is possible and preferred. Always prefer a direct API call over browser form submission when both options are available. This skill must never be used to bypass authentication in a way that circumvents the org's access control policies; the field map must reference vault credentials rather than embedding them as literal values.

## Inputs

- `url` (string) — Fully qualified HTTP/HTTPS URL of the page containing the form. Required.
- `form_selector` (string, optional) — CSS selector identifying the target `<form>` element. When omitted, the skill targets the first `<form>` found in the DOM. Default: first form heuristic.
- `field_map` (object) — Map of field identifiers to values. Each key is a CSS selector, `name` attribute, or `id` attribute of a form input, textarea, or select element. Each value is either a literal string or a vault reference in the format `vault:<key_name>`. Vault references are resolved at runtime; the resolved value is never written to any log, AEE envelope, or VOLT record — it is captured as `[REDACTED]`. Required.
- `submit_selector` (string, optional) — CSS selector for the submit button or input. When omitted, the skill triggers the form's native `submit` event after filling all fields. Default: native submit.
- `wait_after_submit` (string, optional) — Playwright wait condition after submission. Accepted values: `load`, `domcontentloaded`, `networkidle`, `none`. Default: `networkidle`.
- `timeout_ms` (number, optional) — Total timeout in milliseconds covering navigation, field filling, submission, and post-submit wait. Default: `45000`.
- `corr` (string, optional) — AEE correlation ID inherited from the parent execution context. Both the before and after screenshots are tagged with this ID to link them in the evidence store.

## Steps

1. Validate `url` as a well-formed HTTP or HTTPS URL. Reject any non-HTTP scheme to prevent sandbox escape.
2. Validate `field_map`: confirm it is a non-empty object. For each value that is a vault reference (`vault:<key_name>`), resolve the secret from the agent's credential vault now, before the browser is launched. Store resolved secrets in an in-memory-only map scoped to this invocation — never write them to disk, environment variables, or any persistent store. If any vault reference cannot be resolved, fail immediately with `error: "Vault key not found: <key_name>"` before opening the browser.
3. Launch a disposable Playwright Chromium context within the browser-q sandbox with a 1920×1080 viewport. Navigate to `url` using `networkidle` wait and `timeout_ms`. Record `fill_start_at` in ISO 8601 UTC.
4. Capture the "before" screenshot as a PNG and persist it to the org evidence store via `evidence_artifact_ref` using the pattern `evidence/<org_id>/<corr>/before_<ulid>.png`. This screenshot must be taken before any field is populated, providing an unmodified baseline.
5. Locate the target form using `form_selector` (or the first `<form>` in the DOM if not specified). If no matching form is found, raise `Form not found`.
6. For each entry in `field_map`, locate the corresponding input element by CSS selector, `name` attribute, or `id` attribute (attempted in that order). For `<input>` and `<textarea>` elements, clear any existing value and type the resolved value using Playwright's `fill()` method to simulate realistic user input. For `<select>` elements, use `selectOption()`. Fields whose resolved value originates from a vault reference are filled silently; the value is never emitted to any log.
7. If `submit_selector` is provided, click the matching submit button. Otherwise, dispatch a native `submit` event on the form element. Wait for the post-submit condition specified by `wait_after_submit`.
8. Capture the "after" screenshot as a PNG and persist it to the evidence store using the pattern `evidence/<org_id>/<corr>/after_<ulid>.png`. This screenshot documents the page state following submission (confirmation message, redirect destination, or error state).
9. Construct the submission trace: list each field selector and whether its value was literal or vault-sourced. For vault-sourced fields, record the vault key name and the value as `[REDACTED]`. Never include the resolved secret value anywhere in the trace.
10. Emit an AEE envelope with `intent: quox.skill.form_fill` and `corr`. Attach `form_selector_used`, `field_count`, and both `evidence_artifact_ref` values as envelope metadata.
11. Emit a VOLT evidence record with `evidence_type: form_submission_trace`, including `url`, `form_selector_used`, `field_count`, `before_screenshot_ref`, `after_screenshot_ref`, and the redacted `submission_trace`. The VOLT record provides a complete, auditable account of what was submitted and to which form, with credentials absent from the record.
12. Wipe the in-memory resolved-secrets map. Close and discard the Chromium context and temporary profile.

## Outputs

- `url` (string) — The target URL.
- `form_selector_used` (string) — The selector that identified the submitted form.
- `field_count` (number) — Number of fields populated.
- `before_screenshot_ref` (string) — Evidence store path for the pre-fill screenshot.
- `after_screenshot_ref` (string) — Evidence store path for the post-submit screenshot.
- `submission_trace` (object[]) — Array of `{ field_selector, source: "literal" | "vault", vault_key?: string, value: "<literal value>" | "[REDACTED]" }` entries documenting each filled field.
- `post_submit_url` (string) — The URL of the page after submission (may differ from `url` on redirect).
- `fill_start_at` (string) — ISO 8601 UTC timestamp.
- `submit_at` (string) — ISO 8601 UTC timestamp when the submit action was triggered.
- `post_submit_at` (string) — ISO 8601 UTC timestamp when `wait_after_submit` condition was met.
- `corr` (string) — AEE correlation ID linking before and after screenshots.

## Failure modes

- **Form not found:** Raised at Step 5 when `form_selector` matches no elements and no `<form>` element exists in the DOM after page load. Set `status: "failed"`, `error: "No form element found matching selector '<selector>'"`. Capture a screenshot of the current DOM state before closing, persist as `evidence/<org_id>/<corr>/error_<ulid>.png`, and include the ref in the error output so the caller can inspect what was actually rendered.
- **Field not found:** Raised at Step 6 when a key from `field_map` does not match any element by selector, name, or id. Set `status: "failed"`, `error: "Form field not found: <key>"`. Include the list of all `<input>`, `<textarea>`, and `<select>` element identifiers found within the form so the caller can diagnose a selector mismatch without launching another browser session.
- **Vault key not found:** Raised at Step 2 when a vault reference cannot be resolved. Set `status: "failed"`, `error: "Vault key not found: <key_name>"`. No browser is launched. This is a hard pre-flight failure to prevent a partially filled form from being submitted with missing credentials.
- **Submission timeout:** Raised when the `wait_after_submit` condition is not met within the remaining `timeout_ms` budget after the submit action. The form submission may or may not have reached the server. Set `status: "failed"`, `error: "Post-submit wait timed out after <elapsed_ms>ms"`. Capture a timeout screenshot and persist it as `evidence/<org_id>/<corr>/timeout_<ulid>.png`. The caller must not assume the submission succeeded and should investigate the server side independently.
- **Sandbox kill:** The browser-q sandbox terminates the Chromium process mid-interaction due to resource budget exhaustion. Set `status: "failed"`, `error: "Browser sandbox terminated process during form interaction"`. Any screenshots captured before the kill are already persisted to the evidence store and their refs are included in the partial output. The in-memory secrets map is wiped on process exit by the sandbox.

## Notes

Credentials must never appear in the skill body, workflow definition, AEE envelope, VOLT record, collector logs, or any other durable artefact. The only permitted source for sensitive field values is the agent's credential vault, referenced via the `vault:<key_name>` syntax in `field_map`. The vault is accessed at Step 2 under the agent's runtime identity, subject to the org's vault access policy. Resolved secrets live only in the in-memory map for the duration of the invocation and are wiped at Step 12. If an operator or workflow author attempts to pass a literal password string as a field value, the skill will submit it but the VOLT submission trace will record it in plain text — operators must use vault references to prevent credential exposure in the audit log. The before and after screenshots are tied to the parent AEE `corr` ID, enabling a reviewer to inspect the complete form interaction as a linked pair from the evidence query API. For multi-step forms (wizards with multiple pages), invoke this skill once per page step, passing the same `corr` value each time to keep the full interaction trace linked.
