---
name: hipaa-phi-handling-gate
license: LicenseRef-SkillRights-Reserved-1.0
category: compliance
version: 1.0.0
edition: stable
author: quox-core
description: Inspect a payload for PHI markers before any downstream operation; route to quarantine or strip with audit trail if PHI is detected.
tags: [hipaa, phi, pii, data-protection, quarantine, compliance, gate]
best_for_agents: [sentinel, regula]
required_tools: []
required_capabilities: [volt.write, hitl.inbox.write]
related_skills:
  - { skill_id: volt-evidence-attach, relation: composes }
delegate_targets: []
policy_satisfies: [compliance:hipaa-phi-handling]
policy_required: []
kind: procedural
---

# HIPAA PHI Handling Gate

## When to apply

Insert this skill as a pre-flight gate before any workflow step that transmits, stores, indexes, or processes user-supplied text, JSON, or file content where healthcare context is possible — for example, before logging free-text support tickets, before indexing uploaded documents, before passing a user message to an external LLM API, or before writing records to a data lake. Apply proactively; do not rely on the absence of a HIPAA flag elsewhere in the system. This skill is a gate, not a sanitizer — it detects and routes; the calling workflow decides whether to strip, quarantine, or abort.

## Inputs

- `payload_type` (`"text"` | `"json"` | `"file"`) — The type of payload to inspect. Required.
- `payload_content` (string | base64) — The content to inspect. For `"text"` and `"json"`, supply the raw string. For `"file"`, supply base64-encoded bytes (max 10 MB). Required.
- `payload_label` (string, optional) — Human-readable label for this payload (e.g., `"support-ticket-4821"`, `"uploaded-lab-report.pdf"`). Used in the audit record. Default: derived from `payload_type` + timestamp.
- `execution_context_id` (string) — AEE execution or task ID this gate is attached to. Required.
- `action_on_phi_found` (`"quarantine"` | `"strip_and_continue"` | `"abort"`) — What to do if PHI is detected. Required.
- `strip_replacement_token` (string, optional) — Token used when replacing redacted PHI spans in `strip_and_continue` mode. Default: `"[REDACTED]"`.

## Steps

1. Validate inputs: confirm `payload_content` is non-empty, `execution_context_id` is present, and `action_on_phi_found` is one of the allowed values. If any required field is missing, abort with `error: "missing_required_input"`.
2. Decode the payload if `payload_type` is `"file"` (base64 → text or binary). For binary files (PDF, DOCX), extract text using the available document-to-text tool before scanning. If text extraction fails, treat the file as opaque and emit `warning: "text_extraction_failed"` — do not pass an unscanned file downstream.
3. Run the PHI pattern-matching pass over the text content. Detect the following marker classes:
   - **Names in clinical context:** patterns matching `[First] [Last]` adjacent to clinical keywords (`patient`, `dx`, `diagnosis`, `admitted`, `discharged`, `MRN`).
   - **Dates of birth:** ISO 8601 dates (`YYYY-MM-DD`), US format (`MM/DD/YYYY`), and verbose form (`January 5, 1985`) adjacent to person-identifying terms.
   - **MRN (Medical Record Number):** patterns `MRN:`, `MRN #`, `Medical Record No.` followed by an alphanumeric identifier.
   - **SSN-like patterns:** `\d{3}-\d{2}-\d{4}` or `\d{9}` in non-financial context.
   - **ICD-10/ICD-11 codes:** patterns `[A-Z]\d{2}(\.\d+)?` adjacent to clinical terms.
   - **Health insurance identifiers:** patterns matching `Policy #`, `Member ID`, `Group #` adjacent to insurer names or numeric identifiers.
4. Compile a `phi_findings` list: for each detected marker, record `{ marker_type, span_start, span_end, confidence: "high" | "medium" }`. Do not include the matched text itself in the findings list — record offsets only to avoid propagating PHI into logs.
5. If `phi_findings` is empty, record a clean-pass VOLT evidence record (type `json_blob`, description `"PHI gate: clean pass"`) and return `phi_detected: false` with an empty `phi_findings` list. Allow downstream processing to proceed.
6. If PHI is detected, apply `action_on_phi_found`:
   - **`quarantine`:** Write the payload to the PHI quarantine queue with `payload_label`, `execution_context_id`, `phi_findings`, and `quarantine_reason: "phi_detected"`. Do not return payload content to the caller. Return `phi_detected: true`, `quarantine_id`, and `phi_findings` (offsets only).
   - **`strip_and_continue`:** Replace all detected PHI spans with `strip_replacement_token`. Return `phi_detected: true`, `stripped_payload` (the sanitised content), and `phi_findings`.
   - **`abort`:** Return `phi_detected: true`, `phi_findings`, and `error: "phi_detected_abort"`. Do not pass any content downstream.
7. Attach a VOLT evidence record for this gate invocation via `volt-evidence-attach`:
   - `artefact_type: "json_blob"`
   - Content: `{ phi_detected, phi_finding_count, action_taken, payload_label, execution_context_id }` — never include payload content or PHI spans in the evidence record.
   - `retention_policy: "long-term"`
8. Emit an AEE envelope with intent `quox.compliance.phi_gate_passed` (clean) or `quox.compliance.phi_gate_triggered` (PHI found), referencing `execution_context_id` and `evidence_id`.

## Outputs

- `phi_detected` (boolean) — Whether any PHI markers were found.
- `phi_findings` (array) — List of `{ marker_type, span_start, span_end, confidence }` objects. Empty array if `phi_detected: false`. Never contains matched text.
- `phi_finding_count` (number) — Count of detected PHI spans.
- `action_taken` (`"none"` | `"quarantine"` | `"strip_and_continue"` | `"abort"`) — The action applied.
- `quarantine_id` (string | null) — Quarantine queue record ID. Non-null only when `action_taken: "quarantine"`.
- `stripped_payload` (string | null) — Sanitised payload content. Non-null only when `action_taken: "strip_and_continue"`.
- `evidence_id` (string) — VOLT evidence ID for this gate invocation record.
- `gate_ran_at` (string) — ISO 8601 UTC timestamp.

## Failure modes

- **Missing required input:** Abort with `error: "missing_required_input"` listing which fields are absent. Do not run detection on an incomplete invocation.
- **Text extraction failed (file type):** Emit `warning: "text_extraction_failed"` and route the file to quarantine regardless of `action_on_phi_found` — an unscanned file must not proceed downstream. Return `phi_detected: null` to signal the uncertain state.
- **Quarantine queue unavailable:** If `action_on_phi_found` is `"quarantine"` but the queue is unreachable, fall back to `"abort"` and emit `warning: "quarantine_unavailable_fell_back_to_abort"`. Never allow unquarantined PHI to proceed downstream when the quarantine path is broken.
- **VOLT write failure:** If the evidence record cannot be written, still return the gate result to the caller and attach `evidence_write_failed: true`. The caller must retry the evidence write separately via `volt-evidence-attach`.

## Notes

Pattern matching in step 3 is a best-effort heuristic, not a guaranteed PHI detector. False negatives are possible, especially for uncommon identifier formats or non-English names. For highest-assurance healthcare workflows, combine this skill with a dedicated PHI-detection model call. The findings list deliberately records offsets, not text, to avoid writing PHI into VOLT records, logs, or AEE envelopes. The `strip_replacement_token` default `"[REDACTED]"` is intentionally generic — set it to a domain-specific token (e.g., `"[PHI]"`) when the downstream consumer needs to distinguish redacted spans from other absent values.
