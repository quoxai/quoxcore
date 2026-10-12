/**
 * discord-pro: status proxy for the Quox Discord Pro daemon (separate repo:
 * /opt/quoxcore/quox-discord-pro), the install/settings surface's only data
 * path.
 *
 * The daemon runs its own loopback-bound control API (quox-discord-pro's
 * src/controlApi.js) on `controlPort`, token-gated with `X-QDP-Token`. This
 * route proxies GET /health and GET /bindings into one status shape the
 * dashboard view can render.
 *
 * Endpoint resolution (env first, because the collector runs in a container
 * and cannot reach the host's loopback where the daemon listens):
 *   1. QDP_CONTROL_URL + QDP_CONTROL_TOKEN  (e.g. http://172.17.0.1:3109, the
 *      docker bridge gateway, so a containerised collector reaches the host
 *      daemon). Preferred, and the documented requirement if this container
 *      is ever moved somewhere that cannot see /opt/quoxcore at all.
 *   2. Fallback: read controlPort from the daemon config file at
 *      QDP_CONFIG_PATH and call http://127.0.0.1:<controlPort> (works only
 *      when the collector shares the daemon's loopback, e.g. same host, no
 *      container boundary). The token itself resolves separately (env >
 *      controlTokenFile > legacy inline controlToken) — see
 *      resolveControlToken() below; on this host /opt/quoxcore is bind-
 *      mounted read-only into the collector container, so controlTokenFile
 *      (default /opt/quoxcore/.quox-discord/control-token) is reachable
 *      even without QDP_CONTROL_TOKEN set.
 *
 * Status semantics (always HTTP 200, never a 500, so a plugin card never has
 * to error-boundary a down daemon):
 *   not-configured : no endpoint resolved (neither env vars nor a readable
 *                    config with a port+token). The container cannot reach the
 *                    daemon, wire QDP_CONTROL_URL/QDP_CONTROL_TOKEN.
 *   offline        : an endpoint resolved but the daemon did not answer (down,
 *                    wrong port, or stale token).
 *   active         : the daemon answered.
 *
 * Not yet wired: the daemon control API has no /gaps endpoint (open support
 * gaps live as inbox items on the auth service with payload.source === 'qdp-gap').
 * `gaps` is returned empty until that surface exists.
 *
 * QDIS-NEXT phase 6: binding edit/delete proxies. These relay the daemon's
 * actual status code and body (unlike /status, which always answers 200) so
 * the dashboard can surface a real write failure against a live bot instead
 * of masking it.
 *
 * SECURITY (2026-08-11, audited same night as commit 16929412 shipped these
 * two write routes): `requireServiceOrUserAuth()` on its own only checks that
 * the caller is *authenticated*, not that they are authorized to rebind or
 * delete the single real Discord server this daemon runs (it is a host-local,
 * single-guild daemon, not multi-tenant, so any org's plain member could
 * otherwise hijack a channel binding). PUT/DELETE below add:
 *   1. requireBindingAdmin() — reuses the collector's one existing working
 *      role-check pattern (server.js bastion proxy, `req.user.dashboardRole`,
 *      NOT `req.user.role` — see utils/httpAuth.js's `requireAuth()` comment:
 *      `req.user.role` is deliberately never populated for JWT callers, so
 *      the `req.user.role === 'admin'` pattern used elsewhere in this repo
 *      (agentContracts.js, governance-webhooks) currently no-ops to "always
 *      admin-locked" for browser callers — not safe to copy here).
 *   2. sanitizeBindingBody() — allowlists the body to the daemon's real
 *      bindings table columns (quox-discord-pro/src/bindings.js
 *      `openBindings()`), validates `mode` against the daemon's real
 *      implemented modes, and specifically validates the fields that flow
 *      into the daemon's bridge relay -> `quox fleet exec --tool ssh_exec`
 *      pivot (bridge_remote_host / bridge_outbox_host / *_inbox).
 *
 * QDIS-NEXT phase 9 (QUOXIFY): the config plane above (PUT/DELETE) had no
 * audit trail at all -- the daemon's support pipe emits AEE envelopes
 * (QDIS-PRO M2) but a binding change, the single most privileged action in
 * the plugin, left no receipt anywhere. Both write routes now emit a real
 * AEE envelope (setAuditFn(), wired from server.js -> storeAuditEnvelope())
 * after a mutation has already succeeded against the live daemon, carrying
 * the authenticated actor (req.user from requireServiceOrUserAuth()) and,
 * critically, the bridge_* fields when present. See emitBindingEnvelope()
 * below and quox-discord-pro's src/evidence.js for the CLI-path half of
 * this (the daemon's own control API has no caller identity and is only
 * ever locally logged, never AEE-witnessed -- same split as QuoxPlan's CLI,
 * documented in the house CLAUDE.md).
 *
 * QDIS-NEXT phase 8 (QUOXIFY ph2 CREDENTIALED): GET /credentials/bot-token
 * below is the daemon's vault-first bootstrap for its own Discord bot
 * token. The daemon is a standalone process outside the collector, so it
 * cannot decrypt QuoxVault directly; it authenticates here with its own
 * QUOX_SERVICE_KEY (a dedicated scoped qmcp_ token, see
 * /opt/quoxcore/.quox-discord/qdp.env) and this route resolves the org's
 * `discord` vault credential (integration_type 'discord', field bot_token
 * -- see services/auth/config/integrationTypeRegistry.js; the type already
 * existed, nothing new registered) via the same resolveNotifCreds() waterfall
 * notificationService.js already uses for outbound Discord notifications.
 * Gated by requireServiceOrMcpAuth() below, NOT the router's normal
 * requireServiceOrUserAuth() alone -- a browser JWT session must never be
 * able to read the raw bot token just by being logged in, unlike /status
 * and /diagnose above which carry no secret. See quox-discord-pro's
 * collectorClient.js resolveBotToken() for the daemon-side caller and its
 * fallback-to-tokenFile behavior when this route or the vault is
 * unreachable.
 */

'use strict';

const fs = require('fs');
const { Router } = require('express');
const { resolveNotifCreds } = require('../lib/notificationService.js');

const router = Router();

// Discord channel/message/user IDs are 64-bit snowflakes: decimal digits,
// realistically 17-20 chars but allow a slightly wider band for safety.
const SNOWFLAKE_RE = /^\d{5,25}$/;

// Bare hostname or IPv4/IPv6 literal — no scheme, no path, no shell
// metacharacters, no spaces. This is deliberately conservative: there is no
// known-safe host allowlist to source from (the daemon accepts any fleet
// host by design), so a strict shape check is the best available guard at
// this layer. The daemon-side fix (separate agent, bridgeRelay.js) is the
// other half of this defence-in-depth pair.
const HOSTNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,253}[a-zA-Z0-9])?$/;

// Interpolated into a remote shell command by the daemon's bridge relay —
// restrict to a conservative "identifier-like" charset.
const INBOX_RE = /^[\w.-]+$/;

// Modes actually implemented by the daemon (quox-discord-pro/src/index.js
// handleMessage() + bridgeRelay.js's mode:'bridge' handling). Keep in sync
// with that file if new modes ship.
const VALID_MODES = new Set(['echo', 'support', 'quoxchat', 'team', 'roundtable', 'bridge']);

// Allowlisted binding fields, sourced from quox-discord-pro/src/bindings.js
// openBindings() CREATE TABLE bindings (...) — the daemon's authoritative
// schema. Any field not in this set is stripped from the forwarded body
// rather than rejecting the whole request, so a caller sending a harmless
// extra field (e.g. a future dashboard-only UI hint) doesn't hard-fail;
// unknown high-risk-shaped keys are still caught because nothing outside
// this list ever reaches the daemon.
const ALLOWED_BINDING_FIELDS = new Set([
  'mode', 'agent_id', 'hitl_policy', 'cooldown_s', 'persona',
  'persona_webhook_file', 'provider', 'model', 'facts_file',
  'knowledge_widget', 'require_mention', 'instance', 'widget_id',
  'public_key', 'origin', 'bridge_two_way', 'bridge_remote_host',
  'bridge_remote_inbox', 'bridge_outbox_host', 'bridge_outbox_inbox',
]);

/**
 * Require the caller to be an internal service, or a JWT-authenticated user
 * with an elevated dashboard role. Mirrors server.js's bastion proxy gate
 * (the collector's one working precedent for role-gating a
 * requireServiceOrUserAuth() route) rather than the broken req.user.role
 * pattern used elsewhere.
 */
function requireBindingAdmin(req, res, next) {
  if (req.service) return next();
  if (!req.user) {
    return res.status(401).json({ error: 'authentication_required' });
  }
  const role = req.user.dashboardRole;
  if (role !== 'admin' && role !== 'owner') {
    return res.status(403).json({ error: 'admin role required to modify Discord Pro bindings' });
  }
  return next();
}

/**
 * Validate + allowlist a binding write body. Returns { ok: true, body } with
 * unknown fields stripped, or { ok: false, error } with a specific 400
 * reason (never a generic "invalid body").
 */
function sanitizeBindingBody(rawBody) {
  const src = rawBody && typeof rawBody === 'object' ? rawBody : {};

  if (typeof src.mode !== 'string' || !VALID_MODES.has(src.mode)) {
    return { ok: false, error: `mode must be one of: ${[...VALID_MODES].join(', ')}` };
  }

  if (src.bridge_remote_host !== undefined && src.bridge_remote_host !== null) {
    if (typeof src.bridge_remote_host !== 'string' || !HOSTNAME_RE.test(src.bridge_remote_host)) {
      return { ok: false, error: 'bridge_remote_host must be a bare hostname or IP with no scheme, path, or shell metacharacters' };
    }
  }
  if (src.bridge_outbox_host !== undefined && src.bridge_outbox_host !== null) {
    if (typeof src.bridge_outbox_host !== 'string' || !HOSTNAME_RE.test(src.bridge_outbox_host)) {
      return { ok: false, error: 'bridge_outbox_host must be a bare hostname or IP with no scheme, path, or shell metacharacters' };
    }
  }
  if (src.bridge_remote_inbox !== undefined && src.bridge_remote_inbox !== null) {
    if (typeof src.bridge_remote_inbox !== 'string' || !INBOX_RE.test(src.bridge_remote_inbox)) {
      return { ok: false, error: 'bridge_remote_inbox must match /^[\\w.-]+$/' };
    }
  }
  if (src.bridge_outbox_inbox !== undefined && src.bridge_outbox_inbox !== null) {
    if (typeof src.bridge_outbox_inbox !== 'string' || !INBOX_RE.test(src.bridge_outbox_inbox)) {
      return { ok: false, error: 'bridge_outbox_inbox must match /^[\\w.-]+$/' };
    }
  }

  const body = {};
  for (const key of Object.keys(src)) {
    if (ALLOWED_BINDING_FIELDS.has(key)) body[key] = src[key];
  }
  return { ok: true, body };
}

// ─────────────────────────────────────────────────────────────────────────
// Evidence DI (QDIS-NEXT p9) — same pattern as routes/quoxlens.js's
// setAuditFn(): server.js owns storeAuditEnvelope() (the AEE/WARD choke
// point) and this router cannot construct it itself without importing
// server.js (circular). Defaults to a safe no-op so every other route in
// this file keeps working with zero wiring, and unit tests never touch a
// real DB unless they explicitly inject a spy.
//
// WHY HERE, NOT IN THE DAEMON: the daemon's control API (quox-discord-pro
// src/controlApi.js) has no authenticated caller identity -- it is reached
// both by this proxy AND directly by the `qdp` CLI over loopback with only
// a shared token. This proxy is where req.user actually exists (a verified
// JWT, from requireServiceOrUserAuth() at the mount point), so it is the
// only place a real actor can be attached to the envelope without
// fabricating one. The daemon side instead emits a local, unwitnessed audit
// log line for every mutation regardless of caller (see quox-discord-pro's
// src/evidence.js) -- this is the same governed-path/CLI-path split
// documented for QuoxPlan's CLI in the house CLAUDE.md.
// ─────────────────────────────────────────────────────────────────────────
let _storeAuditEnvelope = () => {};

/** Wire in server.js's storeAuditEnvelope. Call once at startup. */
function setAuditFn(fn) {
  if (typeof fn === 'function') _storeAuditEnvelope = fn;
}

/** `human.<email>` for a JWT caller, `system.service` for an internal
 * service-key caller (no email to attach), `system` as the last-resort
 * fallback -- mirrors the `from` address conventions used elsewhere in this
 * collector (see AEE Envelope Structure in quox-dashboard/CLAUDE.md). */
function actorAddress(req) {
  if (req.user?.email) return `human.${req.user.email}`;
  if (req.user?.id) return `human.${req.user.id}`;
  if (req.service) return 'system.service';
  return 'system';
}

/**
 * Emit an AEE envelope for a binding config-plane mutation that has ALREADY
 * succeeded against the live daemon. Never blocks or fails the mutation --
 * called after the response is already sent, wrapped so a storage failure
 * only ever produces a loud console.warn, never a second error to the
 * caller (same non-fatal posture as quoxlens.js's evidence persistence).
 *
 * @param {object} req express request (for actor + org)
 * @param {{intent: string, channelId: string, binding: object|null}} p
 */
function emitBindingEnvelope(req, { intent, channelId, binding }) {
  try {
    const b = binding || {};
    const envelope = {
      v: '1',
      ts: new Date().toISOString(),
      type: 'event',
      from: actorAddress(req),
      to: 'audit.discord-pro',
      intent,
      corr: `QDP_BINDING_${channelId}_${Date.now()}`,
      reply_to: null,
      payload: {
        channel_id: channelId,
        actor_id: req.user?.id || null,
        actor_email: req.user?.email || null,
        mode: b.mode ?? null,
        agent_id: b.agent_id ?? null,
        // The privileged fields: a 'bridge' mode binding points the relay
        // at an arbitrary remote fleet host over governed ssh_exec (SEC
        // audit 2026-08-11) -- these are exactly the fields that make a
        // binding change worth witnessing.
        bridge_remote_host: b.bridge_remote_host ?? null,
        bridge_remote_inbox: b.bridge_remote_inbox ?? null,
        bridge_outbox_host: b.bridge_outbox_host ?? null,
        bridge_outbox_inbox: b.bridge_outbox_inbox ?? null,
      },
      priority: 'normal',
      org_id: req.user?.org_id || null,
    };
    _storeAuditEnvelope(envelope);
  } catch (err) {
    console.warn('[discord-pro] evidence emit failed (non-fatal, mutation already succeeded):', err.message);
  }
}

const CONFIG_PATH = process.env.QDP_CONFIG_PATH || '/opt/quoxcore/quox-discord-pro/config.json';

// Resolve the daemon's control token. Order (first match wins), mirrors
// quox-discord-pro/src/controlToken.js on the daemon side:
//   1. QDP_CONTROL_TOKEN env - required deployment path for a containerised
//      collector once it cannot see the host filesystem at all.
//   2. cfg.controlTokenFile - a path outside the daemon repo (default
//      /opt/quoxcore/.quox-discord/control-token), reachable here because
//      /opt/quoxcore is bind-mounted read-only into this container.
//   3. cfg.controlToken - legacy inline value, kept only so an unmigrated
//      config does not hard-break; logs once if hit.
function resolveControlToken(cfg) {
  if (process.env.QDP_CONTROL_TOKEN) return process.env.QDP_CONTROL_TOKEN;
  if (cfg && cfg.controlTokenFile) {
    try {
      return fs.readFileSync(cfg.controlTokenFile, 'utf8').trim();
    } catch { /* unreadable - fall through */ }
  }
  if (cfg && cfg.controlToken) {
    console.warn('[discord-pro] resolveControl: using legacy inline controlToken from config.json; set controlTokenFile or QDP_CONTROL_TOKEN instead');
    return cfg.controlToken;
  }
  return null;
}

// Resolve the daemon control endpoint. Env-first so a containerised collector
// can reach the host daemon; config-file fallback for same-loopback setups.
function resolveControl() {
  const envUrl = process.env.QDP_CONTROL_URL;
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch { /* config unreadable - env vars are still viable below */ }
  const token = resolveControlToken(cfg);
  if (!token) return null;
  if (envUrl) return { baseUrl: envUrl.replace(/\/+$/, ''), token };
  if (cfg && cfg.controlPort) return { baseUrl: `http://127.0.0.1:${cfg.controlPort}`, token };
  return null;
}

// 3s suits the fast control endpoints (/health, /bindings answer from memory in
// single-digit ms). /doctor does NOT: it makes one Discord REST call per binding
// to establish whether the bot can actually view each channel, which measured
// ~12s against 27 bindings on 2026-08-11. With a flat 3s ceiling the diagnose
// call could never succeed, and the failure surfaced as status:"offline" -- i.e.
// it looked like the daemon was down when the daemon was healthy and merely
// slower than an arbitrary timeout. Callers pass their own budget; the default
// stays 3s so nothing else got slower.
async function callControlApi(baseUrl, token, path, timeoutMs = 3000) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'X-QDP-Token': token },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`control API ${path} returned ${res.status}`);
  return res.json();
}

router.get('/status', async (req, res) => {
  const ctrl = resolveControl();
  if (!ctrl) {
    return res.json({
      ok: false,
      health: { status: 'not-configured' },
      bindings: [],
      gaps: [],
      hint: 'set QDP_CONTROL_URL + QDP_CONTROL_TOKEN (e.g. http://172.17.0.1:3109), or mount QDP_CONFIG_PATH, so the collector can reach the daemon control API',
    });
  }
  try {
    const [health, bindingsResp] = await Promise.all([
      callControlApi(ctrl.baseUrl, ctrl.token, '/health'),
      callControlApi(ctrl.baseUrl, ctrl.token, '/bindings'),
    ]);
    return res.json({
      ok: true,
      health: { status: 'active', ...health },
      bindings: bindingsResp?.bindings || [],
      gaps: [],
    });
  } catch {
    return res.json({
      ok: false,
      health: { status: 'offline' },
      bindings: [],
      gaps: [],
      hint: 'daemon endpoint resolved but did not answer (daemon down, wrong port, or stale token)',
    });
  }
});

// QDIS-CONCIERGE: read-only doctor proxy. Same always-200 semantics as
// /status (a diagnostic surface should never error-boundary a down daemon)
// and NO admin gate -- running the diagnosis is read-only, same posture as
// /status, unlike the two binding-write routes below. The classification
// logic itself lives entirely in the daemon (src/doctor.js's runDoctor /
// formatDoctorReport), reached only through the daemon's own GET /doctor;
// this route never re-implements it.
router.get('/diagnose', async (req, res) => {
  const ctrl = resolveControl();
  if (!ctrl) {
    return res.json({
      ok: false,
      status: 'not-configured',
      results: [],
      hint: 'set QDP_CONTROL_URL + QDP_CONTROL_TOKEN (e.g. http://172.17.0.1:3109), or mount QDP_CONFIG_PATH, so the collector can reach the daemon control API',
    });
  }
  try {
    // 30s: /doctor is one Discord REST call per binding (~12s at 27 bindings and
    // it grows with the estate), so it needs a budget proportional to the work,
    // not the 3s default that suits the in-memory endpoints.
    const report = await callControlApi(ctrl.baseUrl, ctrl.token, '/doctor', 30000);
    return res.json({ ok: true, status: 'active', ...report });
  } catch {
    return res.json({
      ok: false,
      status: 'offline',
      results: [],
      hint: 'daemon endpoint resolved but did not answer (daemon down, wrong port, stale token, or bot token not wired into the daemon control API)',
    });
  }
});

// Shared body-parsing JSON reader for the two write routes below (mirrors the
// callControlApi GET helper's shape, but for PUT/DELETE with a relayed
// non-200 status instead of always-200).
//
// QDIS-NEXT p9: takes an optional onResult(status, payload) callback, fired
// AFTER the response is sent to the caller, so evidence emission can never
// delay or affect what the caller sees. onResult only fires when the
// daemon actually answered (never on the 503/502 early-return paths above,
// since nothing happened at the daemon to witness).
async function proxyToControlApi(res, method, path, body, { onResult } = {}) {
  const ctrl = resolveControl();
  if (!ctrl) {
    return res.status(503).json({ ok: false, error: 'daemon not configured (QDP_CONTROL_URL/QDP_CONTROL_TOKEN not set and config unreadable)' });
  }
  let upstream;
  try {
    upstream = await fetch(`${ctrl.baseUrl}${path}`, {
      method,
      headers: {
        'X-QDP-Token': ctrl.token,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: `daemon unreachable: ${err.message}` });
  }
  let payload = null;
  try {
    payload = await upstream.json();
  } catch { /* non-JSON or empty body from daemon */ }
  res.status(upstream.status).json(payload ?? { ok: upstream.ok });
  if (typeof onResult === 'function') {
    try {
      onResult(upstream.status, payload);
    } catch (err) {
      console.warn('[discord-pro] proxyToControlApi onResult handler failed (non-fatal):', err.message);
    }
  }
}

router.put('/bindings/:channelId', requireBindingAdmin, async (req, res) => {
  if (!SNOWFLAKE_RE.test(req.params.channelId || '')) {
    return res.status(400).json({ error: 'channelId must be a Discord snowflake (digits only)' });
  }
  const validated = sanitizeBindingBody(req.body);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }
  const channelId = req.params.channelId;
  await proxyToControlApi(res, 'PUT', `/bindings/${encodeURIComponent(channelId)}`, validated.body, {
    // The daemon's PUT response echoes `created` (a brand new binding vs an
    // edit of an existing one -- see quox-discord-pro's controlApi.js) and
    // the resulting `binding` row, so no second round trip is needed to
    // build the envelope.
    onResult: (status, payload) => {
      if (status < 200 || status >= 300) return; // daemon rejected it -- nothing to witness
      const intent = payload?.created === true
        ? 'quox.discord.binding.created'
        : 'quox.discord.binding.updated';
      emitBindingEnvelope(req, { intent, channelId, binding: payload?.binding || validated.body });
    },
  });
});

router.delete('/bindings/:channelId', requireBindingAdmin, async (req, res) => {
  if (!SNOWFLAKE_RE.test(req.params.channelId || '')) {
    return res.status(400).json({ error: 'channelId must be a Discord snowflake (digits only)' });
  }
  const channelId = req.params.channelId;
  await proxyToControlApi(res, 'DELETE', `/bindings/${encodeURIComponent(channelId)}`, undefined, {
    // The daemon's DELETE response echoes the `removed` binding (including
    // bridge_* fields) so the envelope can still show what was deleted --
    // the daemon has no other way to answer that after the row is gone.
    onResult: (status, payload) => {
      if (status < 200 || status >= 300) return;
      emitBindingEnvelope(req, { intent: 'quox.discord.binding.deleted', channelId, binding: payload?.removed || null });
    },
  });
});

/**
 * Require an internal service caller (req.service, INTERNAL_SERVICE_KEY) or
 * a scoped qmcp_ MCP token (req.mcpToken) -- never a plain browser JWT
 * session. This route hands back a raw secret; being logged into the
 * dashboard must not be enough to read it.
 */
function requireServiceOrMcpAuth(req, res, next) {
  if (req.service || req.mcpToken) return next();
  return res.status(403).json({
    ok: false,
    error: 'service credential or scoped MCP token required (a browser session cannot read the raw bot token)',
  });
}

// GET /credentials/bot-token — see the QDIS-NEXT phase 8 doc comment at the
// top of this file. Always 200 so the daemon's own fallback logic gets a
// clean signal either way instead of having to distinguish "no credential"
// from "server error" out of an HTTP status code:
//   { ok:true, bot_token, source:'vault' }  -- vault has a discord credential
//   { ok:false, reason:'not_configured' }   -- vault reachable, none set yet
//   { ok:false, reason:'resolve_error' }    -- vault lookup itself failed
router.get('/credentials/bot-token', requireServiceOrMcpAuth, async (req, res) => {
  const orgId = req.user?.org_id || req.query?.org_id || 'default';
  try {
    const credentials = await resolveNotifCreds('discord', orgId);
    if (credentials?.bot_token) {
      return res.json({ ok: true, bot_token: credentials.bot_token, source: 'vault' });
    }
    return res.json({ ok: false, reason: 'not_configured' });
  } catch (err) {
    console.error('[discord-pro] bot-token resolve failed:', err.message);
    return res.json({ ok: false, reason: 'resolve_error' });
  }
});

// resolveControl exported for devSlotDiscordProvision.js: per-slot channel
// provisioning talks to the same daemon control API and must never grow a
// second, driftable copy of the URL/token resolution.
module.exports = { router, setAuditFn, resolveControl };
