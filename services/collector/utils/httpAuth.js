/**
 * HTTP Authentication Middleware for Quox Collector
 *
 * Security fix for issue #162: Memory tool endpoints unauthenticated
 *
 * Verifies JWT tokens on HTTP requests to ensure only authenticated
 * users can access memory tools and other protected endpoints.
 */

const { timingSafeEqual, createHash } = require('crypto');
const { verifyToken, extractToken } = require('./wsAuth');
const { verifyOrgTicket } = require('../lib/pluginOrgTicket');

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth:3101';

// MCP token validation cache — keyed by SHA-256 of the token string.
// Only positive validations are cached; negatives are never cached.
const _mcpTokenCache = new Map();
const _MCP_TOKEN_TTL_MS = 60_000;

/**
 * Validate a qmcp_* token against the auth service.
 * Caches positive results for 60 seconds using a SHA-256 hash of the token
 * as the cache key (the raw token is never stored in memory).
 *
 * @param {string} token - The raw qmcp_* token string
 * @returns {Promise<{valid: boolean, token_id?: string, user_id?: string, org_id?: string, label?: string, reason?: string}>}
 */
async function _validateMcpToken(token) {
  const cacheKey = createHash('sha256').update(token).digest('hex');
  const cached = _mcpTokenCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached;
  }

  const svcKey = process.env.INTERNAL_SERVICE_KEY || '';
  if (!svcKey) {
    console.error('[MCPB-HARDEN] INTERNAL_SERVICE_KEY not set — cannot validate MCP token');
    return { valid: false, reason: 'service_not_configured' };
  }

  try {
    const resp = await fetch(`${AUTH_SERVICE_URL}/api/internal/mcp/tokens/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-service-key': svcKey,
      },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(3000),
    });

    if (!resp.ok) {
      console.warn('[MCPB-HARDEN] MCP token validate returned HTTP', resp.status);
      // 5xx/429/408: auth could not judge the token. That is "unavailable", not "invalid".
      return { valid: false, reason: `http_${resp.status}`, ...(resp.status >= 500 || resp.status === 429 || resp.status === 408 ? { networkError: true } : {}) };
    }

    const data = await resp.json();
    if (data.valid) {
      const entry = {
        valid: true,
        token_id: data.token_id,
        user_id: data.user_id,
        org_id: data.org_id,
        label: data.label,
        // P2: token-bound agent identity; must survive the cache or the
        // preference over the request body only works on cache misses.
        agent_id: data.agent_id ?? null,
        expires: Date.now() + _MCP_TOKEN_TTL_MS,
      };
      _mcpTokenCache.set(cacheKey, entry);
      return entry;
    }

    // valid: false — do not cache
    return { valid: false, reason: data.reason || 'unknown' };
  } catch (e) {
    console.error('[MCPB-HARDEN] MCP token validate network error:', e.message);
    return { valid: false, reason: 'network_error', networkError: true };
  }
}

/**
 * Parse cookies from raw Cookie header string.
 * The collector doesn't use cookie-parser middleware, so we parse manually
 * (same approach as wsAuth.js for WebSocket upgrade requests).
 */
function parseCookieHeader(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [name, ...rest] = c.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=').trim();
  });
  return cookies;
}

/**
 * Timing-safe string comparison for service keys.
 * Prevents timing attacks that could leak key material.
 */
function safeCompareKeys(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Constant-time dummy comparison to avoid leaking length info
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Express middleware to require authentication
 * Extracts JWT from Authorization header or cookie, verifies it,
 * and populates req.user with the verified payload.
 *
 * @param {object} options - Options
 * @param {boolean} options.required - If true, returns 401 when no token (default: true)
 * @returns {function} Express middleware
 */
function requireAuth(options = {}) {
  const { required = true } = options;

  return (req, res, next) => {
    // Extract token from Authorization header
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }

    // Fall back to cookie if no header (parse raw Cookie header — no cookie-parser needed)
    if (!token) {
      const cookies = req.cookies || parseCookieHeader(req.headers.cookie);
      if (cookies.access_token) {
        token = cookies.access_token;
      }
    }

    // No token found
    if (!token) {
      if (required) {
        return res.status(401).json({
          error: 'authentication_required',
          message: 'No authentication token provided'
        });
      }
      return next();
    }

    // Verify token
    const result = verifyToken(token);

    if (!result.valid) {
      return res.status(401).json({
        error: 'invalid_token',
        message: result.error
      });
    }

    // Populate req.user with verified payload
    // MC2 fix: Identity comes from verified JWT, NOT from spoofable headers
    // C3: surface the JWT role as `dashboardRole`, deliberately NOT as
    // `req.user.role`. Historically several routes gated on `req.user.role`,
    // which is never populated here, so those gates silently misbehaved: the
    // `req.user.role !== 'admin'` form denied everyone including real admins,
    // and the `req.user && req.user.role && ...` form short-circuited and
    // admitted everyone (a privilege escalation on six /admin/ routes, found
    // and fixed in the 2026-08-11 audit). They now all go through
    // isAdminUser()/requireAdminRole() below, which read `dashboardRole`.
    // Keep populating `dashboardRole` rather than `role`: flipping `role` on
    // globally would re-enable any check still written against it in one
    // undifferentiated sweep, which is exactly how the escalation went
    // unnoticed. Route authz should call the helpers, not read the field.
    req.user = {
      id: result.payload.sub,
      email: result.payload.email,
      org_id: result.payload.org_id,
      orgId: result.payload.org_id,  // Alias for compatibility
      dashboardRole: result.payload.role || null,
      agent_id: result.payload.agent_id || null,
      actor_type: result.payload.actor_type || null,
      // Resident-agent tokens (auth resident-identity mint) carry the host
      // they belong to; deriveCallerIdentity needs it to stamp the
      // unforgeable resident:<host> author on slot messages.
      resident_host: result.payload.resident_host || null,
      // SVC-AUTH #447 bridge: agent-operated user session — ordinary
      // org-scoped operations accept it; strict human-only gates bar it.
      agent_ops: result.payload.agent_ops === true,
      // QUOXIDENTITY P2 (territory D): requireServiceOrUserAuth() already
      // surfaces attach_lease_id (see above); requireAuth() did not, so
      // routes mounted behind it (e.g. /memory/tool/execute, /memory/tool/batch)
      // never saw it on req.user and createSecureContext() had nothing to
      // read. Needed for the memory read-path scoping rule in
      // docs/QUOXIDENTITY_P2_CONTRACT.md.
      attach_lease_id: result.payload.attach_lease_id || null,
      // QUOXIDENTITY F2b: the attach JWT (services/auth) carries the lease
      // holder as a `holder_user_id` claim alongside attach_lease_id. Surface
      // it the same way so tool-execute evidence (toolEvidence.js) can stamp
      // the responsible human into the AEE envelope, not just the agent's own
      // service identity.
      holder_user_id: result.payload.holder_user_id || null,
      // QUOXIDENTITY P9: splinter label (S1, S2...) of the attach lease. Only
      // present when the claim is; the single extraction point for evidence.
      ...(result.payload.splinter ? { splinter: result.payload.splinter } : {})
    };

    next();
  };
}

/**
 * Create execution context from verified JWT user
 * MC2 fix: Replaces spoofable header-based identity with JWT-verified data
 *
 * @param {object} req - Express request with verified req.user
 * @param {object} context - Additional context from request body
 * @returns {object} Secure execution context
 */
function createSecureContext(req, context = {}) {
  if (!req.user) {
    throw new Error('User not authenticated');
  }

  return {
    // Identity from verified JWT - NOT from headers or request body
    orgId: req.user.org_id || 'default',
    userId: req.user.id,
    agentId: req.user.agent_id || context?.agent_id || 'quox',
    // Non-sensitive fields can come from context
    conversationId: context?.conversation_id || req.headers['x-conversation-id'],
    messageId: context?.message_id || req.headers['x-message-id'],
    // Token for downstream calls (already verified)
    token: req.headers['authorization']?.replace('Bearer ', ''),
    // QUOXIDENTITY P2 (territory D): from req.user ONLY (verified JWT claim),
    // never from context/body — this is what memoryToolHandlers.js's
    // memorySearch() gates the agent-namespace read filter on. A plain
    // resident/mcp caller (no attach lease) gets null here and the read path
    // stays byte-identical to pre-P2 behavior.
    attachLeaseId: req.user.attach_lease_id || null,
    // Lease holder from the signed attach JWT (CX1 F9: attached Cortex reads
    // the holder's own memories). null for every non-attach caller.
    holderUserId: req.user.attach_lease_id ? (req.user.holder_user_id || null) : null
    // MC3 fix: Removed INTERNAL_API_KEY fallback
  };
}

// SEC-PLUGIN-TRUST C1: qplg_* per-plugin credential validation. Positive
// results cached briefly (revocation takes effect within the TTL); negatives
// and errors are never cached and always fail closed.
const _pluginCredCache = new Map();
const _PLUGIN_CRED_TTL_MS = 30_000;

async function _validatePluginCredential(token) {
  const cacheKey = createHash('sha256').update(token).digest('hex');
  const cached = _pluginCredCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached;
  const svcKey = process.env.INTERNAL_SERVICE_KEY || '';
  if (!svcKey) return { valid: false, reason: 'service_not_configured' };
  try {
    const resp = await fetch(`${AUTH_SERVICE_URL}/api/internal/plugin-credentials/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': svcKey },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return { valid: false, reason: `http_${resp.status}`, ...(resp.status >= 500 || resp.status === 429 || resp.status === 408 ? { unavailable: true } : {}) };
    const data = await resp.json();
    if (data.valid && typeof data.plugin_id === 'string' && data.plugin_id) {
      const entry = { valid: true, plugin_id: data.plugin_id, expires: Date.now() + _PLUGIN_CRED_TTL_MS };
      _pluginCredCache.set(cacheKey, entry);
      return entry;
    }
    return { valid: false, reason: data.reason || 'unknown' };
  } catch (e) {
    return { valid: false, reason: 'validation_unavailable', unavailable: true };
  }
}

function __clearPluginCredentialCache() { _pluginCredCache.clear(); }

/**
 * Authenticate a qplg_ plugin credential + on-behalf-of org ticket. Returns
 * { ok:true } after populating req.user / req.pluginAuth, or
 * { ok:false, status, error }. NEVER sets req.service, never sets a role.
 */
async function _authenticatePluginCaller(req, token, { allowTicketless = false } = {}) {
  const cred = await _validatePluginCredential(token);
  if (!cred.valid) {
    if (cred.unavailable) return { ok: false, status: 503, error: 'auth_unavailable' };
    return { ok: false, status: 401, error: 'invalid_plugin_credential' };
  }
  // Background evidence (a plugin's own schedulers, no user request, so no
  // ticket): only where the route allows it (AEE store/sync), and only when NO
  // ticket header is presented at all. It is instance-scoped: no tenant org,
  // no user, whatever the body or envelope claims. A presented-but-bad ticket
  // is always refused below, never degraded to this path.
  const rawTicket = req.headers['x-quox-org-ticket'];
  if (allowTicketless && (rawTicket === undefined || rawTicket === '')) {
    req.user = {
      id: null,
      org_id: null,
      orgId: null,
      dashboardRole: null,
      agent_id: null,
      actor_type: 'plugin',
      plugin_id: cred.plugin_id,
    };
    req.pluginAuth = { pluginId: cred.plugin_id, orgId: null, userId: null, ticketless: true };
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      delete req.body.org_id;
      delete req.body.user_id;
    }
    return { ok: true };
  }
  const t = verifyOrgTicket(rawTicket);
  if (!t.ok) return { ok: false, status: 401, error: t.reason };
  if (t.claims.p !== cred.plugin_id) return { ok: false, status: 403, error: 'ticket_plugin_mismatch' };
  req.user = {
    id: t.claims.u || null,
    org_id: t.claims.o,
    orgId: t.claims.o,
    dashboardRole: null,
    agent_id: null,
    actor_type: 'plugin',
    plugin_id: cred.plugin_id,
  };
  req.pluginAuth = { pluginId: cred.plugin_id, orgId: t.claims.o, userId: t.claims.u || null };
  // Pin any body-supplied identity to the ticket so handlers that still read
  // req.body.org_id / user_id directly (chat has several fallbacks) cannot be
  // steered to another tenant.
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    req.body.org_id = t.claims.o;
    if (t.claims.u) req.body.user_id = t.claims.u; else delete req.body.user_id;
  }
  return { ok: true };
}

/**
 * Auth could not be reached (restart, deploy, timeout): answer 503, never 401.
 * A 401 tells every client "your credential is dead" and a TUI/CLI acts on that
 * by signing the user out; 2026-10-14 an auth rebuild did exactly that to three
 * open sessions whose tokens were fine. 503 + Retry-After says "try again".
 */
function sendAuthUnavailable(res, message = 'Auth service unavailable') {
  if (typeof res.set === 'function') res.set('Retry-After', '5');
  return res.status(503).json({ error: 'auth_unavailable', message, retryable: true });
}

/**
 * Dual auth middleware — accepts either user JWT or service key.
 * Used for endpoints called by both QuoxMCP (service key) and browser (JWT).
 *
 * When INTERNAL_SERVICE_KEY is not configured, all requests are allowed
 * through for dev mode / backwards compatibility.
 *
 * @returns {function} Express middleware
 */
function requireServiceOrUserAuth(options = {}) {
  const { acceptAudience, acceptPluginCredential = false, allowTicketlessPlugin = false } = options;
  return async (req, res, next) => {
    const serviceKey = req.headers['x-service-key'];

    // SEC-PLUGIN-TRUST C1: qplg_* is a per-plugin credential. It is accepted
    // ONLY where a route opts in (acceptPluginCredential: the plugin LLM chat
    // seam and /aee/store|sync). Everywhere else it is refused outright and can
    // never fall through to the service-key or JWT paths.
    if (typeof serviceKey === 'string' && serviceKey.startsWith('qplg_')) {
      if (!acceptPluginCredential) {
        return res.status(401).json({ error: 'plugin_credential_not_accepted' });
      }
      const r = await _authenticatePluginCaller(req, serviceKey, { allowTicketless: allowTicketlessPlugin });
      if (!r.ok) {
        if (r.status === 503) return sendAuthUnavailable(res, 'Plugin credential validation unavailable');
        return res.status(r.status).json({ error: r.error });
      }
      return next();
    }

    // Priority 1: qmcp_* token path (NEW — must be checked before INTERNAL_SERVICE_KEY)
    if (serviceKey && serviceKey.startsWith('qmcp_')) {
      let result;
      try {
        result = await _validateMcpToken(serviceKey);
      } catch (e) {
        console.error('[MCPB-HARDEN] Unexpected error validating MCP token:', e.message);
        return sendAuthUnavailable(res, 'MCP token validation service error');
      }
      if (result.networkError) {
        return sendAuthUnavailable(res, 'MCP token validation unavailable');
      }
      if (result.valid) {
        req.user = {
          id: result.user_id,
          org_id: result.org_id,
          orgId: result.org_id,
          // P2: a token minted through the admin agent-identity route is
          // BOUND to its agent id; prefer that over the request body, which
          // any token holder could set to wear another agent's tool grants.
          // Ordinary user tokens (agent_id null) keep the body/default path.
          agent_id: result.agent_id || req.body?.agent_id || 'quox',
        };
        req.mcpToken = { id: result.token_id, label: result.label };
        return next();
      }
      return res.status(401).json({ error: 'invalid_mcp_token', message: result.reason || 'MCP token validation failed' });
    }

    // Priority 2: INTERNAL_SERVICE_KEY exact match
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    if (expectedKey && serviceKey && safeCompareKeys(serviceKey, expectedKey)) {
      req.service = true;
      req.serviceAgent = req.body?.agent_id || 'quox';
      return next();
    }

    // Priority 3: JWT in Authorization header or cookie
    let token = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }
    if (!token) {
      const cookies = req.cookies || parseCookieHeader(req.headers.cookie);
      if (cookies.access_token) token = cookies.access_token;
    }

    if (token) {
      const result = verifyToken(token, { audience: acceptAudience });
      if (result.valid) {
        // C3 (isolated): see requireAuth() above — surface role as
        // `dashboardRole` for the bastion proxy only, NOT as `req.user.role`
        // (which would change unrelated role-gated routes).
        req.user = {
          id: result.payload.sub,
          session_id: result.payload.session_id || null, // QUOXON-STEPUP: step-up tokens bind to the session
          email: result.payload.email,
          org_id: result.payload.org_id,
          orgId: result.payload.org_id,
          dashboardRole: result.payload.role || null,
          agent_id: result.payload.agent_id || null,
          actor_type: result.payload.actor_type || null,
          resident_host: result.payload.resident_host || null,
          // SEC (X-PLUGIN phase 12): this field was populated by requireAuth()
          // but NOT here, so requireHumanAdmin()'s agent-operated-session check
          // was a silent no-op on every route mounted behind
          // requireServiceOrUserAuth(). An agent_ops token carrying an
          // admin/owner role passed a gate whose entire purpose is to admit
          // only humans. Found by a test written for the X scheduled-publish
          // routes, which are exactly the kind of gate that must not be
          // reachable by an agent. The two auth paths now populate the same
          // fields; fail-closed behaviour is unchanged for everything else,
          // because this only ever makes requireHumanAdmin stricter.
          agent_ops: result.payload.agent_ops === true,
          // QUOXIDENTITY P1: attach JWTs (services/auth routes/agent-attach.js,
          // territory A) carry an attach_lease_id claim binding the token to a
          // single-active lease. Surfaced here (not just agent_id) so gates
          // that must distinguish "an attach-bound agent session" from an
          // ordinary qmcp/resident agent token (e.g. the collector's
          // GET /api/v1/agent-attach/kit, P1 contract) can read it directly
          // off req.user rather than re-decoding the token. exp is carried
          // too so callers can report the lease's token expiry without a
          // second decode.
          attach_lease_id: result.payload.attach_lease_id || null,
          // QUOXIDENTITY F2b: see requireAuth() above for the same field.
          holder_user_id: result.payload.holder_user_id || null,
          exp: result.payload.exp || null,
          // QUOXON-IDENTITY: per-turn tools/execute credential claims.
          ...(result.payload.aud ? { aud: result.payload.aud, turn_id: result.payload.turn_id || null, conversation_id: result.payload.conversation_id || null, turn_intent: result.payload.turn_intent || null, turn_deadline_at: result.payload.turn_deadline_at || null, turn_mode: result.payload.turn_mode === 'plan' ? 'plan' : null, no_shell: result.payload.no_shell === true, tools_gated: result.payload.tools_gated === true } : {}),
          // QUOXIDENTITY P9: see requireAuth() above.
          ...(result.payload.splinter ? { splinter: result.payload.splinter } : {})
        };
        return next();
      }
    }

    // Priority 4: Fail closed — no valid auth found
    if (!expectedKey) {
      console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying service request. Set INTERNAL_SERVICE_KEY in environment.');
    }

    return res.status(401).json({
      error: 'authentication_required',
      message: 'Valid JWT or service key required'
    });
  };
}

/**
 * SEC-PLUGIN-TRUST H2 — AEE evidence endpoint auth.
 *
 * `/aee/store`, `/aee/sync`, `/aee/query` were unauthenticated (any caller on
 * the network, including the public internet via nginx `location /collector/`,
 * could read or forge audit evidence — see
 * docs/STREAM_SEC_PLUGIN_TRUST_PLAN.md §1.3 H2).
 *
 * Enforcement is gated behind AEE_ENDPOINT_AUTH_ENFORCE (default OFF / log-only)
 * per the plan's caller-first ordering: internal callers must be updated to
 * send auth BEFORE the gate can be safely flipped to reject, or evidence
 * silently drops (memory feedback_silent_success_cross_service.md).
 *
 *   AEE_ENDPOINT_AUTH_ENFORCE=true  → missing/invalid auth is REJECTED (401)
 *   unset / any other value         → missing/invalid auth is LOGGED ONLY,
 *                                      request proceeds exactly as before
 *                                      (req.aeeAuthenticated=false)
 *
 * LICENSE-LAUNCH LL-6b: that log-only default is safe on a dev box and is NOT
 * safe unattended in production, where a missing env var silently disabled the
 * gate. lib/enforcementPosture.js keeps the env wording above verbatim and
 * adds one rule on top: under NODE_ENV=production, off WITHOUT an unexpired
 * break-glass record is treated as ON and logged loudly.
 *
 * QUOXIDENTITY P4 §2 (finding G1, no-env-only-config rule): this flag is also
 * registered in lib/platformCapabilities.js (classification:'operator',
 * group:'security-posture', mirroring COLLECTOR_AUTH_ENFORCE) so its state is
 * visible on the Platform Capabilities dashboard surface, not env-only. It is
 * NOT settable there (an org override would defeat the fail-closed production
 * posture above) — visibility only. The default stays OFF here; flipping it
 * is an owner decision, out of scope for this change.
 */
const { isEnforced: isPostureEnforced } = require('../lib/enforcementPosture.js');

function isAeeAuthEnforced() {
  return isPostureEnforced('AEE_ENDPOINT_AUTH_ENFORCE');
}

/**
 * requireAeeAuth() — wraps requireServiceOrUserAuth() (the existing, tested
 * dual auth check) without modifying it, so the ~30-route hub's behavior is
 * untouched (blast-radius containment, per the plan's design decision).
 *
 * On successful auth: sets req.aeeAuthenticated = true, calls next().
 * On failed auth:
 *   - enforce=true  → responds 401 (whatever requireServiceOrUserAuth would
 *                      have sent) and does NOT call next().
 *   - enforce=false → logs a "would reject" warning, sets
 *                      req.aeeAuthenticated = false, and calls next() anyway
 *                      (identical behavior to pre-gate code).
 */
function requireAeeAuth() {
  const inner = requireServiceOrUserAuth({ acceptPluginCredential: true, allowTicketlessPlugin: true });

  return async (req, res, next) => {
    const enforce = isAeeAuthEnforced();
    let rejectedStatus = null;
    let rejectedBody = null;
    let calledNext = false;

    const shadowRes = {
      status(code) { rejectedStatus = code; return shadowRes; },
      json(body) { rejectedBody = body; return shadowRes; },
    };

    await inner(req, shadowRes, () => { calledNext = true; });

    if (calledNext) {
      req.aeeAuthenticated = true;
      return next();
    }

    // SEC-PLUGIN-TRUST C1: a presented qplg_ credential that fails is ALWAYS
    // refused, independent of the AEE log-only posture (that posture exists for
    // legacy anonymous callers, which a plugin never was).
    if (typeof req.headers['x-service-key'] === 'string' && req.headers['x-service-key'].startsWith('qplg_')) {
      return res.status(rejectedStatus || 401).json(rejectedBody || { error: 'invalid_plugin_credential' });
    }

    req.aeeAuthenticated = false;
    req.aeeAuthReason = rejectedBody?.error || 'authentication_required';

    if (enforce) {
      console.warn(`[AEE-AUTH] REJECTED unauthenticated ${req.method} ${req.originalUrl || req.path}: ${req.aeeAuthReason}`);
      return res.status(rejectedStatus || 401).json(rejectedBody || { error: 'authentication_required' });
    }

    console.warn(`[AEE-AUTH] LOG-ONLY (would reject) ${req.method} ${req.originalUrl || req.path}: ${req.aeeAuthReason} — set AEE_ENDPOINT_AUTH_ENFORCE=true to enforce`);
    return next();
  };
}

/**
 * Derive the server-side `from` identity for an AEE envelope.
 *
 * - req.user (JWT/browser)  → FORCED to `human.<user.id>`, regardless of the
 *   body-supplied `from` — a caller can no longer forge `human.adam` or
 *   `volt.witness.approved` (plan §4.2).
 * - req.service (internal caller: auth/screencap/tasks) → keeps the
 *   body-supplied `from`. These callers are inside the trust boundary and
 *   legitimately emit on behalf of subsystems (plan §4.2, OQ-3).
 * - Neither (log-only / unauthenticated path) → body `from` unchanged, so
 *   log-only mode is byte-identical to pre-gate behavior.
 *
 * Only call this when `enforce` is true — derivation is gated behind the
 * same flag as the auth rejection so log-only mode never mutates data.
 */
function deriveAeeFrom(req, bodyFrom) {
  // SEC-PLUGIN-TRUST C1: a plugin backend is always stamped plugin.<id> from the
  // validated credential, never from the body.
  if (req.pluginAuth) return `plugin.${req.pluginAuth.pluginId}`;
  // P0b (DEC-2/DEC-3): label by derived actor_type so an AGENT acting as a user
  // (qmcp_ token / agent-scoped JWT) is evidenced as `agent.<id>`, not forged as
  // `human.<id>`. traceAssembler.js already classifies actors by this prefix.
  const actor = deriveActorType(req);
  if (actor === 'agent') return `agent.${req.user?.agent_id || req.user?.id || 'unknown'}`;
  if (actor === 'human') return `human.${req.user.id}`;
  // service (internal subsystem) and unauthenticated/log-only keep body `from`.
  return bodyFrom;
}

/**
 * SEC (2026-08-11) — admin-role gate, reading the field that is actually
 * populated.
 *
 * requireAuth()/requireServiceOrUserAuth() above surface the JWT's org
 * role as `req.user.dashboardRole`, NOT `req.user.role` (see the C3
 * comments above). Every admin-only route in server.js and
 * routes/agentContracts.js was written against `req.user.role`, which is
 * therefore always `undefined` for JWT callers — this broke gates in two
 * opposite directions: `req.user.role && req.user.role !== 'admin'`
 * short-circuits to false (any authenticated user gets through, fail
 * OPEN), while `req.user.role !== 'admin'` is always true (locks out real
 * admins, fail CLOSED). Route every admin check through here instead of
 * re-deriving the check inline.
 *
 * Role enum (services/auth/db/schema.sql org_memberships.role): owner,
 * admin, builder, runner, viewer. Both 'owner' and 'admin' carry
 * administrative authority over an org, so both pass.
 */
const ADMIN_ROLES = new Set(['owner', 'admin']);

/**
 * True if the caller may access an admin-only route.
 * - Internal service callers (req.service === true, set by
 *   requireServiceOrUserAuth() for INTERNAL_SERVICE_KEY / qmcp_* token
 *   callers) always pass — they are inside the trust boundary already and
 *   both prior patterns let them through.
 * - JWT/browser callers pass only if req.user.dashboardRole is 'admin' or
 *   'owner'. Missing/null/other roles fail CLOSED (403), including a
 *   caller with no role at all.
 */
function isAdminUser(req) {
  if (req && req.service === true) return true;
  if (!req || !req.user) return false;
  return ADMIN_ROLES.has(req.user.dashboardRole);
}

/**
 * Express-style guard for admin-only routes. Sends 403 and returns false
 * if the caller is not an admin/owner or an internal service; otherwise
 * returns true and sends nothing (caller proceeds).
 */
function requireAdminRole(req, res, message = 'Admin access required') {
  if (isAdminUser(req)) return true;
  res.status(403).json({ error: message });
  return false;
}

/**
 * P0a item (b) / QUOXPERTICUS HARD INVARIANT #1 — stricter than requireAdminRole
 * for governance-critical writes (org platform flags, and future mode writes).
 * Unlike isAdminUser(), a service caller (req.service === true — the shared
 * INTERNAL_SERVICE_KEY OR a qmcp_ agent token) is NOT admin here: those writes
 * must be performed by a real human admin/owner, never the shared key and never
 * an autonomous agent. Rejects service callers outright, then requires a human
 * JWT with an admin/owner dashboardRole. Fails CLOSED.
 */
// Pure predicate behind requireHumanAdmin: the ONE rule for "is this caller a
// human org admin". Service keys and agent-operated sessions are never admin.
function isHumanAdmin(req) {
  if (!req || req.service === true) return false;
  // SVC-AUTH #447 bridge: an agent-operated user session is never a human
  // admin, whatever role it holds — same fail-closed posture as agent_id.
  if (isNonHumanPrincipal(req)) return false;
  return Boolean(req.user && ADMIN_ROLES.has(req.user.dashboardRole));
}

function requireHumanAdmin(req, res, message = 'Human admin required') {
  if (isHumanAdmin(req)) return true;
  res.status(403).json({ error: message });
  return false;
}

// deriveActorType lives in ./actorType.js (pure, importable by libs); re-exported below.
const { deriveActorType, isNonHumanPrincipal } = require('./actorType');

/**
 * P0b (DEC-3) — gate a route to a real human actor only (rejects agent AND
 * service). For HITL approval sinks any human owner may act on. Governance
 * writes needing an admin role use requireHumanAdmin() instead. Fails CLOSED.
 */
function requireHumanActor(req, res, message = 'This action requires a human') {
  if (deriveActorType(req) === 'human') return true;
  res.status(403).json({ error: message });
  return false;
}

module.exports = {
  requireAuth,
  requireServiceOrUserAuth,
  createSecureContext,
  parseCookieHeader,
  isAeeAuthEnforced,
  requireAeeAuth,
  deriveAeeFrom,
  __clearPluginCredentialCache,
  isAdminUser,
  requireAdminRole,
  requireHumanAdmin,
  isHumanAdmin,
  deriveActorType,
  requireHumanActor,
  // Exposed for tests only — clears the in-process MCP token cache
  __clearMcpTokenCache: () => _mcpTokenCache.clear(),
};
