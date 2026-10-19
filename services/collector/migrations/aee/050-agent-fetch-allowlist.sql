-- 050-agent-fetch-allowlist.sql — per-org URL-prefix allowlist for the governed
-- agent fetch tool (web_fetch_allowlisted, quox#1171).
--
-- An org admin names the URL prefixes an agent may GET. Default-deny: an org
-- with no rows can fetch nothing. The tool still resolves DNS and refuses
-- loopback, link-local (cloud metadata), unspecified and multicast addresses
-- regardless of this list. Private ranges need an instance admin's entry, and the collector's
-- own networks and Docker bridge ranges are never reachable (lib/agentFetchEgressPolicy.js).

CREATE TABLE IF NOT EXISTS agent_fetch_allowlist (
  org_id     TEXT NOT NULL,
  url_prefix TEXT NOT NULL,
  added_by   TEXT,
  added_at   TEXT,
  note       TEXT,
  -- 1 only when an INSTANCE admin added the entry: the only way a fetch may reach a private
  -- range (RFC1918, CGNAT, ULA). A tenant org admin's entry never does (HYPERION NO-GO fix).
  allow_private INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, url_prefix)
);
