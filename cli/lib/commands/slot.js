/**
 * Slot commands — DEVSUITE-SLOTS Phase 5 (`quox slot`).
 *
 * A slot is a fixed, org-curated address (T1..T8, or named: `triage`,
 * `builder`) that a dev session checks out and releases (see
 * services/collector/lib/devSlotsStore.js, phase 3). Phase 4 derives a
 * Matrix room per slot; phase 5 (this file) adds the say/read message seam
 * through that room. Sessions never hold Matrix credentials — say/read go
 * through the collector routes only (POST/GET /api/v1/slots/:name/say and
 * /messages), never a direct Matrix client in the CLI.
 */

import { presenceText } from './presence.js';
import { readInstalledBuild, CLI_DIR } from '../core/cliBuild.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { formatDetail, formatOutput, printSuccess, printWarning, printInfo } from '../core/output.js';
import { events, printEvent } from '../core/quoxglyph.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { QuoxApiError, QuoxNetworkError } from '../core/errors.js';
import { resolveOrgId } from './helpers.js';
import { parseBroadcastArgs, broadcastSummary, deliveryLine, parseAckArgs } from '../quoxon/slash/broadcast.js';
import { claudeSessionInfo, procStartTime, resolveMyAttach, readSlotState } from './agentAttach.js';
import { runKeeper, keeperDir, makeProcessProbe, sameProcess } from '../core/slotKeeper.js';
import { loadConfig } from '../core/config.js';
import { createAuth } from '../core/auth.js';
import { createClient } from '../core/client.js';

// Local record of the slots checked out from this box, written at checkout
// and cleared at release. Consumers (the slot-inbox hook) re-verify each
// entry against the registry before trusting it, so a stale entry from a
// crashed session degrades to "not ours" rather than to wrong mail.
export function heldSlotsPath() {
  return join(homedir(), '.quox', 'held-slots.json');
}

function readHeldSlots(path = heldSlotsPath()) {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Atomic write (tmp + rename): readers (the slot-inbox hook) never see a
// half-written file, and two sessions pruning at once cannot corrupt it.
function writeHeldSlots(all, path) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2));
  renameSync(tmp, path);
}

// `info` is claudeSessionInfo() ({ sessionKey, pid, starttime }) or null.
// Entries written before quox#662 are { session, recorded_at } only, and
// still read fine: they just carry no process binding.
// HOLDER-SAY (2026-10-17): `profile` is the CLI profile whose identity took the hold. The server binds the hold
// to that identity (holder_identity), so `say` must speak through the same profile, not whatever the default is now.
export function recordHeldSlot(name, session, path = heldSlotsPath(), info = null, member = null, profile = null) {
  try {
    const all = readHeldSlots(path);
    // P10: a joining member must not clobber a sibling session's HOLDER entry
    // (same slot name, same box); the member's label lives in its attach state.
    const prev = all[name];
    if (member && prev && !prev.member && prev.sessionKey && info && prev.sessionKey !== info.sessionKey) return;
    all[name] = {
      session,
      ...(info ? { sessionKey: info.sessionKey, pid: info.pid, starttime: info.starttime } : {}),
      // P10: joined an already-held slot as a member (not the holder).
      ...(member ? { member: true, splinter: member.splinter ?? null, member_key: member.member_key ?? null } : {}),
      ...(profile ? { profile } : {}),
      recorded_at: new Date().toISOString(),
    };
    writeHeldSlots(all, path);
  } catch {
    // Best effort only: failing to write this note must never fail a
    // checkout that the server already accepted.
  }
}

export function forgetHeldSlot(name, path = heldSlotsPath()) {
  try {
    const all = readHeldSlots(path);
    if (!(name in all)) return;
    delete all[name];
    writeHeldSlots(all, path);
  } catch {
    // Same posture: a release that succeeded server-side stands.
  }
}

// Drop entries whose owning process is dead or was replaced (pid reuse).
// Entries with no pid (pre-#662) cannot be checked and are left alone.
export function pruneHeldSlots(probe, path = heldSlotsPath()) {
  try {
    const all = readHeldSlots(path);
    let changed = false;
    for (const [name, e] of Object.entries(all)) {
      if (e && e.pid && !sameProcess(probe, e.pid, e.starttime)) {
        delete all[name];
        changed = true;
      }
    }
    if (changed) writeHeldSlots(all, path);
  } catch {
    // Housekeeping only: never fail a verb over it.
  }
}

// This session's own live binding for a slot, or null.
function ownHeldEntry(name, cur, probe, path = heldSlotsPath()) {
  if (!cur) return null;
  const e = readHeldSlots(path)[name];
  if (!e || !e.sessionKey || e.sessionKey !== cur.sessionKey) return null;
  if (!sameProcess(probe, e.pid, e.starttime)) return null;
  return e;
}

// Default keeper launcher: detached, stdio to the keeper log, unref'd, so it
// outlives the checkout command and is not tied to this terminal.
// Stop a slot's keeper when the slot is released, rather than letting it
// linger until its next heartbeat 409s. Only signals a pid whose cmdline is
// genuinely `slot keep <name>`, so a recycled lock pid is never killed.
function defaultStopKeeper(name) {
  try {
    const pid = parseInt(readFileSync(join(keeperDir(), `${name}.pid`), 'utf-8'), 10);
    if (!Number.isFinite(pid) || pid === process.pid) return;
    let cmd = '';
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').join(' '); } catch { return; }
    if (!cmd.includes(`slot keep ${name} `) && !cmd.endsWith(`slot keep ${name}`)) return;
    process.kill(pid, 'SIGTERM');
  } catch { /* no keeper, or already gone */ }
}

// Only ever spawn a keeper from the real quox binary. Under a test runner
// process.argv[1] is the runner's worker entry, and spawning it as
// `slot keep` launched a crashing stray process (seen 2026-10-03).
export function isQuoxEntry(argv1) {
  return /(^|[\\/])quox(\.js)?$/.test(String(argv1 || ''));
}

export function validTmuxPane(p) {
  return typeof p === 'string' && /^%\d+$/.test(p);
}

function defaultSpawnKeeper(name, session, profile, claude) {
  if (!isQuoxEntry(process.argv[1])) throw new Error('not running as the quox CLI');
  const dir = keeperDir();
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `${name}.log`), 'a');
  try {
    // The keeper runs DETACHED: once this checkout exits it is re-parented
    // away from claude and could not rediscover the session by walking ppid,
    // so it is told which claude process it serves.
    const args = [process.argv[1], ...(profile ? ['--profile', profile] : []), 'slot', 'keep', name, '--session', session,
      ...(claude && claude.pid ? ['--claude-pid', String(claude.pid), '--claude-start', String(claude.starttime ?? '')] : []),
      // QUOX-CLAUDE-3: the tmux pane this session runs in, so the detached
      // keeper can inject /compact on a remote control request.
      ...(validTmuxPane(process.env.TMUX_PANE) ? ['--tmux-pane', process.env.TMUX_PANE] : [])];
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', fd, fd], env: process.env });
    child.unref();
  } finally {
    closeSync(fd);
  }
}

// P11: "is this name one typo away from a real one?" Capped edit distance;
// we only care about the yes/no, never the exact number.
function isNearMiss(a, b) {
  if (!a || !b) return false;
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  if (x === y) return false;
  if (Math.abs(x.length - y.length) > 2) return false;
  const prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (x[i - 1] === y[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[y.length] <= 2;
}

// Unforgeable authorship (migrations/aee/022): from_label is the caller's
// chosen display name and stays useful (many sessions share one
// authenticated account, so the label is the only thing that tells them
// apart). author_identity is the server-derived, unforgeable field. When
// they agree (the common case, including "no label supplied" — the server
// falls back from_label to the identity) there is nothing extra to show.
// When they disagree, a reader needs to be able to tell WHO actually
// posted, not just what they called themselves — this is exactly the
// impersonation case (a session's posts rendering as "QUOX-SECURITY", a
// different session entirely, because from_label was unchecked free text).
export function formatFromCell(m) {
  const label = m.from || '-';
  const identity = m.author_identity || null;
  if (!identity) return label;
  if (String(label).toLowerCase() === String(identity).toLowerCase()) return label;
  return `${label} [verified: ${identity}]`;
}

// P10: render claim/address state next to the message text. Old servers send
// neither field, so the text is returned untouched.
export function messageText(m) {
  const tags = [];
  if (m.claimed_by) tags.push(`[claimed by ${m.claimed_by}]`);
  if (m.addressed_to) tags.push(`[@${m.addressed_to}]`);
  return tags.length ? `${tags.join(' ')} ${m.text}` : m.text;
}

// Is this message for the member described by held entry `e`? Unaddressed,
// @all and @M<id> are for everyone; @S<n> only for that splinter. @M<id>
// names a mission (QUOXIDENTITY P12), and until missions exist there is no
// registry to resolve it against: matching it to a member key orphaned every
// mission-addressed message (no member ever got a claim step).
function addressedToMe(m, e) {
  const a = m.addressed_to;
  if (!a || a === 'all' || /^M/.test(a)) return true;
  return a === e.splinter;
}

function ageFrom(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Held-but-never-read must be unmistakable at a glance (owner incident,
// 2026-08-22/23: a heartbeating holder that never reads its room looks
// exactly like an attended one). Free/stale slots and a held slot that is
// fully caught up render blank, same as every other empty cell here.
function unreadCell(slot) {
  if (slot.state !== 'held') return null;
  const n = slot.unread_count || 0;
  if (n === 0) return null;
  return slot.last_read_at ? `${n} unread` : `${n} unread (NEVER READ)`;
}

// Stale-since honesty (P1-TRUST slice 3, owner incident: `slot list` showed
// a stale slot's HEARTBEAT as "4m ago" — reading like a live heartbeat, not
// a slot the sweep already gave up on). sweepStale stamps last_heartbeat_at
// to the exact moment it swept a held slot to 'stale' (devSlotsStore.js
// sweepStale), so that timestamp IS "stale since" once state is 'stale';
// the API surfaces it distinctly as `stale_since` (falls back to
// last_heartbeat_at for a response predating that field). HEARTBEAT stays
// exactly what it always was for a held slot; a stale or free slot never
// shows a HEARTBEAT age again, only STALE-SINCE does that job now.
function staleSinceCell(slot) {
  if (slot.state !== 'stale') return null;
  const since = slot.stale_since || slot.last_heartbeat_at || null;
  const age = ageFrom(since);
  return age ? `stale ${age}` : null;
}

function toRow(slot) {
  // Option B assign model (plan v2 note #2831): a free slot with an
  // assigned_to still shows a blank HOLDER, so surface the expected holder
  // in the same column as "-> <name>" rather than adding a new column.
  const holder = slot.holder_session
    || (slot.state === 'free' && slot.assigned_to ? `-> ${slot.assigned_to}` : null);
  // CHANNEL honesty (2026-09-21): the slot row carries discord_channel_id and
  // matrix_room_id once provisioned, but `list` never surfaced them — so a
  // correctly-provisioned slot looked identical to an unprovisioned one, which
  // is exactly why slots read as "not spawning channels". Show which surfaces
  // are wired (full ids stay in --output json and are long/noisy for a table).
  const channel = [
    slot.discord_channel_id ? 'discord' : null,
    slot.matrix_room_id ? 'matrix' : null,
  ].filter(Boolean).join('+') || null;
  return {
    NAME: slot.name,
    STATE: slot.state,
    HOLDER: holder,
    CHANNEL: channel,
    HOST: slot.host_id || null,
    AGE: ageFrom(slot.state === 'held' || slot.state === 'stale' ? slot.checked_out_at : slot.created_at),
    HEARTBEAT: slot.state === 'held' && ageFrom(slot.last_heartbeat_at) ? `${ageFrom(slot.last_heartbeat_at)} ago` : null,
    'STALE-SINCE': staleSinceCell(slot),
    UNREAD: unreadCell(slot),
  };
}

// Room provisioning after a fresh checkout measured ~5s live; 6 x 2.5s
// covers it with margin without hanging a genuinely broken say for long.
const SAY_PROVISION_ATTEMPTS = 6;
const SAY_PROVISION_DELAY_MS = 2500;

const CONTROL_WAIT_MS = 40000;
const CONTROL_WAIT_STEP_MS = 2000;

// quox#757/#733: how long `slot wait` keeps retrying 401/403 after the first
// consecutive auth failure before treating it as real.
const WAIT_AUTH_WINDOW_MS = 10 * 60 * 1000;
// Definitive server refusals: never retried, even inside the window.
const PERMANENT_SLOT_CODES = new Set(['not_slot_holder', 'slot_retired', 'licence_revoked', 'license_revoked']);
function isPermanentSlotRefusal(err) {
  return [err?.code, err?.body?.code, err?.body?.error].some((c) => typeof c === 'string' && PERMANENT_SLOT_CODES.has(c.trim().toLowerCase().replace(/\s+/g, '_')));
}

export function registerSlotCommands(program, ctx) {
  const { client, auth, config } = ctx;
  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  // Injectable process seams (tests): who am I, is that pid alive, launch keeper.
  const deps = {
    claudeSessionInfo,
    probe: makeProcessProbe(procStartTime),
    spawnKeeper: (n, sess, claude) => defaultSpawnKeeper(n, sess, program.opts().profile, claude),
    stopKeeper: defaultStopKeeper,
    ...(ctx.deps || {}),
  };

  // HOLDER-SAY: the profile this invocation runs as (null when unknown, e.g. in tests without a config).
  const profileName = () => { try { return ctx.config?.getActiveProfileName?.() || null; } catch { return null; } };
  const explicitProfile = () => Boolean(ctx.config?._explicitProfile) || Boolean(String(process.env.QUOX_PROFILE || '').trim());
  // HOLDER-SAY: the client a say into `name` as session `from` goes through. The hold is bound server-side to the
  // identity that checked it out; when this box recorded that a DIFFERENT local profile took it, speak through that
  // profile (the same identity, its own credentials). The server's holder check is unchanged: another identity
  // still cannot speak as the holder. An explicit -p / QUOX_PROFILE always wins (the caller said who they are).
  function sayClientFor(name, from) {
    if (!from || explicitProfile()) return { client, profile: null };
    const e = readHeldSlots()[name];
    const cur = profileName();
    if (!e || e.member || e.session !== from || !e.profile || !cur || e.profile === cur) return { client, profile: null };
    try {
      const c = deps.clientForProfile ? deps.clientForProfile(e.profile) : (() => { const cfg = loadConfig(e.profile); return createClient(cfg, createAuth(cfg)); })();
      return c ? { client: c, profile: e.profile } : { client, profile: null };
    } catch { return { client, profile: null }; }
  }

  // Session identity (quox#662). Holder names are free text and every verb
  // used to default differently, so EMAIL-AGENTS vs email-agents 409'd. One
  // rule now: --session wins; else the binding this very Claude session
  // recorded at checkout; else $QUOX_STREAM; else the verb's own fallback.
  function resolveSession(options, name, fallback) {
    const held = ownHeldEntry(name, deps.claudeSessionInfo(), deps.probe);
    if (options.session) {
      if (held && held.session !== options.session) {
        printWarning(`--session ${options.session} differs from the session that holds ${name} from this Claude session (${held.session}); using --session as given.`);
      }
      return options.session;
    }
    if (held) return held.session;
    // P10: held-slots.json is keyed by slot name, so a same-box sibling
    // splinter's attach can own that entry. This session's own attach slot
    // state (per-session dir) is the authority for its label on that slot.
    const att = attachedSlotLabel(name);
    if (att) return att;
    return process.env.QUOX_STREAM || fallback;
  }

  function attachedSlotLabel(name) {
    try {
      const mine = resolveMyAttach();
      if (!mine?.agentId) return null;
      const st = readSlotState(mine.agentId);
      return st && st.name === name && st.session_label ? st.session_label : null;
    } catch {
      return null;
    }
  }

  // SLOTS-REPLY: the slot THIS session holds, sent as from_slot so a reply can reach
  // it (a free-text --session label is not an address). Only this Claude session's
  // own live bindings count; outside Claude, an entry recorded under the same
  // session name. The server re-checks the hold (same_user) and drops a bad claim.
  function senderSlot(from) {
    try {
      const cur = deps.claudeSessionInfo();
      const all = readHeldSlots();
      let mine = Object.entries(all).filter(([, e]) => e && !e.member && (cur
        ? e.sessionKey && e.sessionKey === cur.sessionKey && sameProcess(deps.probe, e.pid, e.starttime)
        : from && String(e.session || '').toLowerCase() === String(from).toLowerCase() && (!e.pid || sameProcess(deps.probe, e.pid, e.starttime))));
      if (!mine.length) {
        const mineAtt = resolveMyAttach();
        const st = mineAtt?.agentId ? readSlotState(mineAtt.agentId) : null;
        return st && st.name ? st.name : null;
      }
      const named = mine.filter(([, e]) => from && e.session === from);
      if (named.length) mine = named;
      mine.sort((a, b) => String(b[1].recorded_at || '').localeCompare(String(a[1].recorded_at || '')));
      return mine[0][0];
    } catch {
      return null;
    }
  }

  // P10: the collector recognises splinter members only via the ATTACH token.
  // When this Claude session is attached to an agent whose recorded slot is
  // `name`, send that token (same noAuth + Authorization pattern as
  // releaseAttachLease); otherwise nothing, so the profile token is used.
  function attachAuthFor(name) {
    try {
      const mine = resolveMyAttach();
      if (!mine?.token) return {};
      const st = readSlotState(mine.agentId);
      if (!st || st.name !== name) return {};
      return { noAuth: true, headers: { Authorization: `Bearer ${mine.token}` } };
    } catch {
      return {};
    }
  }

  const slot = program
    .command('slot')
    .description('Manage DEVSUITE-SLOTS: checkout/release the fixed session addresses, say/read into a slot room')
    // Every slot verb sweeps held-slots.json for entries whose Claude session
    // has exited, so the file cannot accumulate dead bindings.
    .hook('preAction', () => pruneHeldSlots(deps.probe));

  slot
    .command('list')
    .description('List slots for the active org')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.slots.list');
      const data = await client.get(ep.path, { service: ep.service, query: { org_id: resolveOrgId(auth, program) } });
      formatOutput((data.slots || []).map(toRow), {
        format: program.opts().output,
        columns: ['NAME', 'STATE', 'HOLDER', 'CHANNEL', 'HOST', 'AGE', 'HEARTBEAT', 'STALE-SINCE', 'UNREAD'],
        emptyMessage: 'No slots yet. Create one with `quox slot create <name>`.',
        // --json gets the API records (data keys), never the table cells.
        raw: data.slots || [],
      });
      // PRESENCE: who is away (approvals to them queue). Table output only; --json has humans in the records.
      if (program.opts().output !== 'json') for (const h of (data.humans || []).filter((x) => x && x.away)) printInfo(`  ⏸ ${presenceText(h)}`);
    });

  slot
    .command('create')
    .description('Create a new slot')
    .argument('<name>', 'slot name, e.g. builder or t1')
    .action(async (name) => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.slots.create');
      const data = await client.post(ep.path, { service: ep.service, body: { name, org_id: resolveOrgId(auth, program) } });
      formatDetail(data.slot || data, { format: program.opts().output, title: `Slot created: ${name}` });
    });

  slot
    .command('retire')
    .description('Retire (delete) a slot')
    .argument('<name>', 'slot name')
    .option('--delete-channel', 'also delete the slot\'s Discord channel (default: keep it, marked disconnected)')
    .action(async (name, opts = {}) => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.slots.retire');
      const body = { name, retire: true, org_id: resolveOrgId(auth, program) };
      if (opts.deleteChannel) body.delete_channel = true;
      const data = await client.post(ep.path, { service: ep.service, body });
      printSuccess(`Slot ${name} retired.`);
      if (opts.deleteChannel && data.channel) {
        if (data.channel.deleted) printSuccess('Discord channel deleted.');
        else printWarning(`Discord channel NOT deleted${data.channel.error ? `: ${data.channel.error}` : ''}.`);
      }
      if (program.opts().output === 'json') formatDetail(data.slot || data, { format: 'json' });
    });

  const printOrphanNotes = (data) => {
    if (data.orphans_error) printWarning(`Orphan channels: ${data.orphans_error}.`);
    if (data.orphan_count) printInfo(`${data.orphan_count} orphan Discord channel(s) found; ${data.orphans_note || 'not listed for this caller'}.`);
  };

  slot
    .command('prune')
    .description('Retire old unused slots (free, idle longer than --older-than days). Dry run unless --yes')
    .option('--older-than <days>', 'idle threshold in days', '14')
    .option('--keep-channels', 'keep the Discord channels (default: delete them)')
    .option('--keep-orphans', 'skip the orphan Discord channel sweep (channels of slots that no longer exist)')
    .option('--yes', 'actually retire; without it this is a dry run')
    .action(async (opts = {}) => {
      auth.requireAuth();
      const days = Number(opts.olderThan === undefined ? 14 : opts.olderThan);
      if (!Number.isFinite(days) || days < 0) throw new Error('--older-than must be a non-negative number of days');
      const ep = resolveEndpoint('v1.slots.prune');
      const execute = opts.yes === true;
      const data = await client.post(ep.path, {
        service: ep.service,
        body: { older_than_days: days, dry_run: !execute, delete_channels: !opts.keepChannels, include_orphans: !opts.keepOrphans, org_id: resolveOrgId(auth, program) },
      });
      if (!execute) {
        const rows = (data.candidates || []).map((c) => ({ NAME: c.name, 'LAST-ACTIVITY': c.last_activity, CHANNEL: c.discord_channel_id ? 'discord' : '-' }));
        formatOutput(rows, {
          format: program.opts().output,
          columns: ['NAME', 'LAST-ACTIVITY', 'CHANNEL'],
          emptyMessage: `No free slots idle for more than ${days} days.`,
          raw: data.candidates || [],
        });
        if (rows.length) printInfo(`DRY RUN: ${rows.length} slot(s) would be retired. Re-run with --yes to retire these.`);
        printOrphanNotes(data);
        if (Array.isArray(data.orphans) && data.orphans.length) {
          formatOutput(data.orphans.map((o) => ({ SLOT: o.slot_name, CHANNEL: o.channel_id })), {
            format: program.opts().output, columns: ['SLOT', 'CHANNEL'], emptyMessage: 'No orphan channels.', raw: data.orphans,
          });
          printInfo(`${data.orphans.length} orphan Discord channel(s) (no live slot in any org) would be deleted. Re-run with --yes, or --keep-orphans to skip.`);
        }
        return;
      }
      const rows = (data.results || []).map((r) => ({
        NAME: r.name,
        RETIRED: r.retired ? 'yes' : 'no',
        CHANNEL: r.channel ? (r.channel.deleted ? 'deleted' : `kept (${r.channel.error || 'not deleted'})`) : '-',
      }));
      formatOutput(rows, {
        format: program.opts().output,
        columns: ['NAME', 'RETIRED', 'CHANNEL'],
        emptyMessage: 'Nothing to prune.',
        raw: data.results || [],
      });
      printOrphanNotes(data);
      if (Array.isArray(data.orphan_results) && data.orphan_results.length) {
        formatOutput(data.orphan_results.map((o) => ({ SLOT: o.slot_name, CHANNEL: o.channel_id, DELETED: o.deleted ? 'yes' : `no (${o.error || 'not deleted'})` })), {
          format: program.opts().output, columns: ['SLOT', 'CHANNEL', 'DELETED'], emptyMessage: 'No orphan channels.', raw: data.orphan_results,
        });
      }
    });

  slot
    .command('checkout')
    .description('Check out a slot for this session')
    .argument('<name>', 'slot name')
    .option('--session <s>', 'session name holding the slot (default: $QUOX_STREAM, else "unnamed")')
    .option('--kind <kind>', 'interactive|loop', 'interactive')
    .option('--host <h>', 'host_id this session is running on')
    .option('--force', 'take the slot even when it is assigned to another session')
    .option('--create', 'create the slot first if it does not already exist, then check it out')
    .option('--no-keep', 'do not start the background hold keeper (heartbeats every 5m while this Claude session lives)')
    .action(async (name, options) => {
      auth.requireAuth();
      const holderSession = options.session || process.env.QUOX_STREAM || 'unnamed';
      const ep = resolveEndpoint('v1.slots.checkout', { name });
      try {
        const data = await client.post(ep.path, {
          service: ep.service,
          body: {
            holder_session: holderSession, holder_kind: options.kind, host_id: options.host || null,
            org_id: resolveOrgId(auth, program), force: options.force === true, create: options.create === true,
          },
        });
        const joined = data.joined === true ? (data.member || {}) : null;
        if (joined) {
          printSuccess(`Joined slot ${name} as member ${joined.splinter ?? joined.member_key ?? '?'}`);
        } else {
          formatDetail(data.slot || data, { format: program.opts().output, title: `Slot checked out: ${name}` });
        }
        printEvent(events.assigned('quox', `slot ${name}`, holderSession));
        // Record the binding locally so anything on this box that needs to
        // know "which slots are ours" does not have to guess an identity.
        // Found the hard way, 2026-08-23: the slot-inbox hook resolved held
        // slots through $QUOX_STREAM, which a fresh shell inherits stale (a
        // session cannot reliably set it for its own later shells), so the
        // hook silently matched nothing and the very session that shipped it
        // kept missing its own mail. The act of checking out is the only
        // moment the binding is known for certain, so it gets written down
        // here rather than re-derived later.
        const me = deps.claudeSessionInfo();
        recordHeldSlot(name, holderSession, heldSlotsPath(), me, joined, profileName());
        // Owner incident, 2026-08-22/23: "you cant bind to a slot and then
        // immediately ignore the channel it creates". Checkout hands back a
        // live address (a Matrix/Discord room), not just a lock; say so once,
        // and name the exact command that watches it.
        //
        // Slots audit, 2026-10-02 (Discord gripe "dev slots are created for
        // sessions but nothing ever replies"): the soft hint above was not
        // enough. Session ASSISTANTQ checked out, never armed the listener,
        // the owner's Discord message sat unread, and with no heartbeat the
        // hold lapsed after 15m, so its later `say` 403'd too (quox#661).
        // The listener is what makes a slot two-way, so call it REQUIRED and
        // say how to run it so it actually wakes an agent session.
        // Hold keeper (quox#662/B): only under a Claude session; residents and
        // supervisors run their own heartbeats.
        let keeping = false;
        if (me && options.keep !== false) {
          try {
            deps.spawnKeeper(name, holderSession, { pid: me.pid, starttime: me.starttime });
            keeping = true;
            printInfo(`hold keeper running for ${name}: heartbeats every 5m while this Claude session lives (log: ~/.quox/keepers/${name}.log; opt out with --no-keep).`);
          } catch (kerr) {
            printWarning(`could not start the hold keeper (${kerr.message}); keep the hold alive with \`quox slot wait ${name}\`.`);
          }
        }
        printInfo(`${name} is a live address, not just a lock. REQUIRED next: run \`quox slot wait ${name} --session ${holderSession}\` in the background ` +
          `(Claude Code: Bash with run_in_background) and re-arm it after every wake. It is what hears Discord/Matrix replies` +
          (keeping
            ? ': without it replies go unheard (the hold keeper keeps the hold itself).'
            : `, and its heartbeat keeps the hold: without it replies go unheard and the hold lapses after 15m.`));
      } catch (err) {
        if (err instanceof QuoxApiError && err.status === 409) {
          // Two distinct 409s now: someone is HOLDING it, or it is ASSIGNED
          // to someone else and this session is not them.
          if (err.detail?.assigned_to) {
            throw new Error(`slot ${name} is assigned to ${err.detail.assigned_to}; pass --force to take it anyway`);
          }
          const holder = err.detail?.holder_session || 'another session';
          // POKE-WAKE: the server refuses a same-session re-checkout under a different identity (a hold
          // taken as a human, re-checked-out as the resident). When this box's binding proves the hold
          // belongs to THIS claude process, the slot is already ours: refresh the keeper (a newer build
          // replaces an older keeper) instead of failing. Nothing server-side changes.
          const me = deps.claudeSessionInfo();
          const rec = readHeldSlots()[name];
          if (me && holder === holderSession && rec && rec.session === holderSession && !rec.member
              && Number(rec.pid) === Number(me.pid) && String(rec.starttime) === String(me.starttime)) {
            printInfo(`slot ${name} is already held by this session (${holderSession}); refreshing its hold keeper.`);
            if (options.keep !== false) {
              try {
                deps.spawnKeeper(name, holderSession, { pid: me.pid, starttime: me.starttime });
              } catch (kerr) {
                printWarning(`could not start the hold keeper (${kerr.message}).`);
              }
            }
            return;
          }
          throw new Error(`slot ${name} is held by ${holder}`);
        }
        // fleet #449: a bare "404 Not Found: unknown" against an instance
        // that has no such slot (or no SLOTS at all) reads as "you typed the
        // name wrong". Slots are per-instance: say which instance was asked
        // and that the slot may live elsewhere.
        if (err instanceof QuoxApiError && err.status === 404) {
          const base = typeof config?.getBaseUrl === 'function' ? config.getBaseUrl() : 'this instance';
          throw new Error(
            `slot ${name} was not found on ${base}. Slots are per-instance: this one may live on a different ` +
            `Quox instance (point the CLI there with a profile and authenticate first), or SLOTS may not be ` +
            `deployed on this instance at all. \`quox slot list\` shows what THIS instance has.`
          );
        }
        throw err;
      }
    });

  slot
    .command('release')
    .description('Release a slot')
    .argument('<name>', 'slot name')
    .option('--force', 'release even if held by another session')
    .option('--session <s>', 'session name holding the slot (default: $QUOX_STREAM)')
    .action(async (name, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.slots.release', { name });
      const relSession = resolveSession(options, name, undefined);
      const data = await client.post(ep.path, {
        service: ep.service,
        ...attachAuthFor(name),
        body: { holder_session: relSession || undefined, force: !!options.force, org_id: resolveOrgId(auth, program) },
      });
      // Never print a tick the server did not earn: the returned slot must actually be free (or handed to
      // someone else), not still held by the session we just asked to release.
      const after = data?.slot;
      if (after && after.state !== 'free' && !data.promoted && (options.force || (relSession && after.holder_session === relSession))) {
        throw new Error(`slot ${name} was NOT released: the server still shows it ${after.state} by ${after.holder_session || 'unknown'}`);
      }
      formatDetail(data.slot || data, { format: program.opts().output, title: `Slot released: ${name}` });
      printEvent(events.released('quox', `slot ${name}`, relSession || 'this box'));
      forgetHeldSlot(name);
      try { deps.stopKeeper(name); } catch { /* best effort */ }
    });

  slot
    .command('control')
    .description('Send a control command to the session holding a slot (owner/admin only). Commands: compact, status')
    .argument('<name>', 'slot name')
    .argument('<command>', 'control command (compact | status | wake)')
    .option('--wait', 'wait up to 40s for the keeper to ack and print its answer (always on for status)')
    .action(async (name, command, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const ep = resolveEndpoint('v1.slots.control', { name });
      const data = await client.post(ep.path, {
        service: ep.service,
        body: { command, org_id: orgId },
      });
      printEvent(events.updated('quox', `slot ${name} control ${command}`, data.control_id, 'requested'));
      if (command !== 'status' && !options.wait) return;
      const get = resolveEndpoint('v1.slots.control.get', { name, id: data.control_id });
      for (let waited = 0; waited < CONTROL_WAIT_MS; waited += CONTROL_WAIT_STEP_MS) {
        await sleep(CONTROL_WAIT_STEP_MS);
        const row = await client.get(get.path, { service: get.service, query: { org_id: orgId } });
        if (row && row.status && row.status !== 'pending') {
          console.log(`${row.status}: ${row.result || '(no result)'}`);
          return;
        }
      }
      printWarning(`requested, no answer yet after ${CONTROL_WAIT_MS / 1000}s (control ${data.control_id}); the keeper may be down or the session not under tmux`);
    });

  slot
    .command('heartbeat')
    .description('Send a heartbeat for a held slot')
    .argument('<name>', 'slot name')
    .option('--session <s>', 'session name holding the slot (default: $QUOX_STREAM)')
    .action(async (name, options) => {
      auth.requireAuth();
      const holderSession = resolveSession(options, name, 'unnamed');
      const ep = resolveEndpoint('v1.slots.heartbeat', { name });
      const data = await client.post(ep.path, { service: ep.service, ...attachAuthFor(name), body: { holder_session: holderSession, org_id: resolveOrgId(auth, program) } });
      formatDetail(data.slot || data, { format: program.opts().output, title: `Heartbeat: ${name}` });
    });

  slot
    .command('assign')
    .description('Assign a slot to an expected holder (session name); slot stays free until claimed')
    .argument('<name>', 'slot name')
    .argument('[session]', 'session name to assign as the expected holder')
    .option('--clear', 'clear the assignment')
    .action(async (name, session, options) => {
      auth.requireAuth();
      if (!options.clear && !session) throw new Error('provide a session name, or use --clear to unassign');
      const ep = resolveEndpoint('v1.slots.assign', { name });
      const data = await client.post(ep.path, {
        service: ep.service,
        body: { assigned_to: options.clear ? null : session, org_id: resolveOrgId(auth, program) },
      });
      formatDetail(data.slot || data, { format: program.opts().output, title: `Slot ${name} assignment updated` });
      printSuccess(options.clear ? `${name} unassigned.` : `${name} assigned to ${session}.`);
    });

  slot
    .command('claim')
    .description('Claim every free slot assigned to this session')
    // "claim" and "checkout" are near-synonyms and only one takes a slot
    // name, so `claim <name>` is a natural reach (the owner hit it live,
    // 2026-08-21). Catch the positional and name the verb they wanted
    // instead of commander's bare "too many arguments".
    .argument('[name]', 'with <messageId>: the shared slot whose message to claim')
    .argument('[messageId]', 'claim this one message (P10 shared slot) instead of assigned slots')
    .option('--session <s>', 'session name (default: $QUOX_STREAM)')
    .action(async (name, messageId, options) => {
      if (name && messageId) {
        // P10 SPLINTER-2: atomic per-message claim (200 claimed / 409 claimed_by).
        auth.requireAuth();
        const from = resolveSession(options, name, null);
        const mep = resolveEndpoint('v1.slots.messageClaim', { name, id: messageId });
        try {
          await client.post(mep.path, {
            service: mep.service,
            ...attachAuthFor(name),
            body: { ...(from ? { holder_session: from } : {}), org_id: resolveOrgId(auth, program) },
          });
        } catch (err) {
          if (err instanceof QuoxApiError && err.status === 409) {
            const by = err.detail?.claimed_by || err.body?.claimed_by || 'another member';
            printWarning(`Already claimed by ${by}`);
            process.exitCode = 1;
            return;
          }
          throw err;
        }
        printSuccess(`Claimed message ${messageId} in ${name}`);
        return;
      }
      if (name) {
        throw new Error(
          `claim takes no slot name: it claims every free slot assigned to your session. `
          + `To take one specific slot, use: quox slot checkout ${name} --session <your-session>`,
        );
      }
      auth.requireAuth();
      const session = options.session || process.env.QUOX_STREAM;
      if (!session) throw new Error('no session name: pass --session or set QUOX_STREAM');
      const ep = resolveEndpoint('v1.slots.claim');
      const data = await client.post(ep.path, {
        service: ep.service,
        body: { session, org_id: resolveOrgId(auth, program) },
      });
      const claimed = data.claimed || [];
      if (claimed.length > 0) {
        printSuccess(`Claimed: ${claimed.join(', ')}`);
      } else {
        // P11: claiming nothing was reported as a SUCCESS, which is how a
        // typo'd assign turned into a slot sitting "awaiting claim" forever
        // with nobody aware. Zero claims is a warning, and when an assignment
        // exists under a near-miss name we say so, because that is almost
        // always what happened.
        printWarning(`No slots are assigned to "${session}", so nothing was claimed.`);
        try {
          const listEp = resolveEndpoint('v1.slots.list');
          const listed = await client.get(listEp.path, {
            service: listEp.service,
            query: { org_id: resolveOrgId(auth, program) },
          });
          const waiting = (listed.slots || []).filter((s) => s.assigned_to);
          const near = waiting.filter((s) => isNearMiss(session, s.assigned_to));
          if (near.length) {
            for (const s of near) {
              printInfo(`  slot "${s.name}" is waiting for "${s.assigned_to}" — did you mean --session ${s.assigned_to}?`);
            }
          } else if (waiting.length) {
            printInfo(`  slots waiting on a claim: ${waiting.map((s) => `${s.name} -> ${s.assigned_to}`).join(', ')}`);
          } else {
            printInfo('  no slot in this org is waiting for a claim. Assign one first with `quox slot assign`.');
          }
        } catch {
          // The claim result is the answer; the hint is a bonus, never a failure.
        }
      }
      if (program.opts().output === 'json') formatDetail(data, { format: 'json' });
    });

  // QUOXON-ROOMS: a slot is a group room. join = subscribe + post without holding it (checkout stays the
  // exclusive task-ownership concept). Membership is server-side, org-scoped.
  async function joinRoom(name, session, person) {
    const ep = resolveEndpoint('v1.slots.join', { name });
    return client.post(ep.path, { service: ep.service, ...attachAuthFor(name), body: { session, ...(person ? { person } : {}), org_id: resolveOrgId(auth, program) } });
  }
  slot
    .command('join')
    .description('Join a slot as a room: read its live stream and post to it without holding it')
    .argument('<name>', 'slot name')
    .option('--session <s>', 'session name to join as (default: $QUOX_STREAM)')
    .option('--person <p>', 'who you act for, shown as "session (person)"')
    .action(async (name, options) => {
      auth.requireAuth();
      const session = options.session || process.env.QUOX_STREAM;
      if (!session) throw new Error('no session name: pass --session or set QUOX_STREAM');
      const data = await joinRoom(name, session, options.person);
      printSuccess(data.already ? `${session} is already in ${name}.` : `${session} joined ${name}. Read: quox slot wait ${name} --session ${session}; post: quox slot say ${name} --room --session ${session} <text>`);
    });
  slot
    .command('leave')
    .description('Leave a slot room you joined (does not release a hold)')
    .argument('<name>', 'slot name')
    .option('--session <s>', 'session name (default: $QUOX_STREAM)')
    .action(async (name, options) => {
      auth.requireAuth();
      const session = options.session || process.env.QUOX_STREAM;
      if (!session) throw new Error('no session name: pass --session or set QUOX_STREAM');
      const ep = resolveEndpoint('v1.slots.leave', { name });
      const data = await client.post(ep.path, { service: ep.service, ...attachAuthFor(name), body: { session, org_id: resolveOrgId(auth, program) } });
      printSuccess(data.removed ? `${session} left ${name}.` : `${session} was not in ${name}.`);
    });
  slot
    .command('rooms')
    .description('List the slot rooms a session has joined')
    .option('--session <s>', 'session name (default: $QUOX_STREAM)')
    .action(async (options) => {
      auth.requireAuth();
      const session = options.session || process.env.QUOX_STREAM;
      if (!session) throw new Error('no session name: pass --session or set QUOX_STREAM');
      const ep = resolveEndpoint('v1.slots.rooms');
      const data = await client.get(ep.path, { service: ep.service, query: { session, org_id: resolveOrgId(auth, program) } });
      formatOutput((data.rooms || []).map((r) => ({ ROOM: r.slot_name, JOINED: r.joined_at })), {
        format: program.opts().output, columns: ['ROOM', 'JOINED'], emptyMessage: `${session} has joined no rooms.`, raw: data.rooms || [],
      });
    });

  slot
    .command('say')
    .description("Say something into a slot's Matrix room (use - to read a multi-line, Markdown message from stdin)")
    .argument('<name>', 'slot name')
    .argument('<text...>', 'message text')
    .option('--session <s>', 'session name to speak as (default: $QUOX_STREAM)')
    .option('--room', 'post as a joined room member (no hold needed); signed "session (person)" by the server')
    .option('--run <command>', 'ask the human to run ONE command in their own terminal (the text is why); the quox TUI shows it in full and runs it only on their y. Never run server-side')
    .action(async (name, textParts, options) => {
      auth.requireAuth();
      // SLOT-RUN: same rule as the collector (one line, max 2000, no control/bidi characters), checked before sending.
      if (options.run !== undefined) {
        const run = String(options.run);
        if (!run.trim()) throw new Error('--run is empty');
        if (run.length > 2000) throw new Error('--run too long (max 2000 characters)');
        if (/[\u0000-\u001f\u007f\u0080-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/.test(run)) throw new Error('--run must be one command on one line, without control, bidi or zero-width characters');
      }
      // `say <name> -` reads the message from stdin (owner 2026-10-05: slot
      // channels were "enormous single paragraphs" because multi-line text is
      // awkward as a shell argument). Line breaks and Markdown survive as-is.
      let text = textParts.join(' ');
      if (textParts.length === 1 && textParts[0] === '-') {
        const input = ctx.stdin || process.stdin;
        let buf = '';
        for await (const chunk of input) buf += chunk;
        text = buf.replace(/\s+$/, '');
        if (!text.trim()) throw new Error('empty message on stdin; nothing to say');
      }
      // Never send the literal "unnamed": it made a post unattributable, so
      // own-post filters could not recognise the sender's own messages and
      // leaked them back as unread mail (a self-loop for a resident). With
      // no session name, send nothing and let the server attribute from the
      // authenticated identity.
      const from = resolveSession(options, name, null);
      const ep = resolveEndpoint('v1.slots.say', { name });
      if (options.room && !from) throw new Error('--room needs a session: pass --session or set QUOX_STREAM');
      const body = { text, ...(options.room ? { room_session: from } : from ? { from } : {}), org_id: resolveOrgId(auth, program) };
      if (options.run !== undefined) body.run = String(options.run);
      // SLOTS-REPLY: carry the sender's own slot so the recipient's reply reaches it.
      // A room post already has its address (the room), so it carries none.
      const fromSlot = options.room ? null : senderSlot(from);
      if (fromSlot) body.from_slot = fromSlot;
      // A freshly created slot gets its Matrix room a few seconds AFTER
      // checkout returns (provisioning is async), so a say straight after
      // checkout used to fail with 409 "no Matrix room yet" (slots audit
      // 2026-10-02, measured ~5s). Ride out exactly that race; any other
      // 409 is real and surfaces immediately.
      let data;
      const sayVia = options.room ? { client, profile: null } : sayClientFor(name, from);
      if (sayVia.profile) printInfo(`Speaking as profile ${sayVia.profile}: it checked out ${name} for ${from}, and the hold is bound to its identity.`);
      for (let attempt = 1; ; attempt += 1) {
        try {
          data = await sayVia.client.post(ep.path, { service: ep.service, ...attachAuthFor(name), body });
          break;
        } catch (err) {
          // The collector sends {error: '<text>'}, which the client stores
          // as err.code, so read every field the text can land in.
          const said = err instanceof QuoxApiError
            ? [err.message, err.code, err.body?.error, err.body?.message].filter(Boolean).join(' ') : '';
          const pending = err instanceof QuoxApiError && err.status === 409 && /no Matrix room yet/i.test(said);
          if (pending && attempt < SAY_PROVISION_ATTEMPTS) {
            await sleep(SAY_PROVISION_DELAY_MS);
            continue;
          }
          if (err instanceof QuoxApiError && err.status === 403 && !err.detail?.holder_session && /not the current holder|not slot holder/i.test(said)) {
            // quox#661: the hold LAPSED (no heartbeat, so the 15m TTL freed
            // it) and the bare "held by nobody" read as a permissions bug.
            const s = from || '<session>';
            throw new Error(
              `you no longer hold slot ${name}: the hold lapsed (no heartbeat for 15m) or was released. ` +
              `Re-claim it with \`quox slot checkout ${name} --session ${s}\`, then keep \`quox slot wait ${name} --session ${s}\` ` +
              `running in the background so replies are heard and the hold stays fresh.`
            );
          }
          // A non-holder who has joined the room: post as a room member instead of failing.
          if (err instanceof QuoxApiError && err.status === 403 && !options.room && from && /not (the current )?slot holder/i.test(said)) {
            try {
              data = await client.post(ep.path, { service: ep.service, ...attachAuthFor(name), body: { ...body, from: undefined, room_session: from } });
              break;
            } catch { /* not a member either: surface the original error with its join hint */ }
          }
          // HOLDER-SAY: the session name matches the hold, but this CLI speaks as a different identity than the one
          // that took it (e.g. the default profile changed since checkout). Never bypassed: say exactly what to do.
          if (err instanceof QuoxApiError && err.status === 403 && from && err.detail?.holder_session === from && /not (the current )?slot holder|not the current holder/i.test(said)) {
            throw new Error(
              `${name} is held by ${from}, but that hold is bound to the identity that checked it out, and this CLI ` +
              `(profile ${profileName() || 'default'}) speaks as a different one. Say it as the profile that checked it out ` +
              `(\`quox -p <that profile> slot say ${name} --session ${from} ...\`), or re-take the hold as this identity: ` +
              `\`quox slot release ${name} --session ${from} && quox slot checkout ${name} --session ${from}\`.`
            );
          }
          throw err;
        }
      }
      printSuccess(`Said into ${name}.`);
      if (!options.room && !fromSlot) {
        printWarning(`${from || 'This session'} holds no slot, so replies cannot reach it. Claim one: quox slot checkout <name> --create --session ${from || '<session>'}`);
      } else if (fromSlot && data?.from_slot_dropped) {
        printWarning(`${fromSlot} was not accepted as your reply address (${data.from_slot_dropped}), so replies cannot reach you; re-check it out: quox slot checkout ${fromSlot} --session ${from || '<session>'}`);
      }
      reportPresence(name, data?.presence);
      reportHumanPresence(data?.human_presence);
      reportBridgeDelivery(data?.bridges);
      if (program.opts().output === 'json') formatDetail(data, { format: 'json' });
    });

  // QUOXON-BROADCAST: one call fans a message out to every held slot in the org (or --slots).
  slot
    .command('broadcast')
    .description('Broadcast a message to every held slot in this org (--slots to pick, --priority urgent, --ack to track acknowledgements)')
    .argument('<text...>', 'message text')
    .option('--slots <list>', 'comma-separated slot names instead of every held slot')
    .option('--priority <p>', 'normal or urgent', 'normal')
    .option('--ack', 'ask recipients to acknowledge with /ack <id>')
    .option('--session <s>', 'session name to sign as (default: $QUOX_STREAM)')
    .action(async (textParts, options) => {
      auth.requireAuth();
      const parsed = parseBroadcastArgs([
        options.slots ? `--slots ${options.slots}` : '', `--priority ${options.priority}`, options.ack ? '--ack' : '', textParts.join(' '),
      ].filter(Boolean).join(' '));
      if (!parsed.ok) throw new Error(parsed.message);
      const from = options.session || process.env.QUOX_STREAM || null;
      const ep = resolveEndpoint('v1.slots.broadcast');
      const data = await client.post(ep.path, {
        service: ep.service, retries: 0,
        body: { text: parsed.text, priority: parsed.priority, ack: parsed.ack, ...(parsed.slots ? { slots: parsed.slots } : {}), ...(from ? { from } : {}), org_id: resolveOrgId(auth, program) },
      });
      if (program.opts().output === 'json') return formatDetail(data, { format: 'json' });
      for (const [line, kind] of broadcastSummary(data)) (kind === 'warn' ? printWarning : printInfo)(line);
      reportHumanPresence(data?.human_presence);
      return undefined;
    });

  slot
    .command('broadcast-status')
    .description('Delivered / acknowledged / awaiting counts for a broadcast')
    .argument('<id>', 'broadcast id (bc_...)')
    .action(async (id) => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.slots.broadcast.get', { id });
      const data = await client.get(ep.path, { service: ep.service, retries: 0, query: { org_id: resolveOrgId(auth, program) } });
      if (program.opts().output === 'json') return formatDetail(data, { format: 'json' });
      printInfo(deliveryLine(data));
      for (const d of data.deliveries || []) printInfo(`  ${d.slot}: ${d.status}${d.room ? `, room ${d.room}` : ''}${d.acked ? ', acknowledged' : ''}`);
      return undefined;
    });

  slot
    .command('ack')
    .description('Acknowledge a broadcast on behalf of a slot you hold')
    .argument('<id>', 'broadcast id (bc_...)')
    .requiredOption('--slot <name>', 'the slot acknowledging')
    .action(async (id, options) => {
      auth.requireAuth();
      const a = parseAckArgs(id);
      if (!a.ok) throw new Error(a.message);
      const ep = resolveEndpoint('v1.slots.broadcast.ack', { id });
      const data = await client.post(ep.path, { service: ep.service, retries: 0, body: { slot: options.slot, org_id: resolveOrgId(auth, program) } });
      if (program.opts().output === 'json') return formatDetail(data, { format: 'json' });
      printSuccess(`Acknowledged ${id} as ${options.slot}. ${deliveryLine(data)}`);
      return undefined;
    });

  /**
   * Print what actually reached each bridge.
   *
   * Why this exists (2026-08-18): `slot say` printed "Said into demo." in the
   * same second the collector logged a 502 rendering that line to Telegram. The
   * say genuinely had succeeded (the durable record is the cache row and the
   * AEE envelope), so reporting failure would have been wrong too. What was
   * missing was the SECOND half of the truth: where the line went, and where it
   * did not. The owner's report was "I say something and never see it", and
   * nothing on screen could tell them which bridge was broken.
   *
   * Silent when no bridges are configured: an org that has not set one up does
   * not need a line about it on every say.
   */
  function agoText(iso) {
    const m = iso ? Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)) : null;
    return m == null || Number.isNaN(m) ? 'a while ago' : m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
  }
  // PRESENCE (owner 2026-10-16): the human this slot belongs to is away; approvals will queue. Silent otherwise.
  function reportHumanPresence(hp) {
    if (hp && hp.away && hp.notice) printInfo(`  ⏸ ${hp.notice}`);
  }
  // Same wording as the TUI (quoxon/slotChat presenceLine). Silent when an older server sends no presence.
  function reportPresence(name, presence) {
    if (!presence || !presence.state) return;
    if (presence.state === 'listening') printInfo(`  ✔ delivered to ${name} (listening now)`);
    else if (presence.state === 'nobody_holds') printInfo(`  · nobody holds this slot`);
    else printInfo(`  · not listening right now (${presence.last_checked_in_at ? `last checked in ${agoText(presence.last_checked_in_at)}` : 'no check-in on record'})`);
  }
  function reportBridgeDelivery(bridges) {
    if (!Array.isArray(bridges) || bridges.length === 0) return;
    for (const b of bridges) {
      const where = b.target ? `${b.platform} (${b.target})` : b.platform || 'bridge';
      if (b.ok === true) printInfo(`  rendered to ${where}`);
      else if (b.ok === null) printInfo(`  ${where}: still sending, check \`quox slot read\``);
      else printWarning(`  NOT rendered to ${where}: ${b.reason}`);
    }
  }

  async function readMessages(name, options) {
    auth.requireAuth();
    const ep = resolveEndpoint('v1.slots.messages', { name });
    const query = {};
    if (options.since) query.since = options.since;
    if (options.limit) query.limit = options.limit;
    // Passing the session marks the channel read up to now, but only when
    // this session is genuinely the current holder (the collector enforces
    // that, same as wait): a bystander reading with --session set to
    // someone else's name marks nobody caught up.
    const session = resolveSession(options, name, null);
    if (session) query.holder_session = session;
    query.org_id = resolveOrgId(auth, program);
    const data = await client.get(ep.path, { service: ep.service, ...attachAuthFor(name), query });
    formatOutput((data.messages || []).map((m) => ({
      TIME: m.created_at, FROM: formatFromCell(m), SOURCE: m.source, TEXT: messageText(m),
    })), {
      format: program.opts().output,
      columns: ['TIME', 'FROM', 'SOURCE', 'TEXT'],
      emptyMessage: `No messages yet in ${name}.`,
      // --json gets the API records (created_at/from/source/text), never
      // the table cells — same rule as slot list.
      raw: data.messages || [],
    });
  }

  slot
    .command('read')
    .description("Read a slot's recent room messages (cached; see quox slot peek for the last few)")
    .argument('<name>', 'slot name')
    .option('--since <ts>', 'only messages after this ISO-8601 timestamp')
    .option('--limit <n>', 'max messages (default 50)', (v) => parseInt(v, 10))
    .option('--session <s>', 'your session name: marks the channel read if you are the current holder (default: $QUOX_STREAM)')
    .action(readMessages);

  slot
    .command('peek')
    .description('Alias of `quox slot read <name> --limit 10`')
    .argument('<name>', 'slot name')
    .option('--session <s>', 'your session name: marks the channel read if you are the current holder (default: $QUOX_STREAM)')
    .action((name, options) => readMessages(name, { ...options, limit: 10 }));

  slot
    .command('wait')
    .description('Block until someone speaks into the slot (long-poll; heartbeats your hold while waiting)')
    .argument('<name>', 'slot name')
    .option('--session <s>', 'your session name: heartbeats the hold and filters out your own says (default: $QUOX_STREAM)')
    .option('--since <ts>', 'resume from this ISO-8601 cursor (from a previous wait timeout)')
    .option('--timeout <mins>', 'give up after this many minutes of silence (default: wait forever)', (v) => parseFloat(v))
    .option('--once', 'single server round-trip (~50s max), exit even if silent')
    .option('--join', 'join the slot as a room first (read without holding it; your own posts are not echoed)')
    .option('--also <slots>', 'also listen on these peer slots (comma-separated, read-only): hear replies another session posts in ITS slot')
    .action(async (name, options) => {
      if (options.also) return waitMany(name, options);
      // Why this verb exists (2026-08-22): slot read-back is pull, and a
      // holding session that forgets to poll is deaf to its own channel; the
      // owner's Discord replies sat unread on quoxperticus-126's first day.
      // One background `quox slot wait` is the product-shaped watcher: it
      // exits the moment a message lands (waking whatever spawned it), and
      // the server heartbeats the hold on every round-trip, replacing the
      // separate heartbeat loop too.
      auth.requireAuth();
      const session = resolveSession(options, name, null);
      if (options.join) {
        if (!session) throw new Error('--join needs a session: pass --session or set QUOX_STREAM');
        await joinRoom(name, session, null);
      }
      const ep = resolveEndpoint('v1.slots.wait', { name });
      const deadline = Number.isFinite(options.timeout) && options.timeout > 0
        ? Date.now() + options.timeout * 60 * 1000
        : null;
      let cursor = options.since || null;
      let netFailures = 0;
      let authSince = null; // start of the current run of consecutive 401/403s

      for (;;) {
        const query = { org_id: resolveOrgId(auth, program), timeout_ms: 50000 };
        if (cursor) query.since = cursor;
        if (session) {
          if (!options.join) query.holder_session = session; // a room member does not hold
          query.exclude_from = session;
        }
        let data;
        try {
          data = await client.get(ep.path, { service: ep.service, ...attachAuthFor(name), query, timeout: 65000 });
          netFailures = 0;
          authSince = null;
        } catch (err) {
          // An unattended watcher must ride through transient faults (a
          // collector redeploy mid-long-poll killed the first live one with
          // a bare timeout, 2026-08-22). Retry with backoff; only give up
          // after a sustained outage, and never swallow real API refusals
          // (403/404 mean something is actually wrong with the call).
          // 401 is retried within the same bounded budget: an auth-service
          // restart answers 401 for a minute or two, and treating that as
          // fatal killed every listening session during a deploy (OPUSIUS,
          // 2026-10-03). A genuinely dead token still exits after ~4 min.
          //
          // Transient faults (collector down, 5xx/429, a re-auth that hit
          // rate_limited while the auth service restarts) back off with
          // capped jittered exponential delay (Retry-After honoured) and
          // keep waiting for as long as the wait's own --timeout allows
          // (quox#747/#752/#753). Only a 401 is bounded, and only a
          // definitive auth refusal / user timeout ends the wait.
          const transient = err instanceof QuoxNetworkError
            || err?.transient === true
            || (err instanceof QuoxApiError && (err.status >= 500 || err.status === 429));
          // 401/403 are transient for a bounded WINDOW of time (not a count):
          // a collector restart answers 401 (auth warming) or 403 (licence
          // lease not loaded yet) for a minute or two (quox#733/#757). Only
          // an auth failure persisting past the window, or a body code the
          // server marks permanent, ends the wait.
          const authRetry = err instanceof QuoxApiError && (err.status === 401 || err.status === 403)
            && !isPermanentSlotRefusal(err);
          if (!(transient || authRetry) || options.once) throw err;
          if (authRetry) {
            if (authSince === null) authSince = Date.now();
            if (Date.now() - authSince >= WAIT_AUTH_WINDOW_MS) throw err;
          } else {
            authSince = null;
          }
          netFailures += 1;
          let delay = Math.min(2000 * 2 ** Math.min(netFailures - 1, 5), 60000);
          delay = Math.round(delay * (0.75 + Math.random() * 0.5));
          if (Number.isFinite(err.retryAfterMs)) delay = Math.min(Math.max(delay, err.retryAfterMs), 300000);
          if (deadline && Date.now() + delay >= deadline) {
            printInfo(`No messages in ${name} (collector unreachable: ${err.message}). Resume with --since ${cursor || '<none>'}`);
            process.exitCode = 1;
            return;
          }
          printWarning(`wait: ${err.message}, retry ${netFailures} in ${Math.round(delay / 1000)}s`);
          await sleep(delay);
          continue;
        }
        cursor = data.cursor || cursor;

        // quox#662/C: a wait whose hold is gone used to warn once and keep
        // polling forever: deaf AND unheld. Exit non-zero so whatever
        // supervises this process (the Claude background-task wake) notices.
        const holdLost = !!session && !options.join && data.held === false;
        const holdLostLine = `HOLD LOST: ${name} is no longer held by ${session}; re-run quox slot checkout ${name} --session ${session}`;

        if ((data.messages || []).length > 0) {
          formatOutput(data.messages.map((m) => ({
            TIME: m.created_at, FROM: formatFromCell(m), SOURCE: m.source, TEXT: messageText(m),
          })), {
            format: program.opts().output,
            columns: ['TIME', 'FROM', 'SOURCE', 'TEXT'],
            raw: data.messages,
          });
          printInfo(`  resume cursor: ${cursor}`);
          if (holdLost) {
            printWarning(holdLostLine);
            process.exitCode = 3;
            return;
          }
          // Seer, 2026-10-03: the wake worked, then the session researched
          // its answer for 28 minutes without a word and without re-arming,
          // so the owner saw silence and the hold went stale. Every wake now
          // carries the two moves that keep a slot alive, in order.
          const s = session || '<session>';
          // P10: a member of a shared slot must win the claim before answering,
          // or two splinters answer the same message.
          const mine = ownHeldEntry(name, deps.claudeSessionInfo(), deps.probe);
          if (mine && mine.member === true) {
            const needing = data.messages.filter((m) => m.id != null && !m.claimed_by && addressedToMe(m, mine));
            if (needing.length > 0) {
              printInfo(`  CLAIM before answering (shared slot, first claim wins; a 409 means another member has it):`);
              for (const m of needing) printInfo(`    quox slot claim ${name} ${m.id} --session ${s}`);
            }
          }
          printInfo(`  NEXT, before any long work: (1) acknowledge now: quox slot say ${name} "seen, on it" --session ${s}`);
          printInfo(`  (2) re-arm in the background: quox slot wait ${name} --session ${s} --since ${cursor}`);
          printInfo('  then do the work and post the full answer with say. The hold lapses 15m after the last wait.');
          return;
        }

        if (holdLost) {
          printWarning(holdLostLine);
          process.exitCode = 3;
          return;
        }

        if (options.once || (deadline && Date.now() >= deadline)) {
          printInfo(`No messages in ${name}. Resume with --since ${cursor}`);
          process.exitCode = 1;
          return;
        }
      }
    });

  slot
    .command('keep', { hidden: true })
    .description('Background hold keeper: heartbeat a held slot every 5m until the owning Claude session exits (spawned by checkout)')
    .argument('<name>', 'slot name')
    .option('--session <s>', 'session name holding the slot')
    .option('--claude-pid <pid>', 'pid of the claude session this keeper serves (passed by checkout)')
    .option('--claude-start <ticks>', 'start ticks of that claude process (guards against pid reuse)')
    .option('--tmux-pane <pane>', 'tmux pane id the session runs in (remote control target, e.g. %3)')
    .action(async (name, options) => {
      auth.requireAuth();
      const session = resolveSession(options, name, null);
      if (!session) throw new Error('no session name: pass --session');
      const orgId = resolveOrgId(auth, program);
      const me = options.claudePid
        ? { pid: Number(options.claudePid), starttime: options.claudeStart || null }
        : deps.claudeSessionInfo();
      const hb = resolveEndpoint('v1.slots.heartbeat', { name });
      const rel = resolveEndpoint('v1.slots.release', { name });
      const pend = resolveEndpoint('v1.slots.control.pending', { name });
      const tmuxPane = validTmuxPane(options.tmuxPane) ? options.tmuxPane : (validTmuxPane(process.env.TMUX_PANE) ? process.env.TMUX_PANE : null);
      const res = await runKeeper({
        name, session, claude: me, probe: deps.probe,
        // KEEPER-REEXEC: track the installed build; on a change start a successor with the SAME
        // args (this keeper has already dropped its lock) and exit, keeping the hold.
        buildId: () => readInstalledBuild(CLI_DIR),
        reexec: () => {
          if (!isQuoxEntry(process.argv[1])) throw new Error('not running as the quox CLI');
          const fd = openSync(join(keeperDir(), `${name}.log`), 'a');
          try {
            spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: ['ignore', fd, fd], env: process.env }).unref();
          } finally { closeSync(fd); }
        },
        sleep: ctx.sleep,
        tmuxPane,
        pollControl: async () => {
          const data = await client.get(pend.path, { service: pend.service, query: { holder_session: session, org_id: orgId } });
          return data.pending || [];
        },
        ackControl: (id, status, result) => {
          const ack = resolveEndpoint('v1.slots.control.ack', { name, id });
          return client.post(ack.path, { service: ack.service, body: { holder_session: session, org_id: orgId, status, result } });
        },
        heartbeat: () => client.post(hb.path, { service: hb.service, body: { holder_session: session, org_id: orgId } }),
        release: () => client.post(rel.path, { service: rel.service, body: { holder_session: session, force: false, org_id: orgId } }),
        forget: () => forgetHeldSlot(name),
      });
      process.exitCode = res.code;
    });

  // quox#691 cross-slot deafness: two sessions in conversation each reply in
  // their OWN slot, so a session listening only on its own never hears the
  // answer. --also polls peer slots too, in short parallel rounds. Only the
  // session's own slot is heartbeated / marked read; peers are read-only.
  async function waitMany(name, options) {
    auth.requireAuth();
    const session = resolveSession(options, name, null);
    const peers = String(options.also).split(',').map((x) => x.trim()).filter((x) => x && x !== name);
    const slots = [name, ...peers];
    const cursors = Object.fromEntries(slots.map((sl) => [sl, options.since || null]));
    const deadline = Number.isFinite(options.timeout) && options.timeout > 0 ? Date.now() + options.timeout * 60 * 1000 : null;
    for (;;) {
      const rounds = await Promise.all(slots.map(async (sl) => {
        const ep = resolveEndpoint('v1.slots.wait', { name: sl });
        const query = { org_id: resolveOrgId(auth, program), timeout_ms: 15000 };
        if (cursors[sl]) query.since = cursors[sl];
        if (session) {
          query.exclude_from = session;
          if (sl === name) query.holder_session = session;
        }
        try {
          const data = await client.get(ep.path, { service: ep.service, query, timeout: 30000 });
          cursors[sl] = data.cursor || cursors[sl];
          return { slot: sl, messages: data.messages || [] };
        } catch (err) {
          printWarning(`wait: ${sl}: ${err.message}`);
          return { slot: sl, messages: [] };
        }
      }));
      const heard = rounds.flatMap((r) => r.messages.map((m) => ({ ...m, slot: r.slot })));
      if (heard.length) {
        formatOutput(heard.map((m) => ({ SLOT: m.slot, TIME: m.created_at, FROM: formatFromCell(m), SOURCE: m.source, TEXT: m.text })), {
          format: program.opts().output, columns: ['SLOT', 'TIME', 'FROM', 'SOURCE', 'TEXT'], raw: heard,
        });
        for (const sl of slots) printInfo(`  resume cursor ${sl}: ${cursors[sl]}`);
        return;
      }
      if (options.once || (deadline && Date.now() >= deadline)) {
        printInfo(`No messages in ${slots.join(', ')}.`);
        process.exitCode = 1;
        return;
      }
    }
  }

  // DEVSUITE-SLOTS Phase 9 — governed, org-scoped bridge-room config
  // (replaces QUOX_SLOT_BRIDGE_ROOM / QUOX_SLOT_DISCORD_ROOM as the primary
  // source; the env vars remain a fallback only, per no-env-only-config).
  const bridge = slot
    .command('bridge')
    .description('Manage the Telegram/Discord rooms a slot `say` renders into');

  bridge
    .command('list')
    .description('Show the configured bridge rooms for the active org')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.slots.bridges.list');
      const data = await client.get(ep.path, { service: ep.service, query: { org_id: resolveOrgId(auth, program) } });
      const rooms = data.bridges || {};
      const details = data.details || {};
      // Phase 10: show WHY a bridge is trusted, not just which room id was
      // typed. An unset row and a set-but-never-verified row used to look
      // identical here, which is how a bridge that rendered to nobody kept
      // reading as configured.
      formatOutput(
        ['telegram', 'discord'].map((platform) => {
          const d = details[platform] || null;
          let status = '(unset)';
          if (rooms[platform]) {
            if (!d || d.verified_at == null) status = 'unverified';
            else status = d.verified_ok ? 'verified' : 'FAILING';
          }
          return {
            PLATFORM: platform,
            ROOM: rooms[platform] || '(unset)',
            STATUS: status,
            CHANNEL: (d && d.channel_label) || '',
          };
        }),
        {
          format: program.opts().output,
          columns: ['PLATFORM', 'ROOM', 'STATUS', 'CHANNEL'],
          emptyMessage: 'No bridge rooms configured.',
        }
      );
    });

  bridge
    .command('set')
    .description('Set the bridge room for a platform (telegram|discord)')
    .argument('<platform>', 'telegram or discord')
    .argument('<room_id>', 'Matrix room id, e.g. !abc:quox')
    .option('--force', 'store the room even if it cannot be verified (it will be shown as unverified)')
    .action(async (platform, roomId, opts) => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.slots.bridges.set', { platform });
      // Phase 10: the collector now PROVES the room carries a slot line to
      // this platform before storing it, so the interesting path here is the
      // refusal. Print the probe's reason and the remediation rather than
      // letting a bare 422 surface, because "unprocessable entity" tells a
      // user nothing about a mis-typed room id.
      let data;
      try {
        data = await client.put(ep.path, {
          service: ep.service,
          body: { room_id: roomId, org_id: resolveOrgId(auth, program), force: !!opts.force },
        });
      } catch (err) {
        if (err instanceof QuoxApiError && err.status === 422) {
          const detail = err.detail || {};
          printWarning(`Not stored: ${err.message}`);
          const probe = detail.probe;
          if (probe) {
            printInfo(`  room reachable by our relay puppet: ${probe.deliverable ? 'yes' : 'no'}`);
            printInfo(`  is a ${platform} portal: ${probe.bridged ? 'yes' : 'no'}`);
            if (probe.delivery_error) printInfo(`  join error: ${probe.delivery_error}`);
            if (probe.other_protocols?.length) printInfo(`  bridged instead to: ${probe.other_protocols.join(', ')}`);
          }
          printInfo('Re-run with --force to store it anyway (it will be listed as unverified).');
          process.exitCode = 1;
          return;
        }
        throw err;
      }
      const entry = data.entry || null;
      if (entry && entry.verified_ok) {
        printSuccess(`${platform} bridge room set to ${roomId} (verified${entry.channel_label ? `: ${entry.channel_label}` : ''}).`);
      } else {
        printWarning(`${platform} bridge room set to ${roomId} but UNVERIFIED. Slot lines may render nowhere.`);
      }
      if (program.opts().output === 'json') formatDetail(data, { format: 'json' });
    });

  bridge
    .command('clear')
    .description('Clear the bridge room for a platform (telegram|discord)')
    .argument('<platform>', 'telegram or discord')
    .action(async (platform) => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.slots.bridges.set', { platform });
      const data = await client.put(ep.path, {
        service: ep.service,
        body: { room_id: null, org_id: resolveOrgId(auth, program) },
      });
      printSuccess(`${platform} bridge room cleared.`);
      if (program.opts().output === 'json') formatDetail(data, { format: 'json' });
    });
}
