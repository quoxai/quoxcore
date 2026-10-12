/**
 * Collector default-deny auth gate — COLLECTOR-AUTH stream #52, plan §3.
 *
 * Registered once, immediately after `express.json()` and before the first
 * route in server.js. Applies `requireServiceOrUserAuth()` (utils/httpAuth.js
 * :209-281) to every request EXCEPT an explicit allowlist (public routes,
 * webhook receivers that self-authenticate via secret/signature, and the
 * /quoxchat public widget subtree).
 *
 * Because this runs before every route registration, placement fragility of
 * the old per-prefix gates disappears and allowlist completeness is provable
 * by construction: anything not matched below is denied.
 *
 * SHADOW MODE (default, safety-critical):
 *   COLLECTOR_AUTH_ENFORCE unset | 'shadow' (DEFAULT) → requests that would be
 *     denied are logged (`[collector-auth-shadow] WOULD-DENY ...`) and then
 *     allowed through (`next()` is still called). Nothing is rejected.
 *   COLLECTOR_AUTH_ENFORCE === 'enforce' → non-allowlisted requests actually
 *     run requireServiceOrUserAuth() and fail closed (401/403).
 *
 * This mirrors the existing AEE_ENDPOINT_AUTH_ENFORCE pattern
 * (utils/httpAuth.js requireAeeAuth()) — deploy first in shadow mode, watch
 * the logs for WOULD-DENY lines from legitimate callers (fleet-agent
 * heartbeats, SSE producers, voice client, etc.), fix those callers, THEN
 * flip to enforce.
 */

const crypto = require('crypto');
const { requireServiceOrUserAuth } = require('./httpAuth');

const userGate = requireServiceOrUserAuth();

// LICENSE-LAUNCH LL-6b: the shadow DEFAULT documented above is exactly the
// hazard — an unset var on a production box leaves this whole gate decorative,
// with nothing but WOULD-DENY log lines to say so. lib/enforcementPosture.js
// preserves the env wording ('enforce' and nothing else) and adds one rule:
// under NODE_ENV=production, shadow WITHOUT an unexpired break-glass record is
// treated as enforce, and says so loudly in the log.
const { isEnforced: isPostureEnforced } = require('../lib/enforcementPosture.js');

function isEnforced() {
  return isPostureEnforced('COLLECTOR_AUTH_ENFORCE');
}

// AGENT-AUTH #126 — dedicated, SCOPED fleet-agent key. Accepted ONLY on the
// agent-push route (POST /api/v1/heartbeat), never elsewhere, so a compromised
// agent host cannot authenticate as a full internal service (that would need
// INTERNAL_SERVICE_KEY). Distributed to agents over the authenticated SSH
// deploy path (deploy/deploy-to-host.sh), NOT the public /install.
function isHeartbeatPush(req) {
  return req.method === 'POST' && req.path === '/api/v1/heartbeat';
}
function agentKeyValid(req) {
  const provided = req.headers['x-service-key'];
  const expected = process.env.AGENT_SERVICE_KEY;
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Rollout staging: while HEARTBEAT_REQUIRE_AGENT_KEY !== 'true', heartbeat is
// still allowed unauthenticated (belt) so the not-yet-rolled fleet stays up.
// Flip to 'true' AFTER the fleet is rolled to send AGENT_SERVICE_KEY.
function heartbeatBeltOpen() {
  return process.env.HEARTBEAT_REQUIRE_AGENT_KEY !== 'true';
}

// Exact-path public routes (no auth ever)
const PUBLIC_EXACT = new Set([
  '/health',
  // #610 Part 2: version/commit probe, same public posture as /health — a
  // secret-free read so `quox status`/doctor and a plain curl can check which
  // commit a DEPLOYED collector is running.
  '/version',
  '/api/v1/health/aggregate',
  '/api/public/honesty-stats',
  '/install',
  '/download/quoxmcp-bundle.tar.gz',
  // CLI-FIRST DEV SERVERS (DEVSUITE phase 8): same posture as the quoxmcp
  // bundle above — a public, secret-free artifact the install script fetches
  // before any credentials exist on the host.
  '/download/quoxcli-bundle.tar.gz',
  // DoneEngine bundle (quox#456), same posture and same fetch point as the
  // CLI bundle above: a public, secret-free artifact pulled by the enable
  // refresh. Missing this entry made the very first real delivery 401 on
  // qcore-rnd01 while every local test passed, because the tests never
  // crossed the default-deny gate.
  '/download/quoxgauge-bundle.tar.gz',
  // Precompacticus bundle (DEVSUITE-DEVMODE phase 14), same posture and same
  // fetch point as the CLI and gauge bundles above: a public, secret-free
  // artifact pulled by the enable refresh before any credentials exist on
  // the host. The gauge bundle 401d on its first real enable for exactly
  // this reason (missing from this allowlist); this entry ships with the
  // leg so it never repeats.
  '/download/precompacticus-bundle.tar.gz',
  // --- QLUSTER read surface (self-authenticates via its OWN read-token model,
  // requireReadToken / requireReadTokenConfigured in server.js — the external
  // Qluster fleet controller sends a QUOXCORE_READ_TOKEN bearer, NOT a Quox JWT,
  // so requireServiceOrUserAuth would wrongly 401 it). Phase 2 health/resources
  // is opt-in (public when token unset, mirrors health/aggregate); Phase 3
  // endpoints fail CLOSED (403) when the token is unset. Owned by QLUSTER-OPS
  // stream — new /api/v1/qluster/* read routes MUST both carry requireReadToken
  // AND be added here (the auth-sweep completeness test flags drift). ---
  '/api/v1/health/resources',
  '/api/v1/qluster/config-fingerprint',
  '/api/v1/qluster/ward-chain',
  '/api/v1/qluster/backups-summary',
  // Phase 4 enrollment EXCHANGE is intentionally unauthed (the single-use
  // enrollment token IS the credential) + rate-limited + token-validated in
  // its handler, so it must be allowlisted or the default-deny gate 401s it.
  // NOTE: enroll/ISSUE, controllers list/revoke, and backups/* are NOT here —
  // they carry their own auth (admin/service key or requireQlusterScope) and
  // the gate correctly lets authenticated requests through.
  '/api/v1/qluster/enroll/exchange',
  // B2 (QUOXGPU #149) — GPU fleet enrollment EXCHANGE, same reasoning as
  // qluster's enroll/exchange directly above (single-use token IS the
  // credential, rate-limited + token-validated in lib/gpuEnroll.js's
  // exchange handler). enroll/ISSUE is NOT here — it carries its own
  // requireServiceOrUserAuth()+admin auth and the gate correctly lets it
  // through.
  '/api/v1/gpu/enroll/exchange',
  // SEC-FLEET-CRED — DEVSUITE-GRIPE fleet-host capability. Self-authenticates
  // via requireFleetHostAuth() (lib/fleetHostCredentialsStore.js): a
  // per-host X-Fleet-Host-Token, NOT a Quox JWT or INTERNAL_SERVICE_KEY, so
  // the default-deny gate's requireServiceOrUserAuth() would wrongly 401 it
  // (same reasoning as enroll/exchange above). The route's own middleware
  // still enforces the token + resolves the org server-side; the CREDENTIAL
  // ISSUANCE route (POST /api/internal/fleet-hosts/:hostId/credential) is
  // NOT here — it carries its own requireServiceOrUserAuth()+admin auth and
  // the gate correctly lets it through.
  '/api/v1/fleet/gripe/file-issue',
  // AQ-9B DEBT 1: Calendar-Q's Google OAuth callback. Google's redirect back
  // to this URL is a plain, unauthenticated browser navigation — it cannot
  // carry a Quox JWT or a service key, so requireServiceOrUserAuth() would
  // wrongly 401 it (same reasoning as enroll/exchange and the fleet-host
  // credential route above). Self-authenticates via the single-use,
  // expiring oauth-state token (lib/calendarq/store.js consumeOauthState)
  // instead — see lib/calendarq/api.js's oauth section comment. The route
  // itself also carries its own per-IP rate limiter
  // (calendarqOauthCallbackLimiter in server.js); the sibling
  // /oauth/start route is NOT here — it still carries requireAuth and the
  // gate correctly closes it under enforce.
  '/api/v1/calendarq/oauth/callback',
]);

// Prefix / regex matchers. Each entry: { methods: '*'|Set, test: (path) => bool }
const ALLOWLIST = [
  // --- PUBLIC ---
  { methods: new Set(['GET']), test: p => p.startsWith('/download/quoxagent-') },
  { methods: new Set(['GET']), test: p => p.startsWith('/api/public/spatial/w/') },
  { methods: new Set(['GET']), test: p => p.startsWith('/public/verify/ward/') },
  // quox#637: the query-form chain verify (no encoding trap) and the public
  // bounded single-receipt inclusion proof. EXACT matches — rate-limited and
  // work-bounded inside the handlers (api-cjs.cjs), evidence data only.
  { methods: new Set(['GET']), test: p => p === '/public/verify/ward' },
  { methods: new Set(['GET']), test: p => p === '/public/verify/receipt' },

  // --- WEBHOOK receivers (self-authenticate via secret/signature; NOT the
  // setup/deactivate/info management siblings — those stay gated regardless
  // of Express route-registration order). ---
  {
    methods: new Set(['POST']),
    test: p => /^\/webhook\/telegram\/(?!setup$|deactivate$|info$)[^/]+$/.test(p) || p === '/webhook/telegram',
  },
  { methods: new Set(['POST']), test: p => p === '/webhook/slack' },
  { methods: new Set(['POST']), test: p => p === '/webhook/discord' },
  { methods: new Set(['POST']), test: p => p === '/webhook/discord/relay' },
  { methods: new Set(['POST']), test: p => /^\/webhook\/inbound\/[^/]+$/.test(p) },
  { methods: new Set(['POST']), test: p => p === '/webhooks/tailscale' },

  // --- PUBLIC (client-side may fire before login; own rate limiters) ---
  { methods: new Set(['POST']), test: p => p === '/feedback' },
  { methods: new Set(['POST']), test: p => p === '/error-reports' },

  // --- DEV LOOP SESSION EVENT INGEST (fleet spawn seam) ---
  // quoxagent's EventForwarder pushes structured-session events outbound;
  // fleet hosts have no Quox JWT. The route self-authenticates with the
  // per-session ingest token the collector minted at spawn time (verified
  // by sha256 in devLoopSessionsStore.ingestEventBatch: bad token → 401,
  // unknown session → 404). ONLY the push route — the spawn and read
  // siblings carry requireServiceOrUserAuth and stay gated.
  { methods: new Set(['POST']), test: p => /^\/api\/v1\/dev-sessions\/[^/]+\/events$/.test(p) },

  // NOTE: POST /api/v1/heartbeat is NOT a static allowlist entry — it is handled
  // by the scoped AGENT-AUTH branch in the middleware below (accepts
  // AGENT_SERVICE_KEY, with a HEARTBEAT_REQUIRE_AGENT_KEY belt during rollout).
  // The sibling read routes (/api/v1/agents*, /fleet/*, /check/:hostId) are
  // dashboard-called and authenticate via the same-origin cookie — intentionally
  // NOT allowlisted; they close under enforce.

  // --- PUBLIC WIDGET SUBTREE (own trust model — visitors have no Quox JWT) ---
  // TODO(COLLECTOR-AUTH-followup): /quoxchat has its own known weaknesses
  // (domainGuard fail-open, several unguarded sub-routes) — out of scope for
  // this stream (plan §2.5). Track under a dedicated widget-hardening stream.
  { methods: '*', test: p => p === '/quoxchat' || p.startsWith('/quoxchat/') },

  // --- QLUSTER Phase 4 backup subtree (list / trigger / :id/download).
  // Self-authenticate via requireQlusterScope: a scoped bearer token + (for
  // operational scopes) an Ed25519-signed, org-bound envelope — NOT a Quox JWT,
  // so the default-deny gate would wrongly 401 them (as it did enroll/exchange).
  // The route handlers still enforce scope + signature + org binding; the gate
  // just stops requiring an additional Quox JWT. Prefix covers the dynamic
  // /:id/download path. ---
  { methods: '*', test: p => p === '/api/v1/qluster/backups' || p.startsWith('/api/v1/qluster/backups/') },

  // --- QLUSTER Phase 5c cross-box EVIDENCE display (GET /api/v1/qluster/
  // evidence/:corr). Self-authenticates via its OWN read-token model
  // (requireReadTokenConfigured + requireReadToken in server.js) exactly like
  // config-fingerprint / ward-chain — the external controller sends a
  // QUOXCORE_READ_TOKEN bearer, NOT a Quox JWT, so requireServiceOrUserAuth
  // would wrongly 401 it. Prefix covers the dynamic :corr path. ---
  { methods: new Set(['GET']), test: p => p.startsWith('/api/v1/qluster/evidence/') },

  // --- QLUSTER Phase 5b governed delegation (POST /api/v1/qluster/delegate).
  // Self-authenticates via requireQlusterScope('agent.delegate'): a scoped
  // bearer + an Ed25519-signed, replay-protected envelope (agent.delegate is
  // an operational scope) — NOT a Quox JWT, so the default-deny gate would
  // wrongly 401 it (same as backups/* and enroll/exchange). The route handler
  // still enforces scope + signature; the box's OWN chat pipeline (policy gate
  // + HITL) governs the delegated prompt. ---
  { methods: new Set(['POST']), test: p => p === '/api/v1/qluster/delegate' },

  // --- QLUSTER-LOOP-B (Track B) signed retrieval of a resumable delegation
  // result (GET /api/v1/qluster/delegate/:corr). Self-authenticates via
  // requireQlusterScope('agent.delegate'): a scoped bearer + an Ed25519-signed,
  // replay-protected envelope (operational scope) — NOT a Quox JWT, so the
  // default-deny gate would wrongly 401 it. The handler additionally enforces
  // org-scope on the row. Prefix covers the dynamic :corr segment. (The internal
  // resume endpoint /api/internal/qluster/delegate/resume is service-key guarded
  // and needs no allowlist entry — INTERNAL_SERVICE_KEY passes the default gate.) ---
  { methods: new Set(['GET']), test: p => p.startsWith('/api/v1/qluster/delegate/') },
];

function isAllowlisted(req) {
  const path = req.path; // nginx already stripped /collector/; strips query string
  for (const e of ALLOWLIST) {
    if ((e.methods === '*' || e.methods.has(req.method)) && e.test(path)) return true;
  }
  return PUBLIC_EXACT.has(path);
}

module.exports = function collectorAuthGate(req, res, next) {
  if (req.method === 'OPTIONS') return next(); // CORS preflight carries no auth

  if (isAllowlisted(req)) return next();

  // AGENT-AUTH #126: scoped fleet-agent heartbeat.
  if (isHeartbeatPush(req)) {
    if (agentKeyValid(req)) return next();      // rolled agent → scoped key
    if (heartbeatBeltOpen()) return next();     // rollout belt → not yet gated
    // else HEARTBEAT_REQUIRE_AGENT_KEY==='true' and no valid agent key → fall
    // through to userGate (a valid user/INTERNAL_SERVICE_KEY still works).
  }

  if (isEnforced()) {
    return userGate(req, res, next); // fail-closed 401/403
  }

  // Shadow mode: run the real auth check against a throwaway response so we
  // only log "WOULD-DENY" for requests that genuinely lack valid auth, and
  // still populate req.user/req.service for requests that DO carry a valid
  // token/service key (mirrors utils/httpAuth.js requireAeeAuth()).
  let calledNext = false;
  const shadowRes = {
    status() { return shadowRes; },
    json() { return shadowRes; },
  };
  Promise.resolve(userGate(req, shadowRes, () => { calledNext = true; }))
    .then(() => {
      if (calledNext) return next();
      console.warn(`[collector-auth-shadow] WOULD-DENY method=${req.method} path=${req.path} reason=no-auth`);
      return next();
    })
    .catch((err) => {
      console.warn(`[collector-auth-shadow] WOULD-DENY method=${req.method} path=${req.path} reason=no-auth (gate-error: ${err.message})`);
      return next();
    });
};

module.exports.isAllowlisted = isAllowlisted;
module.exports.isEnforced = isEnforced;
module.exports.isHeartbeatPush = isHeartbeatPush;
module.exports.agentKeyValid = agentKeyValid;
module.exports.heartbeatBeltOpen = heartbeatBeltOpen;
