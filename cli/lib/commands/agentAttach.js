/**
 * QuoxIdentity P1 attach commands — docs/QUOXIDENTITY_P1_CONTRACT.md, territory C.
 *
 * `quox agent attach <agentId>` leases an agent from AUTH (single-active lease,
 * grant-checked), fetches the ATTACH KIT from the COLLECTOR using the minted
 * attach JWT, and installs it locally under ~/.quox/attach/<agentId>/ so a
 * live Claude Code / Codex session can read its assigned system prompt, tool
 * scope, and lease. Registered from cli/lib/commands/agent.js onto the shared
 * `agent` subcommand, per the contract's "follow the file's existing
 * subcommand registration style" instruction.
 *
 * Local install (all files 0600, matching config.js's session-file posture):
 *   ~/.quox/attach/<agentId>/kit.json   — the collector's kit response verbatim
 *   ~/.quox/attach/<agentId>/token      — the raw attach JWT
 *   ~/.quox/attach/<agentId>/ATTACHED.md — rendered instructions for the session
 *
 * kit.json's own `lease.id` field IS the local record of "which lease does
 * this box currently hold for this agent" — detach/heartbeat read it back
 * rather than inventing a second state file, since the kit is only ever
 * written after both the lease and the kit fetch succeeded.
 *
 * P3 (docs/QUOXIDENTITY_P3_CONTRACT.md, territory G) adds slot-binding
 * awareness on top of the P1/P2 lease/handoff mechanism: an agent identity
 * can own a durable slot ADDRESS (dev_slots row). Lease = identity hold,
 * slot checkout = voice hold; the two are separate by design. This file
 * reuses the slot HTTP shapes already declared in cli/lib/api/endpoints/v1.js
 * (v1.slots.checkout / v1.slots.release) rather than re-declaring them, and
 * reuses cli/lib/commands/slot.js's held-slots ledger helpers
 * (recordHeldSlot/forgetHeldSlot) so the slot-inbox hook still recognises a
 * slot this box holds via an attach, exactly as it would a plain
 * `quox slot checkout`.
 *
 *   ~/.quox/attach/<agentId>/slot.json — {name, session_label}: local record
 *   of "did THIS session check out the agent's bound slot", used to decide
 *   whether detach owes a slot release. Not written when the kit carries no
 *   bound slot, --no-slot was passed, or the checkout itself failed (a 409
 *   held-elsewhere leaves nothing for this session to release later).
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, readdirSync, renameSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { formatDetail, printInfo } from '../core/output.js';
import { events, line, printEvent } from '../core/quoxglyph.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { QuoxError, QuoxApiError } from '../core/errors.js';
import { resolveOrgId, parseJSON } from './helpers.js';
import { recordHeldSlot, forgetHeldSlot, isQuoxEntry } from './slot.js';
import { runKeeper, keeperDir, makeProcessProbe } from '../core/slotKeeper.js';
import { buildSelfIdentity } from '../core/supervisorEngine.js';
import { resolveAgentId } from '../core/agentAlias.js';
import { kitHasBrainContext, buildBrainPrimer, saveHandoffNote } from '../core/brainPrime.js';
import { decisionProvenance } from './brain.js';

export function attachRoot() {
  return join(homedir(), '.quox', 'attach');
}

// QUOXIDENTITY P9 — session-scoped attach. The original layout stored attach
// state flat at ~/.quox/attach/<agentId>/, shared by EVERY shell session on the
// box, and resolution assumed a single "sole" attach per host. The moment a
// second session attached to a second agent, both sessions' lease-aware routing
// (memory/exec/whoami) went ambiguous — the "single resident" design flaw.
//
// Fix: bind attach state to the session. Each session already carries a stable
// per-session id in its environment (QUOX_T, the house session convention, set
// once at session start and inherited by every child process — unlike a shell
// `export`, which does not survive across a Claude session's separate Bash
// calls). New attaches live under ~/.quox/attach/sessions/<sessionKey>/<agent>/
// so two sessions on one box are isolated. The legacy flat path stays READABLE
// for backward compatibility (a session attached under the old CLI keeps working
// until it re-attaches).

const SESSIONS_SUBDIR = 'sessions';

function sanitizeKey(raw) {
  // Strip anything but a safe path segment, then leading dots so a key can
  // never resolve to a parent (e.g. '..' would otherwise point at attachRoot).
  return String(raw || '').trim().replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '') || null;
}

function readProcName(pid) {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
  } catch {
    return null;
  }
}

function readProcStat(pid) {
  // /proc/<pid>/stat: the comm field (2nd) is parenthesised and may contain
  // spaces/parens, so split AFTER the last ')'. Then rest[1]=ppid, rest[3]=sid.
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const rp = s.lastIndexOf(')');
    const rest = s.slice(rp + 2).trim().split(/\s+/);
    // rest[0] is stat field 3, so field 22 (starttime, clock ticks since boot)
    // is rest[19]. It guards against pid reuse: pid+starttime identifies a
    // process for the life of the boot.
    return { ppid: parseInt(rest[1], 10), sid: parseInt(rest[3], 10), starttime: rest[19] || null };
  } catch {
    return null;
  }
}

function readProcCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
  } catch {
    return null;
  }
}

// Claude Code records each live session's current name (including /rename)
// in <config>/sessions/<pid>.json. Read ONLY the `name` field: sibling
// <pid>.*.key files in that directory are secrets and are never opened.
function readClaudeSessionFileName(pid) {
  try {
    const dir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'sessions');
    const data = JSON.parse(readFileSync(join(dir, `${Number(pid)}.json`), 'utf-8'));
    return typeof data?.name === 'string' && data.name.trim() ? data.name.trim() : null;
  } catch {
    return null;
  }
}

const defaultProcReader = { name: readProcName, stat: readProcStat, cmdline: readProcCmdline, sessionName: readClaudeSessionFileName };

/**
 * The Claude Code session NAME: the live name Claude Code records for the
 * nearest `claude` ancestor (covers /rename), else the `--resume <NAME>` on
 * its cmdline. null when there is
 * no claude ancestor or it was not started with --resume.
 */
export function claudeSessionName(reader = defaultProcReader, startPid = process.pid) {
  try {
    const pid = findClaudeAncestor(reader, startPid);
    if (!pid) return null;
    const fromFile = reader.sessionName ? reader.sessionName(pid) : null;
    if (fromFile) return fromFile;
    const raw = reader.cmdline ? reader.cmdline(pid) : null;
    if (!raw) return null;
    const argv = raw.split('\0');
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === '--resume' && argv[i + 1]) return argv[i + 1];
      if (argv[i].startsWith('--resume=') && argv[i].length > 9) return argv[i].slice(9);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Session label precedence: --label, then the Claude session name, then
 * QUOX_STREAM (advisory only: a stale `export` in a shell rc labelled every
 * splinter the same, 2026-10-03).
 */
export function resolveSessionLabel({ label, env = process.env, lookup = claudeSessionName } = {}) {
  return label || lookup() || env.QUOX_STREAM || undefined;
}

/** Nearest ancestor process named `claude` (pid), or null. */
function findClaudeAncestor(reader = defaultProcReader, startPid = process.pid) {
  let pid = startPid;
  for (let hop = 0; hop < 24; hop += 1) {
    if (reader.name(pid) === 'claude') return pid;
    const st = reader.stat(pid);
    if (!st || !st.ppid || st.ppid === pid || pid === 1) break;
    pid = st.ppid;
  }
  return null;
}

/**
 * Identity of the Claude session this process runs under:
 * { sessionKey: 'claude-<pid>', pid, starttime } or null (off-Linux, or no
 * `claude` ancestor). starttime is /proc/<pid>/stat field 22; with the pid
 * it survives pid reuse. Reuses the same walk as autoSessionKey.
 */
export function claudeSessionInfo(reader = defaultProcReader, startPid = process.pid) {
  try {
    const pid = findClaudeAncestor(reader, startPid);
    if (!pid) return null;
    const st = reader.stat(pid);
    if (!st || !st.starttime) return null;
    return { sessionKey: `claude-${pid}`, pid, starttime: st.starttime };
  } catch {
    return null;
  }
}

/** Process start ticks for a pid (null when it does not exist). */
export function procStartTime(pid) {
  const st = readProcStat(pid);
  return st ? st.starttime : null;
}

/**
 * Derive a stable per-session key AUTOMATICALLY from the process tree — no env
 * var, no setup. Walk the ancestry: the nearest `claude` ancestor PID is stable
 * for the life of a Claude Code session (every command it runs descends from
 * that one process, even though each shell invocation is fresh). For a plain
 * human terminal there is no `claude` ancestor, so fall back to the POSIX
 * session id, which is stable per login/terminal. Returns null only when the
 * process tree is unreadable (e.g. no /proc), where callers degrade to the
 * single-attach behaviour.
 */
function autoSessionKey() {
  const claudePid = findClaudeAncestor();
  if (claudePid) return `claude-${claudePid}`;
  const self = readProcStat(process.pid);
  return self && self.sid ? `sid-${self.sid}` : null;
}

/**
 * The current session's stable key. Automatic by default (derived from the
 * process tree, see autoSessionKey). QUOX_ATTACH_SESSION is an optional
 * explicit override for scripts/power users; normal use needs nothing.
 */
export function sessionKey() {
  const override = sanitizeKey(process.env.QUOX_ATTACH_SESSION);
  if (override) return override;
  try {
    return autoSessionKey();
  } catch {
    return null;
  }
}

function sessionsRoot() {
  return join(attachRoot(), SESSIONS_SUBDIR);
}

function sessionScopedDir(agentId, key = sessionKey()) {
  return key ? join(sessionsRoot(), key, agentId) : null;
}

function legacyFlatDir(agentId) {
  return join(attachRoot(), agentId);
}

/**
 * Resolve the on-disk attach directory for an agent from THIS session's point
 * of view. Read-biased so it returns whichever location actually holds state:
 * the session-scoped dir if it exists, else the legacy flat dir if that holds a
 * token (compat), else the session-scoped path a new attach should WRITE to.
 * With no session key at all it degrades to the original flat behaviour, so a
 * genuinely single-session box is unchanged.
 */
export function attachDir(agentId) {
  const key = sessionKey();
  if (!key) return legacyFlatDir(agentId);
  const scoped = sessionScopedDir(agentId, key);
  if (existsSync(scoped)) return scoped;
  const legacy = legacyFlatDir(agentId);
  if (existsSync(join(legacy, 'token'))) return legacy;
  return scoped; // new attach for this session writes here
}

/**
 * Resolve which agent THIS session is acting as, and its attach token.
 * Precedence:
 *   1. QUOX_ATTACH_AGENT env override (explicit "I am <agent>").
 *   2. A keyed session (every Claude session, and any terminal with a POSIX
 *      session id) sees ONLY its own subtree: exactly one attach there, else
 *      null. It never borrows an unowned flat attach — an un-attached session
 *      is itself, not whichever agent some other session happens to hold.
 *   3. Only a genuinely keyless caller (no /proc, no session id) falls back to
 *      a single legacy flat attach (pre-P9 single-session compat).
 * Note: this is the IMPLICIT "which am I" resolution. Explicit named access
 * (attachDir(agentId), used by exec/detach/heartbeat) still honours a legacy
 * flat attach, so a pre-P9 session keeps working for the agent it names.
 * Returns { agentId, token } or null when there is no attach or it is
 * genuinely ambiguous (more than one in scope with no override).
 */
export function resolveMyAttach() {
  const readToken = (dir) => {
    try {
      const t = readFileSync(join(dir, 'token'), 'utf-8').trim();
      return t || null;
    } catch {
      return null;
    }
  };

  // 1. explicit override
  const override = (process.env.QUOX_ATTACH_AGENT || '').trim();
  if (override) {
    const token = readToken(attachDir(override));
    return token ? { agentId: override, token } : null;
  }

  // 2. keyed session: this session's own subtree only, no borrowing.
  const key = sessionKey();
  if (key) {
    const dir = join(sessionsRoot(), key);
    const sole = soleAttachIn(dir);
    if (!sole) return null;
    const token = readToken(join(dir, sole));
    return token ? { agentId: sole, token } : null;
  }

  // 3. keyless caller only: single legacy flat attach (pre-P9 compat).
  const sole = soleAttachIn(attachRoot(), { skip: [SESSIONS_SUBDIR] });
  if (sole) {
    const token = readToken(legacyFlatDir(sole));
    if (token) return { agentId: sole, token };
  }

  return null;
}

/**
 * Like resolveMyAttach but says WHY it is null: 'none' vs 'ambiguous'
 * (keyed session with more than one attach, or a legacy flat set).
 */
export function myAttachState() {
  const one = resolveMyAttach();
  if (one) return { state: 'one', ...one };
  if ((process.env.QUOX_ATTACH_AGENT || '').trim()) return { state: 'none', names: [] };
  const key = sessionKey();
  const names = key
    ? attachNamesIn(join(sessionsRoot(), key))
    : attachNamesIn(attachRoot(), { skip: [SESSIONS_SUBDIR] });
  return { state: names.length > 1 ? 'ambiguous' : 'none', names };
}

/** Names of attach dirs (those holding a token) directly under `dir`, minus `skip`. */
function attachNamesIn(dir, { skip = [] } = {}) {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !skip.includes(e.name))
    .filter((e) => existsSync(join(dir, e.name, 'token')))
    .map((e) => e.name);
}

/** The single attach dir name directly under `dir`, or null if zero or >1. */
function soleAttachIn(dir, opts) {
  const names = attachNamesIn(dir, opts);
  return names.length === 1 ? names[0] : null;
}

export function kitPath(agentId) {
  return join(attachDir(agentId), 'kit.json');
}

export function tokenPath(agentId) {
  return join(attachDir(agentId), 'token');
}

export function instructionsPath(agentId) {
  return join(attachDir(agentId), 'ATTACHED.md');
}

// QUOXIDENTITY P9 (docs/QUOXIDENTITY_SPLINTER_CONTRACT.md, territory B): the
// session-scoped `splinter` file holds one line `S<n> <live count incl. self>`
// so statuslines/hooks can read it without an API call.
export function splinterPath(agentId) {
  return join(attachDir(agentId), 'splinter');
}

/** Atomic (tmp + rename) write of the splinter file. Never throws. */
export function writeSplinterFile(agentId, id, count) {
  try {
    const dir = attachDir(agentId);
    mkdirSync(dir, { recursive: true });
    const path = splinterPath(agentId);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${id} ${count}\n`, 'utf-8');
    renameSync(tmp, path);
  } catch {
    // A statusline convenience file must never fail an attach/heartbeat.
  }
}

/** Normalise a lease-create `splinter` payload (absent on old servers => S1 alone). */
export function splinterInfoFrom(splinter) {
  const siblings = Array.isArray(splinter?.siblings) ? splinter.siblings : [];
  const ordinal = Number.isInteger(splinter?.ordinal) ? splinter.ordinal : 1;
  const id = splinter?.id || `S${ordinal}`;
  return { id, ordinal, siblings, count: siblings.length + 1, present: !!splinter };
}

function fmtAge(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return 'unknown';
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

/**
 * Best-effort recount from the status route after a heartbeat. Old servers
 * return no `splinters` array: leave the file untouched. Never throws.
 */
async function refreshSplinterFile(client, agentId, leaseId) {
  try {
    const ep = resolveEndpoint('agent-attach.status', { agentId });
    const data = await client.get(ep.path, { service: ep.service });
    const list = data?.splinters;
    if (!Array.isArray(list) || list.length === 0) return;
    let id = list.find((x) => x.lease_id === leaseId)?.id;
    if (!id) {
      try { id = readFileSync(splinterPath(agentId), 'utf-8').trim().split(/\s+/)[0]; } catch { /* none */ }
    }
    writeSplinterFile(agentId, id || 'S1', list.length);
  } catch {
    // heartbeat succeeded; the recount is a convenience
  }
}

/**
 * Did a tool result report failure? Governed tools are inconsistent about their
 * result envelope (autonomous loop, 2026-09-21: some return {success:false},
 * some {ok:false}, and the negative may be a boolean OR the string 'no'), so a
 * naive `data.success !== false` check let {ok:false} failures slip through as a
 * green ✔. Treat a NEGATIVE `success` or `ok` (boolean false or 'no'/'false')
 * as failure; absence of both is treated as success (many read tools return
 * neither and are fine). The root-cause envelope inconsistency is filed against
 * the tool layer; this is the CLI reading defensively.
 */
export function execResultFailed(data) {
  if (!data || typeof data !== 'object') return false;
  const negative = (v) => v === false || v === 'no' || v === 'false';
  return negative(data.success) || negative(data.ok);
}

/** The first human-readable error string a failed tool result carries, or a default. */
function execResultError(data) {
  return (data && (data.error || data.error_code || data.reason || data.message)) || 'tool reported failure';
}

/** Decode a JWT's `exp` (unix seconds) without verifying the signature, or null. */
function decodeJwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * QUOXIDENTITY finding-10: the attach token JWT is short-lived (~900s) and only
 * a heartbeat refreshes it. A session that works for a while without an explicit
 * heartbeat finds the token expired, and the NEXT governed call (exec, or the
 * detach handoff — which runs at the very end of a session) 401s, losing the
 * exit-handoff exactly when continuity matters most. SEER read this as a
 * handoff-specific auth bug; it is token expiry (the LEASE may still be alive
 * server-side while the local token JWT has lapsed).
 *
 * Refresh-on-use: if the stored token is within `graceSec` of expiry (or gone),
 * heartbeat the lease FIRST. The heartbeat authenticates with the caller's own
 * (resident/holder) session, NOT the attach token, so it succeeds and mints a
 * fresh attach token even after the old one expired — as long as the lease
 * lives. Returns the freshest token available; never throws. If the heartbeat
 * fails (lease genuinely dead), returns the stale token so the caller surfaces
 * a clear re-attach error rather than a bare 401.
 */
export async function ensureFreshAttachToken(client, agentId, { graceSec = 60 } = {}) {
  let token;
  try {
    token = readFileSync(tokenPath(agentId), 'utf-8').trim();
  } catch (err) {
    throw new Error(
      `Not attached as "${agentId}" (no stored attach token at ${tokenPath(agentId)}). `
      + `Run \`quox agent attach ${agentId}\` first.`
    );
  }

  const exp = decodeJwtExp(token);
  const now = Math.floor(Date.now() / 1000);
  if (exp && exp - now > graceSec) return token; // still comfortably valid

  const stored = readStoredKit(agentId);
  const leaseId = stored?.lease?.id;
  if (!leaseId) return token;

  try {
      const ep = resolveEndpoint('agent-attach.lease.heartbeat', { leaseId });
      const data = await client.post(ep.path, { service: ep.service, body: {} });
      if (data?.token) {
        writeFile0600(tokenPath(agentId), `${data.token}\n`);
        token = data.token;
        const newExpiry = data?.lease?.expires_at || data?.expires_at || null;
        if (newExpiry && stored?.lease) {
          stored.lease.expires_at = newExpiry;
          if (data?.lease?.id) stored.lease.id = data.lease.id;
          writeFile0600(kitPath(agentId), `${JSON.stringify(stored, null, 2)}\n`);
        }
        await refreshSplinterFile(client, agentId, leaseId);
      }
    } catch {
      // Lease likely dead (heartbeat 401/404) — return the stale token; the
      // caller's request will surface the clear "re-attach" error path.
    }
    return token;
  }

  // P3: local record of "this session checked out the agent's bound slot" —
  // see the file header comment. Read by detach to decide whether it owes a
  // slot release; cleared implicitly when removeAttachDir() removes the whole
  // attach directory.
  export function slotStatePath(agentId) {
    return join(attachDir(agentId), 'slot.json');
  }

  function writeFile0600(path, content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort only (e.g. Windows): a failed chmod must not fail an
      // attach the server already granted.
    }
  }

  /** Read back the locally-installed kit for an agent, or null if not attached. */
  export function readStoredKit(agentId) {
    const p = kitPath(agentId);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
      return null;
    }
  }

  /** P3: read back the locally checked-out slot for an agent, or null if none. */
  export function readSlotState(agentId) {
    const p = slotStatePath(agentId);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
      return null;
    }
  }

  /** P3: record that this session checked out the agent's bound slot. */
  export function writeSlotState(agentId, state) {
    writeFile0600(slotStatePath(agentId), `${JSON.stringify(state, null, 2)}\n`);
  }

  /**
   * Render ATTACHED.md: the honesty preamble is VERBATIM from the contract
   * (docs/QUOXIDENTITY_P1_CONTRACT.md CLI section), plus the system prompt,
   * tool scope, and lease id/expiry the session needs to operate.
   */
  /** Compact input signature for a tool from its kit schema: `(host*, port)`. */
  export function toolInputSig(schema) {
    const props = (schema && schema.input_schema && schema.input_schema.properties) || {};
    const required = new Set((schema && schema.input_schema && schema.input_schema.required) || []);
    const names = Object.keys(props);
    if (names.length === 0) return '()';
    return `(${names.map((n) => (required.has(n) ? `${n}*` : n)).join(', ')})`;
  }

  /** One tool-scope line: `- name(sig): first sentence of description`. */
  function renderToolLine(name, toolSchemas) {
    const sc = toolSchemas && toolSchemas[name];
    if (!sc) return `- ${name}`;
    const desc = typeof sc.description === 'string' && sc.description
      ? ` — ${sc.description.split(/\. /)[0].replace(/\.$/, '')}`
      : '';
    return `- ${name}${toolInputSig(sc)}${desc}`;
  }

  export function renderAttachedInstructions({ agentId, kit, splinter }) {
    const tools = Array.isArray(kit?.tools) ? kit.tools : [];
    const lease = kit?.lease || {};
    const lines = [
      `# Attached as ${agentId}`,
      '',
      `You are attached as ${agentId}. Platform calls with the attach token act AS this agent`,
      'and are witnessed. Local tools are not constrained by this kit; honour the tool scope.',
      '',
      `Lease: ${lease.id || 'unknown'} (expires ${lease.expires_at || 'unknown'})`,
      ...(splinter?.present ? [
        `You are ${kit?.display_name || agentId} splinter ${splinter.id} (${splinter.count} live session${splinter.count === 1 ? '' : 's'})`
          + (splinter.siblings.length
            ? `; siblings: ${splinter.siblings.map((x) => `${x.id} ${x.session_label || '(no label)'}`).join(', ')}`
            : ''),
      ] : []),
      '',
      // F6 (QuoxIdentity CLI finding-fix): the lease expires unless renewed.
      // Sessions that ran long tasks without a heartbeat found the lease had
      // quietly expired underneath them; name the fix inline, not just on
      // attach-status.
      `Plain quox verbs in this session now act as ${agentId} by default; use --as self (or -p <profile>) to act as yourself.`,
      '',
      `For sustained work, heartbeat to hold the lease: \`quox agent attach-heartbeat ${agentId}\`.`,
      '',
      '## System prompt',
      '',
      kit?.system_prompt || '(none provided)',
      '',
      '## Tool scope',
      '',
      // Each tool shows its input signature from kit.tool_schemas (fields marked *
      // are required), so an attached session calls it right the first time
      // instead of probing with `{}` (2026-09-21 tooling audit, top finding).
      tools.length
        ? `${tools.map((t) => renderToolLine(t, kit?.tool_schemas)).join('\n')}\n\n(fields marked * are required; call with \`quox agent exec ${agentId} --tool <name> --input '<json>'\`)`
        : '(no tools listed)',
      '',
      // P3 (docs/QUOXIDENTITY_P3_CONTRACT.md, territory G): the agent's bound
      // slot is a durable ADDRESS; messaging it reaches whichever session
      // currently holds the attach lease, regardless of which slot is checked
      // out. Only rendered when the kit actually carries one (older kits or
      // unbound agents keep the plain P1/P2 file shape).
      ...(kit?.slot?.name ? [
        '## Your address',
        '',
        `This agent has a durable address: **${kit.slot.name}**. Speak into it with`,
        `\`quox slot say ${kit.slot.name} "..."\` (keep it short, 1-2 lines) and read`,
        `it with \`quox slot read ${kit.slot.name}\`.`,
        '',
      ] : []),
      '## Detach ritual',
      '',
      'Before detaching, write a handoff note (what state you left things in, open threads,',
      'and next moves) and detach with it, so the next session attached to this agent resumes',
      'with continuity instead of starting cold:',
      '',
      `\`quox agent detach ${agentId} --handoff-text "<state, open threads, next moves>"\``,
      '',
      `or \`quox agent detach ${agentId} --handoff <file>\` for a longer note.`,
      '',
      `Detach without a handoff: \`quox agent detach ${agentId}\` (releases the lease only).`,
      '',
    ];
    return lines.join('\n');
  }

  /** Install the kit + token + rendered instructions. Returns the three paths. */
  export function installAttachKit(agentId, { kit, token, splinter }) {
    mkdirSync(attachDir(agentId), { recursive: true });
    writeFile0600(kitPath(agentId), `${JSON.stringify(kit, null, 2)}\n`);
    writeFile0600(tokenPath(agentId), `${token}\n`);
    writeFile0600(instructionsPath(agentId), renderAttachedInstructions({ agentId, kit, splinter }));
    return { kitPath: kitPath(agentId), tokenPath: tokenPath(agentId), instructionsPath: instructionsPath(agentId) };
  }

  export function removeAttachDir(agentId) {
    const dir = attachDir(agentId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  function noLocalLeaseError(agentId, verb) {
    return new Error(
      `No local attach state for "${agentId}" (expected ${kitPath(agentId)}). `
      + `Run \`quox agent attach ${agentId}\` first, then \`quox agent ${verb} ${agentId}\`.`
    );
  }

  /**
   * One attach-lease heartbeat: extends the lease, rotates the stored token if
   * one is issued, persists the fresh expiry into kit.json and refreshes the
   * splinter file. Shared by `attach-heartbeat` and the background keeper.
   */
export async function heartbeatAttachLease(client, agentId, { getOrgId } = {}) {
  const stored = readStoredKit(agentId);
  const leaseId = stored?.lease?.id;
  // No local kit means the session already detached: that is "hold lost" to
  // the keeper (404), not a retryable failure.
  if (!leaseId) throw new QuoxApiError(404, 'no_local_lease', `No local attach state for "${agentId}"`);

  const ep = resolveEndpoint('agent-attach.lease.heartbeat', { leaseId });
  const data = await client.post(ep.path, { service: ep.service, body: {} });

  if (data?.token) {
    writeFile0600(tokenPath(agentId), `${data.token}\n`);
    printInfo(`  token rotated: ${tokenPath(agentId)}`);
  }
  const newExpiry = data?.lease?.expires_at || data?.expires_at || null;
  // Persist the extended expiry back into kit.json so whoami and the
  // attach expiry-warning read the FRESH deadline, not the stale one from
  // the original attach. Without this, a successful heartbeat still shows
  // "about to expire" everywhere the stored kit is read (SEER-TERMINAL F6).
  if (newExpiry && stored?.lease) {
    stored.lease.expires_at = newExpiry;
    if (data?.lease?.id) stored.lease.id = data.lease.id;
    writeFile0600(kitPath(agentId), `${JSON.stringify(stored, null, 2)}\n`);
  }
  await refreshSplinterFile(client, agentId, leaseId);
  await heartbeatBoundSlot(client, agentId, getOrgId);
  return { leaseId, expires: newExpiry || 'unchanged' };
}

/**
 * P10: keep the bound slot (or this session's membership of it) alive with the
 * ATTACH token. Failures are logged, never fatal to the lease heartbeat.
 */
async function heartbeatBoundSlot(client, agentId, getOrgId) {
  const slotState = readSlotState(agentId);
  if (!slotState?.name) return;
  try {
    const attachToken = readFileSync(tokenPath(agentId), 'utf-8').trim();
    const orgId = getOrgId ? getOrgId() : undefined;
    const ep = resolveEndpoint('v1.slots.heartbeat', { name: slotState.name });
    await client.post(ep.path, {
      service: ep.service,
      noAuth: true,
      headers: { Authorization: `Bearer ${attachToken}` },
      body: {
        holder_session: slotState.session_label,
        ...(slotState.member_key ? { member_key: slotState.member_key } : {}),
        ...(orgId ? { org_id: orgId } : {}),
      },
    });
  } catch (err) {
    const status = err instanceof QuoxApiError ? err.status : 'network error';
    printEvent(events.warned('quox', `slot ${slotState.name}`, `heartbeat failed (${status})`));
  }
}

/**
 * Detach WITHOUT a handoff: release the bound slot (warn-only), post the
 * witnessed detach notice (warn-only), release the lease, remove local state.
 * Shared by `agent detach` and the keeper's session-gone release.
 */
export async function releaseAttachLease({ client, auth, program, agentId, leaseId, reason = 'detach' }) {
  const slotState = readSlotState(agentId);
  if (slotState?.name) {
    const slotEp = resolveEndpoint('v1.slots.release', { name: slotState.name });
    try {
      // P10: attach token so a member release removes only its own membership.
      const slotToken = readFileSync(tokenPath(agentId), 'utf-8').trim();
      await client.post(slotEp.path, {
        service: slotEp.service,
        noAuth: true,
        headers: { Authorization: `Bearer ${slotToken}` },
        body: { holder_session: slotState.session_label, force: false, org_id: resolveOrgId(auth, program) },
      });
      forgetHeldSlot(slotState.name);
      printEvent(events.released('quox', `slot ${slotState.name}`, slotState.session_label));
    } catch (err) {
      const status = err instanceof QuoxApiError ? err.status : 'network error';
      printEvent(events.warned('quox', `slot ${slotState.name}`, `release failed (${status}), continuing detach`));
    }
  }

  // P4 (docs/QUOXIDENTITY_P4_CONTRACT.md section 5): detach witnessing
  // symmetry. Warn-only: a missed witness must never block the detach.
  try {
    const attachToken = readFileSync(tokenPath(agentId), 'utf-8').trim();
    const detachEp = resolveEndpoint('agent-attach.detach');
    await client.post(detachEp.path, {
      service: detachEp.service,
      noAuth: true,
      headers: { Authorization: `Bearer ${attachToken}` },
      body: { lease_id: leaseId, reason },
    });
  } catch (err) {
    const status = err instanceof QuoxApiError ? err.status : 'network error';
    printEvent(events.warned('quox', `detach notice ${agentId}`, `failed (${status}), continuing detach`));
  }

  const ep = resolveEndpoint('agent-attach.lease.release', { leaseId });
  await client.post(ep.path, { service: ep.service, body: {} });
  removeAttachDir(agentId);
  printEvent(events.released('quox', `attach ${agentId}`, `lease ${String(leaseId).slice(0, 8)}`));
}

// ---- attach-lease auto-heartbeat keeper (reuses core/slotKeeper.runKeeper) ----

const keeperName = (agentId) => `attach-${agentId}`;

/** Is `cmd` genuinely `agent keep <agentId>` of the quox CLI? */
export function isAttachKeeperCmd(cmd, agentId) {
  const c = String(cmd || '').split('\0').join(' ');
  if (!/quox/.test(c)) return false;
  return c.includes(`agent keep ${agentId} `) || c.endsWith(`agent keep ${agentId}`);
}

/**
 * Stop this agent's keeper (detach). Only signals a pid whose cmdline is
 * verifiably the keeper, so a recycled lock pid is never killed.
 */
export function stopAttachKeeper(agentId, { dir = keeperDir(), readCmd, kill = process.kill.bind(process) } = {}) {
  try {
    const pid = parseInt(readFileSync(join(dir, `${keeperName(agentId)}.pid`), 'utf-8'), 10);
    if (!Number.isFinite(pid) || pid === process.pid) return;
    const cmd = (readCmd || ((p) => readFileSync(`/proc/${p}/cmdline`, 'utf-8')))(pid);
    if (!isAttachKeeperCmd(cmd, agentId)) return;
    kill(pid, 'SIGTERM');
  } catch { /* no keeper, or already gone */ }
}

/**
 * Spawn the detached keeper. Same guard as slot.js defaultSpawnKeeper: only
 * ever from the real quox binary. QUOX_ATTACH_SESSION pins the keeper (which is
 * re-parented away from claude) to the attach state of the session it serves.
 */
export function spawnAttachKeeper(agentId, profile, claude, { argv1 = process.argv[1], spawnFn = spawn, dir = keeperDir() } = {}) {
  if (!isQuoxEntry(argv1)) throw new Error('not running as the quox CLI');
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `${keeperName(agentId)}.log`), 'a');
  try {
    const args = [argv1, ...(profile ? ['--profile', profile] : []), 'agent', 'keep', agentId,
      '--claude-pid', String(claude.pid), '--claude-start', String(claude.starttime ?? '')];
    const env = { ...process.env, ...(claude.sessionKey ? { QUOX_ATTACH_SESSION: claude.sessionKey } : {}) };
    const child = spawnFn(process.execPath, args, { detached: true, stdio: ['ignore', fd, fd], env });
    child.unref();
  } finally {
    closeSync(fd);
  }
}

export function registerAgentAttachCommands(agent, ctx, program) {
  const { client, auth } = ctx;

  agent
    .command('attach')
    .description('Attach this session as an agent: lease it, fetch its attach kit, and install it locally')
    .argument('<agentId>', 'registry agent id, e.g. seer')
    .option('--ttl <sec>', 'lease TTL in seconds', (v) => parseInt(v, 10), 900)
    .option('--force', 'take over an active lease held elsewhere')
    .option('--label <session_label>', 'session label recorded on the lease')
    .option('--no-slot', "skip checking out the agent's bound slot even if the kit carries one")
    .option('--no-keep', 'do not spawn the background lease keeper (heartbeats the lease every 5m until this Claude session exits)')
    .option('--no-prime', 'do not append the Brain primer (relevant brain passages) to ATTACHED.md')
    .option('--no-adopt', 'do not print the adoption block to stdout (for scripts; the default prints it so a session run via ! adopts the identity without a second step)')
    .action(async (agentId, options) => {
      auth.requireAuth();
      // quox#567 (CLI half): resolve a display name (e.g. VULCAN) to its
      // registry id (forge) before any lease/kit call. Never send the
      // display name itself to the API.
      agentId = await resolveAgentId(client, agentId);
      const leaseEp = resolveEndpoint('agent-attach.lease.create', { agentId });
      const attachLabel = resolveSessionLabel({ label: options.label, lookup: ctx.sessionNameLookup });

      let leaseData;
      try {
        leaseData = await client.post(leaseEp.path, {
          service: leaseEp.service,
          body: {
            session_label: attachLabel,
            ttl_seconds: options.ttl,
            takeover: options.force === true,
          },
        });
      } catch (err) {
        if (err instanceof QuoxApiError && err.status === 409
          && (err.body?.error === 'splinter_cap' || err.code === 'splinter_cap')) {
          const max = err.body?.max ?? err.detail?.max ?? '?';
          const active = err.body?.active ?? err.detail?.active ?? '?';
          throw new QuoxError(
            `agent ${agentId} is at its splinter cap (max ${max}, active ${active}). `
            + 'The cap is the platform setting QUOX_MAX_SPLINTERS (Settings > Platform capabilities, org or instance); raise it, or detach another session first.',
            3,
          );
        }
        if (err instanceof QuoxApiError && err.status === 409) {
          const holder = err.body?.holder ?? err.detail?.holder ?? err.detail ?? 'another session';
          const holderText = typeof holder === 'string' ? holder : JSON.stringify(holder);
          // Contract: "print current holder and exits code 3 with a --force
          // hint". QuoxApiError's own status->exitCode map sends 409 to 6;
          // this is a deliberate override to the contract's exit code.
          throw new QuoxError(
            `agent ${agentId} is already attached (held by ${holderText}). `
            + `Pass --force to take over: quox agent attach ${agentId} --force`,
            3,
          );
        }
        throw err;
      }

      const lease = leaseData?.lease || {};
      const token = leaseData?.token;
      if (!token) {
        throw new Error(`POST ${leaseEp.path} did not return a token; cannot fetch the attach kit.`);
      }

      const kitEp = resolveEndpoint('agent-attach.kit');
      let kit;
      try {
        kit = await client.get(kitEp.path, {
          service: kitEp.service,
          // The kit is fetched with the just-minted ATTACH token, never the
          // caller's own session token: noAuth suppresses client.js's normal
          // Bearer injection so this explicit header is the only credential.
          noAuth: true,
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        const status = err instanceof QuoxApiError ? err.status : 'network error';
        throw new Error(
          `GET ${kitEp.path} failed (${status}) after the lease was granted (lease ${lease.id || 'unknown'}). `
          + `The lease is still active: retry the kit fetch, or run \`quox agent detach ${agentId}\` to release it. `
          + `Original error: ${err.message}`
        );
      }

      const splinter = splinterInfoFrom(leaseData?.splinter);
      const paths = installAttachKit(agentId, { kit, token, splinter });
      // ONE-BRAIN CX4: agents whose resolved tool list carries brain_context get
      // a primer from the brain. Best effort, bounded, never fails the attach.
      let primer = '';
      if (options.prime !== false && kitHasBrainContext(kit)) {
        primer = await buildBrainPrimer(client);
        try {
          writeFile0600(instructionsPath(agentId), `${readFileSync(instructionsPath(agentId), 'utf-8')}\n${primer}`);
        } catch { /* primer is a bonus; the attach stands */ }
      }
      writeSplinterFile(agentId, splinter.id, splinter.count);
      const leaseId = lease.id || kit?.lease?.id || '';
      const expires = lease.expires_at || kit?.lease?.expires_at || leaseData?.expires_at || 'unknown';

      // P3 (docs/QUOXIDENTITY_P3_CONTRACT.md, territory G): the kit carries
      // the agent's bound slot (a durable ADDRESS, Territory F hydration).
      // Check it out as a separate "voice hold" — Lease = identity hold,
      // slot hold = voice, by design. A slot already held elsewhere (e.g. a
      // warden/supervisor) must never fail an otherwise-successful attach:
      // warn, name the holder, hint the takeover, and continue (exit 0).
      if (kit?.slot?.name && options.slot !== false) {
        const slotName = kit.slot.name;
        // DEFECT 3 FIX (QuoxIdentity): a resident session's voice identity
        // (checkSlotSayAuthor, collector server.js) resolves to
        // buildSelfIdentity(hostId) = `resident:<host>`, exactly the way
        // devSupervisor.js checks its own slot out (see checkoutSlot there).
        // Checking out with a synthetic `attach-<agentId>-<lease8>` label
        // instead means a resident's later `slot say` 403s: holder_session
        // never matches its resolved identity. Same resident-detection
        // signal auth.js's own refresh() uses (`auth?.kind === 'resident'`),
        // not a new one. A non-resident (ordinary human JWT) keeps the
        // existing synthetic-label/interactive behaviour unchanged.
        const tokens = typeof auth.getTokens === 'function' ? auth.getTokens() : null;
        const isResident = tokens?.kind === 'resident' && !!tokens?.host_id;
        const sessionLabel = isResident
          // Per-splinter label: two same-host residents must not share a
          // holder_session, or the second is mistaken for the holder
          // re-checking-out (no member join) and its detach frees the hold.
          // "@" not "#": the collector rejects "#" in say/from labels.
          ? `${buildSelfIdentity(tokens.host_id)}@${String(leaseId).slice(0, 8)}`
          : (attachLabel || `attach-${agentId}-${String(leaseId).slice(0, 8)}`);
        const slotEp = resolveEndpoint('v1.slots.checkout', { name: slotName });
        try {
          // P10: present the ATTACH token (not the profile token) so the
          // collector resolves the caller as the agent; a held slot of the
          // same agent then JOINS as a member instead of 409.
          const slotRes = await client.post(slotEp.path, {
            service: slotEp.service,
            noAuth: true,
            headers: { Authorization: `Bearer ${token}` },
            body: {
              holder_session: sessionLabel,
              holder_kind: isResident ? 'resident' : 'interactive',
              ...(isResident ? { host_id: tokens.host_id } : {}),
              org_id: resolveOrgId(auth, program),
            },
          });
          if (slotRes?.joined === true) {
            const member = {
              splinter: slotRes.member?.splinter ?? null,
              member_key: slotRes.member?.member_key ?? null,
            };
            recordHeldSlot(slotName, sessionLabel, undefined, (ctx.claudeSessionInfo || claudeSessionInfo)(), member);
            writeSlotState(agentId, { name: slotName, session_label: sessionLabel, member: true, ...member });
            printInfo(`Joined slot ${slotName} as member ${member.splinter ?? member.member_key ?? 'unknown'}`);
          } else {
            recordHeldSlot(slotName, sessionLabel, undefined, (ctx.claudeSessionInfo || claudeSessionInfo)());
            writeSlotState(agentId, { name: slotName, session_label: sessionLabel });
            printEvent(events.assigned('quox', `slot ${slotName}`, sessionLabel));
          }
        } catch (err) {
          const is409 = err instanceof QuoxApiError && err.status === 409;
          const holder = (is409 && (err.detail?.holder_session || err.body?.holder_session)) || 'another session';
          printEvent(events.warned(
            'quox',
            `slot ${slotName}`,
            is409 ? `held by ${holder}` : `checkout failed (${err instanceof QuoxApiError ? err.status : 'network error'})`
          ));
          if (is409) {
            printInfo(`  takeover: quox slot checkout ${slotName} --force`);
          }
        }
      }

      // F6 (QuoxIdentity CLI finding-fix): a lease granted with little TTL
      // left will expire mid-work if the session never heartbeats. Warn at
      // grant time rather than only on a later attach-status check.
      const msLeft = expires !== 'unknown' ? new Date(expires).getTime() - Date.now() : NaN;
      if (Number.isFinite(msLeft) && msLeft > 0 && msLeft < 15 * 60 * 1000) {
        printEvent(events.warned(
          'quox',
          `attach ${agentId}`,
          `expires in ${Math.max(1, Math.round(msLeft / 60000))}m, run attach-heartbeat`
        ));
      }

      const splinterTag = splinter.present && splinter.ordinal === 1 && splinter.siblings.length ? ' (S1)' : '';
      printEvent(line('quox', `attach ${agentId}${splinterTag}`, { result: `lease ${String(leaseId).slice(0, 8)} · expires ${expires}` }));
      if (splinter.present && splinter.ordinal > 1) {
        printInfo(`Joined ${kit?.display_name || agentId} as SPLINTER ${splinter.id} (${splinter.count} live session${splinter.count === 1 ? '' : 's'})`);
      }
      if (splinter.present && (splinter.ordinal > 1 || splinter.siblings.length)) {
        for (const sib of splinter.siblings) {
          printInfo(`  ${sib.id} ${sib.session_label || '(no label)'} · heartbeat ${fmtAge(sib.last_heartbeat_at)}`);
        }
      }
      printInfo(`  kit: ${paths.kitPath}`);
      printInfo(`  token: ${paths.tokenPath}`);
      printInfo(`  instructions: ${paths.instructionsPath}`);
      // Auto-heartbeat: the lease TTL is 15m and nothing renewed it unless the
      // model remembered `attach-heartbeat`. A detached keeper (bound to this
      // claude session) renews every 5m and releases the lease when the
      // session exits. Only when a claude session is detected.
      if (options.keep !== false) {
        const me = claudeSessionInfo();
        if (me) {
          try {
            stopAttachKeeper(agentId, { dir: ctx.keeperDir });
            (ctx.spawnKeeper || spawnAttachKeeper)(agentId, program.opts().profile, me);
            printInfo(`  keeper: heartbeating this lease every 5m until the claude session exits (--no-keep to opt out)`);
          } catch (err) {
            printEvent(events.warned('quox', `keeper ${agentId}`, `not started (${err.message}); run attach-heartbeat yourself`));
          }
        }
      }
      printInfo(`  detach with: quox agent detach ${agentId}`);
      // P9: surface the (automatic) session binding so multi-session use is
      // legible. The key is derived from the process tree — nothing to set.
      {
        const key = sessionKey();
        if (key) {
          printInfo(`  session: ${key}, this attach is scoped to THIS session; other sessions on this box stay independent`);
        }
      }
      // P2 (docs/QUOXIDENTITY_P2_CONTRACT.md, territory E): kit.memory.handoff
      // is the most recent handoff note left by a prior attached session.
      // Note it so the session knows continuity was restored, not starting cold.
      const handoff = kit?.memory?.handoff;
      if (handoff) {
        const createdAt = handoff.created_at || handoff.createdAt || 'unknown';
        printEvent(line('quox', 'continuity restored', { result: `handoff ${createdAt}` }));
      }
      if (program.opts().output === 'json') formatDetail({ lease, kit }, { format: 'json' });

      // Print the adoption block to stdout by default. The point: a human runs
      // `! quox agent attach <agent>` inside a live Claude/Codex session, and
      // the identity SEER should adopt lands directly in that session's context
      // instead of relying on a separate "now go read ATTACHED.md" step that is
      // easy to skip. --no-adopt (or -o json) suppresses it for scripts.
      if (options.adopt !== false && program.opts().output !== 'json') {
        const bar = '─'.repeat(60);
        printInfo('');
        printInfo(bar);
        printInfo(`ADOPT NOW: you are attached as ${agentId}. From this point on in this`);
        printInfo(`session, operate AS ${agentId} under the identity and tool scope below.`);
        printInfo(bar);
        printInfo(renderAttachedInstructions({ agentId, kit, splinter }));
        if (primer) printInfo(`\n${primer}`);
        printInfo(bar);
      }
    });

  agent
    .command('detach')
    .description('Detach this session from an agent: release its lease and remove the local attach kit')
    .argument('<agentId>', 'registry agent id')
    .option('--handoff <file>', 'path to a file with a handoff note (state, open threads, next moves) to store before detaching')
    .option('--handoff-text <text>', 'handoff note text, provided inline instead of a file')
    .option('--force-detach', 'release the lease even if storing the handoff note fails')
    .option('--no-brain-note', 'do not also save the handoff to the knowledge brain as a private note')
    .action(async (agentId, options) => {
      auth.requireAuth();
      // quox#567 (CLI half): same display-name -> registry-id resolution as attach.
      agentId = await resolveAgentId(client, agentId);
      const stored = readStoredKit(agentId);
      const leaseId = stored?.lease?.id;
      if (!leaseId) throw noLocalLeaseError(agentId, 'attach-status');

      if (options.handoff && options.handoffText) {
        throw new QuoxError('Pass only one of --handoff or --handoff-text.', 2);
      }

      // P2 (docs/QUOXIDENTITY_P2_CONTRACT.md, territory E): store the handoff
      // BEFORE releasing the lease, and abort the detach (naming the endpoint
      // + status) rather than silently losing the handoff on store failure.
      // --force-detach is the explicit override for that abort.
      let handoffContent = null;
      if (options.handoff) {
        try {
          handoffContent = readFileSync(options.handoff, 'utf-8');
        } catch (err) {
          throw new Error(`Cannot read handoff file ${options.handoff}: ${err.message}`);
        }
      } else if (options.handoffText) {
        handoffContent = options.handoffText;
      }

      if (handoffContent !== null) {
        // finding-10: the handoff runs at the very end of a session, often long
        // after the last heartbeat, so the short-lived attach token has usually
        // expired by now — which 401'd the handoff and lost continuity. Refresh
        // it first (heartbeat uses the resident session, so it works even with
        // an expired attach token, as long as the lease still lives).
        const token = await ensureFreshAttachToken(client, agentId);

        const handoffEp = resolveEndpoint('agent-attach.handoff');
        try {
          await client.post(handoffEp.path, {
            service: handoffEp.service,
            // Same posture as the kit fetch: authenticate with the attach
            // JWT explicitly, not the caller's own session token.
            noAuth: true,
            headers: { Authorization: `Bearer ${token}` },
            body: { content: handoffContent },
          });
        } catch (err) {
          const status = err instanceof QuoxApiError ? err.status : 'network error';
          const message =
            `POST ${handoffEp.path} failed (${status}); the lease was NOT released so the handoff `
            + `is not lost (lease ${String(leaseId).slice(0, 8)}). Retry the detach, or pass `
            + `--force-detach to release the lease anyway. Original error: ${err.message}`;
          if (!options.forceDetach) throw new Error(message);
          printEvent(events.warned('quox', `handoff ${agentId}`, `store failed (${status}), forcing detach`));
        }
        // ONE-BRAIN CX3: also keep the handoff in the knowledge brain. Best
        // effort: a capture failure warns and never blocks the detach.
        if (options.brainNote !== false) {
          const res = await saveHandoffNote(client, {
            agentId,
            content: handoffContent,
            prov: decisionProvenance(),
            sessionName: resolveSessionLabel({ lookup: ctx.sessionNameLookup }),
          });
          if (res.ok) printEvent(line('quox', `handoff note ${agentId}`, { result: 'saved to brain' }));
          else printEvent(events.warned('quox', `handoff note ${agentId}`, `brain save failed (${res.error}), continuing detach`));
        }
      } else {
        printInfo('  Tip: a handoff preserves continuity for the next session. Pass --handoff <file> or --handoff-text "...".');
      }

      // P3/P4: slot release, witnessed detach notice, lease release (shared
      // with the keeper's session-gone release).
      try { stopAttachKeeper(agentId, { dir: ctx.keeperDir }); } catch { /* best effort */ }
      await releaseAttachLease({
        client, auth, program, agentId, leaseId,
        reason: handoffContent !== null ? 'handoff_and_detach' : 'detach',
      });
    });

  agent
    .command('keep', { hidden: true })
    .description('Background attach-lease keeper: heartbeat the lease every 5m until the owning Claude session exits (spawned by attach)')
    .argument('<agentId>', 'canonical registry agent id (passed by attach)')
    .option('--claude-pid <pid>', 'pid of the claude session this keeper serves')
    .option('--claude-start <ticks>', 'start ticks of that claude process (guards against pid reuse)')
    .action(async (agentId, options) => {
      auth.requireAuth();
      const me = options.claudePid
        ? { pid: Number(options.claudePid), starttime: options.claudeStart || null }
        : claudeSessionInfo();
      const res = await runKeeper({
        name: keeperName(agentId),
        session: agentId,
        claude: me,
        probe: ctx.probe || makeProcessProbe(procStartTime),
        sleep: ctx.sleep,
        dir: ctx.keeperDir,
        heartbeat: () => heartbeatAttachLease(client, agentId, { getOrgId: () => resolveOrgId(auth, program) }),
        release: async () => {
          const leaseId = readStoredKit(agentId)?.lease?.id;
          if (!leaseId) return;
          await releaseAttachLease({ client, auth, program, agentId, leaseId });
        },
        forget: () => {},
      });
      process.exitCode = res.code;
    });

  agent
    .command('attach-status')
    .description('Show the current attach lease status for an agent')
    .argument('<agentId>', 'registry agent id')
    .action(async (agentId) => {
      auth.requireAuth();
      // quox#567 (CLI half): same display-name -> registry-id resolution as attach.
      agentId = await resolveAgentId(client, agentId);
      const ep = resolveEndpoint('agent-attach.status', { agentId });
      const data = await client.get(ep.path, { service: ep.service });
      const active = data?.active_lease || null;

      if (!active) {
        printInfo(`No active attach lease for ${agentId}. my_grant: ${!!data?.my_grant}`);
      } else {
        formatDetail(active, { format: program.opts().output, title: `Attach lease: ${agentId}` });
        printInfo(`  my_grant: ${!!data?.my_grant}`);
      }
      if (Array.isArray(data?.splinters) && data.splinters.length) {
        printInfo('  splinters:');
        for (const sp of data.splinters) {
          printInfo(`    ${sp.id}${sp.is_root ? ' (root)' : ''} ${sp.session_label || '(no label)'} · heartbeat ${fmtAge(sp.last_heartbeat_at)}`);
        }
      }

      // P3: best-effort bound slot + current holder. Never fails
      // attach-status: an org with no binding wired yet (or a caller without
      // the route deployed) degrades to silence, not an error.
      try {
        const bindingEp = resolveEndpoint('agent-attach.slot-binding.get', { agentId });
        const binding = await client.get(bindingEp.path, { service: bindingEp.service });
        if (binding?.name) {
          printInfo(`  slot: ${binding.name}${binding.holder_session ? ` (held by ${binding.holder_session})` : ' (free)'}`);
        }
      } catch {
        // No binding, or the route isn't deployed yet: not a status-command failure.
      }

      if (program.opts().output === 'json') formatDetail(data, { format: 'json' });
    });

  agent
    .command('attach-heartbeat')
    .description("Heartbeat this session's attach lease, rotating the stored token if one is issued")
    .argument('<agentId>', 'registry agent id')
    .action(async (agentId) => {
      auth.requireAuth();
      // quox#567 (CLI half): same display-name -> registry-id resolution as attach.
      agentId = await resolveAgentId(client, agentId);
      const leaseId = readStoredKit(agentId)?.lease?.id;
      if (!leaseId) throw noLocalLeaseError(agentId, 'attach-heartbeat');

      const { expires } = await heartbeatAttachLease(client, agentId, { getOrgId: () => resolveOrgId(auth, program) });
      printEvent(line('quox', `heartbeat ${agentId}`, { result: `lease ${String(leaseId).slice(0, 8)} · expires ${expires}`, status: 'ok' }));
    });

  // F3 (QuoxIdentity CLI finding-fix, SEER-TERMINAL): the first-class way to
  // do WITNESSED work AS the attached agent. Reads the token this session
  // stored on `attach` and calls the collector's governed
  // /api/v1/tools/execute with it, authenticated the same way the kit fetch
  // is: noAuth + an explicit Authorization header, never the caller's own
  // session token. Before this verb, witnessed work as the attached identity
  // meant hand-curling the endpoint.
  agent
    .command('exec')
    .description('Execute a tool as the attached agent (witnessed, uses the stored attach token)')
    .argument('<agentId>', 'registry agent id')
    .requiredOption('--tool <name>', 'tool name to execute, e.g. memory_search')
    .requiredOption('--input <json>', 'tool input, as a JSON string, e.g. \'{"query":"..."}\'')
    .action(async (agentId, options) => {
      // quox#567 (CLI half): same display-name -> registry-id resolution as
      // attach. Must run BEFORE ensureFreshAttachToken, since the stored
      // attach kit lives under the canonical id (~/.quox/attach/<id>/).
      agentId = await resolveAgentId(client, agentId);

      // finding-10: refresh a near-expired token before use (heartbeats the
      // lease, which authenticates with the resident session, so it works even
      // after the short-lived attach token has lapsed).
      const token = await ensureFreshAttachToken(client, agentId);

      const input = parseJSON(options.input, '--input');
      const orgId = resolveOrgId(auth, program);

      const ep = resolveEndpoint('v1.tools.execute');
      let data;
      try {
        data = await client.post(ep.path, {
          service: ep.service,
          noAuth: true,
          headers: { Authorization: `Bearer ${token}` },
          body: { tool_name: options.tool, input, org_id: orgId },
        });
      } catch (err) {
        const status = err instanceof QuoxApiError ? err.status : 'network error';
        if (err instanceof QuoxApiError && (err.status === 401 || err.status === 403)) {
          throw new Error(
            `POST ${ep.path} failed (${status}): the attach token for "${agentId}" is no longer valid `
            + `(expired or revoked lease). Re-attach with \`quox agent attach ${agentId}\`.`
          );
        }
        throw new Error(`POST ${ep.path} failed (${status}): ${err.message}`);
      }

      // finding (autonomous loop): the glyph must reflect the TOOL result, not
      // just that the HTTP transport returned 200. A tool that reports failure
      // (success:false OR ok:false) is a FAILURE; printing ✔ made a scanning
      // agent read failures as passes ([error-body-is-not-data] at the CLI
      // surface). Set a non-zero exit code too so a scripted / feedback-loop
      // caller can't mistake it for a pass.
      const toolOk = !execResultFailed(data);
      // Skip the announce line under --json/-o json: a scripted caller parses
      // stdout as a single JSON document, and the glyph line would break that.
      if (program.opts().output !== 'json') {
        printEvent(line('quox', `exec ${options.tool}`, {
          result: toolOk ? agentId : `${agentId} · ${execResultError(data)}`,
          status: toolOk ? 'ok' : 'fail',
        }));
      }
      formatDetail(data, { format: program.opts().output, title: `Tool result: ${options.tool}` });
      if (!toolOk) process.exitCode = 1;
    });

  // P3 (docs/QUOXIDENTITY_P3_CONTRACT.md, territory F/G): admin verbs mapping
  // to the PUT/DELETE slot-binding routes. Binding an address is an admin
  // act (org owner/admin only, not attach tokens) — org-admin errors surface
  // the endpoint + status rather than a bare "forbidden".
  agent
    .command('bind-slot')
    .description("Bind an agent identity to a durable slot address (org admin only)")
    .argument('<agentId>', 'registry agent id')
    .argument('<slotName>', 'slot name to bind, e.g. seer-address')
    .action(async (agentId, slotName) => {
      auth.requireAuth();
      const ep = resolveEndpoint('agent-attach.slot-binding.set', { agentId });
      let data;
      try {
        data = await client.put(ep.path, { service: ep.service, body: { slot_name: slotName } });
      } catch (err) {
        const status = err instanceof QuoxApiError ? err.status : 'network error';
        throw new Error(`PUT ${ep.path} failed (${status}): ${err.message}`);
      }
      printEvent(events.created('quox', `bind-slot ${agentId}`, slotName));
      if (program.opts().output === 'json') formatDetail(data, { format: 'json' });
    });

  agent
    .command('unbind-slot')
    .description("Remove an agent identity's slot binding (org admin only)")
    .argument('<agentId>', 'registry agent id')
    .action(async (agentId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('agent-attach.slot-binding.delete', { agentId });
      let data;
      try {
        data = await client.delete(ep.path, { service: ep.service });
      } catch (err) {
        const status = err instanceof QuoxApiError ? err.status : 'network error';
        throw new Error(`DELETE ${ep.path} failed (${status}): ${err.message}`);
      }
      printEvent(events.released('quox', `bind-slot ${agentId}`, agentId));
      if (program.opts().output === 'json') formatDetail(data, { format: 'json' });
    });

  // P1 grant model (owner decision: per-agent attach grant, default owner-only).
  // These verbs are the only client for the auth grant routes; without them the
  // grant model is unreachable except by raw HTTP. Org owner/admin only, so the
  // errors surface the endpoint + status rather than a bare "forbidden".
  agent
    .command('grant-attach')
    .description('Grant a user permission to attach as an agent (org admin only)')
    .argument('<agentId>', 'registry agent id, e.g. seer')
    .argument('<userId>', 'the user id to grant attach permission to')
    .action(async (agentId, userId) => {
      auth.requireAuth();
      // quox#567 (CLI half): same display-name -> registry-id resolution as attach.
      agentId = await resolveAgentId(client, agentId);
      const ep = resolveEndpoint('agent-attach.grants.add', { agentId });
      let data;
      try {
        data = await client.post(ep.path, { service: ep.service, body: { user_id: userId } });
      } catch (err) {
        const status = err instanceof QuoxApiError ? err.status : 'network error';
        throw new Error(`POST ${ep.path} failed (${status}): ${err.message}`);
      }
      printEvent(events.created('quox', `grant-attach ${agentId}`, userId));
      if (program.opts().output === 'json') formatDetail(data, { format: 'json' });
    });

  agent
    .command('grant-attach-all')
    .description('Grant a user permission to attach as ANY agent in the org, present and future (org admin only)')
    .argument('<userId>', 'the user id to grant roster-wide attach permission to')
    .action(async (userId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('agent-attach.grants.add-all');
      let data;
      try {
        data = await client.post(ep.path, { service: ep.service, body: { user_id: userId } });
      } catch (err) {
        const status = err instanceof QuoxApiError ? err.status : 'network error';
        throw new Error(`POST ${ep.path} failed (${status}): ${err.message}`);
      }
      printEvent(events.created('quox', 'grant-attach-all', userId));
      printInfo(`  ${userId} can now attach ANY agent in the org (no per-agent grant needed). Revoke: quox agent revoke-attach-all ${userId}`);
      if (program.opts().output === 'json') formatDetail(data, { format: 'json' });
    });

  agent
    .command('revoke-attach-all')
    .description("Revoke a user's roster-wide (attach-any) grant (org admin only)")
    .argument('<userId>', 'the user id to revoke')
    .action(async (userId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('agent-attach.grants.remove-all', { granteeUserId: userId });
      let data;
      try {
        data = await client.delete(ep.path, { service: ep.service });
      } catch (err) {
        const status = err instanceof QuoxApiError ? err.status : 'network error';
        throw new Error(`DELETE ${ep.path} failed (${status}): ${err.message}`);
      }
      printEvent(events.released('quox', 'grant-attach-all', userId));
      if (program.opts().output === 'json') formatDetail(data, { format: 'json' });
    });

  agent
    .command('revoke-attach')
    .description("Revoke a user's attach grant for an agent (org admin only)")
    .argument('<agentId>', 'registry agent id')
    .argument('<userId>', 'the user id to revoke')
    .action(async (agentId, userId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('agent-attach.grants.remove', { agentId, granteeUserId: userId });
      let data;
      try {
        data = await client.delete(ep.path, { service: ep.service });
      } catch (err) {
        const status = err instanceof QuoxApiError ? err.status : 'network error';
        throw new Error(`DELETE ${ep.path} failed (${status}): ${err.message}`);
      }
      printEvent(events.released('quox', `grant-attach ${agentId}`, userId));
      if (program.opts().output === 'json') formatDetail(data, { format: 'json' });
    });

  agent
    .command('list-grants')
    .description('List attach grants for an agent (org admin only)')
    .argument('<agentId>', 'registry agent id')
    .action(async (agentId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('agent-attach.grants.list', { agentId });
      const data = await client.get(ep.path, { service: ep.service });
      formatDetail(data, { format: program.opts().output, title: `Attach grants: ${agentId}` });
    });
}
