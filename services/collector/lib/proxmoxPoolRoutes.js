/**
 * Proxmox VM pool routes (DEVFLEET-P10).
 *
 *   GET  /api/v1/proxmox/pool                  status: config, counts, VMs      (any authenticated org member)
 *   GET  /api/v1/proxmox/rehearsals/:id        a rehearsal record (any authenticated org member, own org only)
 *   GET  /api/v1/proxmox/doctor/:target        VM Doctor: read-only diagnosis of a VM by name or vmid (any authenticated org member)
 *   GET  /api/v1/proxmox/doctor/reports/:id    a stored VM Doctor report (own org only)
 *   POST /api/v1/proxmox/pool/lease            201 {lease} for a warm VM, 202 {vmid,state:'building'} when built to order (poll GET). { lessee, ssh_pubkey, cores?, memory_gb?, disk_gb?, ttl_h?, purpose?, require_avx2?, node? }  (human)
 *   POST /api/v1/proxmox/pool/:vmid/release    202 recycling now, destroy + re-warm in background (human)
 *   GET  /api/v1/proxmox/pool/config           the org's pool settings           (any authenticated org member)
 *   PUT  /api/v1/proxmox/pool/config           settings write                    (HUMAN org admin only)
 *
 * The org ALWAYS comes from the verified caller (req.user), never from the body or query.
 * Each route is behind the collector default-deny gate AND its own auth() (no allowlist entry).
 * Host commands run through the governed ssh_exec boundary (lib/proxmoxPool.js), so the org's
 * standing grant / HITL decides what actually executes; these routes add no authorization of
 * their own beyond who may ask.
 */

'use strict';

const { PoolError } = require('./proxmoxPool.js');

const STATUS = {
  bad_request: 400, out_of_range: 400, not_found: 404, pool_disabled: 409, pool_full: 409, busy: 409,
  no_free_vmid: 409, no_avx2_lane: 409, pending_approval: 202,
};

function userOrg(req) {
  return (req.user && (req.user.org_id || req.user.orgId)) || null;
}

function actor(req) {
  return String((req.user && (req.user.id || req.user.sub)) || 'unknown');
}

function fail(res, e) {
  if (e instanceof PoolError) {
    return res.status(STATUS[e.code] || 502).json({ error: e.code, message: e.message, ...(e.approvalId ? { approval_id: e.approvalId } : {}) });
  }
  console.error('[ProxmoxPool] route error:', e && e.message);
  return res.status(503).json({ error: 'pool_unavailable' });
}

function registerProxmoxPoolRoutes(app, { auth, requireHumanAdmin, requireHumanActor, getPool = () => require('./proxmoxPool.js').getPool(), getRehearsals = () => require('./proxmoxRehearseStore.js'), getDoctor = () => require('./proxmoxDoctor.js'), getDoctorStore = () => require('./proxmoxDoctorStore.js') }) {
  const orgOr400 = (req, res) => {
    const o = userOrg(req);
    if (!o) { res.status(400).json({ error: 'org_required' }); return null; }
    return o;
  };

  app.get('/api/v1/proxmox/pool/config', auth(), (req, res) => {
    const orgId = orgOr400(req, res); if (!orgId) return undefined;
    try { return res.json({ config: getPool().store.getConfig(orgId) }); } catch (e) { return fail(res, e); }
  });

  app.put('/api/v1/proxmox/pool/config', auth(), (req, res) => {
    if (!requireHumanAdmin(req, res, 'Only a human org admin can change the VM pool settings')) return undefined;
    const orgId = orgOr400(req, res); if (!orgId) return undefined;
    try { return res.json({ config: getPool().configure(orgId, req.body || {}, actor(req)) }); } catch (e) { return fail(res, e); }
  });

  app.get('/api/v1/proxmox/pool', auth(), async (req, res) => {
    const orgId = orgOr400(req, res); if (!orgId) return undefined;
    try { return res.json(await getPool().statusFresh(orgId)); } catch (e) { return fail(res, e); }
  });

  // DEVFLEET-P15: a rehearsal record (verdict, health diff, output tail). Org from the verified caller only.
  app.get('/api/v1/proxmox/rehearsals/:id', auth(), (req, res) => {
    const orgId = orgOr400(req, res); if (!orgId) return undefined;
    const id = String(req.params.id || '');
    if (!/^RH_[0-9A-F]{16}$/.test(id)) return res.status(400).json({ error: 'bad_request', message: 'rehearsal id must look like RH_ followed by 16 hex characters' });
    try {
      const rec = getRehearsals().get(orgId, id);
      return rec ? res.json({ rehearsal: rec }) : res.status(404).json({ error: 'not_found' });
    } catch (e) { return fail(res, e); }
  });

  // DEVFLEET-DOCTOR: VM Doctor. Read only. Org from the verified caller only; a stored report is only
  // ever returned to the org that owns it. Registered before /doctor/:target (different depth, but explicit).
  app.get('/api/v1/proxmox/doctor/reports/:id', auth(), (req, res) => {
    const orgId = orgOr400(req, res); if (!orgId) return undefined;
    const id = String(req.params.id || '');
    if (!/^DR_[0-9A-F]{16}$/.test(id)) return res.status(400).json({ error: 'bad_request', message: 'report id must look like DR_ followed by 16 hex characters' });
    try {
      const rec = getDoctorStore().get(orgId, id);
      return rec ? res.json({ success: true, report: rec }) : res.status(404).json({ error: 'not_found' });
    } catch (e) { return fail(res, e); }
  });

  app.get('/api/v1/proxmox/doctor/:target', auth(), async (req, res) => {
    const orgId = orgOr400(req, res); if (!orgId) return undefined;
    const target = String(req.params.target || '').trim();
    if (!target || target.length > 128) return res.status(400).json({ error: 'bad_request', message: 'target (VM name or vmid) is required' });
    try {
      const out = await getDoctor().diagnose(orgId, { target }, { actor: actor(req) });
      if (out.success) return res.json({ success: true, report: out.report });
      const status = { missing_target: 400, not_found: 404, ambiguous: 409, unsupported_type: 422 }[out.error] || (out.code === 'not_configured' ? 503 : 502);
      return res.status(status).json({ success: false, error: out.error, detail: out.detail, ...(out.candidates ? { candidates: out.candidates } : {}) });
    } catch (e) { return fail(res, e); }
  });

  app.post('/api/v1/proxmox/pool/lease', auth(), async (req, res) => {
    if (!requireHumanActor(req, res, 'Leasing a pool VM requires a human caller')) return undefined;
    const orgId = orgOr400(req, res); if (!orgId) return undefined;
    try {
      const r = await getPool().leaseOrStart(orgId, req.body || {}, actor(req));
      // A made-to-order build takes minutes: 202 now, poll GET /api/v1/proxmox/pool for state 'leased'.
      if (r.building) return res.status(202).json({ vmid: r.building.vmid, state: 'building', poll: '/api/v1/proxmox/pool' });
      return res.status(201).json({ lease: r.lease });
    } catch (e) { return fail(res, e); }
  });

  app.post('/api/v1/proxmox/pool/:vmid/release', auth(), async (req, res) => {
    if (!requireHumanActor(req, res, 'Releasing a pool VM requires a human caller')) return undefined;
    const orgId = orgOr400(req, res); if (!orgId) return undefined;
    const vmid = /^\d{1,9}$/.test(String(req.params.vmid)) ? Number(req.params.vmid) : NaN;
    // 202: the VM is out of the lessee's hands now (recycling); the destroy finishes in the background. Poll status.
    try { return res.status(202).json({ ...getPool().releaseStart(orgId, vmid, actor(req)), poll: '/api/v1/proxmox/pool' }); } catch (e) { return fail(res, e); }
  });
}

module.exports = { registerProxmoxPoolRoutes };
