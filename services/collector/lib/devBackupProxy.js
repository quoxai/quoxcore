/**
 * G2d slice 2 — collector control plane for dev.backup / dev.restore.
 *
 * The executors live host-side in quoxagent (internal/plugins/dev/backup and
 * .../restore), wrapping scripts/backup-quox.sh and scripts/restore-quox.sh.
 * This module is ONLY the governed reach-through, exactly as devBuildProxy.js
 * is for dev.build: it builds a signed JobEnvelope naming a dev.backup /
 * dev.restore method, has the auth oracle sign it, delivers it over Bastion to
 * the agent's loopback /api/v1/dev/invoke, and parses the response. Same
 * signing contract as devLoopSpawner (goJsonStringify over the Job in Go
 * struct-field order); nothing here accepts a command string, and a restore
 * only ever NAMES an archive the host itself registered.
 *
 * Route surface (wired in server.js, behind the default-deny auth gate PLUS
 * an explicit requireServiceOrUserAuth() — see the comment at that block on
 * why backup/restore does not ride on the global gate alone):
 *   POST /api/v1/dev-backup/:hostId/dispatch       {mode?, stream?, phase?, message?}
 *   GET  /api/v1/dev-backup/:hostId/status
 *   GET  /api/v1/dev-backup/:hostId/archives
 *   POST /api/v1/dev-backup/:hostId/restore        {archive_id, dry_run?, stores?}
 *   GET  /api/v1/dev-backup/:hostId/restore-status
 */

const crypto = require('crypto');
const { goJsonStringify, buildDeliveryCommand, rfc3339Utc } = require('./devLoopSpawner.js');
const { callerCanAccessOrg } = require('./devServerSkillPacksStore.js');

const DEV_BACKUP_CAPABILITY = 'dev.backup';
const DEV_RESTORE_CAPABILITY = 'dev.restore';

// Backup modes the engine understands (scripts/backup-quox.sh run_backup's
// `mode` argument). Validated here so a typo is a 400 from the collector
// rather than a signed envelope the agent has to refuse.
const BACKUP_MODES = Object.freeze(['full', 'quick']);

// An archive id is a host-side identifier (the engine's run timestamp, e.g.
// 20260917_020000). Constrained to a sane token so nothing shell-ish or
// path-traversing can ever reach the delivery command, even though the
// envelope is JSON and base64'd on the way over.
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

// Store names come from the backup manifest's stores ledger; same token rule.
const STORE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Build the envelope (unsigned) + the exact bytes the oracle must sign, for
 * any dev.backup / dev.restore method. Pure — tests pin its output.
 */
function buildDevBackupEnvelope({ envelopeId, createdAt, expiresAt, capability, method, input, correlationId }) {
  const cap = capability || DEV_BACKUP_CAPABILITY;
  const job = {
    type: 'tool',
    name: `${cap.replace('.', '-')}-${method} ${correlationId}`,
    tool: `${cap}.${method}`,
    inputs: [{ name: 'input.json', content: JSON.stringify(input || {}) }],
    requester: 'collector.dev-backup',
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
 * Sign + deliver one dev.backup / dev.restore method invocation to hostId and
 * return the agent's output object. Throws with a real reason on any failure —
 * a dispatch that didn't reach the agent must never look like one that did.
 */
async function deliverDevBackupInvoke({ orgId, hostId, capability, method, input, signFn, deliverFn, agentApiUrl }) {
  const cap = capability || DEV_BACKUP_CAPABILITY;
  const envelopeId = `dvbk_${crypto.randomBytes(12).toString('hex')}`;
  const correlationId = envelopeId;
  const now = new Date();
  const createdAt = rfc3339Utc(now);
  const expiresAt = rfc3339Utc(new Date(now.getTime() + 5 * 60 * 1000));

  const { envelope, signedBytes } = buildDevBackupEnvelope({
    envelopeId, createdAt, expiresAt, capability: cap, method, input, correlationId,
  });

  const canonicalBytesHex = Buffer.from(signedBytes, 'utf8').toString('hex');
  const signed = await signFn(orgId, canonicalBytesHex);
  if (!signed || !signed.signature || !signed.key_id) {
    throw new Error('devBackupProxy: signing oracle returned an incomplete response');
  }
  envelope.signature = Buffer.from(signed.signature, 'hex').toString('base64');
  envelope.key_id = signed.key_id;

  const command = buildDeliveryCommand(envelope, agentApiUrl);
  const result = await deliverFn(hostId, command);
  if (!result || !result.success) {
    throw new Error(`devBackupProxy: delivery to ${hostId} failed: ${result && (result.error || result.stderr) || 'no result'}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`devBackupProxy: agent response was not JSON: ${String(result.stdout).slice(0, 300)}`);
  }
  if (parsed.status !== 'ok') {
    const reason = (parsed && (parsed.error || JSON.stringify(parsed))) || 'unknown';
    const err = new Error(`agent refused ${cap}.${method}: ${String(reason).slice(0, 500)}`);
    err.agentRefusal = true;
    throw err;
  }
  return parsed.output || {};
}

/**
 * Shared host gate: the target host must be a registered dev server whose
 * verified profile enables dev.backup, AND owned by the authenticated
 * caller's own org (see callerCanAccessOrg in devServerSkillPacksStore.js —
 * without this check any authenticated user of ANY org could trigger a
 * backup, or a RESTORE, against another org's dev host just by knowing its
 * host_id). The two restore routes additionally require dev.restore —
 * reading data back over a live stack is a strictly bigger grant than
 * writing an archive, so it is a separate capability and a host may hold one
 * without the other. Returns the row, or writes the HTTP refusal and returns
 * null.
 */
function requireBackupHost(req, res, getServer, hostId, { requireRestore = false } = {}) {
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
  if (!enabled.includes(DEV_BACKUP_CAPABILITY)) {
    res.status(409).json({ error: `${DEV_BACKUP_CAPABILITY} is not enabled on ${hostId} (enabled: ${enabled.join(', ') || 'none'})` });
    return null;
  }
  if (requireRestore && !enabled.includes(DEV_RESTORE_CAPABILITY)) {
    res.status(409).json({ error: `${DEV_RESTORE_CAPABILITY} is not enabled on ${hostId} (enabled: ${enabled.join(', ') || 'none'})` });
    return null;
  }
  return server;
}

function callerTerminal(req) {
  const caller = (req && req.user && (req.user.email || req.user.id)) || 'service';
  return `dashboard:${caller}`;
}

function refusalStatus(err) {
  return err && err.agentRefusal ? 422 : 502;
}

/**
 * POST /api/v1/dev-backup/:hostId/dispatch — run a backup on the host.
 * Body: {mode?: "full"|"quick", stream?, phase?, message?}.
 *
 * mode is passed through only when supplied: the engine owns the default, and
 * asserting one here would silently override a host-side policy change. The
 * terminal label is derived from the authenticated caller, never the body:
 * receipts must say who actually asked.
 */
function createDevBackupDispatchHandler(deps) {
  const { getServer, invoke, resolveOrgId, emitEnvelope } = deps;
  return async function devBackupDispatchHandler(req, res) {
    const hostId = req.params.hostId;
    const { mode, stream, phase, message } = req.body || {};
    if (mode !== undefined && mode !== null && !BACKUP_MODES.includes(mode)) {
      return res.status(400).json({ error: `mode must be one of: ${BACKUP_MODES.join(', ')}` });
    }
    if (!requireBackupHost(req, res, getServer, hostId)) return;

    const orgId = resolveOrgId(req);
    const input = { terminal: callerTerminal(req) };
    if (mode) input.mode = mode;
    if (typeof stream === 'string' && stream) input.stream = stream;
    if (typeof phase === 'string' && phase) input.phase = phase;
    if (typeof message === 'string' && message) input.message = message;

    try {
      const output = await invoke({ orgId, hostId, capability: DEV_BACKUP_CAPABILITY, method: 'dispatch', input });
      if (typeof emitEnvelope === 'function') {
        // Fire-and-forget evidence, same contract as the dispatch emit in
        // devBuildProxy: never blocks or fails the dispatch.
        try {
          emitEnvelope({
            type: 'event',
            from: `agent.${input.terminal}`,
            to: 'audit.backup_queue',
            intent: 'quox.backup.dispatch',
            corr: `BACKUP_DISPATCH_${hostId}`,
            payload: {
              host_id: hostId,
              mode: input.mode || null,
              terminal: input.terminal,
              stream: input.stream,
              phase: input.phase,
              org_id: orgId,
            },
          });
        } catch { /* evidence is best-effort here */ }
      }
      return res.json({ dispatched: true, host_id: hostId, ...output });
    } catch (err) {
      return res.status(refusalStatus(err)).json({ error: String(err && err.message || err) });
    }
  };
}

/**
 * GET /api/v1/dev-backup/:hostId/status — live backup-engine state (running
 * now, last outcome, last archive) straight from the host.
 */
function createDevBackupStatusHandler(deps) {
  const { getServer, invoke, resolveOrgId } = deps;
  return async function devBackupStatusHandler(req, res) {
    const hostId = req.params.hostId;
    if (!requireBackupHost(req, res, getServer, hostId)) return;
    try {
      const output = await invoke({ orgId: resolveOrgId(req), hostId, capability: DEV_BACKUP_CAPABILITY, method: 'status', input: {} });
      return res.json({ host_id: hostId, ...output });
    } catch (err) {
      return res.status(refusalStatus(err)).json({ error: String(err && err.message || err) });
    }
  };
}

/**
 * GET /api/v1/dev-backup/:hostId/archives — the archives the host has
 * registered: {id, path, sha256, size_bytes, created_at}. This is the ONLY
 * source of a valid archive_id for a restore; the collector never composes one.
 */
function createDevBackupArchivesHandler(deps) {
  const { getServer, invoke, resolveOrgId } = deps;
  return async function devBackupArchivesHandler(req, res) {
    const hostId = req.params.hostId;
    if (!requireBackupHost(req, res, getServer, hostId)) return;
    try {
      const output = await invoke({ orgId: resolveOrgId(req), hostId, capability: DEV_BACKUP_CAPABILITY, method: 'archives', input: {} });
      return res.json({ host_id: hostId, ...output });
    } catch (err) {
      return res.status(refusalStatus(err)).json({ error: String(err && err.message || err) });
    }
  };
}

/**
 * POST /api/v1/dev-backup/:hostId/restore — restore a registered archive.
 * Body: {archive_id, dry_run?, stores?}.
 *
 * dry_run is passed through EXACTLY as given and NEVER invented: absent stays
 * absent so the agent's own dry-run-default (true) rules, and a live restore
 * is therefore only ever the result of a caller explicitly sending false. A
 * non-boolean dry_run is a 400 rather than a silent coercion — "dry_run":
 * "false" quietly becoming a real restore is precisely the accident this
 * refuses to allow.
 */
function createDevRestoreDispatchHandler(deps) {
  const { getServer, invoke, resolveOrgId, emitEnvelope } = deps;
  return async function devRestoreDispatchHandler(req, res) {
    const hostId = req.params.hostId;
    const body = req.body || {};
    const archiveId = typeof body.archive_id === 'string' ? body.archive_id.trim() : '';
    if (!archiveId) {
      return res.status(400).json({ error: 'archive_id is required' });
    }
    if (!ARCHIVE_ID_PATTERN.test(archiveId)) {
      return res.status(400).json({ error: 'archive_id must be 1-128 chars of [A-Za-z0-9._-]' });
    }
    if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') {
      return res.status(400).json({ error: 'dry_run must be a boolean when supplied' });
    }
    let stores;
    if (body.stores !== undefined) {
      if (!Array.isArray(body.stores) || body.stores.length === 0) {
        return res.status(400).json({ error: 'stores must be a non-empty array of store names when supplied' });
      }
      stores = body.stores.map((s) => (typeof s === 'string' ? s.trim() : ''));
      if (!stores.every((s) => STORE_NAME_PATTERN.test(s))) {
        return res.status(400).json({ error: 'each store name must be 1-128 chars of [A-Za-z0-9._-]' });
      }
    }
    if (!requireBackupHost(req, res, getServer, hostId, { requireRestore: true })) return;

    const orgId = resolveOrgId(req);
    const input = { archive_id: archiveId, terminal: callerTerminal(req) };
    if (body.dry_run !== undefined) input.dry_run = body.dry_run;
    if (stores) input.stores = stores;

    try {
      const output = await invoke({ orgId, hostId, capability: DEV_RESTORE_CAPABILITY, method: 'dispatch', input });
      if (typeof emitEnvelope === 'function') {
        try {
          emitEnvelope({
            type: 'event',
            from: `agent.${input.terminal}`,
            to: 'audit.backup_queue',
            intent: 'quox.restore.dispatch',
            corr: `RESTORE_DISPATCH_${hostId}_${archiveId}`,
            payload: {
              host_id: hostId,
              archive_id: archiveId,
              // Reported exactly as sent, including absent: the evidence must
              // not claim a dry-run posture the caller never asserted.
              dry_run: input.dry_run === undefined ? null : input.dry_run,
              stores: input.stores || null,
              terminal: input.terminal,
              org_id: orgId,
            },
          });
        } catch { /* evidence is best-effort here */ }
      }
      return res.json({ dispatched: true, host_id: hostId, archive_id: archiveId, ...output });
    } catch (err) {
      return res.status(refusalStatus(err)).json({ error: String(err && err.message || err) });
    }
  };
}

/**
 * GET /api/v1/dev-backup/:hostId/restore-status — live restore-engine state
 * from the host (running now, last outcome, dry-run or real).
 */
function createDevRestoreStatusHandler(deps) {
  const { getServer, invoke, resolveOrgId } = deps;
  return async function devRestoreStatusHandler(req, res) {
    const hostId = req.params.hostId;
    if (!requireBackupHost(req, res, getServer, hostId, { requireRestore: true })) return;
    try {
      const output = await invoke({ orgId: resolveOrgId(req), hostId, capability: DEV_RESTORE_CAPABILITY, method: 'status', input: {} });
      return res.json({ host_id: hostId, ...output });
    } catch (err) {
      return res.status(refusalStatus(err)).json({ error: String(err && err.message || err) });
    }
  };
}

module.exports = {
  DEV_BACKUP_CAPABILITY,
  DEV_RESTORE_CAPABILITY,
  BACKUP_MODES,
  ARCHIVE_ID_PATTERN,
  buildDevBackupEnvelope,
  deliverDevBackupInvoke,
  requireBackupHost,
  createDevBackupDispatchHandler,
  createDevBackupStatusHandler,
  createDevBackupArchivesHandler,
  createDevRestoreDispatchHandler,
  createDevRestoreStatusHandler,
};
