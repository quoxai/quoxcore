/**
 * HYPERION activity (DEVFLEET-P15): one read-only view of what the Proxmox operator is doing.
 *
 *   GET /api/v1/proxmox/activity   (any authenticated org member; org from the verified caller only)
 *
 * Who holds a VM comes from two books: the org's pool store (pool VMs) and Proxmox itself (lane VMs built
 * through the standing grant carry the tag `hyperion`, a `lessee-<name>` tag and a description line
 * `hyperion: lessee=<x> purpose=<y> since=<iso> expires=<iso|none>`). Each part degrades on its own:
 * a Proxmox REST failure yields `nodes_error`, an AEE read failure yields `ops_error`; never a 500.
 */

'use strict';

const OPS_LIMIT = 20;
const CONFIG_CONCURRENCY = 6;
const MAX_LANE_CONFIG_READS = 60;

function parseTags(raw) {
  return String(raw || '').split(/[;,]/).map((t) => t.trim()).filter(Boolean);
}

const DESC_RE = /^hyperion:\s+lessee=(\S+)\s+purpose=(.*?)\s+since=(\S+)\s+expires=(\S+)\s*$/;
/** Defensive parse of the lane description line; null when it is not one of ours. */
function parseHyperionDescription(desc) {
  if (typeof desc !== 'string') return null;
  const line = desc.split('\n').map((l) => l.trim()).find((l) => l.startsWith('hyperion:'));
  if (!line) return null;
  const m = DESC_RE.exec(line.slice(0, 600));
  if (!m) return null;
  return { lessee: m[1], purpose: m[2] || null, since: m[3], expires: m[4] === 'none' ? null : m[4] };
}

async function defaultListResources(orgId) {
  const { pveGet } = require('./proxmoxApi.js');
  const rows = await pveGet('/cluster/resources', undefined, { orgId });
  return Array.isArray(rows) ? rows : [];
}
async function defaultReadVmConfig(orgId, node, vmid) {
  const { pveGet } = require('./proxmoxApi.js');
  return pveGet(`/nodes/${node}/qemu/${vmid}/config`, undefined, { orgId });
}

/**
 * Bastion fallback lister. Like the proxmox tool executors (toolExecutors/proxmox.js readJson): the pvesh-read builtin
 * first (RiskTier safe, fixed path, no shell string), and the raw fixed-literal `pvesh get` only when Bastion does not
 * know the tool. Failure throws. toolRun is injectable for tests.
 */
async function bastionListResources(callBastion, host = 'hyp-01', toolRun) {
  const { runSafeRead } = require('./bastionSafeRead.js');
  const result = await runSafeRead('pvesh-read', host, { path: '/cluster/resources' },
    () => callBastion(host, 'pvesh get /cluster/resources --output-format json'), toolRun ? { toolRun } : {});
  if (!result || !result.success) throw new Error(`Bastion pvesh failed: ${(result && result.error) || 'unknown error'}`);
  const raw = result.output || result.stdout || '';
  if (!String(raw).trim()) throw new Error('Empty response from Bastion pvesh');
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('Failed to parse Bastion pvesh output'); }
  if (!Array.isArray(data)) throw new Error('Bastion pvesh returned an unexpected shape');
  return data;
}

function readRecentOps(aeeDb, orgId, limit = OPS_LIMIT) {
  // envelopes.payload is encrypted at rest, so filter on the org_id column, never json_extract.
  const { decryptField, isEncrypted } = require('../utils/fieldEncryption.js');
  const rs = aeeDb.prepare(
    `SELECT ts, intent, "from" AS actor, payload FROM envelopes
     WHERE intent LIKE 'quox.proxmox.%' AND org_id = ?
     ORDER BY ts DESC LIMIT ?`,
  ).all(orgId, limit);
  return rs.map((r) => {
    let p = {};
    try {
      const text = isEncrypted(r.payload) ? decryptField(r.payload) : r.payload;
      p = JSON.parse(text) || {};
    } catch { /* keep {} : row stays, outcome null */ }
    const outcome = p.outcome !== undefined ? p.outcome : (p.verdict !== undefined ? p.verdict : null);
    return { ts: r.ts, intent: r.intent, vmid: Number.isInteger(p.vmid) ? p.vmid : null, actor: r.actor, outcome };
  });
}

const msg = (e) => String((e && e.message) || e).slice(0, 200);

const { restFallsBack, restFallbackNote } = require('./proxmoxApi.js');

async function buildActivity(orgId, {
  store = require('./proxmoxPoolStore.js'), getPool = () => require('./proxmoxPool.js').getPool(), aeeDb = null,
  listResources = defaultListResources, callBastion = null, bastionToolRun = null, listBastionResources = null, readVmConfig = defaultReadVmConfig, now = () => Date.now(),
} = {}) {
  const out = { nodes: [], vms: [], pool: null, recent_ops: [], generated_at: new Date(now()).toISOString() };

  // Pool part (local, no network)
  let poolRows = [];
  try { poolRows = store.listVms(orgId); } catch (e) { out.pool_error = msg(e); }
  try {
    const s = getPool().status(orgId);
    out.pool = { enabled: !!(s.config && s.config.enabled), counts: s.counts || {}, paused: s.paused || null };
  } catch (e) { out.pool = null; out.pool_error = msg(e); }

  // Cluster part (Proxmox REST)
  let resources = null;
  let bastionMode = false;
  try {
    resources = await listResources(orgId);
    out.nodes_source = 'rest';
  } catch (e) {
    const lister = listBastionResources || (callBastion ? () => bastionListResources(callBastion, 'hyp-01', bastionToolRun) : null);
    if (restFallsBack(e) && lister) {
      try {
        resources = await lister(orgId);
        bastionMode = true;
        out.nodes_source = 'bastion';
        const note = restFallbackNote(e);
        if (note) { out.rest_error = note; console.warn(`[ProxmoxApi] activity REST list refused (HTTP ${e.status}); falling back to Bastion`); }
      } catch (e2) { out.nodes_error = msg(e2); }
    } else out.nodes_error = msg(e);
  }
  const byVmid = new Map();
  if (resources) {
    for (const r of resources) {
      if (r.type === 'node') {
        out.nodes.push({ node: r.node, status: r.status || 'unknown', cpu: r.cpu ?? null, mem_used: r.mem ?? null, mem_total: r.maxmem ?? null });
      } else if (r.type === 'qemu' && Number.isInteger(r.vmid)) byVmid.set(r.vmid, r);
    }
  }

  const vms = [];
  const poolIds = new Set();
  for (const p of poolRows) {
    poolIds.add(p.vmid);
    const live = byVmid.get(p.vmid);
    vms.push({
      vmid: p.vmid, name: (live && live.name) || p.name, node: (live && live.node) || p.node,
      status: live ? live.status : p.state, uptime_s: live && live.uptime !== undefined ? live.uptime : null,
      held_by: { source: 'pool', lessee: p.lessee || null, purpose: p.purpose || null, since: p.leased_at || null, expires: p.lease_expires_at || null },
    });
  }

  const lane = [...byVmid.values()].filter((r) => !poolIds.has(r.vmid) && parseTags(r.tags).includes('hyperion'));
  const laneCapped = lane.slice(0, MAX_LANE_CONFIG_READS);
  let configErrors = 0;
  let next = 0;
  const laneOut = [];
  const worker = async () => {
    while (next < laneCapped.length) {
      const r = laneCapped[next++];
      const tagLessee = (parseTags(r.tags).find((t) => t.startsWith('lessee-')) || '').slice('lessee-'.length) || null;
      let parsed = null;
      if (!bastionMode) {
        try {
          const cfg = await readVmConfig(orgId, r.node, r.vmid);
          parsed = parseHyperionDescription(cfg && cfg.description);
        } catch { configErrors += 1; }
      }
      laneOut.push({
        vmid: r.vmid, name: r.name, node: r.node, status: r.status, uptime_s: r.uptime !== undefined ? r.uptime : null,
        held_by: parsed
          ? { source: 'lane', ...parsed }
          : { source: tagLessee ? 'lane' : 'none', lessee: tagLessee, purpose: null, since: null, expires: null },
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONFIG_CONCURRENCY, laneCapped.length) }, worker));
  vms.push(...laneOut);
  if (configErrors) out.vm_config_errors = configErrors;
  if (lane.length > laneCapped.length) out.vms_truncated = lane.length - laneCapped.length;
  out.vms = vms.sort((a, b) => a.vmid - b.vmid);

  // Ops part (AEE)
  try {
    if (!aeeDb) throw new Error('evidence store unavailable');
    out.recent_ops = readRecentOps(aeeDb, orgId);
  } catch (e) { out.recent_ops = []; out.ops_error = msg(e); }
  return out;
}

function registerProxmoxActivityRoutes(app, { auth, getAeeDb = () => null, ...deps }) {
  app.get('/api/v1/proxmox/activity', auth(), async (req, res) => {
    const orgId = (req.user && (req.user.org_id || req.user.orgId)) || null;
    if (!orgId) return res.status(400).json({ error: 'org_required' });
    try { return res.json(await buildActivity(orgId, { aeeDb: getAeeDb(), ...deps })); } catch (e) {
      console.error('[ProxmoxActivity] route error:', msg(e));
      return res.status(503).json({ error: 'activity_unavailable' });
    }
  });
}

module.exports = { buildActivity, registerProxmoxActivityRoutes, parseHyperionDescription, parseTags, readRecentOps };
