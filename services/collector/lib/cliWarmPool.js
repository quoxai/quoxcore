'use strict';
/**
 * QUOXON-LATENCY lane L2: warm `claude` spares for the CLI-tools dispatch path.
 *
 * Measured 2026-10-14 in the collector container (CLI 2.1.197): a cold `claude -p`
 * spends 2.9 to 3.3 s booting before it calls the model (live dispatch->cli_init 3.4 to
 * 4.7 s, 16 s under a load spike). A process already booted and waiting on
 * `--input-format stream-json` reaches init 0.16 to 0.26 s after it is given a turn.
 *
 * A spare is spawned ahead of a turn with every argument of that turn EXCEPT the system
 * prompt and the user message, and with NO credential in its env. At turn time the
 * dispatcher takes it, writes this turn's token into the spare's private token file,
 * sends the system prompt in the stream-json `initialize` control request (the CLI
 * applies it once, before the first message) and then the user message. When the
 * result arrives the dispatcher ends stdin and the spare exits.
 *
 * Security properties (each pinned in test/cliWarmPool.test.js):
 *   - single use: a spare serves exactly one turn, never two.
 *   - never shared across users or orgs: the key covers org, user and the full env and
 *     args fingerprint, and take() re-checks org and user on the spare itself.
 *   - the turn credential is per TURN: the spare's env carries only
 *     QUOX_AUTH_TOKEN_FILE (a path), the file exists only between beginTurn() and
 *     endTurn(), mode 0600 in a 0700 dir. No token, service key or force flag is ever
 *     in a spare's env. The env otherwise is the caller's pickCliToolsEnv slice.
 *   - lifetime: idle TTL kill, a cap with oldest-first eviction, killAll() on collector
 *     shutdown, and a spare whose parent dies exits on stdin EOF (verified live).
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TTL_MS = 600000; // 10 min (was 3): spares are cheap idle, the first token is not
const DEFAULT_MAX_DELEGATE = 6;
// Hard global cap (QUOX_CLI_WARM_MAX). Each idle spare costs ~200 MB and ~4% of a core
// (measured 2026-10-16), so the pool is bounded regardless of users x agents. 4 evicted ~90%
// of spares before use when eviction was not LRU (2026-10-15); 8 with LRU keeps the active pairs.
const DEFAULT_MAX_SPARES = 8;
// Never part of a spare's env and never part of its key: these are per turn or service-only.
const CREDENTIAL_ENV = ['QUOX_AUTH_TOKEN', 'QUOX_TOKEN', 'QUOX_AUTH_TOKEN_FILE', 'QUOX_SERVICE_KEY', 'QUOX_FORCE_SERVICE_KEY'];

/** The spare's argv: the turn's argv minus --system-prompt <v> and -p <msg>, plus stream-json input. */
function warmArgsFrom(turnArgs) {
  const out = [];
  const a = Array.isArray(turnArgs) ? turnArgs : [];
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === '--system-prompt' || a[i] === '-p' || a[i] === '--print' || a[i] === '--input-format') { i += 1; continue; }
    out.push(a[i]);
  }
  return [...out, '--input-format', 'stream-json', '-p'];
}

// Per-turn values that must not bind a spare to one conversation id: they travel in a file.
const PER_TURN_ENV = ['QUOX_SESSION_ID', 'QUOX_SESSION_ID_FILE'];

function stripCredentials(env) {
  const out = { ...(env || {}) };
  for (const k of CREDENTIAL_ENV) delete out[k];
  for (const k of PER_TURN_ENV) delete out[k];
  return out;
}

/** Fingerprint of everything a spare is bound to. The system prompt and message are not in it. */
function warmKey({ orgId, userId, args, env }) {
  const e = stripCredentials(env);
  const canon = JSON.stringify({
    org: String(orgId || ''),
    user: String(userId || ''),
    args: warmArgsFrom(args),
    env: Object.keys(e).sort().map((k) => [k, String(e[k])]),
  });
  return crypto.createHash('sha256').update(canon).digest('hex');
}

function createCliWarmPool({
  spawnFn,
  enabled = true,
  ttlMs = DEFAULT_TTL_MS,
  maxSpares = DEFAULT_MAX_SPARES,
  // Delegated specialist hops share the pool but cannot crowd out conversation spares.
  maxDelegate = DEFAULT_MAX_DELEGATE,
  tokenRoot = os.tmpdir(),
  // quox#1151: durable record of conversation spares so boot can re-warm them (lib/cliWarmBoot.js).
  recipeStore = null,
  log = console,
} = {}) {
  const spares = new Map(); // key -> spare (insertion order = age)

  function rmDir(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  function remove(spare) {
    if (spares.get(spare.key) === spare) spares.delete(spare.key);
    if (spare.idleTimer) { clearTimeout(spare.idleTimer); spare.idleTimer = null; }
  }

  function makeSpare({ key, orgId, userId, proc, dir }) {
    const tokenFile = path.join(dir, 'turn-token');
    const sessionFile = path.join(dir, 'turn-session');
    const spare = {
      key, orgId: String(orgId), userId: String(userId), proc, tokenFile, dir,
      createdAt: Date.now(), idleTimer: null, disposed: false,
      alive() { return !spare.disposed && proc.exitCode === null && !proc.killed; },
      beginTurn(token, { sessionId } = {}) {
        fs.writeFileSync(tokenFile, String(token || ''), { mode: 0o600 });
        try { fs.chmodSync(tokenFile, 0o600); } catch { /* best effort */ }
        if (sessionId) fs.writeFileSync(sessionFile, String(sessionId), { mode: 0o600 });
      },
      endTurn() {
        try { fs.unlinkSync(tokenFile); } catch { /* already gone */ }
        try { fs.unlinkSync(sessionFile); } catch { /* already gone */ }
      },
      /** Writes the initialize request carrying this turn's system prompt; returns its request_id. */
      sendInit(systemPrompt) {
        const requestId = `quox-init-${crypto.randomBytes(4).toString('hex')}`;
        proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize', systemPrompt: String(systemPrompt || '') } }) + '\n');
        return requestId;
      },
      sendUser(userMessage) {
        proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: String(userMessage || '') }, parent_tool_use_id: null, session_id: '' }) + '\n');
      },
      sendTurn({ systemPrompt, userMessage }) {
        spare.sendInit(systemPrompt);
        spare.sendUser(userMessage);
      },
      dispose(reason) {
        if (spare.disposed) return;
        spare.disposed = true;
        remove(spare);
        spare.endTurn();
        rmDir(dir);
        if (proc.exitCode === null) {
          try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        }
        if (reason && reason !== 'used') log.log(`[CLI-WARM] spare disposed reason=${reason}`);
      },
    };
    return spare;
  }

  // Delegate hop recipes are kept IN MEMORY only (never persisted: test/cliWarmBoot.test.js pins that delegate
  // prespawns are not recorded in the recipe store), so per-agent pre-warm can re-boot a hop spare for (org, user, agent)
  // after it was used, evicted or reaped. Bounded: one recipe per pair, oldest dropped past DELEGATE_RECIPES_MAX.
  const delegateRecipes = new Map();
  const DELEGATE_RECIPES_MAX = 64;
  function remember(key, orgId, userId, args, env, kind, fromBoot) {
    if (fromBoot) return; // a boot replay never refreshes its recipe: a crash loop must not keep a stale pair alive
    if (kind === 'delegate') {
      const e = stripCredentials(env);
      const pair = `${orgId}|${userId}|${e.QUOX_AGENT_ID || ''}`;
      delegateRecipes.delete(pair);
      delegateRecipes.set(pair, { orgId: String(orgId), userId: String(userId), kind: 'delegate', args: warmArgsFrom(args), env: e, at: Date.now() });
      while (delegateRecipes.size > DELEGATE_RECIPES_MAX) delegateRecipes.delete(delegateRecipes.keys().next().value);
      return;
    }
    if (!recipeStore || kind !== 'conversation') return;
    try { recipeStore.record({ key, orgId, userId, args: warmArgsFrom(args), env: stripCredentials(env) }); } catch { /* diagnostic store only */ }
  }

  // Per-agent pre-warm (QUOXON 2026-10-17): one spare for (org, user, agent) from that user's own recipe for that agent:
  // the in-memory delegate recipe first, else the newest persisted fresh-shape conversation recipe. The recipe's env
  // carries QUOX_AGENT_ID = agentId (checked), so the spare's key binds it to that agent: it never serves another.
  const lastAgentWarm = new Map();
  // `shape` ({ args, env }) is a DRY RUN of the dispatcher's own hop builder (lib/cliHopShape.js), used only when there is
  // no recipe (the first hop to this agent after a boot). It must pass the same identity checks as a recipe.
  function prewarmAgent({ orgId, userId, agentId, shape = null, throttleMs = 60000, now = Date.now() } = {}) {
    if (!enabled || !orgId || !userId || !agentId) return { spawned: false, reason: 'not_applicable' };
    const pair = `${orgId}|${userId}|${agentId}`;
    const isResume = (a) => Array.isArray(a) && (a.includes('--resume') || a.includes('-r'));
    const fits = (x) => x && x.env && String(x.orgId) === String(orgId) && String(x.userId) === String(userId)
      && String(x.env.QUOX_AGENT_ID || '') === String(agentId) && String(x.env.QUOX_ORG_ID || '') === String(orgId)
      && String(x.env.QUOX_USER_ID || '') === String(userId) && Array.isArray(x.args) && !isResume(x.args);
    let r = delegateRecipes.get(pair);
    if (!fits(r)) {
      let stored = [];
      try { stored = (recipeStore && recipeStore.list()) || []; } catch { stored = []; }
      r = stored.find(fits) || null;
    }
    if (!r && shape && fits({ orgId, userId, env: shape.env, args: shape.args })) r = { kind: 'delegate', args: shape.args, env: shape.env };
    if (!r) return { spawned: false, reason: shape ? 'shape_unresolved' : 'no_recipe' };
    const existing = spares.get(warmKey({ orgId, userId, args: r.args, env: r.env }));
    if (existing && existing.alive() && !existing.taken && !existing.idleOut) return { spawned: false, reason: 'present' };
    const last = lastAgentWarm.get(pair) || 0;
    if (now - last < throttleMs) return { spawned: false, reason: 'throttled' };
    lastAgentWarm.set(pair, now);
    const spare = prespawn({ orgId, userId, args: r.args, env: r.env, kind: r.kind === 'delegate' ? 'delegate' : 'conversation', fromBoot: true });
    return spare ? { spawned: true, reason: 'warmed', kind: spare.kind } : { spawned: false, reason: 'spawn' };
  }

  function prespawn({ orgId, userId, args, env, kind = 'conversation', fromBoot = false }) {
    if (!enabled || typeof spawnFn !== 'function') return null;
    if (!orgId || !userId) return null;
    const key = warmKey({ orgId, userId, args, env });
    remember(key, orgId, userId, args, env, kind, fromBoot);
    const existing = spares.get(key);
    // Same key = identical argv and env: a live idle spare already serves the next turn.
    // Keep it (its TTL is not extended) rather than boot a twin: each spare is ~200 MB and
    // a boot ~5 to 8 CPU-seconds (first-text, 2026-10-16).
    if (existing && existing.alive() && !existing.idleOut && !existing.taken) {
      // LRU: this pair just took a turn, so it moves to the newest slot (eviction takes the
      // stalest pair). Its idle TTL is NOT extended: a pair unused for ttlMs still expires.
      spares.delete(key); spares.set(key, existing);
      return existing;
    }
    if (existing) existing.dispose('replaced');
    if (kind === 'delegate') {
      const mine = [...spares.values()].filter((x) => x.kind === 'delegate'); // insertion order = least recently refilled first
      while (mine.length >= Math.max(1, maxDelegate)) mine.shift().dispose('evicted');
    }
    while (spares.size >= Math.max(1, maxSpares)) {
      const oldest = spares.values().next().value;
      oldest.dispose('evicted');
    }
    let dir;
    let proc;
    try {
      dir = fs.mkdtempSync(path.join(tokenRoot, 'quox-turn-'));
      fs.chmodSync(dir, 0o700);
      const spareEnv = { ...stripCredentials(env), QUOX_AUTH_TOKEN_FILE: path.join(dir, 'turn-token'), QUOX_SESSION_ID_FILE: path.join(dir, 'turn-session') };
      proc = spawnFn('claude', warmArgsFrom(args), { env: spareEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      if (dir) rmDir(dir);
      log.warn(`[CLI-WARM] prespawn failed: ${e.message}`);
      return null;
    }
    const spare = makeSpare({ key, orgId, userId, proc, dir });
    spare.kind = kind;
    spare.parts = { args: warmArgsFrom(args), env: Object.fromEntries(Object.entries(stripCredentials(env)).map(([k, v]) => [k, String(v)])) };
    // Idle output is not expected; keep the pipes drained so a chatty spare cannot block.
    if (proc.stdout && typeof proc.stdout.on === 'function') proc.stdout.on('data', (d) => { if (!spare.taken) spare.idleOut = true; else if (spare.onStdout) spare.onStdout(d); });
    if (proc.stderr && typeof proc.stderr.on === 'function') proc.stderr.on('data', (d) => { if (spare.taken && spare.onStderr) spare.onStderr(d); });
    if (proc.stdin && typeof proc.stdin.on === 'function') proc.stdin.on('error', () => { /* EPIPE surfaces as close */ });
    proc.on('close', (code) => {
      if (!spare.taken) { spare.dispose(`exited_idle code=${code}`); return; }
      if (spare.onClose) spare.onClose(code);
    });
    proc.on('error', (err) => {
      if (!spare.taken) { spare.dispose(`spawn_error ${err.message}`); return; }
      if (spare.onError) spare.onError(err);
    });
    spare.idleTimer = setTimeout(() => spare.dispose('idle_ttl'), ttlMs);
    if (spare.idleTimer && typeof spare.idleTimer.unref === 'function') spare.idleTimer.unref();
    spares.set(key, spare);
    return spare;
  }

  /** The spare for exactly this identity + turn shape, removed from the pool, or null. */
  function take({ orgId, userId, args, env }) {
    if (!enabled || !orgId || !userId) return null;
    const key = warmKey({ orgId, userId, args, env });
    const spare = spares.get(key);
    if (!spare) {
      // Say WHY (once per miss): which part of the key differs from this user's newest spare.
      try {
        const mine = [...spares.values()].filter((x) => x.orgId === String(orgId) && x.userId === String(userId));
        if (!mine.length) log.log(`[CLI-WARM] miss reason=no_spare pool=${spares.size}/${Math.max(1, maxSpares)}`);
        else {
          const wa = warmArgsFrom(args); const e = stripCredentials(env);
          const diffs = mine.map((m) => {
            const argDiff = wa.map((v, i) => [i, v]).filter(([i, v]) => m.parts.args[i] !== v).map(([i, v]) => `${i}:${String(m.parts.args[i]).slice(0, 12)}!=${String(v).slice(0, 12)}`);
            const envDiff = Object.keys(e).filter((k) => m.parts.env[k] !== String(e[k]));
            return { argDiff, envDiff, n: argDiff.length + envDiff.length };
          }).sort((x, y) => x.n - y.n)[0];
          log.log(`[CLI-WARM] miss reason=key_mismatch pool=${spares.size}/${Math.max(1, maxSpares)} spares=${mine.length} args_diff=[${diffs.argDiff.join(',')}] env_diff=[${diffs.envDiff.join(',')}]`);
        }
      } catch { /* diagnostic only */ }
      return null;
    }
    if (spare.orgId !== String(orgId) || spare.userId !== String(userId)) return null;
    remove(spare);
    if (!spare.alive() || spare.idleOut) { spare.dispose(spare.idleOut ? 'idle_output' : 'dead'); return null; }
    spare.taken = true;
    return spare;
  }

  function killAll(reason = 'shutdown') {
    for (const s of [...spares.values()]) s.dispose(reason);
  }

  const cap = () => Math.max(1, maxSpares);
  return { prespawn, take, prewarmAgent, killAll, size: () => spares.size, cap, stats: () => `${spares.size}/${cap()}`, enabled: !!enabled, log };
}

/**
 * After a turn's offer: pre-warm the agents it names as delegate holders, so the hop that follows a few seconds later
 * takes a warm spare. The first holder (other than the turn's own agent) of each hint, at most `max` agents. Never throws.
 */
function prewarmHintedAgents(pool, { orgId, userId, self = '', hints = [], max = 2, resolveShape = null, onShape = null } = {}) {
  if (!pool || typeof pool.prewarmAgent !== 'function' || !orgId || !userId || !Array.isArray(hints)) return [];
  const agents = [];
  for (const h of hints) {
    const a = (Array.isArray(h && h.holders) ? h.holders : []).find((x) => x && x !== self);
    if (a && !agents.includes(a)) agents.push(a);
    if (agents.length >= max) break;
  }
  const pending = [];
  const out = agents.map((agentId) => {
    try {
      const r = pool.prewarmAgent({ orgId, userId, agentId });
      // No recipe (the first hop to this agent after a boot): ask for the DRY RUN of the dispatcher's own hop builder
      // (lib/cliHopShape.js resolveHopShape, async). Unresolvable = no spare ('shape_unresolved'). Never throws.
      if (r.reason === 'no_recipe' && typeof resolveShape === 'function') {
        pending.push(Promise.resolve().then(() => resolveShape(agentId)).catch(() => null).then((shape) => {
          let res;
          try {
            res = shape && shape.ok && Array.isArray(shape.args) && shape.env
              ? pool.prewarmAgent({ orgId, userId, agentId, shape: { args: shape.args, env: shape.env } })
              : { spawned: false, reason: 'shape_unresolved' };
          } catch { res = { spawned: false, reason: 'error' }; }
          const row = { agentId, ...res };
          if (typeof onShape === 'function') { try { onShape(row); } catch { /* latency only */ } }
          return row;
        }));
      }
      return { agentId, ...r };
    } catch { return { agentId, spawned: false, reason: 'error' }; }
  });
  // The sync rows come back as before; `pending` settles with the dry-run rows (tests await it).
  Object.defineProperty(out, 'pending', { value: Promise.all(pending), enumerable: false });
  return out;
}

module.exports = { createCliWarmPool, warmArgsFrom, warmKey, prewarmHintedAgents, DEFAULT_TTL_MS, DEFAULT_MAX_SPARES };
