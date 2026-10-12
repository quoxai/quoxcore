---
name: ssl-audit
license: LicenseRef-SkillRights-Reserved-1.0
category: security
version: 1.0.0
edition: stable
author: quox-core
description: Audit TLS/SSL configuration for one or more hostnames — cert expiry, cipher suite strength, protocol versions, chain validity, OCSP stapling, and HSTS posture.
tags: [tls, ssl, certificate, cipher, hsts, ocsp]
best_for_agents: [sentinel]
required_tools:
  - { name: http_call, version_constraint: ">=1.0.0" }
required_capabilities: [network.read]
related_skills:
  - { skill_id: network-egress-snapshot, relation: composes }
delegate_targets: []
policy_satisfies: [security:audit-trail, tls:minimum-version]
policy_required: []
kind: procedural
---

# SSL Audit

## When to apply

Apply when a scheduled TLS posture check fires, when a certificate expiry alert is raised, or when a new hostname is added to the asset registry. Also suitable for ad-hoc audits triggered by the user or by WARDEN during a security sweep. Run before any public launch of a new service.

## Inputs

- `hosts` (array of strings) — One or more FQDNs or IPs to audit. Required.
- `port` (integer, optional) — TLS port to probe. Default: `443`.
- `min_tls_version` (string, optional) — Minimum acceptable TLS version (`TLSv1.2` or `TLSv1.3`). Default: `TLSv1.2`.
- `expiry_warn_days` (integer, optional) — Warn if cert expires within this many days. Default: `30`.

## Steps

1. For each host in `hosts`, open a TLS handshake on the target port and record the negotiated protocol version and selected cipher suite.
2. Retrieve the full certificate chain; extract subject CN/SAN, issuer, `notBefore`, `notAfter`, and key size.
3. Calculate days until expiry from `notAfter`; flag as `critical` if ≤ 7 days, `warn` if ≤ `expiry_warn_days`.
4. Verify the chain against system trust roots; record any self-signed, expired, or mismatched intermediates.
5. Check whether the server supports deprecated protocols (SSLv3, TLSv1.0, TLSv1.1); flag each enabled deprecated protocol as a finding.
6. Probe for OCSP stapling by inspecting the TLS handshake `status_request` extension response.
7. Issue an HTTPS request and inspect the `Strict-Transport-Security` response header; record `max-age`, `includeSubDomains`, and `preload` values (or absence).
8. Aggregate all findings into a structured report keyed by hostname; emit a VOLT evidence envelope per host.

## Outputs

- `results` (array of objects) — One entry per host: `{ host, tls_version, cipher, cert_expiry_days, chain_valid, ocsp_stapled, hsts, findings[] }`.
- `summary` (object) — `{ total_hosts, passing, warnings, critical }`.
- `findings` (array of objects) — Flat list of all issues with `severity`, `host`, and `detail`.

## Failure modes

- **Host unreachable:** Mark host as `error: unreachable` in results; continue with remaining hosts; surface in summary counts.
- **Certificate parse failure:** Record `cert_parse_error` for the affected host; do not abort the audit.
- **OCSP responder timeout:** Record `ocsp_timeout`; treat as `unknown` rather than a failure finding; note in output.

## Notes

Emit one VOLT evidence envelope per audited host so the audit trail is queryable per asset. WARD policy `tls:minimum-version` governs what minimum TLS version is acceptable; WARDEN should escalate to the human inbox when `critical` findings are present. Chain validation uses the bastion-routed network path — results reflect the egress profile from the Quox control plane, not the public internet, unless `network-egress-snapshot` confirms they match.
