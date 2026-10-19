/**
 * SEC-FIX-4: Resolve the effective agent_id for tool-execute requests,
 * preventing identity spoofing via unvalidated body fields.
 *
 * Problem: POST /api/v1/tools/execute previously built ctx.agentId from
 *   req.body.agent_id || 'quox' with no validation. A JWT user identified
 *   as 'cipher' could send { agent_id: 'quox' } and gain the orchestrator's
 *   full toolset — including delegate_to_agent, proxmox_vm_action, etc.
 *
 * Resolution rules:
 *   - JWT callers (req.user present):
 *       • If req.user.agent_id is set (JWT claim), use it — body is ignored.
 *         This closes the spoofing vector.
 *       • If JWT has no agent claim AND body supplies a known agent, allow it.
 *       • If JWT has no agent claim AND body is empty, default to 'quox'.
 *       • Body value that isn't a known agent → reject with 400.
 *   - Service callers (req.service=true, e.g. QuoxMCP, Telegram, fleet):
 *       • Body agent_id is preserved if it's a known agent.
 *       • Unknown agent_id → reject with 400.
 *       • Default to 'quox' if nothing specified.
 *   - No auth context: default 'quox' (only reachable in dev/tests without auth).
 *
 * The "known agent" allowlist is the top-level keys of AGENT_TOOLS.
 */

const { AGENT_TOOLS, aliasAgentId } = require('./agentTools.js');
const toolStore = require('./toolDefinitionsStore.js');

function isKnownAgent(agentId) {
  if (!agentId || typeof agentId !== 'string') return false;
  // Static core agents (16) — fast path
  if (Object.prototype.hasOwnProperty.call(AGENT_TOOLS, agentId)) return true;
  // POWERS-deployed agents (mcp_endpoint or mcp_hosted) — toolDefinitionsStore lookup
  if (toolStore?.hasAgent?.(agentId)) return true;
  return false;
}

/**
 * Resolve the agent_id for a tool-execute request.
 *
 * @param {object} req - Express request. Expected: req.user?, req.service?, req.body.
 * @returns {{ ok: true, agentId: string } | { ok: false, error: string, agentId: null }}
 */
function resolveCallerAgentId(req) {
  // QUOXHAT D1.5: resolve the display-name alias (commanderq -> quox) so the
  // EFFECTIVE agent_id validated + returned is the registered orchestrator, and
  // the downstream backends (memory / brain / inbox) stop 400ing "unknown agent:
  // CommanderQ". Narrow + case-preserving — only this one alias is remapped, so
  // no non-alias identity changes and no new spoofing (CommanderQ is just the
  // orchestrator's own voice display-name, which a caller could already select).
  const bodyAgentId = aliasAgentId(req.body?.agent_id);
  const jwtAgentClaim = aliasAgentId(req.user?.agent_id || null);
  const isServiceAuth = req.service === true;

  // JWT caller: JWT claim beats body to prevent spoofing
  if (req.user && !isServiceAuth) {
    if (jwtAgentClaim) {
      if (isKnownAgent(jwtAgentClaim)) {
        return { ok: true, agentId: jwtAgentClaim };
      }
      // JWT claim itself is unknown — fail closed
      return { ok: false, agentId: null, error: `unknown agent in JWT claim: ${jwtAgentClaim}` };
    }
    // No JWT agent claim — allow body value if it's a known agent
    if (bodyAgentId) {
      if (isKnownAgent(bodyAgentId)) {
        return { ok: true, agentId: bodyAgentId };
      }
      return { ok: false, agentId: null, error: `unknown agent: ${bodyAgentId}` };
    }
    // Neither JWT claim nor body — default
    return { ok: true, agentId: 'quox' };
  }

  // Service caller: body value trusted if known (QuoxMCP selects agent per-call)
  if (isServiceAuth) {
    if (bodyAgentId) {
      if (isKnownAgent(bodyAgentId)) {
        return { ok: true, agentId: bodyAgentId };
      }
      return { ok: false, agentId: null, error: `unknown agent: ${bodyAgentId}` };
    }
    return { ok: true, agentId: 'quox' };
  }

  // No auth context (dev/tests)
  if (bodyAgentId) {
    if (isKnownAgent(bodyAgentId)) {
      return { ok: true, agentId: bodyAgentId };
    }
    return { ok: false, agentId: null, error: `unknown agent: ${bodyAgentId}` };
  }
  return { ok: true, agentId: 'quox' };
}

/**
 * quox#576 flaw #1 — a custom/org assistant (auth `assistants` table row,
 * attached via `quox agent attach <customId>`) is neither a core
 * AGENT_TOOLS key nor a POWERS-deployed tool, so isKnownAgent() above
 * always rejected it. Every tool-execute call from an attached custom
 * assistant 400'd `invalid agent_id`, which broke memory_search/recall —
 * the core persistent-memory promise of attaching — even though the attach
 * itself had already succeeded.
 *
 * This resolves ONE agent id as a "known custom agent" ONLY if it is a REAL
 * assistant row IN THE GIVEN org, via auth's internal endpoint
 * (services/auth/routes/internal-assistants.js — X-Service-Key, org-scoped
 * `WHERE org_id = ? AND (id = ? OR slug = ?)`, 404 for any other org's
 * matching row). That 404 boundary IS the tenant-isolation check; this
 * function does no scoping of its own beyond passing the org through.
 *
 * SECURITY: callers MUST pass an orgId they already trust (the JWT claim's
 * org_id) — see resolveCallerAgentIdAsync() below, which is the only
 * production call site and only ever invokes this for the JWT agent_id
 * claim, never for a body-supplied value. That is the spoofing boundary:
 * a body-supplied agent_id must never reach this function.
 *
 * Briefly cached (CUSTOM_AGENT_CACHE_TTL_MS) so a hot tool-execute loop
 * (memory_search on every turn) doesn't round-trip to auth on every call;
 * correctness still wins on a cache miss or a network failure (fails
 * closed — see catch below).
 */
// Same host/port convention + URL/header shape agentAttachKit.js's
// fetchCustomAssistantForKit() uses for this endpoint — duplicated here
// (rather than requiring agentAttachKit.js, which pulls in a much heavier
// module chain, e.g. llmRoutingPolicy/httpAuth, with its own
// module-load-time env requirements unrelated to this lookup) to keep this
// resolver self-contained. Both call the SAME auth endpoint
// (services/auth/routes/internal-assistants.js) with the SAME org-scoped
// contract, so they can never disagree about what counts as "in-org".
const AUTH_URL_DEFAULT = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`;
const CUSTOM_AGENT_FETCH_TIMEOUT_MS = 2000;

async function fetchCustomAssistantOrgScoped({ orgId, agentId, fetchFn, authServiceUrl = AUTH_URL_DEFAULT, timeoutMs = CUSTOM_AGENT_FETCH_TIMEOUT_MS }) {
  const doFetch = fetchFn || globalThis.fetch;
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
  const url = `${authServiceUrl}/api/internal/assistants/${encodeURIComponent(agentId)}?org_id=${encodeURIComponent(orgId || '')}`;
  const resp = await doFetch(url, {
    headers: { 'X-Service-Key': serviceKey, 'X-Org-Id': orgId || '' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  // HYPERION NO-GO fix (2026-10-16): only a 404 is a definite "no" (cross-org, unknown, retired).
  // Any other non-ok (401/500/503...) THROWS, so no caller can read an auth outage as an answer.
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`auth answered ${resp.status}`);
  const data = await resp.json();
  return data && typeof data === 'object' && typeof data.id === 'string' ? data : null;
}

// quox#1170: a user-made agent (`quox agent create`, auth agents table) is asked about the same
// way, against its own org-scoped endpoint: 200 only for an ACTIVE, non-built-in agent of that
// slug IN the caller's org.
async function fetchOrgAgentOrgScoped({ orgId, agentId, fetchFn, authServiceUrl = AUTH_URL_DEFAULT, timeoutMs = CUSTOM_AGENT_FETCH_TIMEOUT_MS }) {
  const doFetch = fetchFn || globalThis.fetch;
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
  const url = `${authServiceUrl}/api/internal/org-agents/${encodeURIComponent(agentId)}?org_id=${encodeURIComponent(orgId || '')}`;
  const resp = await doFetch(url, {
    headers: { 'X-Service-Key': serviceKey, 'X-Org-Id': orgId || '' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  // HYPERION NO-GO fix (2026-10-16): only a 404 is a definite "no" (cross-org, unknown, retired).
  // Any other non-ok (401/500/503...) THROWS, so no caller can read an auth outage as an answer.
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`auth answered ${resp.status}`);
  const data = await resp.json();
  return data && typeof data === 'object' && data.org_id === orgId && data.status === 'active' ? data : null;
}

const CUSTOM_AGENT_CACHE_TTL_MS = 15000;
const customAgentCache = new Map(); // `${orgId}::${agentId}` -> { known, expires }

function _customAgentCacheGet(key) {
  const hit = customAgentCache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    customAgentCache.delete(key);
    return undefined;
  }
  return hit.known;
}

function _customAgentCacheSet(key, known) {
  customAgentCache.set(key, { known, expires: Date.now() + CUSTOM_AGENT_CACHE_TTL_MS });
}

/** Test-only: clears the org-scoped custom-agent + resident caches between cases. */
function clearCustomAgentCache() {
  customAgentCache.clear();
  residentAgentCache.clear();
  orgAgentCache.clear();
}

// Journey #3 (2026-10-19): a REAL agent was refused "unknown agent in JWT claim" when this lookup timed out during
// an event-loop stall (the 2 s timeout, fail closed). One retry after a short pause; when auth still cannot answer
// the result carries the error, so the caller can say "could not verify" instead of "unknown". Still fails closed.
const CUSTOM_AGENT_RETRY_MS = 250;
async function checkCustomOrgAgent({ orgId, agentId, fetchFn } = {}) {
  if (!orgId || !agentId || typeof agentId !== 'string') return { known: false, error: null };
  const key = `${orgId}::${agentId}`;
  const cached = _customAgentCacheGet(key);
  if (cached !== undefined) return { known: cached, error: null };
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, CUSTOM_AGENT_RETRY_MS));
    try {
      const assistant = await fetchCustomAssistantOrgScoped({ orgId, agentId, fetchFn });
      const known = !!assistant || !!(await fetchOrgAgentOrgScoped({ orgId, agentId, fetchFn }));
      _customAgentCacheSet(key, known);
      return { known, error: null };
    } catch (err) {
      lastErr = err;
      console.error(`[agentIdResolver] custom-org agent check failed (org=${orgId}, agent=${agentId}, attempt ${attempt + 1}/2): ${err.message}`);
    }
  }
  // Fail CLOSED: an unreachable auth service must never widen who counts as a known agent. Not cached, so a
  // transient outage does not poison the next call once auth recovers.
  return { known: false, error: String((lastErr && (lastErr.name === 'TimeoutError' ? `timeout: ${lastErr.message}` : lastErr.message)) || 'auth did not answer') };
}

async function isKnownCustomOrgAgent(args = {}) {
  return (await checkCustomOrgAgent(args)).known === true;
}

/**
 * quox#1171: is this a USER-MADE agent (auth agents table, non-built-in, active) in this org?
 * Unlike isKnownCustomOrgAgent this THROWS when auth cannot answer, so a caller that restricts
 * user-made agents (slot_say) can fail closed instead of mistaking an outage for "not user-made".
 * Only definite answers are cached.
 */
const orgAgentCache = new Map(); // `${orgId}::${agentId}` -> { known, expires }
async function isUserMadeOrgAgent({ orgId, agentId, fetchFn } = {}) {
  if (!orgId || !agentId || typeof agentId !== 'string') return false;
  // A tenant row may share a built-in's id (ids are unique per org only); the built-in is never shadowed.
  if (isKnownAgent(aliasAgentId(agentId))) return false;
  const key = `${orgId}::${agentId}`;
  const hit = orgAgentCache.get(key);
  if (hit && Date.now() <= hit.expires) return hit.known;
  const known = !!(await fetchOrgAgentOrgScoped({ orgId, agentId, fetchFn }));
  orgAgentCache.set(key, { known, expires: Date.now() + CUSTOM_AGENT_CACHE_TTL_MS });
  return known;
}

const RESIDENT_AGENT_CACHE_TTL_MS = 15000;
const residentAgentCache = new Map(); // `${orgId}::${agentId}` -> { known, expires }

/**
 * QUOXTRUST — is this VERIFIED JWT agent_id a legitimate ACTIVE resident agent
 * in the given org? A resident's identity lives in auth's resident_identities
 * table (a users-row ULID with actor_type='agent'), NOT the assistants table,
 * so isKnownCustomOrgAgent() never matches it and every tool-execute call from
 * a resident/attached automated session 400'd "unknown agent in JWT claim"
 * (STATUS_AND_LIMITS_X.md / quoxpert-x). This mirrors that function's shape
 * against the resident registry via a dedicated org-scoped internal endpoint
 * (services/auth/routes/resident-identity.js): 200 only for an ACTIVE row whose
 * org_id AND user_id both match — the 404 boundary IS the tenant + revocation
 * check. Fails CLOSED on any error/timeout. Briefly cached so a hot tool loop
 * does not round-trip auth every call.
 *
 * SECURITY: callers MUST pass the org_id + agent_id from the VERIFIED JWT claim,
 * never a body-supplied value — resolveCallerAgentIdAsync() (the only
 * production caller) gates this on req.user.resident_host and never consults
 * req.body. That is the SEC-FIX-4 spoofing boundary, unchanged.
 */
async function fetchResidentIdentityOrgScoped({ orgId, agentId, fetchFn, authServiceUrl = AUTH_URL_DEFAULT, timeoutMs = CUSTOM_AGENT_FETCH_TIMEOUT_MS }) {
  const doFetch = fetchFn || globalThis.fetch;
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
  const url = `${authServiceUrl}/api/internal/resident-identities/verify?org_id=${encodeURIComponent(orgId || '')}&user_id=${encodeURIComponent(agentId)}`;
  const resp = await doFetch(url, {
    headers: { 'X-Service-Key': serviceKey, 'X-Org-Id': orgId || '' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  // HYPERION NO-GO fix (2026-10-16): only a 404 is a definite "no" (cross-org, unknown, retired).
  // Any other non-ok (401/500/503...) THROWS, so no caller can read an auth outage as an answer.
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`auth answered ${resp.status}`);
  const data = await resp.json();
  return data && typeof data === 'object' && data.status === 'active' && typeof data.id === 'string' ? data : null;
}

async function isKnownResidentAgent({ orgId, agentId, fetchFn } = {}) {
  if (!orgId || !agentId || typeof agentId !== 'string') return false;
  const key = `${orgId}::${agentId}`;
  const hit = residentAgentCache.get(key);
  if (hit && Date.now() <= hit.expires) return hit.known;
  if (hit) residentAgentCache.delete(key);
  try {
    const row = await fetchResidentIdentityOrgScoped({ orgId, agentId, fetchFn });
    const known = !!row;
    residentAgentCache.set(key, { known, expires: Date.now() + RESIDENT_AGENT_CACHE_TTL_MS });
    return known;
  } catch (err) {
    console.error(`[agentIdResolver] resident agent check failed (org=${orgId}, agent=${agentId}): ${err.message}`);
    // Fail CLOSED — an unreachable auth service must never widen who is known.
    return false;
  }
}

/**
 * Async superset of resolveCallerAgentId(): identical rules and identical
 * result for every case the sync version already handles. The ONE addition
 * is that when the TRUSTED JWT agent_id claim fails the static
 * isKnownAgent() check, it is also checked against isKnownCustomOrgAgent()
 * (org-scoped to the caller's own org, from the same verified JWT claim)
 * before being rejected. quox#576 flaw #1.
 *
 * A body-supplied agent_id is NEVER eligible for the custom-org check —
 * that is the exact spoofing vector SEC-FIX-4 (resolveCallerAgentId's own
 * doc comment, top of file) closed for the static case, and this function
 * must not reopen it for the custom-agent case.
 *
 * @param {object} req
 * @param {{fetchFn?: Function}} [opts] - test override for the auth fetch
 * @returns {Promise<{ ok: true, agentId: string } | { ok: false, error: string, agentId: null }>}
 */
async function resolveCallerAgentIdAsync(req, opts = {}) {
  const sync = resolveCallerAgentId(req);
  if (sync.ok) return sync;

  const isServiceAuth = req.service === true;
  const jwtAgentClaim = req.user?.agent_id || null;

  // Only the "JWT claim present but not a static known agent" rejection
  // shape is eligible for the custom-org escalation — this is exactly the
  // branch resolveCallerAgentId() takes for `req.user && !isServiceAuth &&
  // jwtAgentClaim` above, which never consults req.body at all.
  if (req.user && !isServiceAuth && jwtAgentClaim) {
    const orgId = req.user.org_id || req.user.orgId || null;

    // Resident/attached agent: recognised ONLY from the verified JWT
    // (resident_host marker + agent_id claim), verified active + in-org
    // against the resident registry. Gated on resident_host so a plain
    // custom-assistant claim never reaches the resident endpoint, and a
    // body-supplied value never reaches here at all (jwtAgentClaim is the
    // JWT claim, not the body).
    if (req.user.resident_host) {
      const resident = await isKnownResidentAgent({ orgId, agentId: jwtAgentClaim, fetchFn: opts.fetchFn });
      if (resident) {
        return { ok: true, agentId: jwtAgentClaim };
      }
    }

    const check = await checkCustomOrgAgent({ orgId, agentId: jwtAgentClaim, fetchFn: opts.fetchFn });
    if (check.known) {
      return { ok: true, agentId: jwtAgentClaim };
    }
    if (check.error) {
      // still refused, but never reported as "unknown": auth could not answer, so a retry may succeed
      return { ok: false, agentId: null, error: `could not verify agent ${jwtAgentClaim} right now (auth lookup failed: ${check.error}); nothing ran, retry` };
    }
  }

  return sync;
}

module.exports = {
  resolveCallerAgentId,
  resolveCallerAgentIdAsync,
  isKnownAgent,
  isKnownCustomOrgAgent,
  isUserMadeOrgAgent,
  isKnownResidentAgent,
  clearCustomAgentCache,
};
