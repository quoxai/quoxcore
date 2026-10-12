---
name: eu-ai-act-classification
license: LicenseRef-SkillRights-Reserved-1.0
category: compliance
version: 1.0.0
edition: stable
author: quox-core
description: Classify a Quox workflow or agent action against EU AI Act risk tiers, returning the tier, applicable obligations, and recommended Article 12 audit-log fields.
tags: [eu-ai-act, risk-classification, article-12, compliance, governance, regulatory]
best_for_agents: [sentinel]
required_tools: []
required_capabilities: [volt.write]
related_skills:
  - { skill_id: volt-evidence-attach, relation: composes }
  - { skill_id: ward-policy-update, relation: composes }
delegate_targets: []
policy_satisfies: [compliance:eu-ai-act-art-12]
policy_required: []
kind: procedural
---

# EU AI Act Classification

## When to apply

Use this skill before deploying or modifying a Quox workflow or agent action where EU AI Act compliance obligations may apply — for example, before enabling a new automated decision-making workflow, before expanding an agent's access to personal data, or as part of a periodic compliance review. Apply this skill whenever the org operates in, or processes data from, the European Economic Area, or when a customer contract requires EU AI Act attestation. The output tier and obligation list feed directly into the WARD policy track and Article 12 audit configuration.

## Inputs

- `subject_type` (`"workflow"` | `"agent_action"`) — What is being classified. Required.
- `subject_id` (string) — Workflow ID or agent action identifier. Required. Example: `"workflow:01HEXAMPLE"` or `"agent:sentinel:action:port-scan"`.
- `subject_description` (string) — Plain-language description of what the workflow or action does, who it affects, and what data it processes (max 2000 characters). Required. The classification reasoning is only as good as this description.
- `affected_persons` (array of strings) — Categories of natural persons whose data or decisions are affected. Required if applicable; pass an empty array only if the subject operates solely on system/infrastructure data with no personal data path. Examples: `["employees", "customers", "patients"]`.
- `decision_outputs` (array of strings, optional) — List of consequential decisions or actions the subject can produce. Examples: `["access granted/denied", "alert generated", "record flagged for review"]`.
- `existing_human_oversight` (string, optional) — Description of any existing human-in-the-loop controls. Absence of this field is treated as "no human oversight currently in place."

## Steps

1. Validate that `subject_description` is non-empty and `subject_id` is provided. If either is absent, abort with `error: "insufficient_input"`.
2. Evaluate the subject against the four EU AI Act risk tiers in descending order of severity:
   - **Unacceptable (Article 5):** Check for prohibited practices — social scoring by public authorities, real-time biometric surveillance in public spaces, exploitation of vulnerabilities, subliminal manipulation. If any indicator is present, classify as `unacceptable` and stop.
   - **High risk (Annex III):** Check for use in: critical infrastructure, education/vocational training, employment/worker management, essential private/public services, law enforcement, migration/border control, administration of justice, democratic processes. If the subject's `affected_persons` or `decision_outputs` align with any Annex III category, classify as `high`.
   - **Limited risk (Article 50):** Check for direct interaction with natural persons (chatbots, synthetic media generation, emotion recognition). If applicable but Annex III criteria are not met, classify as `limited`.
   - **Minimal risk:** Default tier if none of the above criteria are met.
3. For the assigned tier, compile the applicable obligations list from the EU AI Act:
   - **Unacceptable:** `["prohibited — do not deploy"]`
   - **High:** `["conformity-assessment", "technical-documentation", "transparency-to-users", "human-oversight-measures", "accuracy-robustness-cybersecurity", "registration-eu-database", "post-market-monitoring"]`
   - **Limited:** `["transparency-disclosure-to-users", "synthetic-content-labelling"]`
   - **Minimal:** `["voluntary-codes-of-conduct"]`
4. Generate the recommended Article 12 audit-log fields for the assigned tier:
   - Always include: `["subject_id", "action_timestamp", "operator_id", "output_summary"]`
   - High tier additionally requires: `["input_data_ref", "model_version", "human_reviewer_id", "decision_basis", "confidence_score"]`
   - Limited tier additionally requires: `["disclosure_shown_to_user", "interaction_session_id"]`
5. Attach a VOLT evidence record for this classification via `volt-evidence-attach` with `artefact_type: "json_blob"` containing the full classification output, `retention_policy: "long-term"`.
6. Emit an AEE envelope with intent `quox.compliance.eu_ai_act_classified`, referencing `subject_id`, `risk_tier`, and `evidence_id`.

## Outputs

- `subject_id` (string) — The workflow or agent action that was classified.
- `risk_tier` (`"unacceptable"` | `"high"` | `"limited"` | `"minimal"`) — The assigned EU AI Act risk tier.
- `tier_rationale` (string) — One to three sentences explaining which criteria drove the tier assignment.
- `obligations` (array of strings) — Applicable EU AI Act obligations for this tier.
- `article_12_fields` (array of strings) — Recommended audit-log fields to capture for compliance with Article 12.
- `evidence_id` (string) — VOLT evidence ID for this classification record.
- `classified_at` (string) — ISO 8601 UTC timestamp.

## Failure modes

- **Insufficient input:** If `subject_description` is empty or `subject_id` is missing, abort with `error: "insufficient_input"`. Classification without a description is guesswork, not compliance.
- **Unacceptable tier detected:** Return `risk_tier: "unacceptable"` with `obligations: ["prohibited — do not deploy"]`. Do not block silently — the caller must receive the explicit unacceptable classification and handle accordingly. This skill does not prevent deployment; it records and surfaces the classification.
- **VOLT write failure:** If the evidence record cannot be written, return the classification result with `evidence_id: null` and `error_detail: "volt_write_failed"`. The classification is still valid; the caller must retry the evidence attachment separately.

## Notes

This skill is an interpretive aid, not legal advice. The tier assignment is based on the subject description and decision_outputs provided — if that description is incomplete or inaccurate, the classification will be incorrect. High-risk classifications should be reviewed by a qualified legal or compliance officer before being used as the sole basis for deployment decisions. Article 13 transparency obligations (not covered here) may apply in addition to Article 12 logging. The EU AI Act became fully applicable on 2 August 2026; obligations for high-risk systems in Annex III were applicable from 2 August 2025.
