/**
 * SLOTS-TMUX step B — collector control plane for the dev.sessions tmux
 * (interactive) path.
 *
 * The executor lives host-side in quoxagent (internal/plugins/dev/sessions:
 * one persistent `tmux -C` control-mode client per host, sessions survive
 * detach). This module is ONLY the governed reach-through: it builds a
 * signed JobEnvelope naming a dev.sessions method, has the auth oracle sign
 * it, delivers it over Bastion to the agent's loopback /api/v1/dev/invoke,
 * and parses the response. Same signing contract as devLoopSpawner
 * (goJsonStringify over the Job in Go struct-field order).
 *
 * Bastion's /api/v1/exec has a HARDCODED 60s ceiling (exec.go, known
 * incident, unfixed). That ceiling never binds a session's LIFETIME here by
 * construction: every route below is one short envelope delivery (curl -m
 * 25 inside a 45s Bastion call); the interactive session itself lives on
 * the host's tmux server between calls. Nothing in this file may ever wait
 * on a session — only on a single method invocation.
 *
 * Route surface (wired in server.js, service/user auth, same posture as the
 * structured /api/v1/dev-sessions/spawn seam):
 *   GET    /api/v1/dev-sessions/tmux/:hostId                       list
 *   POST   /api/v1/dev-sessions/tmux/:hostId            {name?, backend?}
 *   POST   /api/v1/dev-sessions/tmux/:hostId/:sessionId/keys    {keys}
 *   GET    /api/v1/dev-sessions/tmux/:hostId/:sessionId/pane
 *   DELETE /api/v1/dev-sessions/tmux/:hostId/:sessionId           kill
 */

const crypto = require('crypto');
const { goJsonStringify, buildDeliveryCommand, rfc3339Utc } = require('./devLoopSpawner.js');
const { callerCanAccessOrg } = require('./devServerSkillPacksStore.js');

const DEV_SESSIONS_CAPABILITY = 'dev.sessions';

// Interactive pane backends the agent knows how to launch. 'shell' is the
// default: a plain login shell, tmux's own default when no command given.
const TMUX_BACKENDS = ['shell', 'claude', 'codex'];

// tmux rejects ':' and '.' in session names; keep it tighter than that so a
// name is always safe inside evidence strings and CLI output too.
const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// Keys ride inside a base64 envelope inside a Bastion ssh command line;
// cap them well below anything that could stress that path. Interactive
// input is lines, not documents.
const MAX_KEYS_LENGTH = 4096;

/**
 * Build the envelope (unsigned) + the exact bytes the oracle must sign,
 * for any dev.sessions method. Pure — tests pin its output.
 */
function buildDevSessionsEnvelope({ envelopeId, createdAt, expiresAt, method, input, correlationId }) {
  const job = {
    type: 'tool',
    name: `dev-sessions-${method} ${correlationId}`,
    tool: `${DEV_SESSIONS_CAPABILITY}.${method}`,
    inputs: [{ name: 'input.json', content: JSON.stringify(input || {}) }],
    requester: 'collector.dev-sessions',
    correlation_id: correlationId,
  };
  const signedBytes = envelopeId + createdAt + goJsonStringify(job);
  const envelope = {
    version: '1',
    id: envelopeId,
    job,
    created_at: createdAt,
    expires_at: expiresAt,
  };
  return { envelope, signedBytes };
}

/**
 * Sign + deliver one dev.sessions method invocation to hostId and return
 * the agent's output object. Throws with a real reason on any failure — an
 * invocation that didn't reach the agent must never look like one that did.
 */
async function deliverDevSessionsInvoke({ orgId, hostId, method, input, signFn, deliverFn, agentApiUrl }) {
  const envelopeId = `dvs_${crypto.randomBytes(12).toString('hex')}`;
  const correlationId = envelopeId;
  const now = new Date();
  const createdAt = rfc3339Utc(now);
  const expiresAt = rfc3339Utc(new Date(now.getTime() + 5 * 60 * 1000));

  const { envelope, signedBytes } = buildDevSessionsEnvelope({
    envelopeId, createdAt, expiresAt, method, input, correlationId,
  });

  const canonicalBytesHex = Buffer.from(signedBytes, 'utf8').toString('hex');
  const signed = await signFn(orgId, canonicalBytesHex);
  if (!signed || !signed.signature || !signed.key_id) {
    throw new Error('devSessionsProxy: signing oracle returned an incomplete response');
  }
  envelope.signature = Buffer.from(signed.signature, 'hex').toString('base64');
  envelope.key_id = signed.key_id;

  const command = buildDeliveryCommand(envelope, agentApiUrl);
  const result = await deliverFn(hostId, command);
  if (!result || !result.success) {
    throw new Error(`devSessionsProxy: delivery to ${hostId} failed: ${result && (result.error || result.stderr) || 'no result'}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`devSessionsProxy: agent response was not JSON: ${String(result.stdout).slice(0, 300)}`);
  }
  if (parsed.status !== 'ok') {
    const reason = (parsed && (parsed.error || JSON.stringify(parsed))) || 'unknown';
    const err = new Error(`agent refused ${DEV_SESSIONS_CAPABILITY}.${method}: ${String(reason).slice(0, 500)}`);
    err.agentRefusal = true;
    throw err;
  }
  return parsed.output || {};
}

/**
 * Shared host gate: the target host must be a registered dev server with
 * dev.sessions enabled by its verified profile, AND owned by the
 * authenticated caller's own org (see callerCanAccessOrg in
 * devServerSkillPacksStore.js — without this check any authenticated user of
 * ANY org could create/list/send-keys-into/kill an interactive tmux session
 * on another org's dev host just by knowing its host_id). Returns the row or
 * writes the HTTP refusal and returns null.
 */
function requireSessionsHost(req, res, getServer, hostId) {
  const server = getServer(hostId);
  if (!server) {
    res.status(404).json({ error: `unknown dev server: ${hostId}` });
    return null;
  }
  // QUOXTRUST FND_..SPCJ (cross-org host control): a USER caller may only act on a host in
  // their OWN org; a trusted service-key caller (req.service — e.g. the backup runner,
  // bobTools build dispatch, admin-backups) legitimately acts across orgs and is allowed.
  if (!req.service && !callerCanAccessOrg(req, server.org_id)) {
    res.status(403).json({ error: 'org_scope_mismatch' });
    return null;
  }
  const enabled = Array.isArray(server.enabled_capabilities) ? server.enabled_capabilities : [];
  if (!enabled.includes(DEV_SESSIONS_CAPABILITY)) {
    res.status(409).json({ error: `${DEV_SESSIONS_CAPABILITY} is not enabled on ${hostId} (enabled: ${enabled.join(', ') || 'none'})` });
    return null;
  }
  return server;
}

/** Map an invoke failure onto the response: 422 agent refusal, 502 transport. */
function writeInvokeError(res, err) {
  const status = err && err.agentRefusal ? 422 : 502;
  return res.status(status).json({ error: String(err && err.message || err) });
}

/** Fire-and-forget evidence emit — never blocks or fails the request. */
function emitSessionEvidence(emitEnvelope, intent, hostId, payload) {
  if (typeof emitEnvelope !== 'function') return;
  try {
    emitEnvelope({
      type: 'event',
      from: 'collector.dev-sessions',
      to: 'audit.dev_sessions',
      intent,
      corr: `DEV_TMUX_${hostId}_${payload.session_id || payload.name || 'new'}`,
      payload: { host_id: hostId, ...payload },
    });
  } catch { /* evidence is best-effort here */ }
}

/**
 * POST /api/v1/dev-sessions/tmux/:hostId — create an interactive tmux
 * session on the host. Body: {name?, backend?} (backend defaults to shell).
 */
function createTmuxNewHandler(deps) {
  const { getServer, invoke, resolveOrgId, emitEnvelope } = deps;
  return async function tmuxNewHandler(req, res) {
    const hostId = req.params.hostId;
    const { name, backend } = req.body || {};
    const chosenBackend = backend === undefined || backend === null || backend === '' ? 'shell' : backend;
    if (!TMUX_BACKENDS.includes(chosenBackend)) {
      return res.status(400).json({ error: `backend must be one of: ${TMUX_BACKENDS.join(', ')}` });
    }
    if (name !== undefined && name !== null && name !== '' && !SESSION_NAME_RE.test(String(name))) {
      return res.status(400).json({ error: 'name must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}' });
    }
    if (!requireSessionsHost(req, res, getServer, hostId)) return;

    const input = { backend: chosenBackend };
    if (name) input.name = String(name);
    try {
      const output = await invoke({ orgId: resolveOrgId(req), hostId, method: 'new-session', input });
      emitSessionEvidence(emitEnvelope, 'quox.dev.sessions.new', hostId, {
        session_id: output.session_id, name: output.name, backend: chosenBackend,
      });
      return res.json({ host_id: hostId, ...output });
    } catch (err) {
      return writeInvokeError(res, err);
    }
  };
}

/** GET /api/v1/dev-sessions/tmux/:hostId — live sessions on the host. */
function createTmuxListHandler(deps) {
  const { getServer, invoke, resolveOrgId } = deps;
  return async function tmuxListHandler(req, res) {
    const hostId = req.params.hostId;
    if (!requireSessionsHost(req, res, getServer, hostId)) return;
    try {
      const output = await invoke({ orgId: resolveOrgId(req), hostId, method: 'list-sessions', input: {} });
      return res.json({ host_id: hostId, ...output });
    } catch (err) {
      return writeInvokeError(res, err);
    }
  };
}

/**
 * POST /api/v1/dev-sessions/tmux/:hostId/:sessionId/keys — inject one line
 * of input (the agent appends Enter). Body: {keys}.
 */
function createTmuxSendKeysHandler(deps) {
  const { getServer, invoke, resolveOrgId, emitEnvelope } = deps;
  return async function tmuxSendKeysHandler(req, res) {
    const hostId = req.params.hostId;
    const sessionId = req.params.sessionId;
    // ?by=name: the identifier is the tmux session NAME (orphans have no id).
    const byName = !!(req.query && req.query.by === 'name');
    const { keys } = req.body || {};
    if (typeof keys !== 'string' || keys.length === 0) {
      return res.status(400).json({ error: 'keys is required' });
    }
    if (keys.length > MAX_KEYS_LENGTH) {
      return res.status(400).json({ error: `keys must be at most ${MAX_KEYS_LENGTH} characters` });
    }
    if (!requireSessionsHost(req, res, getServer, hostId)) return;
    try {
      const ident = byName ? { name: sessionId } : { session_id: sessionId };
      const output = await invoke({
        orgId: resolveOrgId(req), hostId, method: 'send-keys',
        input: { ...ident, keys },
      });
      // Evidence carries the keystrokes: injected input into a live session
      // is exactly what an audit needs to reconstruct.
      emitSessionEvidence(emitEnvelope, 'quox.dev.sessions.send_keys', hostId, { ...ident, keys });
      return res.json({ host_id: hostId, ...output });
    } catch (err) {
      return writeInvokeError(res, err);
    }
  };
}

/** GET /api/v1/dev-sessions/tmux/:hostId/:sessionId/pane — read the pane. */
function createTmuxPaneHandler(deps) {
  const { getServer, invoke, resolveOrgId } = deps;
  return async function tmuxPaneHandler(req, res) {
    const hostId = req.params.hostId;
    const sessionId = req.params.sessionId;
    const byName = !!(req.query && req.query.by === 'name');
    if (!requireSessionsHost(req, res, getServer, hostId)) return;
    try {
      const output = await invoke({
        orgId: resolveOrgId(req), hostId, method: 'capture-pane',
        input: byName ? { name: sessionId } : { session_id: sessionId },
      });
      return res.json({ host_id: hostId, ...output });
    } catch (err) {
      return writeInvokeError(res, err);
    }
  };
}

/**
 * DELETE /api/v1/dev-sessions/tmux/:hostId/:sessionId — kill the session.
 * `?by=name` treats the identifier as the tmux session NAME instead of the
 * agent session id: an orphan (survived an agent restart) has no session_id
 * in the tmux truth list, so its name is its only handle.
 */
function createTmuxKillHandler(deps) {
  const { getServer, invoke, resolveOrgId, emitEnvelope } = deps;
  return async function tmuxKillHandler(req, res) {
    const hostId = req.params.hostId;
    const sessionId = req.params.sessionId;
    const byName = !!(req.query && req.query.by === 'name');
    if (!requireSessionsHost(req, res, getServer, hostId)) return;
    try {
      const output = await invoke({
        orgId: resolveOrgId(req), hostId, method: 'kill-session',
        input: byName ? { name: sessionId } : { session_id: sessionId },
      });
      emitSessionEvidence(emitEnvelope, 'quox.dev.sessions.kill', hostId,
        byName ? { name: sessionId } : { session_id: sessionId });
      return res.json({ host_id: hostId, ...output });
    } catch (err) {
      return writeInvokeError(res, err);
    }
  };
}

module.exports = {
  DEV_SESSIONS_CAPABILITY,
  TMUX_BACKENDS,
  MAX_KEYS_LENGTH,
  buildDevSessionsEnvelope,
  deliverDevSessionsInvoke,
  createTmuxNewHandler,
  createTmuxListHandler,
  createTmuxSendKeysHandler,
  createTmuxPaneHandler,
  createTmuxKillHandler,
};
