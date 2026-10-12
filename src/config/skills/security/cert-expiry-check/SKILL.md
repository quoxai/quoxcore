---
name: cert-expiry-check
license: LicenseRef-SkillRights-Reserved-1.0
category: security
version: 1.0.0
edition: stable
author: quox-core
description: Read TLS certificates across a declared list of Quox-managed hosts, returning cert/issuer/expiry triples sorted ascending by days-until-expiry so the nearest expirations appear first.
tags: [tls, certificate, expiry, pki, ssl, security-posture, inventory]
best_for_agents: [horus]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Cert Expiry Check

## When to apply

Apply when HORUS needs a current snapshot of TLS certificate health across the fleet, when a scheduled certificate-audit workflow fires, or when an operator asks "which certificates are expiring soon?" This skill reads live certificate data from each declared host — it does not rely on cached state. Use it before making renewal decisions, setting up automated renewal triggers, or generating compliance evidence of certificate hygiene. Hosts are reached via the Quox bastion at gw-01; the caller must ensure the declared host list is within the authorised asset scope.

## Inputs

- `hosts` (array of objects) — One entry per host to probe. Each object: `{ host: string, port: number }`. `host` is an FQDN or IP; `port` defaults to `443` if omitted. At least one entry is required.
- `warning_threshold_days` (integer, optional) — Number of days before expiry at which a certificate is flagged `warning`. Default: `30`.
- `critical_threshold_days` (integer, optional) — Number of days before expiry at which a certificate is flagged `critical`. Default: `7`.
- `include_chain` (boolean, optional) — If `true`, also capture intermediate and root issuer names from the presented chain. Default: `false`.
- `timeout_ms` (integer, optional) — TLS handshake timeout per host in milliseconds. Default: `5000`.

## Steps

1. Validate the `hosts` array: each entry must have a non-empty `host` value; apply default `port: 443` to entries missing the field. Abort with `error: empty_host_list` if the array is empty.
2. For each host entry, route the TLS connection through the Quox bastion (gw-01) when the target IP falls within a private RFC-1918 range; connect directly for public FQDNs. This ensures internal fleet hosts are reachable without opening direct external paths.
3. Initiate a TLS handshake to `host:port` with a timeout of `timeout_ms`. Extract the leaf certificate from the presented chain; if `include_chain` is `true`, extract all certificates in the chain.
4. Parse each certificate's `Subject Common Name` (CN), `Issuer Organisation` (O), `Not Before`, `Not After` (expiry), and `Subject Alternative Names` (SANs). Compute `days_until_expiry = floor((not_after - now_utc) / 86400)`.
5. Classify each certificate: `expired` if `days_until_expiry < 0`, `critical` if `days_until_expiry <= critical_threshold_days`, `warning` if `days_until_expiry <= warning_threshold_days`, otherwise `ok`.
6. Collect all results into a flat list of cert records (one per host), then sort the list ascending by `days_until_expiry` so the most urgent items appear first.
7. Emit a VOLT evidence record with `evidence_type: cert_expiry_inventory`, containing the full sorted result list (excluding private key material — certs only). Include scan timestamp, host count, and severity counts.
8. Attach an AEE envelope to the current execution context (`corr` inherited from caller) referencing the VOLT evidence record id and tagging the skill invocation as `quox.skill.cert_expiry_check`.

## Outputs

- `results` (array of objects) — Sorted by `days_until_expiry` ascending. Each object: `{ host, port, common_name, issuer, not_before, not_after, days_until_expiry, status, sans, chain_issuers }`. `chain_issuers` is populated only when `include_chain` is `true`.
- `summary` (object) — `{ total_hosts, expired_count, critical_count, warning_count, ok_count, scan_at }`.
- `volt_evidence_id` (string) — ULID of the emitted VOLT evidence record.

## Failure modes

- **TLS_HANDSHAKE_FAILED:** The host refused the connection or the handshake timed out. Set `status: unreachable` for that host and continue processing remaining hosts. Include an `error` field on the record with the failure reason. Do not abort the full run.
- **CERTIFICATE_PARSE_ERROR:** The presented certificate could not be parsed (malformed DER/PEM). Set `status: parse_error` for that host; include the raw error message. Surface in the summary as a separate `parse_error_count`.
- **EMPTY_HOST_LIST:** The `hosts` array is empty or contains only invalid entries. Abort immediately with `error: empty_host_list`; do not emit a VOLT record for an empty scan.
- **BASTION_ROUTING_FAILURE:** The connection to gw-01 could not be established for private-range hosts. Set `status: bastion_unreachable` on all affected hosts and include a top-level `warn: bastion_unavailable` in the output. Public hosts that do not require bastion routing are unaffected.

## Notes

This skill reads certificates only — it does not issue, renew, or revoke them. Renewal actions must be triggered separately by the calling agent based on the `status` classification returned here. The VOLT evidence record this skill emits serves as the audit artefact for certificate-inventory compliance checks; downstream WARD policies can query the ledger for `cert_expiry_inventory` records to confirm the sweep ran on schedule. When `include_chain` is `true`, issuer names in the chain are captured as strings only — no raw certificate bytes are stored in the VOLT payload. For wildcard certificates, the CN will contain a `*` prefix; the SANs list is the authoritative set of covered domains.
