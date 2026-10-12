/**
 * qlusterBackupProxy.js — Qluster Phase 4 box-side backup access proxy.
 *
 * The external Qluster fleet controller never touches the auth service's DB
 * or its user-scoped /orgs/:orgId/backups routes directly. Instead it hits
 * these collector routes (gated by requireQlusterScope in server.js), which
 * proxy to the auth service's INTERNAL (X-Service-Key gated) backups routes:
 *
 *   GET  /api/v1/qluster/backups?org_id=      (scope node.read)
 *        → GET  {auth}/api/internal/backups?org_id=
 *   POST /api/v1/qluster/backups/trigger      (scope backup.trigger, signed)
 *        → POST {auth}/api/internal/backups/trigger   + AEE audit
 *   GET  /api/v1/qluster/backups/:id/download (scope backup.download, signed)
 *        → stream {auth}/api/internal/backups/:id/download + AEE audit
 *
 * Operational routes (trigger/download) record an AEE envelope via the
 * collector's storeAuditEnvelope (NEVER POST /aee/store — see server.js:2554
 * / docs/PLAN.md appendix), from `qluster:<controller_id>`.
 *
 * Handlers are dependency-injected factories (fetchImpl, audit, authBaseUrl,
 * serviceKey) so they unit-test without a live auth service or server.js.
 */

function authBase(deps) {
  return (deps.authBaseUrl || process.env.AUTH_SERVICE_URL || 'http://auth:3101').replace(/\/$/, '');
}
function serviceKeyOf(deps) {
  return deps.serviceKey || process.env.INTERNAL_SERVICE_KEY || '';
}
function fetchOf(deps) {
  return deps.fetchImpl || global.fetch;
}
function auditOf(deps) {
  return typeof deps.audit === 'function' ? deps.audit : () => {};
}

function controllerId(req) {
  return req.qlusterController?.id || 'unknown';
}
// Org binding declared at enrollment. Empty ⇒ deny-all for backups
// (fail-closed) — the controller may still do node.read health.
function allowedOrgsOf(req) {
  const a = req.qlusterController?.allowed_orgs;
  return Array.isArray(a) ? a : [];
}
function corrFor(id) {
  return `QLUSTER_${id}_${Date.now()}`;
}

// Pipe a fetch Response body (web ReadableStream or Node stream) to res,
// counting bytes. Returns total bytes written.
async function streamBody(response, res) {
  let bytes = 0;
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      bytes += buf.length;
      res.write(buf);
    }
  } else if (body && typeof body.on === 'function') {
    await new Promise((resolve, reject) => {
      body.on('data', (chunk) => {
        const buf = Buffer.from(chunk);
        bytes += buf.length;
        res.write(buf);
      });
      body.on('end', resolve);
      body.on('error', reject);
    });
  } else {
    // Fallback: buffer the whole thing.
    const ab = await response.arrayBuffer();
    const buf = Buffer.from(ab);
    bytes += buf.length;
    res.write(buf);
  }
  res.end();
  return bytes;
}

// ─── GET /api/v1/qluster/backups (node.read) ──────────────────────────────
function createBackupsListHandler(deps = {}) {
  return async function backupsListHandler(req, res) {
    try {
      const orgId = req.query?.org_id;
      // org_id is REQUIRED — no "omit → every org" behavior (cross-tenant leak).
      if (!orgId) return res.status(400).json({ error: 'org_id_required' });
      const allowed = allowedOrgsOf(req);
      if (!allowed.includes(String(orgId))) {
        return res.status(403).json({ error: 'org_not_allowed' });
      }
      const base = authBase(deps);
      // Pass the allowed set to auth too (defense in depth).
      const url = `${base}/api/internal/backups?org_id=${encodeURIComponent(orgId)}&allowed_orgs=${encodeURIComponent(allowed.join(','))}`;
      const r = await fetchOf(deps)(url, { headers: { 'X-Service-Key': serviceKeyOf(deps) } });
      const data = await r.json().catch(() => null);
      return res.status(r.status).json(data);
    } catch (err) {
      return res.status(502).json({ error: 'auth_unreachable', detail: err.message });
    }
  };
}

// ─── POST /api/v1/qluster/backups/trigger (backup.trigger, signed) ────────
function createBackupTriggerHandler(deps = {}) {
  return async function backupTriggerHandler(req, res) {
    const cid = controllerId(req);
    try {
      const orgId = req.body?.org_id;
      if (!orgId) return res.status(400).json({ error: 'org_id_required' });
      const allowed = allowedOrgsOf(req);
      if (!allowed.includes(String(orgId))) {
        return res.status(403).json({ error: 'org_not_allowed' });
      }
      const base = authBase(deps);
      const r = await fetchOf(deps)(`${base}/api/internal/backups/trigger`, {
        method: 'POST',
        headers: { 'X-Service-Key': serviceKeyOf(deps), 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId }),
      });
      const data = await r.json().catch(() => null);
      try {
        auditOf(deps)({
          type: 'event',
          from: `qluster:${cid}`,
          to: 'audit.system',
          intent: 'qluster.backup.trigger',
          corr: corrFor(cid),
          payload: {
            org_id: orgId,
            backup_id: data?.backup?.id || null,
            status: r.status,
          },
        });
      } catch { /* audit must never fail the request */ }
      return res.status(r.status).json(data);
    } catch (err) {
      return res.status(502).json({ error: 'auth_unreachable', detail: err.message });
    }
  };
}

// ─── GET /api/v1/qluster/backups/:id/download (backup.download, signed) ────
function createBackupDownloadHandler(deps = {}) {
  return async function backupDownloadHandler(req, res) {
    const cid = controllerId(req);
    const id = req.params.id;
    try {
      // Fail-closed: no org binding ⇒ no cross-tenant archive access.
      const allowed = allowedOrgsOf(req);
      if (!allowed.length) return res.status(403).json({ error: 'org_not_allowed' });
      const base = authBase(deps);
      // Auth resolves the backup's org and 403s BEFORE opening the stream —
      // the archive is never streamed until the org check passes.
      const url = `${base}/api/internal/backups/${encodeURIComponent(id)}/download?allowed_orgs=${encodeURIComponent(allowed.join(','))}`;
      const r = await fetchOf(deps)(url, {
        headers: { 'X-Service-Key': serviceKeyOf(deps) },
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({ error: 'download_failed' }));
        return res.status(r.status).json(data);
      }
      const cl = r.headers?.get?.('content-length');
      if (cl) res.setHeader('Content-Length', cl);
      res.setHeader('Content-Type', r.headers?.get?.('content-type') || 'application/gzip');
      const cd = r.headers?.get?.('content-disposition');
      if (cd) res.setHeader('Content-Disposition', cd);
      res.status(200);
      const bytes = await streamBody(r, res);
      try {
        auditOf(deps)({
          type: 'event',
          from: `qluster:${cid}`,
          to: 'audit.system',
          intent: 'qluster.backup.download',
          corr: corrFor(cid),
          payload: { backup_id: id, bytes },
        });
      } catch { /* audit must never fail the request */ }
    } catch (err) {
      if (!res.headersSent) {
        return res.status(502).json({ error: 'auth_unreachable', detail: err.message });
      }
      try { res.end(); } catch { /* ignore */ }
    }
  };
}

module.exports = {
  streamBody,
  createBackupsListHandler,
  createBackupTriggerHandler,
  createBackupDownloadHandler,
};
