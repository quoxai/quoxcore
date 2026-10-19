'use strict';

/**
 * devLoopSpawner.js — DEVSUITE-DEVMODE fleet spawn seam: builds the signed
 * job envelope that invokes dev.sessions.structured-start on a quoxagent
 * host, and delivers it via Bastion ssh to the agent's loopback API
 * (POST /api/v1/dev/invoke).
 *
 * CROSS-LANGUAGE SIGNING CONTRACT (pinned by test, same discipline as
 * devCapabilityProfileIssuer's known-vector): quoxagent verifies
 * Ed25519(signature) over
 *
 *     envelope.ID + CreatedAt.Format(RFC3339) + json.Marshal(Job)
 *
 * (internal/crypto/verifier.go buildSignedData). Go's json.Marshal emits
 * struct-field order with omitempty, so this module builds the Job object
 * in EXACTLY quoxagent's pkg/jobs.Job field order (type, name, tool,
 * inputs, requester, correlation_id — everything else omitted when empty)
 * and formats created_at at SECOND precision UTC ("...Z", no
 * milliseconds), because Go re-formats the parsed time with time.RFC3339,
 * which drops sub-seconds — a millisecond timestamp would sign one string
 * and verify another.
 *
 * Auth/oracle: the same auth-service signing oracle that signs dev
 * capability profiles signs these bytes ({org_id, canonical_bytes_hex} →
 * {signature: hex, key_id}); quoxagent's envelope verifier trusts that
 * exact key (agent commit 74f4096). Oracle returns HEX, envelopes carry
 * BASE64 — converted here, same as the profile issuer.
 */

const crypto = require('crypto');

const AGENT_API_URL = 'http://127.0.0.1:9847';

/** Second-precision UTC RFC3339, byte-identical to Go's re-format. */
function rfc3339Utc(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Make JSON.stringify output byte-identical to Go's json.Marshal for our
 * data shapes: Go HTML-escapes <, >, & inside strings (SetEscapeHTML
 * defaults ON for json.Marshal) and escapes U+2028/U+2029; JS does
 * neither. Without this, an objective payload containing any of those
 * characters signs one byte-string while the agent verifies another.
 * Replacing on the serialized form is safe: in JSON those characters can
 * only occur inside string literals.
 */
function goJsonStringify(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Light validation + session stamping for the tasks service's tool_access
 * block (pinned snake_case contract: {enabled, agent_id, org_id, enabled_tools}).
 *
 * The collector, not the caller, owns session_id: it stamps the id it just
 * minted, overwriting anything the caller sent. Only the known fields
 * survive, so no service key, auth token or other secret can ride along into
 * the signed envelope by being tacked onto the request body.
 *
 * Returns { ok: true, value } (value undefined when the caller sent nothing)
 * or { ok: false, error }.
 */
function normalizeToolAccess(raw, sessionId) {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'tool_access must be an object' };
  }
  if (typeof raw.enabled !== 'boolean') {
    return { ok: false, error: 'tool_access.enabled must be a boolean' };
  }
  if (raw.agent_id !== undefined && typeof raw.agent_id !== 'string') {
    return { ok: false, error: 'tool_access.agent_id must be a string' };
  }
  if (raw.org_id !== undefined && typeof raw.org_id !== 'string') {
    return { ok: false, error: 'tool_access.org_id must be a string' };
  }
  if (raw.enabled_tools !== undefined) {
    if (!Array.isArray(raw.enabled_tools) || !raw.enabled_tools.every(t => typeof t === 'string' && t.length > 0)) {
      return { ok: false, error: 'tool_access.enabled_tools must be an array of non-empty strings' };
    }
  }

  const value = { enabled: raw.enabled };
  if (raw.agent_id !== undefined) value.agent_id = raw.agent_id;
  if (raw.org_id !== undefined) value.org_id = raw.org_id;
  if (raw.enabled_tools !== undefined) value.enabled_tools = raw.enabled_tools;
  value.session_id = sessionId;
  return { ok: true, value };
}

/**
 * Build the envelope (unsigned) + the exact bytes the oracle must sign.
 * Pure — the known-vector test pins its output.
 */
function buildLoopSpawnEnvelope({
  envelopeId,
  createdAt,          // RFC3339 second-precision UTC string
  expiresAt,          // same format; agent requires <= 10 min ahead
  sessionRef,         // collector-side dev_loop_sessions id
  ingestToken,
  collectorLanUrl,    // LAN-reachable collector base URL for the forwarder
  backend,
  payload,
  args,
  maxDurationMs,
  maxTurns,
  toolAccess,         // normalized {enabled, agent_id?, org_id?, session_id}
}) {
  const input = {
    backend,
    payload: payload || '',
    session_ref: sessionRef,
    ingest_token: ingestToken,
    collector_url: collectorLanUrl,
  };
  if (Array.isArray(args) && args.length) input.args = args;
  if (maxDurationMs > 0) input.max_duration_ms = maxDurationMs;
  if (maxTurns > 0) input.max_turns = maxTurns;
  // Same level as args, omitted entirely when absent so a spawn without
  // tool_access signs byte-identical bytes to before this field existed.
  if (toolAccess) input.tool_access = toolAccess;

  // pkg/jobs.Job in Go struct-field order, empties omitted (omitempty).
  const job = {
    type: 'tool',
    name: `dev-loop-spawn ${sessionRef}`,
    tool: 'dev.sessions.structured-start',
    inputs: [{ name: 'input.json', content: JSON.stringify(input) }],
    requester: 'collector.dev-loop-spawner',
    correlation_id: sessionRef,
  };

  // goJsonStringify, not plain stringify: the agent re-marshals the
  // decoded Job with Go's HTML-escaping before verifying (see module doc).
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
 * Build the Bastion-executed shell command that delivers the signed
 * envelope to the agent's loopback /dev/invoke. The envelope travels
 * base64-encoded so no envelope byte ever meets shell parsing (same
 * posture as skillPackInstaller's file writes).
 */
function buildDeliveryCommand(signedEnvelope, agentApiUrl = AGENT_API_URL) {
  const b64 = Buffer.from(JSON.stringify(signedEnvelope), 'utf8').toString('base64');
  return `printf '%s' '${b64}' | base64 -d | curl -s -m 25 -X POST -H 'Content-Type: application/json' --data-binary @- ${agentApiUrl}/api/v1/dev/invoke`;
}

/**
 * Spawn a loop session on hostId end to end: sign via signFn (the auth
 * oracle), deliver via deliverFn (callBastion-shaped: (hostId, command) →
 * {success, stdout, stderr, error}), parse the agent's response.
 *
 * Returns { agentSessionId } or throws with a real reason — a spawn that
 * didn't spawn must never look like one that did.
 */
async function deliverLoopSpawn({
  orgId,
  hostId,
  sessionRef,
  ingestToken,
  collectorLanUrl,
  backend,
  payload,
  args,
  maxDurationMs,
  maxTurns,
  toolAccess,  // normalized tool_access block (see normalizeToolAccess)
  signFn,      // async (orgId, canonicalBytesHex) => { signature: hex, key_id }
  deliverFn,   // async (hostId, command, grant) => { success, stdout, stderr, error }
  grantFn,     // optional async (hostId, command) => grant string|null; throws to refuse
  agentApiUrl, // test override
}) {
  const envelopeId = `dvi_${crypto.randomBytes(12).toString('hex')}`;
  const now = new Date();
  const createdAt = rfc3339Utc(now);
  const expiresAt = rfc3339Utc(new Date(now.getTime() + 5 * 60 * 1000));

  const { envelope, signedBytes } = buildLoopSpawnEnvelope({
    envelopeId, createdAt, expiresAt, sessionRef, ingestToken,
    collectorLanUrl, backend, payload, args, maxDurationMs, maxTurns, toolAccess,
  });

  const canonicalBytesHex = Buffer.from(signedBytes, 'utf8').toString('hex');
  const signed = await signFn(orgId, canonicalBytesHex);
  if (!signed || !signed.signature || !signed.key_id) {
    throw new Error('devLoopSpawner: signing oracle returned an incomplete response');
  }
  envelope.signature = Buffer.from(signed.signature, 'hex').toString('base64');
  envelope.key_id = signed.key_id;

  const command = buildDeliveryCommand(envelope, agentApiUrl);
  // WHY after buildDeliveryCommand: the grant binds the exact command string,
  // which is unique per spawn, so it can only be minted once the command exists.
  const grant = grantFn ? await grantFn(hostId, command) : undefined;
  const result = await deliverFn(hostId, command, grant);
  if (!result || !result.success) {
    throw new Error(`devLoopSpawner: delivery to ${hostId} failed: ${result && (result.error || result.stderr) || 'no result'}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`devLoopSpawner: agent response was not JSON: ${String(result.stdout).slice(0, 300)}`);
  }
  const agentSessionId = parsed && parsed.output && parsed.output.session_id;
  if (parsed.status !== 'ok' || !agentSessionId) {
    throw new Error(`devLoopSpawner: agent refused the spawn: ${JSON.stringify(parsed).slice(0, 500)}`);
  }
  return { agentSessionId };
}

/**
 * Build a signed dev.sessions.structured-kill envelope for the QLoop
 * Observer/Knot interrupt. Same signing contract as spawn (goJsonStringify
 * over the job, Go struct-field order), just a different tool + input.
 */
function buildLoopKillEnvelope({ envelopeId, createdAt, expiresAt, agentSessionId }) {
  const job = {
    type: 'tool',
    name: `dev-loop-kill ${agentSessionId}`,
    tool: 'dev.sessions.structured-kill',
    inputs: [{ name: 'input.json', content: JSON.stringify({ session_id: agentSessionId }) }],
    requester: 'collector.dev-loop-observer',
    correlation_id: agentSessionId,
  };
  const signedBytes = envelopeId + createdAt + goJsonStringify(job);
  const envelope = { version: '1', id: envelopeId, job, created_at: createdAt, expires_at: expiresAt };
  return { envelope, signedBytes };
}

/**
 * Kill a live structured session on hostId (Observer/Knot interrupt). Signs
 * + delivers a structured-kill to the agent's /dev/invoke. Idempotent on the
 * agent side; an unknown session is an error there, surfaced here.
 */
async function deliverLoopKill({ orgId, hostId, agentSessionId, signFn, deliverFn, agentApiUrl }) {
  const envelopeId = `dvi_${crypto.randomBytes(12).toString('hex')}`;
  const now = new Date();
  const createdAt = rfc3339Utc(now);
  const expiresAt = rfc3339Utc(new Date(now.getTime() + 5 * 60 * 1000));

  const { envelope, signedBytes } = buildLoopKillEnvelope({ envelopeId, createdAt, expiresAt, agentSessionId });
  const canonicalBytesHex = Buffer.from(signedBytes, 'utf8').toString('hex');
  const signed = await signFn(orgId, canonicalBytesHex);
  if (!signed || !signed.signature || !signed.key_id) {
    throw new Error('devLoopSpawner: kill signing oracle returned an incomplete response');
  }
  envelope.signature = Buffer.from(signed.signature, 'hex').toString('base64');
  envelope.key_id = signed.key_id;

  const command = buildDeliveryCommand(envelope, agentApiUrl);
  const result = await deliverFn(hostId, command);
  if (!result || !result.success) {
    throw new Error(`devLoopSpawner: kill delivery to ${hostId} failed: ${result && (result.error || result.stderr) || 'no result'}`);
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
  return { killed: !!(parsed && parsed.status === 'ok') };
}

module.exports = {
  normalizeToolAccess,
  buildLoopSpawnEnvelope,
  buildLoopKillEnvelope,
  buildDeliveryCommand,
  deliverLoopSpawn,
  deliverLoopKill,
  rfc3339Utc,
  AGENT_API_URL,
  // Exported for devBuildProxy.js: there is exactly ONE implementation of
  // the Go-marshal signing contract in this codebase. Duplicating it is
  // how two callers drift one byte apart and every envelope verifies for
  // one of them only.
  goJsonStringify,
};
