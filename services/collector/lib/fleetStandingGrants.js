'use strict';

/**
 * Fleet standing grants (owner decision 2026-10-13, zero-to-hero test VM lane).
 *
 * An org admin pre-approves ONE host + an anchored command-regex allowlist + a
 * VMID range + an expiry for ssh_exec. A call the grant covers runs without a
 * per-command HITL approval; EVERYTHING else (another host, another command
 * shape, a VMID outside the range, an expired or revoked grant, another org)
 * falls through to the normal approval gate unchanged.
 *
 * Containment is structural, not a denylist:
 *   - every pattern is compiled fully anchored (^...$), no flags, so a covered
 *     command can never carry a `;`, `&&`, `$(` or newline tail;
 *   - every named group starting with `vmid` must parse into [vmid_min, vmid_max],
 *     and a range may not contain the template it clones from;
 *   - a guest payload is only ever a single-quoted string with no quote inside,
 *     so the HOST shell treats it as one literal argument (it runs in the guest);
 *   - \0 and \r are refused outright.
 *
 * Evidence: create / use / revoke each emit an AEE envelope (setEmitter wires
 * storeAuditEnvelope); each use also lands as an `approved` tool_approvals row
 * (written by the ssh_exec executor) so it shows in approvals history.
 * The bastion still needs an X-Bastion-Approval-Grant per call: auth signs it
 * only after re-validating THIS grant by keyed callback (checkGrant).
 */

const crypto = require('crypto');

const TOOLS = new Set(['ssh_exec']);
const MAX_DAYS = 30;
const MAX_PATTERNS = 32;
const MAX_COMMAND = 16384;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const PREFIX_RE = /^[a-z][a-z0-9]{1,15}$/;
const LITERAL_RE = /^[A-Za-z0-9 ._/=-]+$/;

let _db = null;
let _emit = () => {};

function ensure(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fleet_standing_grants (
      grant_id      TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL,
      tool          TEXT NOT NULL,
      host          TEXT NOT NULL,
      patterns_json TEXT NOT NULL,
      preset        TEXT,
      vmid_min      INTEGER,
      vmid_max      INTEGER,
      expires_at    INTEGER NOT NULL,
      created_by    TEXT NOT NULL,
      reason        TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      revoked_at    INTEGER,
      revoked_by    TEXT,
      use_count     INTEGER NOT NULL DEFAULT 0,
      last_used_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_fleet_standing_grants_org ON fleet_standing_grants(org_id, host);
  `);
  // DEVFLEET-P15 (ephemeral rehearsal grants): optional caps. NULL = the old behaviour, so every
  // existing grant is unaffected. max_uses bounds how many calls the grant may cover; vmid_allow_json
  // is an explicit VMID allowlist (the range model cannot express {target, twin}); source_approval_id
  // names the human approval that minted it.
  const have = new Set(db.prepare('PRAGMA table_info(fleet_standing_grants)').all().map((c) => c.name));
  if (!have.has('max_uses')) db.exec('ALTER TABLE fleet_standing_grants ADD COLUMN max_uses INTEGER');
  if (!have.has('vmid_allow_json')) db.exec('ALTER TABLE fleet_standing_grants ADD COLUMN vmid_allow_json TEXT');
  if (!have.has('source_approval_id')) db.exec('ALTER TABLE fleet_standing_grants ADD COLUMN source_approval_id TEXT');
  _db = db;
}

function requireDb() {
  if (!_db) throw new Error('fleetStandingGrants.ensure(db) must be called before use');
  return _db;
}

function setEmitter(fn) { _emit = typeof fn === 'function' ? fn : () => {}; }

function emit(intent, orgId, actor, payload, fromOverride) {
  try {
    _emit({
      type: 'event',
      from: fromOverride || (actor ? `human.${actor}` : 'system.collector'),
      to: 'system.approvals',
      intent,
      corr: payload.grant_id,
      payload: { orgId, org_id: orgId, ...payload },
    });
  } catch { /* evidence never blocks */ }
}

/**
 * The Proxmox throwaway-VM lane: clone from ONE template into a VMID range,
 * power/config/destroy those VMs, run payloads inside them via the guest agent,
 * plus read-only `qm list` and the template's config. Nothing else on the host.
 */
function proxmoxTestVmLane({ templateVmid, namePrefix }) {
  const T = String(templateVmid);
  const P = namePrefix;
  const ID = '(?<vmid>\\d{1,9})';
  const DETACH = `(?:systemd-run --collect --unit ${P}-[a-z0-9-]{1,40} )?`;
  // DEVFLEET-P15: Proxmox itself is the book of who holds a lane VM. Tags are [a-z0-9_-] items split by
  // commas; the description is ONE single-quoted argument of plain text (no quote, newline or shell metachar).
  const TAGS = '[a-z0-9_-]{1,40}(?:,[a-z0-9_-]{1,40}){0,9}';
  const DESC = "'[A-Za-z0-9 .,:=_/@+-]{1,300}'";
  return [
    'qm list',
    `qm config ${T}`,
    `${DETACH}qm clone ${T} ${ID} --name ${P}-[a-z0-9-]{1,40}(?: --full)?(?: --storage [a-z0-9-]{1,40})?`,
    `qm set ${ID}(?: --(?:cores|sockets|memory|balloon|cpu|onboot|agent|name|net0|ipconfig0) [A-Za-z0-9=,._:/-]{1,80})+`,
    `qm set ${ID} --tags ${TAGS}`,
    `qm set ${ID} --description ${DESC}`,
    `qm set ${ID} --tags ${TAGS} --description ${DESC}`,
    `qm resize ${ID} (?:scsi|virtio|sata)0 \\+?\\d{1,4}G`,
    `qm (?:start|status|config|stop|reboot|reset|pending) ${ID}`,
    `qm shutdown ${ID}(?: --timeout \\d{1,4})?`,
    `qm destroy ${ID}(?: --purge)?`,
    `qm guest cmd ${ID} (?:ping|network-get-interfaces|get-osinfo|info|get-host-name)`,
    `${DETACH}qm guest exec ${ID}(?: --timeout \\d{1,5})? -- bash -c '[^']*'`,
    `qm guest exec-status ${ID} \\d{1,10}`,
  ];
}

const PRESETS = { 'proxmox-test-vm-lane': proxmoxTestVmLane };

/** Regex-escape a literal so the anchored compile() matches exactly that string and nothing else. */
function escapeRe(str) { return String(str).replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&'); }

function compile(p) { return new RegExp(`^(?:${p})$`); }

/** True when every ( has a matching ) and no ) is stray (escapes and [...] classes skipped). */
function parensBalanced(p) {
  let depth = 0; let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth < 0) return false; }
  }
  return depth === 0 && !inClass;
}

const META = [';', '&', '|', '`', '$(', '\n', '>', '<', '&&', '||'];
/** Probe commands a custom pattern must NOT cover: shell-metachar tails/heads and arbitrary prefixes. */
function probeStrings(vmidMin, vmidMax) {
  const probes = ['rm -rf /; ', 'rm -rf /; echo 9100', 'echo 9100; rm -rf /', 'rm -rf /', 'x', ''];
  const ids = [9100];
  if (Number.isInteger(vmidMin)) ids.push(vmidMin);
  if (Number.isInteger(vmidMax)) ids.push(vmidMax);
  for (const id of ids) {
    probes.push(`rm -rf /; echo ${id}`, `echo ${id}; rm -rf /`, `rm -rf / ${id}`);
    for (const m of META) probes.push(`rm -rf / ${m} qm start ${id}`, `qm start ${id} ${m} rm -rf /`, `qm start ${id}${m}x`);
  }
  for (const m of META) probes.push(`x ${m} y`, `${m}`, `qm list ${m} rm -rf /`, `rm -rf / ${m} qm list`);
  return probes;
}

function hasVmidGroup(p) { return /\(\?<vmid[A-Za-z0-9]*>/.test(p); }

/** validateGrant(body) -> { ok } | { error } */
function validateGrant(b = {}) {
  const tool = b.tool || 'ssh_exec';
  if (!TOOLS.has(tool)) return { error: 'tool must be ssh_exec' };
  const host = typeof b.host === 'string' ? b.host.trim() : '';
  if (!HOST_RE.test(host)) return { error: 'host must be one concrete host id' };
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (reason.length < 8 || reason.length > 500) return { error: 'reason is required (8-500 characters)' };
  const exact = b.exact_commands !== undefined && b.exact_commands !== null;
  let expiresAt;
  if (exact) {
    // Ephemeral exact-scope grant (rehearsal twins): minutes, not days, and literal commands only.
    const mins = Number(b.expires_in_minutes);
    if (!Number.isFinite(mins) || mins <= 0 || mins > 120) return { error: 'expires_in_minutes must be > 0 and <= 120 for an exact-command grant' };
    expiresAt = Date.now() + Math.round(mins * 60000);
  } else {
    const days = Number(b.expires_in_days);
    if (!Number.isFinite(days) || days <= 0 || days > MAX_DAYS) return { error: `expires_in_days must be > 0 and <= ${MAX_DAYS} (expiry)` };
    expiresAt = Date.now() + Math.round(days * 86400000);
  }
  let maxUses = null;
  if (b.max_uses !== undefined && b.max_uses !== null) {
    maxUses = Number(b.max_uses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 500) return { error: 'max_uses must be an integer from 1 to 500' };
  }
  let vmidAllow = null;
  if (b.vmid_allow !== undefined && b.vmid_allow !== null) {
    if (!Array.isArray(b.vmid_allow) || b.vmid_allow.length < 1 || b.vmid_allow.length > 8
      || b.vmid_allow.some((n) => !Number.isInteger(n) || n < 100 || n > 999999999)) {
      return { error: 'vmid_allow must be 1-8 integers >= 100' };
    }
    vmidAllow = [...new Set(b.vmid_allow)].sort((x, y) => x - y);
  }
  let sourceApproval = null;
  if (b.source_approval_id !== undefined && b.source_approval_id !== null) {
    if (typeof b.source_approval_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(b.source_approval_id)) return { error: 'source_approval_id is malformed' };
    sourceApproval = b.source_approval_id;
  }

  let vmidMin = null; let vmidMax = null;
  if (b.vmid_min !== undefined || b.vmid_max !== undefined) {
    vmidMin = Number(b.vmid_min); vmidMax = Number(b.vmid_max);
    if (!Number.isInteger(vmidMin) || !Number.isInteger(vmidMax) || vmidMin < 100 || vmidMax < vmidMin || vmidMax - vmidMin > 999) {
      return { error: 'vmid_min/vmid_max must be integers >= 100, min <= max, span <= 1000' };
    }
  }

  let patterns; let preset = null;
  if (exact) {
    if (b.preset || b.patterns) return { error: 'exact_commands cannot be combined with preset or patterns' };
    if (vmidMin !== null) return { error: 'exact_commands use vmid_allow, not a vmid range' };
    if (!Array.isArray(b.exact_commands) || b.exact_commands.length < 1 || b.exact_commands.length > 40) return { error: 'exact_commands must be 1-40 commands' };
    const seen = new Set(); patterns = [];
    for (const c of b.exact_commands) {
      if (typeof c !== 'string' || !c.trim() || c.length > MAX_COMMAND || /[\x00-\x1f\x7f]/.test(c)) return { error: 'each exact command must be a non-empty single-line string' };
      if (!seen.has(c)) { seen.add(c); patterns.push(escapeRe(c)); }
    }
  } else if (b.preset !== undefined && b.preset !== null) {
    if (!PRESETS[b.preset]) return { error: `unknown preset (known: ${Object.keys(PRESETS).join(', ')})` };
    const tv = Number(b.template_vmid);
    if (!Number.isInteger(tv) || tv < 100) return { error: 'template_vmid is required for this preset' };
    if (vmidMin === null) return { error: 'vmid_min/vmid_max are required for this preset' };
    if (tv >= vmidMin && tv <= vmidMax) return { error: 'the VMID range must not contain the template' };
    const namePrefix = typeof b.name_prefix === 'string' ? b.name_prefix : '';
    if (!PREFIX_RE.test(namePrefix)) return { error: 'name_prefix must be 2-16 lowercase letters/digits' };
    patterns = PRESETS[b.preset]({ templateVmid: tv, namePrefix });
    preset = b.preset;
  } else {
    if (!Array.isArray(b.patterns) || b.patterns.length === 0 || b.patterns.length > MAX_PATTERNS) {
      return { error: `patterns must be a non-empty array (max ${MAX_PATTERNS})` };
    }
    patterns = [];
    for (const p of b.patterns) {
      if (typeof p !== 'string' || !p || p.length > 600) return { error: 'each pattern must be a non-empty string' };
      if (!parensBalanced(p)) return { error: `pattern has unbalanced parentheses: ${p}` };
      let re;
      try { re = compile(p); } catch (e) { return { error: `pattern does not compile: ${p}` }; }
      if (probeStrings(vmidMin, vmidMax).some((s) => re.test(s))) {
        return { error: `pattern is too broad (matches shell metacharacters or an arbitrary prefix): ${p}` };
      }
      if (vmidMin !== null && !hasVmidGroup(p) && !LITERAL_RE.test(p)) {
        return { error: `pattern needs a (?<vmid>...) group when a VMID range is set (or must be an exact literal): ${p}` };
      }
      patterns.push(p);
    }
  }
  return {
    ok: { tool, host, reason, patterns, preset, vmid_min: vmidMin, vmid_max: vmidMax, expires_at: expiresAt, max_uses: maxUses, vmid_allow: vmidAllow, source_approval_id: sourceApproval },
  };
}

function rowToGrant(r) {
  return {
    grant_id: r.grant_id, org_id: r.org_id, tool: r.tool, host: r.host, preset: r.preset,
    patterns: JSON.parse(r.patterns_json), vmid_min: r.vmid_min, vmid_max: r.vmid_max,
    expires_at: new Date(r.expires_at).toISOString(), created_by: r.created_by, reason: r.reason,
    created_at: new Date(r.created_at).toISOString(),
    revoked_at: r.revoked_at ? new Date(r.revoked_at).toISOString() : null, revoked_by: r.revoked_by || null,
    use_count: r.use_count, last_used_at: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    max_uses: r.max_uses === undefined ? null : r.max_uses,
    vmid_allow: r.vmid_allow_json ? JSON.parse(r.vmid_allow_json) : null,
    source_approval_id: r.source_approval_id || null,
  };
}

function createGrant(orgId, v, createdBy) {
  if (!orgId) throw new Error('createGrant requires orgId');
  if (!createdBy) throw new Error('createGrant requires createdBy');
  const id = `SGR_${crypto.randomBytes(10).toString('hex')}`;
  const t = Date.now();
  requireDb().prepare(`
    INSERT INTO fleet_standing_grants (grant_id, org_id, tool, host, patterns_json, preset, vmid_min, vmid_max, expires_at, created_by, reason, created_at, max_uses, vmid_allow_json, source_approval_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, orgId, v.tool, v.host, JSON.stringify(v.patterns), v.preset, v.vmid_min, v.vmid_max, v.expires_at, createdBy, v.reason, t,
    v.max_uses ?? null, v.vmid_allow ? JSON.stringify(v.vmid_allow) : null, v.source_approval_id ?? null);
  const g = getGrant(orgId, id);
  emit('quox.approval.standing_grant.created', orgId, createdBy, {
    grant_id: id, tool: v.tool, host: v.host, preset: v.preset, vmid_min: v.vmid_min, vmid_max: v.vmid_max,
    expires_at: g.expires_at, reason: v.reason, pattern_count: v.patterns.length,
    max_uses: g.max_uses, vmid_allow: g.vmid_allow, source_approval_id: g.source_approval_id,
  });
  return g;
}

function getRow(orgId, grantId) {
  return requireDb().prepare('SELECT * FROM fleet_standing_grants WHERE org_id = ? AND grant_id = ?').get(orgId, grantId) || null;
}

function getGrant(orgId, grantId) { const r = getRow(orgId, grantId); return r ? rowToGrant(r) : null; }

function listGrants(orgId, { includeInactive = false } = {}) {
  const rows = requireDb().prepare('SELECT * FROM fleet_standing_grants WHERE org_id = ? ORDER BY created_at DESC').all(orgId);
  const now = Date.now();
  return rows.filter((r) => includeInactive || (!r.revoked_at && r.expires_at > now)).map(rowToGrant);
}

function revokeGrant(orgId, grantId, revokedBy) {
  const r = getRow(orgId, grantId);
  if (!r) return null;
  if (!r.revoked_at) {
    requireDb().prepare('UPDATE fleet_standing_grants SET revoked_at = ?, revoked_by = ? WHERE org_id = ? AND grant_id = ?')
      .run(Date.now(), revokedBy || null, orgId, grantId);
    emit('quox.approval.standing_grant.revoked', orgId, revokedBy, { grant_id: grantId, host: r.host, tool: r.tool, use_count: r.use_count });
  }
  return getGrant(orgId, grantId);
}

/** Does this one grant row cover (tool, host, command) right now? -> reason string | null (null = covered). */
function whyNot(r, { tool, host, command, now, afterUse = false }) {
  if (!r) return 'no such grant';
  if (r.revoked_at) return 'grant revoked';
  if (r.expires_at <= now) return 'grant expired';
  // max_uses: coversCall runs BEFORE recordUse, the auth mint callback (checkGrant) AFTER it for the
  // same call, so the callback tolerates use_count == max_uses and only refuses beyond it.
  if (r.max_uses !== null && r.max_uses !== undefined && (afterUse ? r.use_count > r.max_uses : r.use_count >= r.max_uses)) return 'grant exhausted (max_uses reached)';
  if (r.tool !== tool) return 'tool not covered';
  if (r.host !== host) return 'host not covered';
  if (typeof command !== 'string' || !command || command.length > MAX_COMMAND) return 'command missing or too long';
  if (/[\x00-\x1f\x7f]/.test(command)) return 'command contains a control character';
  for (const p of JSON.parse(r.patterns_json)) {
    let m;
    try { m = compile(p).exec(command); } catch { continue; }
    if (!m) continue;
    const groups = m.groups || {};
    const ids = Object.keys(groups).filter((k) => k.startsWith('vmid') && groups[k] !== undefined);
    if (r.vmid_allow_json) {
      const allow = JSON.parse(r.vmid_allow_json);
      // An explicit VMID allowlist: every captured VMID must be on it, and a pattern with no VMID
      // group only counts when it is an exact escaped literal of this very command.
      if (!ids.every((k) => allow.includes(Number(groups[k])))) continue;
      if (ids.length === 0 && p !== escapeRe(command)) continue;
    }
    if (r.vmid_min !== null && r.vmid_min !== undefined) {
      if (ids.length === 0 && !LITERAL_RE.test(p)) continue;
      const inRange = ids.every((k) => { const n = Number(groups[k]); return Number.isInteger(n) && n >= r.vmid_min && n <= r.vmid_max; });
      if (!inRange) continue;
    }
    return null;
  }
  return 'command not covered';
}

/** coversCall({orgId, tool, host, command, now}) -> grant | null. Org comes from trusted ctx only. */
function coversCall({ orgId, tool, host, command, now = Date.now() }) {
  if (!orgId || !host) return null;
  let rows;
  try {
    rows = requireDb().prepare('SELECT * FROM fleet_standing_grants WHERE org_id = ? AND host = ? AND revoked_at IS NULL AND expires_at > ?').all(orgId, host, now);
  } catch { return null; }
  for (const r of rows) if (whyNot(r, { tool, host, command, now }) === null) return rowToGrant(r);
  return null;
}

/** The auth mint callback: re-validate ONE named grant. -> { allowed, reason? } */
function checkGrant({ orgId, grantId, host, command, tool = 'ssh_exec', now = Date.now(), targets, resolvedHost }) {
  if (!orgId || !grantId) return { allowed: false, reason: 'org_id and grant_id are required' };
  // The signed grant binds `targets`; it must be exactly the one host this call resolves to.
  if (!Array.isArray(targets) || targets.length !== 1 || !resolvedHost || targets[0] !== resolvedHost) {
    return { allowed: false, reason: 'targets must be exactly the resolved grant host' };
  }
  const why = whyNot(getRow(orgId, grantId), { tool, host, command, now, afterUse: true });
  return why === null ? { allowed: true } : { allowed: false, reason: why };
}

function recordUse(orgId, grantId, { approvalId, command, userId, agentId, host } = {}) {
  requireDb().prepare('UPDATE fleet_standing_grants SET use_count = use_count + 1, last_used_at = ? WHERE org_id = ? AND grant_id = ?')
    .run(Date.now(), orgId, grantId);
  emit('quox.approval.standing_grant.used', orgId, userId, {
    grant_id: grantId, approval_id: approvalId || null, host: host || null, agent_id: agentId || null, user_id: userId || null,
    approved_by: (getRow(orgId, grantId) || {}).created_by || null, caller: agentId ? `agent.${agentId}` : (userId ? `human.${userId}` : 'system.collector'),
    command_sha256: crypto.createHash('sha256').update(String(command || '')).digest('hex'),
  }, agentId ? `agent.${agentId}` : null);
}

module.exports = {
  ensure, setEmitter, validateGrant, createGrant, getGrant, listGrants, revokeGrant,
  coversCall, checkGrant, recordUse, PRESETS, escapeRe, _internal: { compile, whyNot },
};
