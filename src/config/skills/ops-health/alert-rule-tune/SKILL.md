---
name: alert-rule-tune
license: LicenseRef-SkillRights-Reserved-1.0
category: ops/health
version: 1.0.0
edition: stable
author: quox-core
description: Reads an existing Prometheus alerting rule, fetches its metric series over the last 7 days, proposes a tuned threshold derived from statistical analysis of that window, and emits a rule diff for human approval before any change is applied.
tags: [alerting, prometheus, threshold-tuning, alert-rule, diff, human-approval, observability]
best_for_agents: [metrics]
required_tools: []
required_capabilities: []
related_skills: [prom-range-query]
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Alert Rule Tune

## When to apply

Use this skill when an alerting rule is producing excessive false positives (threshold too tight), missing real incidents (threshold too loose), or has not been reviewed since initial deployment. Typical triggers: an operator asks to review a noisy alert, a post-incident review identifies a threshold that should have fired earlier, or a weekly reliability review surfaces rules that have not been adjusted in more than 30 days. This skill is read-and-propose only — it never modifies the alerting rule directly. All threshold changes require an explicit human approval step. Do not use this skill to create new alerting rules from scratch; its input is an existing, named rule.

## Inputs

- `rule_group` (string) — Name of the Prometheus rule group containing the target rule. Required.
- `rule_name` (string) — Name of the alerting rule to tune (the `alert:` field value). Required.
- `rules_source` (string, optional) — Path or URL to the YAML rules file, or `"prometheus_api"` to read the rule from the Prometheus `/api/v1/rules` endpoint. Default: `"prometheus_api"`.
- `lookback_days` (number, optional) — Number of days of historical metric data to analyse. Default: `7`. Minimum: `1`. Maximum: `30`.
- `step` (string, optional) — Resolution step for the historical query, forwarded to `prom-range-query`. Default: `5m`.
- `percentile` (number, optional) — The percentile of the historical series used to anchor the proposed threshold. Default: `95`. Accepted values: `50`, `75`, `90`, `95`, `99`. The proposal adds a configurable headroom margin on top of the chosen percentile.
- `headroom_pct` (number, optional) — Percentage headroom added above the computed percentile value to reduce false positives. Default: `20`. Set to `0` to propose the raw percentile with no margin.
- `approval_required` (boolean, optional) — When `true`, the skill emits an HITL approval request via the Quox inbox before finalising the diff. Default: `true`. Set to `false` only in automated review pipelines where a human review step is handled externally.

## Steps

1. Resolve the current alerting rule definition. If `rules_source` is `"prometheus_api"`, issue a GET to `<prometheus.base_url>/api/v1/rules` and locate the rule whose `name` matches `rule_name` within the group `rule_group`. If `rules_source` is a file path or URL, load the YAML and locate the rule by the same fields. Fail with `rule_not_found` if no matching rule exists.
2. Extract the PromQL expression from the rule's `expr` field. Parse the expression to identify the metric name and any label filters that form the basis of the threshold comparison. Record the current threshold value as `current_threshold` by inspecting the comparison operator and scalar on the right-hand side of the expression (e.g. in `http_request_duration_seconds{} > 0.5`, the threshold is `0.5`).
3. Derive a base query for the metric without the threshold comparison (e.g. strip `> <value>` from the expression) to produce a pure time-series query. Validate the derived query is syntactically valid PromQL before proceeding.
4. Invoke `prom-range-query` with the derived metric query, `start` set to `now − lookback_days × 86400s`, `end` set to `now`, and the supplied `step`. Inherit the `corr` id for the AEE chain.
5. From the returned `series`, compute the requested `percentile` across all data points (union of all series values). If multiple series are returned (e.g. per-instance metrics), compute the percentile across the aggregated union, then separately compute per-series percentiles for the notes section.
6. Compute `proposed_threshold = percentile_value × (1 + headroom_pct / 100)`. Round to the same number of significant figures as `current_threshold`.
7. Generate a rule diff: produce the original rule YAML block and a modified block with `current_threshold` replaced by `proposed_threshold`. Include the diff in unified-diff format (lines prefixed with `−` and `+`).
8. If `approval_required` is `true`, emit an HITL approval request to the Quox inbox (subject: `Alert rule threshold proposal: <rule_name>`) containing the diff, the statistical rationale (percentile value, headroom, lookback window), and links to the VOLT evidence record. The output field `approval_status` is set to `"pending"` until the user acts.
9. Attach an AEE envelope with `intent: quox.skill.alert_rule_tune`, inheriting `corr` from the caller. Emit a VOLT evidence record with `evidence_type: alert_rule_proposal` containing `rule_name`, `current_threshold`, `proposed_threshold`, `percentile`, `headroom_pct`, and `lookback_days`.
10. Return the structured output object (see Outputs).

## Outputs

- `rule_name` (string) — The alerting rule that was analysed.
- `rule_group` (string) — The group the rule belongs to.
- `current_threshold` (number) — The threshold value extracted from the existing rule expression.
- `proposed_threshold` (number) — The computed replacement threshold. Equal to `current_threshold` if the statistical analysis determines no change is warranted (i.e. the existing value already satisfies the percentile + headroom criterion).
- `change_warranted` (boolean) — `true` when `proposed_threshold` differs from `current_threshold` by more than 1% in either direction.
- `percentile_value` (number) — The raw percentile computed from the historical series, before headroom is applied.
- `percentile` (number) — The percentile that was requested (echoed).
- `headroom_pct` (number) — The headroom percentage applied (echoed).
- `lookback_days` (number) — The lookback window used (echoed).
- `series_count` (number) — Number of Prometheus series included in the analysis.
- `total_points_analysed` (number) — Total data points across all series used for the percentile calculation.
- `diff_unified` (string | null) — Unified-diff string showing the rule change. `null` when `change_warranted` is `false`.
- `diff_original_yaml` (string) — The original rule block in YAML.
- `diff_proposed_yaml` (string | null) — The proposed rule block in YAML. `null` when `change_warranted` is `false`.
- `approval_status` (string | null) — `"pending"` when an HITL request was emitted and not yet resolved; `"not_required"` when `approval_required` was `false`; `null` when `change_warranted` is `false`.
- `volt_evidence_id` (string | null) — VOLT record ID; `null` if VOLT store unavailable.
- `error` (string | null) — Human-readable error message; `null` on success.

## Failure modes

- **rule_not_found:** The specified `rule_name` does not exist in `rule_group` at the configured rules source. Set `error: "Rule '<rule_name>' not found in group '<rule_group>'"`. Return immediately without performing any metric query. The caller should verify the rule name and group, accounting for case sensitivity in Prometheus rule identifiers.
- **threshold_unparseable:** The rule's `expr` field does not contain a recognisable scalar threshold comparison (e.g. it uses a recording rule or a relational expression referencing another metric). Set `error: "Cannot extract numeric threshold from expr: <expr>"`. Return `current_threshold: null` and `proposed_threshold: null`. The rule may require manual analysis; do not attempt to guess the threshold structure.
- **insufficient_data:** The historical series returned by `prom-range-query` contains fewer than 50 total data points across all series for the lookback window. This makes percentile computation unreliable. Set `error: "Insufficient historical data: <n> points for <lookback_days>d window"`. Return the raw `series` result so the caller can inspect what data was available and decide whether to widen the lookback window.
- **no_change_warranted:** The computed `proposed_threshold` is within 1% of `current_threshold`. This is not an error — set `change_warranted: false`, `diff_unified: null`, `approval_status: null`, and `error: null`. Log the finding in the VOLT evidence record so the operator can see that the rule was reviewed and found to be appropriately tuned.
- **prom_query_failure:** The internal call to `prom-range-query` fails (e.g. Prometheus unreachable, bad PromQL after stripping the threshold). Propagate the nested error with prefix `"Metric query failed: <nested_error>"`. Emit VOLT evidence noting the analysis was attempted but incomplete. Do not propose a threshold from partial data.

## Notes

This skill deliberately separates concern: it proposes, never applies. The diff it emits must be reviewed by a human operator before being committed to the rules repository or pushed to a live Prometheus instance via the API. Routing the approval through the Quox HITL inbox (step 8) ensures the proposal is traceable and linkable to the VOLT evidence record, satisfying the `ops:change-approval` policy track. The `headroom_pct` default of 20% is conservative; for metrics with high natural variance (e.g. batch-job durations), operators should increase this to 30–40% to avoid re-tuning on the next weekly review. For metrics with very tight acceptable bounds (e.g. a hard SLA on p99 latency), set `headroom_pct: 0` and use a high `percentile: 99` to produce an aggressive but evidence-backed threshold. The related skill `prom-range-query` is called internally at step 4 — passing a pre-fetched `series` array is not currently supported; the lookback query is always re-issued to guarantee data freshness.
