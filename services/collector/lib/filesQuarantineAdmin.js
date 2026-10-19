'use strict';
/**
 * F01 A' (SITE-CLI audit ENG_01M4Z02S830K0X3K61W50K0X3K): quarantine admin for the legacy files store.
 * GET  /api/v1/admin/files/quarantine            files with no proven owner (hidden from every org)
 * POST /api/v1/admin/files/assign {assignments: [{file_id, org_id}]}   owner-approved assignments
 * Only a HUMAN instance admin (isInstanceAdmin: a human session auth confirms) may call either; agents, ordinary
 * members and service callers get 403. Every successful assignment is one audit envelope naming the human actor
 * (AEE, so WARD-witnessed). The files service refuses to re-assign a file that already has an owner (409).
 */
const MAX = 500;

function makeFilesQuarantineHandlers({ checkInstanceAdmin, isInstanceAdmin, filesCall, audit }) {
  // checkInstanceAdmin answers 'yes' | 'no' | 'unavailable'; isInstanceAdmin (boolean) is the older shape.
  const check = checkInstanceAdmin || (async (req) => ((await isInstanceAdmin(req)) ? 'yes' : 'no'));
  const gate = async (req, res) => {
    const v = await check(req);
    if (v === 'yes') return true;
    if (v === 'unavailable') res.status(503).json({ error: 'instance_admin_check_unavailable', message: 'Could not confirm instance admin with the auth service. Nothing was changed; try again.' });
    else res.status(403).json({ error: 'instance_admin_required' });
    return false;
  };
  return {
    async list(req, res) {
      if (!(await gate(req, res))) return;
      const r = await filesCall('GET', '/admin/quarantine');
      if (r.status !== 200) return res.status(502).json({ error: 'files_service', status: r.status });
      return res.json({ files: (r.json && r.json.files) || [] });
    },
    async assign(req, res) {
      if (!(await gate(req, res))) return;
      const list = req.body && req.body.assignments;
      const valid = Array.isArray(list) && list.length > 0 && list.length <= MAX
        && list.every((a) => a && typeof a.file_id === 'string' && a.file_id && typeof a.org_id === 'string' && a.org_id);
      if (!valid) return res.status(400).json({ error: `assignments: 1..${MAX} items of {file_id, org_id}` });
      const actor = req.user && req.user.id;
      const results = [];
      for (const a of list) {
        const r = await filesCall('POST', '/admin/assign', { fileId: a.file_id, orgId: a.org_id, actor });
        if (r.status === 200) {
          try {
            audit({ intent: 'quox.files.quarantine.assigned', org_id: a.org_id, payload: { file_id: a.file_id, org_id: a.org_id, actor_user_id: actor } });
          } catch { /* evidence never blocks; the files service also recorded it */ }
          results.push({ file_id: a.file_id, org_id: a.org_id, ok: true });
        } else {
          results.push({ file_id: a.file_id, org_id: a.org_id, ok: false, status: r.status, error: (r.json && r.json.error) || null });
        }
      }
      return res.json({ results });
    },
  };
}

module.exports = { makeFilesQuarantineHandlers };
