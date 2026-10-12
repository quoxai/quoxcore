-- 007-fleet-host-credentials-table.sql — collector AEE database (aee.db)
--
-- SEC-FLEET-CRED (owner-authorized, HIGH severity, not yet exploitable in
-- production — nothing currently provisions real fleet hosts with these
-- credentials — but must be fixed before any real deployment).
--
-- Closes an org-impersonation hole in DEVSUITE-GRIPE's fleet-host capability
-- (lib/fleetGripeHandler.js). The handler previously trusted org_id straight
-- from the request body under requireServiceOrUserAuth()'s shared-key
-- branch: ANY caller holding INTERNAL_SERVICE_KEY (the SAME master secret
-- shared by every trusted same-box internal service — auth, quoxflow,
-- collector) could claim to act as ANY org, and the collector would resolve
-- THAT org's real vault-stored GitHub credentials
-- (lib/connectors/bridge.js's activateConnector(orgId, connectorId), no
-- cross-check). That pattern is fine for same-box trusted internal services
-- but stops being fine the moment a REMOTE FLEET HOST (quoxagent, running on
-- arbitrary managed hosts, potentially compromised) is handed the same
-- master key.
--
-- This table is the durable store for per-fleet-host credentials: issued
-- ONCE via POST /api/internal/fleet-hosts/:hostId/credential (admin/service
-- key gated — an enrollment action, NOT something a fleet host calls on
-- itself) and bound to a specific org_id at issuance time. See
-- lib/fleetHostCredentialsStore.js's requireFleetHostAuth() — it resolves
-- req.fleetHost = { hostId, orgId } from THIS table by hashing the
-- X-Fleet-Host-Token header presented on each request, so the org identity
-- flows from a server-side binding made at enrollment time, never from
-- anything the request body claims.
--
-- token_hash only — the raw token is returned exactly once at issuance and
-- is never persisted (same discipline as scim_tokens / mcp_tokens /
-- gpu_enroll_tokens elsewhere in this codebase, all SHA-256-at-rest).
-- revoked_at is nullable so a credential can be revoked without deleting
-- its row (audit trail preserved). host_id is the PK — (re)issuing a
-- credential for the same host_id replaces its prior token (UPSERT), which
-- also implicitly revokes the old one since only one token_hash can be
-- valid per host_id.

CREATE TABLE IF NOT EXISTS fleet_host_credentials (
  host_id     TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_fleet_host_credentials_org ON fleet_host_credentials(org_id);
