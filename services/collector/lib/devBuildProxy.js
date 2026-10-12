/**
 * DEVSUITE-BUILD step 3 — collector control plane for dev.build.
 *
 * The executor lives host-side in quoxagent (internal/plugins/dev/build):
 * queue, journal, runner, verify probes. This module is ONLY the governed
 * reach-through: it builds a signed JobEnvelope naming a dev.build method,
 * has the auth oracle sign it, delivers it over Bastion to the agent's
 * loopback /api/v1/dev/invoke, and parses the response. Same signing
 * contract as devLoopSpawner (goJsonStringify over the Job in Go
 * struct-field order); the envelope's input only ever NAMES a
 * pre-registered target — the agent refuses anything else, and nothing
 * here accepts a command string.
 *
 * Route surface (wired in server.js, behind the default-deny auth gate —
 * requireServiceOrUserAuth, org resolved from the caller):
 *   POST /api/v1/dev-build/:hostId/dispatch  {target, stream?, phase?, msg?}
 *   GET  /api/v1/dev-build/:hostId/status
 *   GET  /api/v1/dev-build/:hostId/targets
 */

const crypto = require('crypto');
const { goJsonStringify, buildDeliveryCommand, rfc3339Utc } = require('./devLoopSpawner.js');
const { callerCanAccessOrg } = require('./devServerSkillPacksStore.js');

const DEV_BUILD_CAPABILITY = 'dev.build';

/**
 * Build the envelope (unsigned) + the exact bytes the oracle must sign,
 * for any dev.build method. Pure — tests pin its output.
 */
function buildDevBuildEnvelope({ envelopeId, createdAt, expiresAt, method, input, correlationId }) {
  const job = {
    type: 'tool',
    name: `dev-build-${method} ${correlationId}`,
    tool: `${DEV_BUILD_CAPABILITY}.${method}`,
    inputs: [{ name: 'input.json', content: JSON.stringify(input || {}) }],
    requester: 'collector.dev-build',
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
 * Sign + deliver one dev.build method invocation to hostId and return the
 * agent's output object. Throws with a real reason on any failure — a
 * dispatch that didn't reach the agent must never look like one that did.
 */
async function deliverDevBuildInvoke({ orgId, hostId, method, input, signFn, deliverFn, agentApiUrl }) {
  const envelopeId = `dvb_${crypto.randomBytes(12).toString('hex')}`;
  const correlationId = envelopeId;
  const now = new Date();
  const createdAt = rfc3339Utc(now);
  const expiresAt = rfc3339Utc(new Date(now.getTime() + 5 * 60 * 1000));

  const { envelope, signedBytes } = buildDevBuildEnvelope({
    envelopeId, createdAt, expiresAt, method, input, correlationId,
  });

  const canonicalBytesHex = Buffer.from(signedBytes, 'utf8').toString('hex');
  const signed = await signFn(orgId, canonicalBytesHex);
  if (!signed || !signed.signature || !signed.key_id) {
    throw new Error('devBuildProxy: signing oracle returned an incomplete response');
  }
  envelope.signature = Buffer.from(signed.signature, 'hex').toString('base64');
  envelope.key_id = signed.key_id;

  const command = buildDeliveryCommand(envelope, agentApiUrl);
  const result = await deliverFn(hostId, command);
  if (!result || !result.success) {
    throw new Error(`devBuildProxy: delivery to ${hostId} failed: ${result && (result.error || result.stderr) || 'no result'}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`devBuildProxy: agent response was not JSON: ${String(result.stdout).slice(0, 300)}`);
  }
  if (parsed.status !== 'ok') {
    const reason = (parsed && (parsed.error || JSON.stringify(parsed))) || 'unknown';
    const err = new Error(`agent refused ${DEV_BUILD_CAPABILITY}.${method}: ${String(reason).slice(0, 500)}`);
    err.agentRefusal = true;
    throw err;
  }
  return parsed.output || {};
}

/**
 * Shared host gate: the target host must be a registered dev server with
 * dev.build enabled by its verified profile, AND owned by the authenticated
 * caller's own org (see callerCanAccessOrg in devServerSkillPacksStore.js —
 * without this check any authenticated user of ANY org could dispatch a
 * build, or worse, on another org's dev host just by knowing its host_id).
 * Returns the row or writes the HTTP refusal and returns null.
 */
function requireBuildHost(req, res, getServer, hostId) {
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
  if (!enabled.includes(DEV_BUILD_CAPABILITY)) {
    res.status(409).json({ error: `dev.build is not enabled on ${hostId} (enabled: ${enabled.join(', ') || 'none'})` });
    return null;
  }
  return server;
}

/**
 * POST /api/v1/dev-build/:hostId/dispatch — queue a build of a
 * pre-registered target on the host. Body: {target, stream?, phase?, msg?}.
 * The terminal label is derived from the authenticated caller, never taken
 * from the body: receipts must say who actually asked.
 */
function createDevBuildDispatchHandler(deps) {
  const { getServer, invoke, resolveOrgId, emitEnvelope } = deps;
  return async function devBuildDispatchHandler(req, res) {
    const hostId = req.params.hostId;
    const { target, stream, phase, msg } = req.body || {};
    if (!target || typeof target !== 'string' || !target.trim()) {
      return res.status(400).json({ error: 'target is required' });
    }
    if (!requireBuildHost(req, res, getServer, hostId)) return;

    const orgId = resolveOrgId(req);
    const caller = (req.user && (req.user.email || req.user.id)) || 'service';
    const input = {
      target: target.trim(),
      terminal: `dashboard:${caller}`,
    };
    if (typeof stream === 'string' && stream) input.stream = stream;
    if (typeof phase === 'string' && phase) input.phase = phase;
    if (typeof msg === 'string' && msg) input.msg = msg;

    try {
      const output = await invoke({ orgId, hostId, method: 'dispatch', input });
      if (typeof emitEnvelope === 'function') {
        // Fire-and-forget evidence, same contract as the receipt emit in
        // buildReceiptsStore: never blocks or fails the dispatch.
        try {
          emitEnvelope({
            type: 'event',
            from: `agent.${input.terminal}`,
            to: 'audit.build_queue',
            intent: 'quox.build.dispatch',
            corr: `BUILD_DISPATCH_${hostId}_${input.target}`,
            payload: { host_id: hostId, target: input.target, terminal: input.terminal, stream: input.stream, phase: input.phase, org_id: orgId },
          });
        } catch { /* evidence is best-effort here */ }
      }
      return res.json({ dispatched: true, host_id: hostId, targets: output.targets || [] });
    } catch (err) {
      const status = err && err.agentRefusal ? 422 : 502;
      return res.status(status).json({ error: String(err && err.message || err) });
    }
  };
}

/**
 * GET /api/v1/dev-build/:hostId/status — live executor state (readiness,
 * prereqs, building-now, last outcome per target) straight from the host.
 */
function createDevBuildStatusHandler(deps) {
  const { getServer, invoke, resolveOrgId } = deps;
  return async function devBuildStatusHandler(req, res) {
    const hostId = req.params.hostId;
    if (!requireBuildHost(req, res, getServer, hostId)) return;
    try {
      const output = await invoke({ orgId: resolveOrgId(req), hostId, method: 'status', input: {} });
      return res.json({ host_id: hostId, ...output });
    } catch (err) {
      const status = err && err.agentRefusal ? 422 : 502;
      return res.status(status).json({ error: String(err && err.message || err) });
    }
  };
}

/**
 * GET /api/v1/dev-build/:hostId/targets — the host's pre-registered
 * target list.
 */
function createDevBuildTargetsHandler(deps) {
  const { getServer, invoke, resolveOrgId } = deps;
  return async function devBuildTargetsHandler(req, res) {
    const hostId = req.params.hostId;
    if (!requireBuildHost(req, res, getServer, hostId)) return;
    try {
      const output = await invoke({ orgId: resolveOrgId(req), hostId, method: 'targets', input: {} });
      return res.json({ host_id: hostId, ...output });
    } catch (err) {
      const status = err && err.agentRefusal ? 422 : 502;
      return res.status(status).json({ error: String(err && err.message || err) });
    }
  };
}

module.exports = {
  DEV_BUILD_CAPABILITY,
  buildDevBuildEnvelope,
  deliverDevBuildInvoke,
  createDevBuildDispatchHandler,
  createDevBuildStatusHandler,
  createDevBuildTargetsHandler,
};
