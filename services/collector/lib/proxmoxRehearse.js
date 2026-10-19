'use strict';

/**
 * Rehearsal twins (DEVFLEET-P15): "approve with proof".
 *
 * HYPERION (agent atlas) clones a target VM from a fresh snapshot into a NETWORK-ISOLATED twin,
 * runs the proposed command inside the twin through the guest agent, diffs health before/after,
 * destroys the twin and returns a verdict a human can read on an approval card.
 *
 * NO PARALLEL ENFORCEMENT PATH. Every host command goes through proxmoxPool.governedRun, i.e. the
 * one governed ssh_exec boundary acting as agent `atlas`: a command inside a standing-grant lane runs,
 * anything else files ONE normal HITL approval and this module stops (the run is an 'error' with
 * pending:true; nothing is retried into a second approval).
 *
 * ONE human approval per rehearsal (owner decision, option A): the proposal carries the FULL
 * deterministic plan (every host command string). Only on the APPROVED resume does this module
 * ask fleetStandingGrants for an ephemeral grant whose patterns are exactly those strings (escaped
 * literals), on the target node, for 60 minutes, max_uses-capped, created_by the approving human. It
 * decides nothing itself: ssh_exec's own standing-grant lookup (coversCall) is the only boundary that
 * reads that grant, and the grant is revoked in finally on every exit path.
 *
 * The twin carries the target's IP and hostname, so it must NEVER reach the LAN: link_down=1 is
 * set on every netN and re-verified from `qm config` BEFORE `qm start`. Cleanup runs on every exit
 * path (finally). Dependencies are injected so the whole flow is testable with ssh mocked at its
 * boundary and asserted on exact command strings.
 */

const poolMod = require('./proxmoxPool.js');
const defaultPoolStore = require('./proxmoxPoolStore.js');
const defaultStore = require('./proxmoxRehearseStore.js');
const crypto = require('crypto');

const { governedRun, parseQmList, cmd: poolCmd, ACTOR_AGENT } = poolMod;

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const UNIT_RE = /^[A-Za-z0-9@:._-]{1,100}$/;
const URL_RE = /^http:\/\/127\.0\.0\.1(?::\d{1,5})?(?:\/[A-Za-z0-9._~\/%+=,:@?-]*)?$/;
const CMD_CHECK_RE = /^[A-Za-z0-9 ._\/:=@%+,-]{1,200}$/;
const NET_VALUE_RE = /^[A-Za-z0-9=,._:\/-]{1,300}$/;
const MAX_CHECKS = 10;
const MAX_COMMAND = 2000;
const GRANT_MINUTES = 60;
const GRANT_POLL_SLACK = 5;
const OUTPUT_TAIL = 2000;

class RehearseError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'RehearseError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

/** -> { ok: [normalised checks] } | { error } */
function validateChecks(raw) {
  if (raw === undefined || raw === null) return { ok: [] };
  if (!Array.isArray(raw) || raw.length > MAX_CHECKS) return { error: `checks must be a list of at most ${MAX_CHECKS} checks` };
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') return { error: 'each check must be an object { type, ... }' };
    if (c.type === 'url') {
      if (typeof c.url !== 'string' || !URL_RE.test(c.url) || c.url.length > 200) return { error: 'url check must be http://127.0.0.1[:port][/path] with only simple path characters (no quotes, & ; | $ or spaces)' };
      out.push({ type: 'url', url: c.url });
    } else if (c.type === 'unit') {
      if (typeof c.name !== 'string' || !UNIT_RE.test(c.name)) return { error: 'unit check name must be a systemd unit name (letters, digits, @ : . _ -)' };
      out.push({ type: 'unit', name: c.name });
    } else if (c.type === 'cmd') {
      if (typeof c.run !== 'string' || !CMD_CHECK_RE.test(c.run)) return { error: 'cmd check may only use letters, digits, space and . _ / : = @ % + , - (no quotes or shell metacharacters)' };
      out.push({ type: 'cmd', run: c.run });
    } else {
      return { error: 'check type must be url, unit or cmd' };
    }
  }
  return { ok: out };
}

/** The rehearsed command runs inside bash -c '...': no single quotes, no control characters. */
function validateCommand(c) {
  if (typeof c !== 'string' || !c.trim()) return { error: 'command is required' };
  if (c.length > MAX_COMMAND) return { error: `command may be at most ${MAX_COMMAND} characters` };
  if (c.includes("'")) return { error: 'command may not contain single quotes (it runs inside bash -c, use double quotes)' };
  if (/[\x00-\x1f\x7f]/.test(c)) return { error: 'command must be one line with no control characters' };
  return { ok: c };
}

const tsOf = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14);

/** The probe: failed-unit count + list, then one KEY=value line per check. No single quotes. */
function probeScript(checks) {
  const parts = [
    // A fresh twin may still be booting when the agent first answers (live 2026-10-19: the before-probe read url 000 on
    // a VM that serves 200, then docker restart hung on the half-started daemon past the 60 s gateway cap). Wait for
    // boot to finish, bounded so the probe stays well inside that cap; a twin that never settles is probed as it is.
    'timeout 30 systemctl is-system-running --wait >/dev/null 2>&1;',
    'echo FAILED_COUNT=$(systemctl --failed --no-legend | wc -l);',
    'echo FAILED_UNITS=$(systemctl --failed --no-legend --plain | awk "{print \\$1}" | tr "\\n" ,);',
  ];
  checks.forEach((c, i) => {
    if (c.type === 'url') parts.push(`echo CHK${i}=$(curl -fsS -o /dev/null -w %{http_code} --max-time 10 "${c.url}" 2>/dev/null || true);`);
    else if (c.type === 'unit') parts.push(`echo CHK${i}=$(systemctl is-active ${c.name});`);
    else parts.push(`${c.run} >/dev/null 2>&1; echo CHK${i}=$?;`);
  });
  parts.push('echo PROBE_DONE');
  return parts.join(' ');
}

function parseJsonObject(text) {
  const s = String(text || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function checkOk(c, value) {
  if (c.type === 'url') return /^[23]\d\d$/.test(value);
  if (c.type === 'unit') return value === 'active';
  return value === '0';
}

function parseProbe(out, checks) {
  const j = parseJsonObject(out);
  const data = j ? String(j['out-data'] || '') : '';
  if (!/PROBE_DONE/.test(data)) return null;
  const kv = {};
  data.split('\n').forEach((l) => { const m = /^([A-Z_]+\d*)=(.*)$/.exec(l.trim()); if (m) kv[m[1]] = m[2].trim(); });
  const units = (kv.FAILED_UNITS || '').split(',').map((u) => u.trim()).filter(Boolean);
  const count = Number.isFinite(Number(kv.FAILED_COUNT)) ? Number(kv.FAILED_COUNT) : units.length;
  const results = checks.map((c, i) => {
    const value = kv[`CHK${i}`] === undefined ? '' : kv[`CHK${i}`];
    return { type: c.type, target: c.url || c.name || c.run, value, ok: checkOk(c, value) };
  });
  return { failed_count: count, failed_units: units, checks: results };
}

/** Pure: what got worse between baseline and after. */
function diffProbes(before, after) {
  const newUnits = after.failed_units.filter((u) => !before.failed_units.includes(u));
  const newCount = Math.max(newUnits.length, after.failed_count - before.failed_count, 0);
  const flipped = [];
  after.checks.forEach((c, i) => { if (before.checks[i] && before.checks[i].ok && !c.ok) flipped.push({ type: c.type, target: c.target, before: before.checks[i].value, after: c.value }); });
  return { new_failed_units: newUnits, new_failed_count: newCount, flipped };
}

// ---------------------------------------------------------------------------
// The deterministic plan
// ---------------------------------------------------------------------------

function netLines(config) {
  const out = [];
  if (config && typeof config === 'object') {
    for (const k of Object.keys(config)) if (/^net\d+$/.test(k) && typeof config[k] === 'string') out.push({ key: k, value: config[k] });
  }
  return out.sort((a, b) => Number(a.key.slice(3)) - Number(b.key.slice(3)));
}

const isolatedValue = (v) => `${v.replace(/,link_down=[01]/g, '')},link_down=1`;

/**
 * Every host command the rehearsal will run, as exact strings, derived ONLY from the plan params and
 * the pool config's VMID range. The approver sees this list; the grant covers exactly these strings.
 */
function commandsFor(p, cfg) {
  const unit = `${poolMod.NAME_PREFIX}-twin-${p.twin}`;
  const exec = (script) => poolCmd.exec(cfg, p.twin, script);
  const sets = p.nets.map((n) => `--${n.key} ${isolatedValue(n.value)}`);
  return {
    snapshot: `qm snapshot ${p.vmid} ${p.snap} --vmstate 0`,
    clone: `systemd-run --collect --unit ${unit} qm clone ${p.vmid} ${p.twin} --snapname ${p.snap} --name ${poolMod.NAME_PREFIX}-twin-${p.vmid}-${p.ts} --full`,
    unitActive: `systemctl is-active ${unit}`,
    journal: `journalctl -u ${unit} -n 20 --no-pager`,
    set: `qm set ${p.twin} ${[...sets, '--onboot 0'].join(' ')}`,
    start: poolCmd.start(cfg, p.twin),
    ping: poolCmd.ping(cfg, p.twin),
    probe: exec(probeScript(p.checks)),
    exec: exec(p.command),
    stop: poolCmd.stop(cfg, p.twin),
    destroy: poolCmd.destroy(cfg, p.twin),
    delsnapshot: `qm delsnapshot ${p.vmid} ${p.snap}`,
  };
}

/** Order the approver reads them in; `invocations` counts calls that spend grant uses (probe runs twice; reads are fleet-read allowlisted). */
function planFromParams(p, cfg) {
  const C = commandsFor(p, cfg);
  const ordered = [C.snapshot, C.clone, C.unitActive, C.journal, C.set, C.start, C.ping, C.probe, C.exec, C.stop, C.destroy, C.delsnapshot];
  const commands = [...new Set(ordered)];
  const invocations = 11; // snapshot, clone, set, start, ping, probe x2, exec, stop, destroy, delsnapshot
  const sha256 = crypto.createHash('sha256').update(JSON.stringify({ params: p, commands })).digest('hex');
  return { params: p, commands, invocations, max_uses: invocations + GRANT_POLL_SLACK, sha256 };
}

const ID_RE = /^RH_[0-9A-F]{16}$/;

// ---------------------------------------------------------------------------
// Default Proxmox REST reads (read-only; the same allowlisted pveGet the other HYPERION reads use)
// ---------------------------------------------------------------------------

async function defaultReadVmConfig(orgId, node, vmid) {
  const { pveGet } = require('./proxmoxApi.js');
  try { return await pveGet(`/nodes/${node}/qemu/${vmid}/config`, undefined, { orgId }); } catch (e) {
    if (e && (e.status === 404 || e.status === 500 || /does not exist|not exist|no such/i.test(String(e.message)))) return null;
    throw e;
  }
}
async function defaultListClusterVmids(orgId) {
  const { pveGet } = require('./proxmoxApi.js');
  const rows = await pveGet('/cluster/resources', { type: 'vm' }, { orgId });
  return new Set((Array.isArray(rows) ? rows : []).map((r) => Number(r.vmid)).filter(Number.isInteger));
}
async function defaultReadAgent(orgId, node, vmid) {
  const { pveGet } = require('./proxmoxApi.js');
  try { await pveGet(`/nodes/${node}/qemu/${vmid}/agent/get-host-name`, undefined, { orgId }); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

function createRehearser({
  store = defaultStore, poolStore = defaultPoolStore, runTool, emit = () => {},
  grants = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), log = (m) => console.log(m),
  pingAttempts = 60, pingIntervalMs = 5000, cloneAttempts = 180, cloneIntervalMs = 10000, earlyAttempts = 6, earlyIntervalMs = 10000, maxConcurrent = 3,
  readVmConfig = defaultReadVmConfig, listClusterVmids = defaultListClusterVmids, readAgent = defaultReadAgent,
} = {}) {
  if (typeof runTool !== 'function') throw new Error('createRehearser requires runTool');
  const fsg = () => grants || require('./fleetStandingGrants.js');
  const inflight = new Set();      // `${org}:${vmid}` with a rehearsal running in THIS process (one per target VM)
  const background = new Set();

  const run = (orgId, cfg, command, reason, opts) => governedRun({ runTool, sleep, now }, orgId, cfg, command, `Rehearsal twin: ${reason}`, opts);

  function must(r, what) {
    if (r.ok) return r.stdout;
    if (r.pending) throw new RehearseError('pending_approval', `${what}: needs approval ${r.approvalId}`, { approvalId: r.approvalId });
    throw new RehearseError('host_failed', `${what} failed: ${r.error}`);
  }

  const emitSafe = (intent, orgId, payload, actor) => { try { emit(intent, orgId, payload, actor || ACTOR_AGENT); } catch { /* evidence never blocks */ } };

  function validateInput(input) {
    const vmid = Number(input.vmid);
    if (!Number.isInteger(vmid) || vmid < 100 || vmid > 999999999) throw new RehearseError('bad_request', 'vmid must be an integer >= 100');
    const node = typeof input.node === 'string' ? input.node.trim() : '';
    if (!HOST_RE.test(node)) throw new RehearseError('bad_request', 'node must be one concrete host id');
    const cv = validateCommand(input.command);
    if (cv.error) throw new RehearseError('bad_request', cv.error);
    const kv = validateChecks(input.checks);
    if (kv.error) throw new RehearseError('bad_request', kv.error);
    return { vmid, node, command: cv.ok, checks: kv.ok, keepTwin: input.keep_twin === true };
  }

  /**
   * PROPOSE phase: validate, read the target over the read-only REST path, pick the twin VMID and
   * compute the full deterministic plan. Stores it (state awaiting_approval). Creates no grant, runs
   * no host command, touches nothing. -> { rehearsal_id, plan, gateInput }
   */
  async function prepare(orgId, input = {}) {
    if (!orgId) throw new RehearseError('bad_request', 'rehearsal needs an org context');
    const v = validateInput(input);
    const cfg = poolStore.getConfig(orgId);
    if (cfg.deny_nodes.includes(v.node)) throw new RehearseError('refused', `node ${v.node} is on the pool deny list; nothing runs there`);
    if (cfg.vmid_min === null || cfg.vmid_max === null || cfg.vmid_min === undefined) {
      throw new RehearseError('bad_request', 'rehearsal needs the VM pool configured (a vmid range is used for twins)');
    }
    let conf; let used;
    try {
      conf = await readVmConfig(orgId, v.node, v.vmid);
      used = await listClusterVmids(orgId);
    } catch (e) {
      throw new RehearseError('plan_unavailable', `cannot plan a rehearsal without read access to the Proxmox API (${String(e && e.message).slice(0, 160)})`);
    }
    if (!conf) throw new RehearseError('not_found', `VM ${v.vmid} not found on ${v.node}`);
    if (Number(conf.template) === 1) throw new RehearseError('refused', `VM ${v.vmid} is a template; rehearse a VM, not a template`);
    const nets = netLines(conf);
    for (const n of nets) {
      if (!NET_VALUE_RE.test(isolatedValue(n.value))) throw new RehearseError('isolation_failed', `cannot safely isolate ${n.key}; refusing to plan this rehearsal`);
    }
    const taken = new Set([...used, ...poolStore.listVms(orgId).filter((x) => x.state !== 'failed').map((x) => x.vmid), ...store.runningTwinVmids(orgId)]);
    let twin = null;
    for (let i = cfg.vmid_min; i <= cfg.vmid_max; i++) if (!taken.has(i)) { twin = i; break; }
    if (twin === null) throw new RehearseError('no_free_vmid', `no free VMID in the pool range ${cfg.vmid_min}-${cfg.vmid_max} for a twin`);
    const t0 = now();
    const ts = tsOf(t0);
    const params = {
      vmid: v.vmid, node: v.node, name: typeof conf.name === 'string' ? conf.name.slice(0, 64) : null, command: v.command, checks: v.checks,
      keep_twin: v.keepTwin, twin, snap: `hyp-rehearse-${ts}`, ts, nets,
    };
    const plan = planFromParams(params, cfg);
    const id = store.begin(orgId, { vmid: v.vmid, node: v.node, twin_vmid: null, snapshot: null, command: v.command, keep_twin: v.keepTwin, plan, verdict: 'awaiting_approval' });
    return {
      rehearsal_id: id, plan,
      gateInput: { vmid: v.vmid, node: v.node, command: v.command, checks: v.checks, keep_twin: v.keepTwin, rehearsal_id: id, plan_sha256: plan.sha256 },
    };
  }

  /**
   * RUN phase, after the approval gate. `approval` ({ approvalId, approvedBy }) is supplied ONLY by the
   * caller that verified an approved resume; without it the run is un-granted (every command is then
   * individually governed by ssh_exec and the first uncovered one stops the run).
   * -> { rehearsal_id, state:'running', done } ; throws RehearseError before anything is created.
   */
  async function startApproved(orgId, ref = {}, approval = null) {
    if (!orgId) throw new RehearseError('bad_request', 'rehearsal needs an org context');
    const id = String(ref.rehearsal_id || '');
    if (!ID_RE.test(id)) throw new RehearseError('bad_request', 'rehearsal_id is malformed');
    const stored = store.getPlan(orgId, id);
    if (!stored) throw new RehearseError('not_found', `no rehearsal ${id} for this org`);
    if (stored.verdict !== 'awaiting_approval') throw new RehearseError('busy', `rehearsal ${id} is not awaiting approval (state ${stored.verdict}); a rehearsal runs once`);
    const p = stored.plan.params;
    const cfg = poolStore.getConfig(orgId);
    if (cfg.deny_nodes.includes(p.node)) throw new RehearseError('refused', `node ${p.node} is on the pool deny list; nothing runs there`);
    // Re-derive the plan from its params and compare: the stored copy is never trusted on its own.
    const plan = planFromParams(p, cfg);
    if (plan.sha256 !== stored.plan_sha256 || plan.sha256 !== stored.plan.sha256) throw new RehearseError('plan_mismatch', 'the stored rehearsal plan no longer matches what was proposed; refusing to run');
    if (ref.plan_sha256 !== undefined && ref.plan_sha256 !== plan.sha256) throw new RehearseError('plan_mismatch', 'the approved plan hash does not match the stored plan; refusing to run');
    for (const [k, want] of [['vmid', p.vmid], ['node', p.node], ['command', p.command]]) {
      if (ref[k] !== undefined && ref[k] !== want) throw new RehearseError('plan_mismatch', `approved ${k} does not match the plan; refusing to run`);
    }
    const key = `${orgId}:${p.vmid}`;
    if (inflight.has(key)) throw new RehearseError('busy', `a rehearsal of VM ${p.vmid} is already running`);
    if (inflight.size >= maxConcurrent) throw new RehearseError('busy', `at most ${maxConcurrent} rehearsals run at once; try again shortly`);
    if (!store.claimToRun(orgId, id, approval && approval.approvalId)) throw new RehearseError('busy', `rehearsal ${id} was already started`);
    inflight.add(key);
    let grant = null;
    try {
      if (approval && approval.approvalId && approval.approvedBy) {
        const g = fsg();
        const v = g.validateGrant({
          tool: 'ssh_exec', host: p.node, reason: `rehearsal ${id} via approval ${approval.approvalId}`,
          exact_commands: plan.commands, expires_in_minutes: GRANT_MINUTES, max_uses: plan.max_uses, vmid_allow: [p.vmid, p.twin], source_approval_id: approval.approvalId,
        });
        if (v.error) throw new RehearseError('grant_invalid', `could not build the rehearsal grant: ${v.error}`);
        grant = g.createGrant(orgId, v.ok, approval.approvedBy);
        store.patch(orgId, id, { grant_id: grant.grant_id });
        emitSafe('quox.proxmox.rehearse.grant_minted', orgId, {
          rehearsal_id: id, grant_id: grant.grant_id, approval_id: approval.approvalId, approved_by: approval.approvedBy, node: p.node, vmid: p.vmid, twin_vmid: p.twin,
          command_count: plan.commands.length, max_uses: plan.max_uses, expires_at: grant.expires_at,
        }, `human.${approval.approvedBy}`);
      }
    } catch (e) {
      inflight.delete(key);
      store.finish(orgId, id, { verdict: 'error', error: `grant not minted: ${e.message}` });
      throw e;
    }
    const done = execute({ orgId, cfg, plan, p, recId: id, grant, approval, actor: approval && approval.approvedBy })
      .finally(() => { inflight.delete(key); background.delete(done); });
    background.add(done);
    return { rehearsal_id: id, state: 'running', grant_id: grant ? grant.grant_id : null, done };
  }

  /** Revoke an ephemeral grant (idempotent). Returns an error string or null. */
  function revoke(orgId, recId, grantId, approvalId, why) {
    if (!grantId) return null;
    try {
      const g = fsg().revokeGrant(orgId, grantId, 'system:rehearsal-complete');
      emitSafe('quox.proxmox.rehearse.grant_revoked', orgId, { rehearsal_id: recId, grant_id: grantId, approval_id: approvalId || null, use_count: g ? g.use_count : null, why: why || 'rehearsal complete' });
      return null;
    } catch (e) { return `revoke ${grantId}: ${e.message}`; }
  }

  /** The run. Never throws: a failure is verdict 'error' on the record. */
  async function execute({ orgId, cfg, plan, p, recId, grant, approval, actor }) {
    const C = commandsFor(p, cfg);
    const { vmid, node, twin, snap } = p;
    const t0 = now();
    const tgt = { ...cfg, node };
    const st = { snapshot: false, cloneLaunched: false, isolated: false, started: false };
    const res = {
      verdict: 'error', exit_code: null, duration_s: null, failed_units_before: [], failed_units_after: [], new_failed_units: [],
      checks_before: [], checks_after: [], flipped: [], output_tail: '', twin_vmid: twin, snapshot: snap, rehearsal_id: recId, grant_id: grant ? grant.grant_id : null, twin_kept: false, cleanup_errors: [],
    };
    const diskKey = (c) => Object.keys(c || {}).some((k) => /^(scsi|virtio|sata|ide)\d+$/.test(k));
    try {
      // Preflight again over REST (the target may have changed since the proposal).
      const conf = await readVmConfig(orgId, node, vmid);
      if (!conf) throw new RehearseError('not_found', `VM ${vmid} not found on ${node}`);
      if (Number(conf.template) === 1) throw new RehearseError('refused', `VM ${vmid} is a template; rehearse a VM, not a template`);

      must(await run(orgId, tgt, C.snapshot, `snapshot ${vmid}`, { retry: false }), `snapshot ${vmid}`);
      st.snapshot = true;
      store.patch(orgId, recId, { snapshot: snap });

      st.cloneLaunched = true; // from here a half-made twin may exist: cleanup destroys it
      store.patch(orgId, recId, { twin_vmid: twin }); // recorded only now, so boot recovery never touches a VMID we did not create
      must(await run(orgId, tgt, C.clone, `clone ${vmid} -> ${twin} (detached)`, { retry: false }), `twin clone ${twin} launch`);

      // Early fail: within ~60s the twin config exists (REST) or the systemd unit is active.
      let started = false;
      for (let i = 0; i < earlyAttempts && !started; i++) {
        let c = null; try { c = await readVmConfig(orgId, node, twin); } catch { c = null; }
        if (c) { started = true; break; }
        const a = await run(orgId, tgt, C.unitActive, `clone unit active?`, { retry: false });
        if (a.pending) must(a, 'systemctl is-active');
        if (a.ok && /^active/.test(a.stdout.trim())) { started = true; break; }
        if (i < earlyAttempts - 1) await sleep(earlyIntervalMs);
      }
      if (!started) {
        const j = await run(orgId, tgt, C.journal, `why did the clone unit not start?`, { retry: false });
        const lines = j.ok ? j.stdout.trim().split('\n').slice(-20).join(' | ').slice(0, 600) : `journal unavailable (${j.error})`;
        throw new RehearseError('clone_not_started', `twin clone ${twin} never started: ${lines || 'no journal lines'}`);
      }

      // Wait for the full clone to finish (REST poll: no host command, no grant use).
      let twinConf = null;
      for (let i = 0; i < cloneAttempts; i++) {
        let c = null; try { c = await readVmConfig(orgId, node, twin); } catch { c = null; }
        if (c && !/clone/.test(String(c.lock || '')) && diskKey(c)) { twinConf = c; break; }
        await sleep(cloneIntervalMs);
      }
      if (!twinConf) throw new RehearseError('clone_timeout', `twin clone ${twin} did not finish`);

      // Isolate BEFORE boot, then verify from the twin's own config.
      must(await run(orgId, tgt, C.set, `isolate ${twin}`), `isolate ${twin}`);
      const after = await readVmConfig(orgId, node, twin);
      const bad = netLines(after).filter((n) => !/(^|,)link_down=1(,|$)/.test(n.value));
      if (!after || bad.length) throw new RehearseError('isolation_failed', `${bad.map((n) => n.key).join(', ') || 'network'} still linked after isolation; refusing to boot the twin`);
      st.isolated = true;

      st.started = true; // a failed start may still leave it running: cleanup stops it
      const sr = await run(orgId, tgt, C.start, `start ${twin}`);
      if (!sr.ok) must(sr, `start ${twin}`);
      let agentUp = false;
      for (let i = 0; i < pingAttempts && !agentUp; i++) {
        agentUp = await readAgent(orgId, node, twin).catch(() => false);
        if (!agentUp && i < pingAttempts - 1) await sleep(pingIntervalMs);
      }
      if (!agentUp) throw new RehearseError('no_guest_agent', 'target has no guest agent, rehearsal impossible');
      const pr = await run(orgId, tgt, C.ping, `agent ping ${twin}`);
      if (!pr.ok) {
        if (pr.pending) must(pr, 'agent ping');
        throw new RehearseError('no_guest_agent', 'target has no guest agent, rehearsal impossible');
      }

      const probe = async (label) => {
        const out = must(await run(orgId, tgt, C.probe, `${label} checks on ${twin}`), `${label} checks`);
        const parsed = parseProbe(out, p.checks);
        if (!parsed) throw new RehearseError('probe_failed', `${label} health probe returned no usable output`);
        return parsed;
      };
      const probeBefore = await probe('baseline');
      res.failed_units_before = probeBefore.failed_units; res.checks_before = probeBefore.checks;

      const tc = now();
      const raw = must(await run(orgId, tgt, C.exec, `run command in ${twin}`, { retry: false }), 'rehearsed command');
      res.duration_s = Math.max(0, Math.round((now() - tc) / 1000));
      const j = parseJsonObject(raw);
      if (!j) throw new RehearseError('exec_failed', 'guest exec returned no result');
      const exited = j.exited === undefined ? 1 : Number(j.exited);
      res.exit_code = exited === 0 ? -1 : (Number.isInteger(j.exitcode) ? j.exitcode : -1);
      res.output_tail = `${j['out-data'] || ''}${j['err-data'] ? `\n[stderr]\n${j['err-data']}` : ''}`.slice(-OUTPUT_TAIL);
      if (exited === 0) res.output_tail = `[command did not finish within the guest exec timeout]\n${res.output_tail}`.slice(-OUTPUT_TAIL);

      const probeAfter = await probe('post');
      res.failed_units_after = probeAfter.failed_units; res.checks_after = probeAfter.checks;
      const d = diffProbes(probeBefore, probeAfter);
      res.new_failed_units = d.new_failed_units; res.flipped = d.flipped; res.new_failed_count = d.new_failed_count;
      res.verdict = res.exit_code === 0 && d.new_failed_count === 0 && !d.flipped.length ? 'pass' : 'fail';
    } catch (e) {
      res.verdict = 'error';
      res.error = e && e.message ? String(e.message).slice(0, 300) : String(e);
      if (e && e.code === 'pending_approval') { res.pending = true; res.approvalId = e.approvalId; res.error = `${res.error}. Nothing was retried; once a human decides, re-run the rehearsal.`; }
      if (e && e.code) res.code = e.code;
    } finally {
      // Cleanup on EVERY exit path, each step independent and best effort, still under the grant.
      const keep = p.keep_twin && st.isolated && res.verdict !== 'error';
      if (st.started || st.cloneLaunched) {
        const r = await run(orgId, tgt, C.stop, `stop ${twin}`);
        if (!r.ok && !/not running|does not exist|no such|not found/i.test(r.error || '')) res.cleanup_errors.push(`stop ${twin}: ${r.pending ? `needs approval ${r.approvalId}` : r.error}`);
      }
      if (st.cloneLaunched && !keep) {
        const r = await run(orgId, tgt, C.destroy, `destroy ${twin}`);
        if (!r.ok && !/does not exist|no such|not found/i.test(r.error || '')) res.cleanup_errors.push(`destroy ${twin}: ${r.pending ? `needs approval ${r.approvalId}` : r.error}`);
      }
      res.twin_kept = keep;
      if (st.snapshot) {
        const r = await run(orgId, tgt, C.delsnapshot, `delete snapshot ${snap}`);
        if (!r.ok && !/does not exist|no such|not found/i.test(r.error || '')) res.cleanup_errors.push(`delsnapshot ${snap}: ${r.pending ? `needs approval ${r.approvalId}` : r.error}`);
      }
      // The ephemeral grant dies with the run, whatever happened.
      const rerr = revoke(orgId, recId, grant && grant.grant_id, approval && approval.approvalId, res.verdict === 'error' ? 'rehearsal failed' : 'rehearsal complete');
      if (rerr) res.cleanup_errors.push(rerr);
    }
    res.total_s = Math.round((now() - t0) / 1000);
    if (res.duration_s === null) res.duration_s = res.total_s;
    if (res.cleanup_errors.length) log(`[ProxmoxRehearse] org=${orgId} vm=${vmid} twin=${twin} CLEANUP INCOMPLETE: ${res.cleanup_errors.join('; ')}`);
    try {
      store.finish(orgId, recId, {
        verdict: res.verdict, exit_code: res.exit_code, duration_s: res.duration_s,
        new_failed_units: res.new_failed_count ?? res.new_failed_units.length,
        failed_units_before: res.failed_units_before, failed_units_after: res.failed_units_after,
        checks_before: res.checks_before, checks_after: res.checks_after, flipped: res.flipped,
        output_tail: res.output_tail, error: [res.error, ...res.cleanup_errors].filter(Boolean).join(' | ') || null,
      });
    } catch (e) { log(`[ProxmoxRehearse] org=${orgId} rehearsal=${recId} could not store the result: ${e.message}`); }
    emitSafe('quox.proxmox.rehearse', orgId, {
      rehearsal_id: recId, vmid, node, twin_vmid: twin, snapshot: snap, verdict: res.verdict, exit_code: res.exit_code,
      duration_s: res.duration_s, new_failed_units: res.new_failed_count ?? res.new_failed_units.length, flipped_checks: res.flipped.length,
      twin_kept: res.twin_kept, cleanup_ok: res.cleanup_errors.length === 0, grant_id: res.grant_id, approval_id: approval ? approval.approvalId : null,
      ...(res.error ? { error: res.error.slice(0, 200) } : {}),
    }, actor);
    return res;
  }

  /** Test/ops convenience: propose, then run as if approved by `approval`. */
  async function rehearse(orgId, input = {}, approval = null) {
    const prep = await prepare(orgId, input);
    const s = await startApproved(orgId, prep.gateInput, approval);
    return s.done;
  }

  /**
   * Boot recovery: rows still 'running' after olderThanMs belong to a collector that died mid-run.
   * Clean up only what the record says was created (twin, snapshot), via the same governed path, revoke
   * the row's ephemeral grant, then mark the row 'error: interrupted'. Nothing is retried; cleanup that
   * needs approval is reported on the row. Unapproved proposals older than 2h are closed too.
   */
  async function recoverInterrupted({ olderThanMs = 45 * 60 * 1000 } = {}) {
    const out = { recovered: 0, cleanup_errors: [] };
    for (const rec of store.staleRunning(olderThanMs, now())) {
      if (inflight.has(`${rec.org_id}:${rec.vmid}`)) continue;
      const errs = [];
      let cfg;
      try { cfg = { ...poolStore.getConfig(rec.org_id), node: rec.node }; } catch (e) { errs.push(`config: ${e.message}`); }
      if (cfg && !cfg.deny_nodes.includes(rec.node)) {
        if (rec.twin_vmid) {
          const inRange = Number.isInteger(rec.twin_vmid) && rec.twin_vmid >= cfg.vmid_min && rec.twin_vmid <= cfg.vmid_max;
          if (!inRange) errs.push(`twin ${rec.twin_vmid} is outside the pool range; left alone`);
          else {
            for (const [what, c] of [['stop', poolCmd.stop(cfg, rec.twin_vmid)], ['destroy', poolCmd.destroy(cfg, rec.twin_vmid)]]) {
              const r = await run(rec.org_id, cfg, c, `recover interrupted rehearsal: ${what} ${rec.twin_vmid}`);
              if (!r.ok && !/not running|does not exist|no such|not found/i.test(r.error || '')) errs.push(`${what} ${rec.twin_vmid}: ${r.pending ? `needs approval ${r.approvalId}` : r.error}`);
            }
          }
        }
        if (rec.snapshot) {
          const r = await run(rec.org_id, cfg, `qm delsnapshot ${rec.vmid} ${rec.snapshot}`, `recover interrupted rehearsal: delete snapshot ${rec.snapshot}`);
          if (!r.ok && !/does not exist|no such|not found/i.test(r.error || '')) errs.push(`delsnapshot ${rec.snapshot}: ${r.pending ? `needs approval ${r.approvalId}` : r.error}`);
        }
      }
      const rerr = revoke(rec.org_id, rec.id, rec.grant_id, rec.approval_id, 'interrupted rehearsal recovered at boot');
      if (rerr) errs.push(rerr);
      store.finish(rec.org_id, rec.id, { verdict: 'error', error: ['interrupted (collector restarted mid-run)', ...errs].join(' | ') });
      out.recovered += 1; out.cleanup_errors.push(...errs);
      log(`[ProxmoxRehearse] org=${rec.org_id} rehearsal=${rec.id} interrupted; ${errs.length ? `cleanup incomplete: ${errs.join('; ')}` : 'cleaned up'}`);
    }
    for (const rec of store.staleRunning(2 * 3600000, now(), 'awaiting_approval')) {
      store.finish(rec.org_id, rec.id, { verdict: 'error', error: 'never approved (proposal expired)' });
    }
    return out;
  }

  /**
   * At process start nothing in this process can be running a rehearsal, so every 'running' row is
   * orphaned whatever its age. The 45 min threshold above is for a sweep inside a live process; used at
   * boot it left a row 7 min old at restart stuck 'running' forever, with its twin and snapshot leaked
   * (live 2026-10-19, RH_634F7C36C018CDF4).
   */
  const recoverAtBoot = () => recoverInterrupted({ olderThanMs: 0 });

  return { prepare, startApproved, rehearse, recoverInterrupted, recoverAtBoot, idle: () => Promise.all([...background]), store };
}

// ---------------------------------------------------------------------------
// Default (production) wiring: the same governed ssh_exec choke the pool uses.
// ---------------------------------------------------------------------------

let _default = null;
function getRehearser() {
  if (!_default) _default = createRehearser({ runTool: poolMod.defaultRunTool, emit: (...a) => poolMod.defaultEmit(...a) });
  return _default;
}
function _setRehearserForTest(r) { _default = r; }

module.exports = {
  createRehearser, getRehearser, _setRehearserForTest, RehearseError, validateChecks, validateCommand, probeScript, parseProbe, diffProbes,
  commandsFor, planFromParams, isolatedValue, netLines, GRANT_MINUTES,
};
