/**
 * QUOXON server calls. Thin wrapper over the CLI client so the app can be
 * driven by a fake (demo + tests). All routes per docs/QUOXON_EVENTS_v1.md.
 */
import { resolveEndpoint } from '../api/endpoints.js';
import { rememberEmail } from '../core/auth.js';
import { isSessionDead } from './sessionDead.js'; // not signin.js: that loads React + Ink (QUOXON-LATENCY)
import { buildStreamQuery } from '../commands/chat.js';
import { loadBundledAssistantsRoster } from '../core/agentAlias.js';
import { bundledIdentities } from './objects/fetch.js';
import { recordHeldSlot } from '../commands/slot.js';
import { askGripe, settleGripe } from '../commands/gripe.js';
import { sendFeedback } from './feedback.js';
import { fromObjective, fromExecution, fromApproval, sortRows } from './roster.js';
import { normChoice } from './model.js';
import { normPrefs as normModelPrefs } from './modelPrefs.js';
import { createRowsStore } from './rowsStore.js';
import { createObjectsApi } from './objects/fetch.js';
import { createKillerApi } from './slash/killerApi.js';
import { createUndoOps } from './slash/undoApi.js';
import { resolveDashboardBase, resolveCollectorBase, detectLanIp } from './hostUrls.js';
import { grantBody } from './consent.js';
import { loadJourney } from './onboarding/journey.js';
import { joinServiceUrl } from '../core/config.js';
import { runVmCommand } from '../core/vmTui.js';
import { fetchActivity, heldLines } from '../core/hyperion.js';
import { createPeekFetchers, peekId } from '../core/peek.js';
import { askAside } from '../core/aside.js';

const missing = (e) => e?.status === 404 || e?.status === 405 || e?.status === 501;
/** Server steer refusal label -> client reason. Unknown labels are 'ambiguous', never "finished". */
const steerReason = (label) => label === 'turn_finished' ? 'turn_finished' : (label === 'steer_unsupported' || label === 'unsupported') ? 'unsupported' : 'ambiguous';
const eventsPath = (c, t) => `/api/v1/conversations/${encodeURIComponent(c)}/turns/${encodeURIComponent(t)}/events`;
/** Reconnect backoff (ms) for a dropped durable turn; ~1 min in all, then the user is told /resume reattaches. */
export const REATTACH_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000, 15000, 30000];

/**
 * Drain one SSE connection of a turn into the consumer, exactly once by seq. Returns null when the turn
 * finished (or the caller aborted), else { error } describing why the connection ended early.
 * turn.finished arrives just after `done`: keep reading to the close, but never hang (3 s grace).
 */
async function* readTurn(open, cur, signal) {
  const inner = new AbortController();
  const relay = () => inner.abort();
  if (signal) { if (signal.aborted) inner.abort(); else signal.addEventListener('abort', relay, { once: true }); }
  let grace = null;
  try {
    for await (const ev of open(inner.signal)) {
      if (typeof ev?.seq === 'number') { if (ev.seq <= cur.lastSeq) continue; cur.lastSeq = ev.seq; }
      if (ev?.type === 'turn.started' && ev.conversation_id) cur.conversationId = ev.conversation_id;
      if (ev?.type === 'turn.finished') cur.finished = true;
      yield ev;
      if ((ev.type === 'done' || ev.type === 'error' || ev.type === 'turn.finished') && !grace) grace = setTimeout(() => inner.abort(), 3000);
      if (ev.type === 'turn.finished') return null;
    }
    return signal?.aborted || grace ? null : { error: null }; // closed without turn.finished
  } catch (e) {
    if (signal?.aborted) return null;
    if (grace && inner.signal.aborted) return null; // grace timeout, not a failure
    if (e?.status) throw e; // the server answered with an HTTP error: not a dropped connection
    return { error: e };
  } finally { clearTimeout(grace); signal?.removeEventListener('abort', relay); inner.abort(); } // cancels the HTTP body
}
const sleepFor = (ms, signal) => new Promise((r) => { if (signal?.aborted) return r(); const t = setTimeout(done, ms); function done() { clearTimeout(t); signal?.removeEventListener?.('abort', done); r(); } signal?.addEventListener?.('abort', done, { once: true }); });
const listOf = (d, ...keys) => { for (const k of keys) if (Array.isArray(d?.[k])) return d[k]; return Array.isArray(d) ? d : null; };

export const SLOTS_UNLICENSED = 'Slots need a licence. This Quox does not have one, so /slot is off. See: quox setup license status';
// Z2H run-6: every slot write (checkout, /say, /broadcast) names the licence reason the same way.
/** #1288: a refused vault write, keeping the server's "confirm this private address" hint. */
const vaultFailure = (e) => ({ ok: false, status: e?.status, message: e?.message || 'failed', ...(e?.body?.confirmable === true ? { confirmable: true, origin: typeof e.body.origin === 'string' ? e.body.origin : null } : {}) });
const slotsUnlicensed = (e) => e?.status === 403 && /not licen[cs]ed/i.test(`${e?.code || ''} ${e?.body?.error || ''} ${e?.message || ''}`);

/** PRESENCE: only a person at a real terminal is "back". --print, pipes, proof runs and agents are not. */
export function isInteractiveHuman({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  return Boolean(stdin?.isTTY && stdout?.isTTY) && !env.CI;
}

export function createApi({ client, config, auth, windowOrg = null, reattachBackoff = REATTACH_BACKOFF_MS }) {
  let holderSessionFn = null;
  const orgId = () => { try { return auth.getOrgId(); } catch { return null; } };
  const rowsStore = createRowsStore({ client, config, orgId });
  let credsSeen = null; // credentials-file mtime last seen (credentialsChanged)
  const userId = () => { try { return config.getAuth?.()?.user_id || null; } catch { return null; } };
  /** Z2H-R3: the server's public app URL (instance_config app_base_url), or null (not admin, old server, unset). Never throws. */
  const serverAppUrl = async () => {
    try { const ep = resolveEndpoint('admin.instance.basics.get'); const r = await client.get(ep.path, { service: ep.service, retries: 0 }); return r?.effective?.appBaseUrl || null; } catch { return null; }
  };
  const journeyUrl = () => { try { return loadJourney()?.dashboardUrl || null; } catch { return null; } };
  const listApprovals = async () => {
    // quox#827: the set comes from the server's one open-approvals function (the same one behind the dashboard badge and LUCID).
    const ep = resolveEndpoint('inbox.approvals.open', { orgId: orgId() });
    try {
      const data = await client.get(ep.path, { service: ep.service });
      if (Array.isArray(data?.approvals)) return data.approvals.map((a) => a.item).filter(Boolean);
    } catch (e) { if (!missing(e)) throw e; } // an older server without the route: fall back to the inbox list below
    const old = resolveEndpoint('inbox.list', { orgId: orgId() });
    const data = await client.get(old.path, { service: old.service, query: { kind: 'approval', include_snoozed: 'true', limit: 200 } }); // status omitted = every ACTIVE status
    const items = data.items || data.data || data || [];
    return Array.isArray(items) ? items : [];
  };
  const conv = (c, t) => `/api/v1/conversations/${encodeURIComponent(c)}/turns/${encodeURIComponent(t)}`;
  /**
   * After a drop: reconnect with backoff, replaying from the last seq we yielded. A 404/410 ends it with
   * that error; running out of attempts throws err.code 'reattach_failed' (the turn may still be running).
   */
  async function* reattachLoop({ turnId, cur, signal, first, backoff = REATTACH_BACKOFF_MS }) {
    let last = first;
    for (let attempt = 1; attempt <= backoff.length; attempt++) {
      if (signal?.aborted) return;
      yield { type: 'reconnecting', turn_id: turnId, attempt, after: cur.lastSeq };
      await sleepFor(backoff[attempt - 1], signal);
      if (signal?.aborted) return;
      let announced = false;
      const before = cur.lastSeq;
      let drop;
      try {
        drop = yield* readTurn((sig) => (async function* () {
          for await (const ev of client.stream(eventsPath(cur.conversationId, turnId), { service: 'collector', query: { after: cur.lastSeq }, signal: sig, untilClose: true })) {
            if (!announced) { announced = true; yield { type: 'resumed', turn_id: turnId, after: before }; }
            yield ev;
          }
        })(), cur, signal);
      } catch (e) {
        if (e?.status === 404) { const err = new Error('The server no longer knows this turn (it may have been restarted).'); err.code = 'turn_not_found'; err.status = 404; throw err; }
        if (e?.status === 410) { const err = new Error('This turn finished too long ago to replay; its answer is in the conversation history (/resume).'); err.code = 'turn_events_expired'; err.status = 410; throw err; }
        if (e?.status === 401 || e?.status === 403) throw e;
        drop = { error: e };
      }
      if (cur.finished || !drop || signal?.aborted) return;
      last = drop.error || last;
      if (cur.lastSeq > before) attempt = 0; // progress: start the backoff again
    }
    const err = new Error(`Lost the connection to the server${last?.message ? ` (${last.message})` : ''}. Quox keeps working on the turn; /resume reattaches.`);
    err.code = 'reattach_failed';
    throw err;
  }
  /** PRESENCE auto-clear: the human's own first real action. -> { ok, cleared, welcome } (welcome once: { away_text, via }). Never throws. */
  async function noteActivity(action, { quiet = false, interactive = isInteractiveHuman() } = {}) {
    if (!interactive) return { ok: false, cleared: false, welcome: null, skipped: 'not interactive' };
    try {
      const ep = resolveEndpoint('presence.activity');
      const d = await client.post(ep.path, { service: ep.service, retries: 0, timeout: 6000, body: { action, org_id: orgId(), ...(quiet ? { quiet: true } : {}) } });
      return { ok: true, cleared: d?.cleared === true, welcome: d?.welcome || null };
    } catch (e) { return { ok: false, cleared: false, welcome: null, status: e?.status || null }; }
  }
  return {
    ...createKillerApi({ client }),
    orgId,
    undoOps: createUndoOps({ client, orgId }), // /undo
    userId,
    /** /peek <id>: the same lookup as `quox peek`, in this window's org. -> peekId result */
    peek: (id) => peekId(id, createPeekFetchers({ client, orgId })),
    /** /aside: a no-tools, no-conversation question (core/aside.js). turns = recent exchanges, read-only context. */
    aside: (question, turns = []) => askAside(client, { question, turns }),
    /** @mention hosts: the Bastion inventory (same read as `quox fleet hosts`). -> [{ id, group, health }] */
    async mentionHosts() {
      const ep = resolveEndpoint('v1.fleet.hosts.list');
      const d = await client.get(ep.path, { service: ep.service, retries: 0, timeout: 8000 });
      return (listOf(d, 'hosts') || []).map(h => ({ id: h.id, group: h.group || '', health: h.status?.health || '' }));
    },
    /** @mention tasks: the newest objectives (one read, cached by the composer for the session). -> [{ id, title, status }] */
    async mentionTasks() {
      const ep = resolveEndpoint('objectives.list');
      const d = await client.get(ep.path, { service: ep.service, query: { limit: 30 }, retries: 0, timeout: 8000 });
      return (listOf(d, 'objectives', 'data') || []).map(o => ({ id: o.id, title: o.title || '', status: o.status || '' }));
    },
    /** Z2H: the same login path as `quox login` (createAuth().login). Returns only what the card needs; tokens are stored by auth, never surfaced. */
    async signIn(email, password) {
      const r = await auth.login(config.getServiceUrl('auth'), email, password);
      return { mfa_required: Boolean(r.mfa_required), access_token: r.mfa_required ? r.access_token : undefined, user: r.user ? { email: r.user.email } : null };
    },
    verifyMfa: (token, code) => auth.verifyMfa(config.getServiceUrl('auth'), token, code),
    /** The last email this profile signed in with (prefill for /login), or ''. */
    lastEmail() { try { return config.getAuth?.()?.email || config.getActiveProfile?.()?.last_email || ''; } catch { return ''; } },
    /**
     * Startup/ongoing check: is the stored session dead? Only a locally expired token is probed, via the refresh seam.
     * -> { alive: true } | { alive: false, reason: 'idle_timeout'|'max_session'|null }. A transient failure reads as alive (we learned nothing).
     */
    async probeSession() {
      try {
        if (!auth.isExpired?.()) return { alive: true };
        try { rememberEmail(config, config.getAuth?.()?.email); } catch { /* best-effort */ }
        await auth.refresh(config.getServiceUrl('auth'));
        return { alive: true };
      } catch (e) {
        return isSessionDead(e) ? { alive: false, reason: e.reason || null } : { alive: true };
      }
    },
    /**
     * Stale sign-in: true once each time the credentials file changed on disk since the last call (another window
     * or `quox login` wrote it). A cheap stat; the first call only records the baseline.
     */
    credentialsChanged() {
      try {
        const m = config.credentialsMtime?.() || 0;
        const was = credsSeen; credsSeen = m;
        return was !== null && m !== was;
      } catch { return false; }
    },
    /** Re-read this profile's credentials from disk. -> true when a signed-in profile is there to retry with. */
    reloadCredentials() {
      try { config.reloadAuth?.(); return Boolean(config.getAuth?.()?.access_token); } catch { return false; }
    },
    /** Inline object views (objects/): skill, workflow, crystal, agent, memory, rules, proof, reconcile. */
    objects: createObjectsApi({ client, orgId, profile: config?._effectiveProfile || null }),
    /** /model choice persisted on the active profile ({ provider, model? } only, never a key); null = auto. */
    modelChoice() { try { return normChoice(config.getActiveProfile?.()?.chat_model); } catch { return null; } },
    setModelChoice(choice) {
      const prof = config.getActiveProfile?.();
      if (!prof) return false;
      const c = normChoice(choice);
      if (c) prof.chat_model = c; else delete prof.chat_model;
      config.save?.();
      return true;
    },
    /** Server-side QuoxSound setting (the dashboard's `soundProfile` preference), or null when unset. */
    async soundSettings() {
      const ep = resolveEndpoint('auth.me.list');
      const d = await client.get(ep.path, { service: ep.service, retries: 0 });
      return (d?.user?.preferences ?? d?.preferences)?.soundProfile ?? null;
    },
    async setSoundSettings(value) {
      const ep = resolveEndpoint('auth.me.update');
      await client.patch(ep.path, { service: ep.service, body: { preferences: { soundProfile: value } } });
      return true;
    },
    /**
     * QUOXON-FW6: model favourites + default. The server is the source of truth: the user's
     * `quoxonModels` preference (PATCH /api/auth/me merges top-level namespaces, the same store as
     * soundProfile). The active CLI profile keeps a copy (model_prefs) for offline starts.
     * -> { prefs, source: 'server' | 'local', error? }.
     */
    async modelPrefs() {
      const local = () => normModelPrefs(config.getActiveProfile?.()?.model_prefs);
      try {
        const ep = resolveEndpoint('auth.me.list');
        const d = await client.get(ep.path, { service: ep.service, retries: 0 });
        const raw = (d?.user?.preferences ?? d?.preferences)?.quoxonModels;
        const prefs = normModelPrefs(raw);
        const prof = config.getActiveProfile?.();
        if (prof && raw !== undefined) { prof.model_prefs = prefs; config.save?.(); }
        const useLocal = raw === undefined && local().favourites.length;
        return { prefs: useLocal ? local() : prefs, source: 'server' };
      } catch (e) { return { prefs: local(), source: 'local', error: e?.message || 'failed' }; }
    },
    /** -> { ok, synced, error? }: the local copy is always written; synced=false: refused. */
    async setModelPrefs(value) {
      const prefs = normModelPrefs(value);
      const prof = config.getActiveProfile?.();
      if (prof) { prof.model_prefs = prefs; config.save?.(); }
      try {
        const ep = resolveEndpoint('auth.me.update');
        const body = { preferences: { quoxonModels: prefs } };
        await client.patch(ep.path, { service: ep.service, body, retries: 0 });
        return { ok: true, synced: true };
      } catch (e) { return { ok: Boolean(prof), synced: false, error: e?.message || 'failed' }; }
    },
    localModelPrefs() {
      try { return normModelPrefs(config.getActiveProfile?.()?.model_prefs); }
      catch { return normModelPrefs(null); }
    },
    /**
     * QUOXON-FW17 / ROWS: custom rows. url, quox and plugin rows sync per user (preference namespace `quoxonRows`);
     * cmd rows stay in a local file. One implementation, shared with `quox rows` (rowsStore.js).
     */
    ...rowsStore,
    /** Local copy on the active CLI profile: offline start + fallback store. */
    localSoundProfile() { try { return config.getActiveProfile?.()?.sound_profile || null; } catch { return null; } },
    setLocalSoundProfile(p) { const prof = config.getActiveProfile?.(); if (!prof) return false; prof.sound_profile = p; config.save?.(); return true; },
    /**
     * One turn. Durable by default (events v1.1, docs/QUOXON_EVENTS_v1_1.md): the server keeps the turn running
     * if this connection drops, every event carries a `seq`, and a drop before turn.finished is followed by an
     * automatic reattach (GET .../turns/:tid/events?after=<last seq>) with backoff. Events are yielded exactly once
     * by seq. While reconnecting it yields { type:'reconnecting', attempt } and, once back, { type:'resumed', after }.
     * A server without v1.1 (no seq on its events) gets the v1 behaviour: no reattach.
     */
    async *stream({ turnId, message, agent, conversationId, context, provider, model, promptProfile, heldSlot = null, durable = true, overrideId = undefined, turnBudgetMs = undefined, mode = undefined, handoffFrom = undefined }, signal) {
      const body = buildStreamQuery({ queryId: turnId, message, agent: agent || 'quox', sessionId: conversationId, context });
      body.turn_id = turnId;
      if (durable) body.durable = true; // the server keeps the turn running when we disconnect (v1.1)
      if (Number(turnBudgetMs) > 0) body.turn_budget_ms = Math.floor(Number(turnBudgetMs)); // quox#1090: a delegation hop may use the turn's budget
      if (provider) body.provider = provider; // a request: the server policy decides, turn.started says what ran
      if (provider && model) body.model = model;
      if (promptProfile === 'compact' || promptProfile === 'full') body.prompt_profile = promptProfile; // D3: server default when absent
      if (conversationId) body.conversation_id = conversationId;
      if (mode === 'plan') body.mode = 'plan'; // PLAN MODE: the server makes no state-changing tool eligible and refuses writes
      if (heldSlot?.name && heldSlot?.session) body.held_slot = heldSlot; // QUOXON-MESH: slot_say signs as this window's slot
      if (handoffFrom) body.handoff_from = String(handoffFrom).slice(0, 80); // a handed-off turn: this agent stays attached, the server labels the exchange for it
      const ep = resolveEndpoint('chat.stream');
      const cur = { lastSeq: 0, finished: false, conversationId: conversationId || null };
      const drop = yield* readTurn((sig) => client.stream(ep.path, { service: ep.service, body, signal: sig, untilClose: true, ...(overrideId ? { headers: { 'x-override-id': overrideId } } : {}) }), cur, signal);
      if (cur.finished || !drop || !durable || signal?.aborted) return;
      if (!cur.lastSeq || !cur.conversationId) { if (drop.error) throw drop.error; return; } // v1 server: nothing to reattach to
      yield* reattachLoop({ turnId, cur, signal, first: drop.error, backoff: reattachBackoff });
    },
    /**
     * Reattach to a running (or just finished) turn and yield its events after `after`, exactly once, until
     * turn.finished. Same reconnect behaviour as stream(). Throws err.code 'turn_not_found' (404) or
     * 'turn_events_expired' (410).
     */
    async *reattach({ conversationId, turnId, after = 0 }, signal) {
      const cur = { lastSeq: after, finished: false, conversationId };
      const drop = yield* readTurn((sig) => client.stream(eventsPath(conversationId, turnId), { service: 'collector', query: { after }, signal: sig, untilClose: true }), cur, signal);
      if (cur.finished || !drop || signal?.aborted) return;
      yield* reattachLoop({ turnId, cur, signal, first: drop.error, backoff: reattachBackoff });
    },
    /** -> { running:true, turnId, lastSeq } | { running:false } | null (route missing or failed: never "not running"). */
    async runningTurn(conversationId) {
      if (!conversationId) return { running: false };
      try {
        const r = await client.get(`/api/v1/conversations/${encodeURIComponent(conversationId)}/running`, { service: 'collector', retries: 0 });
        if (r?.running === true && r.turn_id) return { running: true, turnId: r.turn_id, lastSeq: r.last_seq ?? null };
        return r?.running === false ? { running: false } : null;
      } catch { return null; }
    },
    /**
     * -> { ok:true } | { ok:false, reason }. reason: 'unsupported' | 'turn_finished' (409, safe to queue)
     * | 'denied' (403 steer_denied_by_policy) | 'ambiguous' (network, timeout, 5xx: may have been applied).
     * NEVER retried automatically; steerId lets the server de-duplicate a deliberate resend.
     */
    async steer(conversationId, turnId, text, steerId = null) {
      if (!conversationId) return { ok: false, reason: 'unsupported' };
      try {
        const body = steerId ? { text, steer_id: steerId } : { text };
        const r = await client.post(`${conv(conversationId, turnId)}/steer`, { service: 'collector', body, retries: 0 });
        if (r && r.queued === false) return { ok: false, reason: steerReason(r.reason) };
        return { ok: true };
      } catch (e) {
        if (e?.status === 403) return { ok: false, reason: 'denied', message: e.code === 'steer_denied_by_policy' ? 'steer_denied_by_policy' : (e.message || 'forbidden') };
        // Only say "finished" when the server says so; an unlabelled 409 may have been applied.
        if (e?.status === 409) return { ok: false, reason: steerReason(e.code || e.detail?.code || e.detail?.reason || e.reason) };
        if (e?.status === 404 || e?.status === 405) return { ok: false, reason: 'unsupported' };
        return { ok: false, reason: 'ambiguous', message: e?.message || 'failed' };
      }
    },
    /** -> { ok } ; ok:false means the server has no interrupt route (fall back to local abort) */
    async interrupt(conversationId, turnId) {
      if (!conversationId) return { ok: false };
      try { await client.post(`${conv(conversationId, turnId)}/interrupt`, { service: 'collector', body: {} }); return { ok: true }; }
      catch { return { ok: false }; }
    },
    /** -> { exists:true } | { exists:false } | { exists:null, reason } ; null = could not verify (never "not found"). */
    async conversationExists(conversationId) {
      try {
        const r = await client.get(`/api/v1/conversations/${encodeURIComponent(conversationId)}/turns`, { service: 'collector', query: { limit: 1 }, retries: 0 });
        const turns = r?.turns;
        if (!Array.isArray(turns)) return { exists: null, reason: 'unexpected response' };
        return { exists: turns.length > 0 };
      } catch (e) { return { exists: null, reason: e?.status === 404 || e?.status === 405 ? 'route not available' : (e?.message || 'failed') }; }
    },
    /**
     * -> [{ agent_id, name }] ; every agent id you can talk to: the live core registry (the list `quox agent attach`
     * validates against, with display names from the bundled roster) plus your org's own agents (`quox agent list`).
     * Throws only when no source answered at all.
     */
    async agents() {
      const roster = loadBundledAssistantsRoster();
      const nameOf = new Map(roster.map(r => [r.id, r.name || r.shortName || r.id]));
      const out = new Map(); let ok = 0; let lastErr = null;
      let ids = null; const roleOf = (id) => { ids ??= bundledIdentities(); const i = ids.get(id); return i?.tagline || i?.description || null; };
      try {
        const ep = resolveEndpoint('v1.tools.agents.list');
        const d = await client.get(ep.path, { service: ep.service, retries: 0 }); // authenticated: the collector's default-deny gate 401s a noAuth read
        for (const id of Object.keys(d?.agentTools || {})) out.set(id, { agent_id: id, name: nameOf.get(id) || id, role: roleOf(id), status: 'registered' });
        ok++;
      } catch (e) { lastErr = e; for (const r of roster) out.set(r.id, { agent_id: r.id, name: nameOf.get(r.id), role: roleOf(r.id) }); if (roster.length) ok++; }
      try {
        const ep = resolveEndpoint('agents.list', { orgId: orgId() });
        const rows = listOf(await client.get(ep.path, { service: ep.service, query: { includeTools: 'false' }, retries: 0 }), 'agents', 'data', 'items');
        for (const r of rows || []) if (r.agent_id && !out.has(r.agent_id)) out.set(r.agent_id, { agent_id: r.agent_id, name: r.name || r.agent_id, role: r.description || null, status: r.status || null });
        if (rows) ok++;
      } catch (e) { lastErr = lastErr || e; }
      if (!ok) throw lastErr || new Error('no agent list available');
      const list = [...out.values()];
      // The live registry failed and the bundled roster stood in: say so, so a miss is never read as "no such agent".
      if (lastErr) Object.defineProperty(list, 'listError', { value: lastErr });
      return list;
    },
    /** -> saved turns of one of YOUR conversations, oldest first [{ id, role, content }]; [] when none or not yours. */
    async conversationTurns(conversationId) {
      const d = await client.get(`/api/v1/conversations/${encodeURIComponent(conversationId)}/turns`, { service: 'collector', query: { limit: 200 }, retries: 0 });
      const rows = listOf(d, 'turns');
      if (!rows) throw new Error('unexpected response');
      return rows;
    },
    /** -> the org-wide live index (GET /api/v1/sessions, QUOXON J1): { rows, groups, counts, sources }. */
    async sessionsIndex() {
      const d = await client.get('/api/v1/sessions', { service: 'collector', retries: 0 });
      if (!d || !Array.isArray(d.groups)) throw new Error('unexpected response');
      return d;
    },
    /** GET /api/consent: this user's AI data sharing record ({ ai_data_sharing_consent, provider_consent }). */
    async consentStatus() {
      const ep = resolveEndpoint('consent.list');
      return client.get(ep.path, { service: ep.service, retries: 0 });
    },
    /** Grant AI data sharing consent for one provider (the user's own act; keeps the other providers' settings). */
    async grantConsent(provider) {
      const lst = resolveEndpoint('consent.list');
      let cur = null; try { cur = await client.get(lst.path, { service: lst.service, retries: 0 }); } catch { cur = null; }
      const ep = resolveEndpoint('consent.create');
      await client.post(ep.path, { service: ep.service, body: grantBody(cur, provider), retries: 0 });
      return true;
    },
    /** The dashboard address to print (never localhost when a better one is known). */
    async dashboardBase() {
      const profileUrl = config.getActiveProfile?.()?.url || config.getBaseUrl();
      return resolveDashboardBase({ serverApp: await serverAppUrl(), profileUrl, journeyUrl: journeyUrl(), lanIp: detectLanIp() }).url;
    },
    /** POST /api/v1/conversations/:id/compact (server-side summary; a model call, so a long timeout and never retried). */
    async compactConversation(conversationId) {
      return client.post(`/api/v1/conversations/${encodeURIComponent(conversationId)}/compact`, { service: 'collector', body: {}, retries: 0, timeout: 180000 });
    },
    /** GET /api/v1/conversations/:id/context -> { turns, compacted_turns, summary_present, summary_at, tokens, provider, model }. */
    async conversationContext(conversationId) {
      return client.get(`/api/v1/conversations/${encodeURIComponent(conversationId)}/context`, { service: 'collector', retries: 0 });
    },
    /** Persistent memory answers for this login (the same call as `quox memory stats`). -> { ok } | { ok:false, error }. */
    async memoryStatus() {
      try {
        const ep = resolveEndpoint('memory.stats.list');
        await client.get(ep.path, { service: ep.service, retries: 0 });
        return { ok: true };
      } catch (e) { return { ok: false, error: e?.status ? `HTTP ${e.status}` : (e?.message || 'failed') }; }
    },
    /** The `quox doctor` checks, run in this process. */
    async doctorChecks() { const { runDoctorChecks } = await import('../commands/doctor.js'); return runDoctorChecks({ config }); },
    /** C4: the `quox server status` panel rows for the local install. -> { ok, rows } | { ok:false, error }. */
    async serverStatus() {
      const { createSys } = await import('../server/sys.js');
      const { resolveInstall, backupsRoot } = await import('../server/install.js');
      const { gatherStatus, statusRows, defaultUrls } = await import('../server/status.js');
      const sys = createSys();
      const install = await resolveInstall({ sys });
      if (install.error) return { ok: false, error: install.error };
      const st = await gatherStatus({ install, sys, urls: defaultUrls(config), backups: backupsRoot() });
      return { ok: true, rows: statusRows(st) };
    },
    /** /dashboard: mint a one-time sign-in link for this profile (see slash/dashboard.js). Never throws; kind 'link' | 'plain' | 'error'. */
    async dashboardLink(page) {
      const { runDashboard } = await import('./slash/dashboard.js');
      const profileUrl = config.getActiveProfile?.()?.url || config.getBaseUrl();
      const baseUrl = resolveDashboardBase({ serverApp: await serverAppUrl(), profileUrl, journeyUrl: journeyUrl(), lanIp: detectLanIp() }).url;
      return runDashboard({ page, baseUrl, mint: () => { const ep = resolveEndpoint('auth.login-link'); return client.post(ep.path, { service: ep.service, body: {}, retries: 0 }); } });
    },
    /** Z2H-R3: the address to print for the host installer (never localhost when a better one is known). */
    async hostsBaseUrl() {
      let collectorUrl = null; try { collectorUrl = new URL(config.getServiceUrl('collector')).origin; } catch { /* none */ }
      return resolveCollectorBase({ collectorUrl, serverApp: await serverAppUrl(), journeyUrl: journeyUrl(), lanIp: detectLanIp() }).url;
    },
    /** Z2H-3c: can `${base}/install` be served? -> { ok, status } or null when unreachable (never throws, 4 s cap). */
    async hostInstallCheck(base) {
      if (!base || /^<|example/.test(String(base))) return null;
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
      try { const r = await fetch(`${String(base).replace(/\/+$/, '')}/install`, { method: 'GET', signal: ctl.signal }); try { await r.body?.cancel?.(); } catch { /* drained */ } return { ok: r.ok, status: r.status }; }
      catch { return null; } finally { clearTimeout(t); }
    },
    serverUrl() { try { return new URL(config.getServiceUrl('collector')).origin; } catch { return null; } },
    /** /config settings on the active profile. */
    settings() { try { const q = config.getActiveProfile?.()?.quoxon; return q && typeof q === 'object' ? { ...q } : {}; } catch { return {}; } },
    saveSetting(id, value) {
      try { const prof = config.getActiveProfile?.(); if (!prof) return false; prof.quoxon = { ...(prof.quoxon || {}), [id]: value }; config.save?.(); return true; } catch { return false; }
    },
    /** -> [{ id, title, updated_at, turn_count }] ; GET /api/v1/conversations (title is server-derived, no rename route). */
    async conversations(limit = 20) {
      const d = await client.get('/api/v1/conversations', { service: 'collector', query: { limit }, retries: 0 });
      const rows = listOf(d, 'conversations');
      if (!rows) throw new Error('unexpected response');
      return rows;
    },
    /**
     * Same call as `quox slot checkout <name> --create --session <s>` (cli/lib/commands/slot.js), then the same
     * local held-slots record. The hold keeper and slot wait loop are NOT started here.
     * -> { ok:true, slot } | { ok:false, message }.
     */
    /**
     * /gripe: the same governed path as `quox gripe --yes` (the GRIPE agent over chat, then the deterministic
     * file when the agent did not). The client asks the user first, so the agent is told to file without asking.
     * -> { ok:true, response, url, superseded, notes } | { ok:false, message }.
     */
    async gripe(text, { yes = true } = {}) {
      try {
        const options = { yes };
        const data = await askGripe({ client, complaint: text, yes, orgId: orgId() });
        const r = await settleGripe({ client, data, complaint: text, options, orgId: orgId() });
        return { ok: true, response: r.response, url: r.url, superseded: r.superseded, notes: r.notes };
      } catch (e) {
        return { ok: false, message: e?.status ? `HTTP ${e.status}: ${e.message}` : (e?.message || 'failed') };
      }
    },
    /**
     * /feedback: POST the previewed payload to the public quox.ai feedback API (not the org's server, not GitHub).
     * Anonymous by design: no token, cookie, org or profile goes with it. -> { ok:true, id, url } | { ok:false, message }.
     */
    async feedback(payload, { version = null } = {}) { return sendFeedback(payload, { version }); },
    /** Installed, enabled plugin ids for the org (GET plugins.list, as `quox plugin list`). Throws on failure so it never reads as "none". */
    async installedPlugins() {
      const id = orgId();
      if (!id) throw new Error('no org');
      const ep = resolveEndpoint('plugins.list', { orgId: id });
      const data = await client.get(ep.path, { service: ep.service, retries: 0 });
      const rows = listOf(data, 'plugins', 'data', 'items');
      if (!rows) throw new Error('unexpected response');
      return rows.filter(r => r.is_enabled !== false && r.is_enabled !== 0).map(r => r.plugin_id).filter(Boolean);
    },
    /** Fleet hosts already connected (tips skip the QuoxAgent tip when > 0). GET agents list; throws on failure so a failure never reads as "no hosts". */
    async hostCount() {
      const ep = resolveEndpoint('v1.agents.list');
      const rows = listOf(await client.get(ep.path, { service: ep.service, retries: 0 }), 'agents', 'data', 'items');
      if (!rows) throw new Error('unexpected response');
      return rows.length;
    },
    /** -> [{ name, host_name, assigned_to, ... }] ; GET /api/v1/slots (throws on failure, never reads as empty). */
    async slots() {
      const ep = resolveEndpoint('v1.slots.list');
      const rows = listOf(await client.get(ep.path, { service: ep.service, retries: 0 }), 'slots');
      if (!rows) throw new Error('unexpected response');
      return rows;
    },
    /**
     * Post a message into a slot room (same call as `quox slot say`). QUOXON-MESH: `from` signs it as this window
     * ("quox1 (Adam)"); `fast` answers once the line is in the slot, without waiting on the chat-app bridges.
     * -> { ok:true, message } | { ok:false, message, status }.
     */
    /** SLOTS-REPLY2: the window registers how to name its checkout session; slotSay then sends it as holder_session. */
    bindHolderSession(fn) { holderSessionFn = typeof fn === 'function' ? fn : null; },
    async slotSay(name, text, { from = null, fast = false, roomSession = null, fromSlot = null, holderSession = holderSessionFn ? holderSessionFn() : null } = {}) {
      const ep = resolveEndpoint('v1.slots.say', { name });
      try {
        // SLOTS-REPLY: fromSlot is this window's held slot, its reply address (the server verifies the hold).
        const d = await client.post(ep.path, { service: ep.service, retries: 0, body: { text, org_id: orgId(), ...(roomSession ? { room_session: roomSession } : from ? { from } : {}), ...(!roomSession && fromSlot ? { from_slot: fromSlot } : {}), ...(!roomSession && holderSession ? { holder_session: holderSession } : {}), ...(fast ? { bridge_report: false } : {}) } });
        return { ok: true, message: d?.message || null, roomPending: d?.room_pending === true, presence: d?.presence || null, humanPresence: d?.human_presence || null };
      } catch (e) {
        if (slotsUnlicensed(e)) return { ok: false, unlicensed: true, status: 403, message: SLOTS_UNLICENSED };
        return { ok: false, message: e?.status === 404 ? `no slot named ${name}` : (e?.message || 'failed'), status: e?.status || null };
      }
    },
    /** QUOXON-BROADCAST: fan a message out to the org's held slots. -> { ok:true, data } | { ok:false, message, status }. */
    async slotBroadcast({ text, slots = null, priority = 'normal', ack = false, from = null } = {}) {
      const ep = resolveEndpoint('v1.slots.broadcast');
      try {
        const data = await client.post(ep.path, { service: ep.service, retries: 0, body: { text, priority, ack, org_id: orgId(), ...(slots ? { slots } : {}), ...(from ? { from } : {}) } });
        return { ok: true, data };
      } catch (e) {
        if (slotsUnlicensed(e)) return { ok: false, unlicensed: true, status: 403, message: SLOTS_UNLICENSED };
        return { ok: false, message: e?.message || 'failed', status: e?.status || null };
      }
    },
    async slotBroadcastStatus(id) {
      const ep = resolveEndpoint('v1.slots.broadcast.get', { id });
      try { return { ok: true, data: await client.get(ep.path, { service: ep.service, retries: 0, query: { org_id: orgId() } }) }; } catch (e) { return { ok: false, message: e?.message || 'failed', status: e?.status || null }; }
    },
    // POKE-WAKE: slot control (server allows a human org owner/admin only; agents are refused).
    async slotControl(slot, command) {
      const ep = resolveEndpoint('v1.slots.control', { name: slot });
      try { return { ok: true, data: await client.post(ep.path, { service: ep.service, retries: 0, body: { command, org_id: orgId() } }) }; } catch (e) { return { ok: false, message: e?.message || 'failed', status: e?.status || null }; }
    },
    async slotControlGet(slot, id) {
      const ep = resolveEndpoint('v1.slots.control.get', { name: slot, id });
      try { return { ok: true, data: await client.get(ep.path, { service: ep.service, retries: 0, query: { org_id: orgId() } }) }; } catch (e) { return { ok: false, message: e?.message || 'failed', status: e?.status || null }; }
    },
    async slotAck(id, slot) {
      const ep = resolveEndpoint('v1.slots.broadcast.ack', { id });
      try { return { ok: true, data: await client.post(ep.path, { service: ep.service, retries: 0, body: { slot, org_id: orgId() } }) }; } catch (e) { return { ok: false, message: e?.message || 'failed', status: e?.status || null }; }
    },
    /** QUOXON-MESH: the slot's live messages (SSE). Yields { type: 'connected' | 'slot.message' | 'reconnect' }. */
    async *slotStream(name, { since = null, excludeFrom = null, session = null } = {}, signal) {
      const ep = resolveEndpoint('v1.slots.stream', { name });
      yield* client.stream(ep.path, { service: ep.service, query: { org_id: orgId(), since, exclude_from: excludeFrom, ...(session ? { session } : {}) }, signal, untilClose: true });
    },
    /** QUOXON-ROOMS: join / leave a slot as a room (no hold). -> { ok, already? | removed? } | { ok:false, message, status }. */
    async slotJoin(name, session, person = null) {
      const ep = resolveEndpoint('v1.slots.join', { name });
      try { const d = await client.post(ep.path, { service: ep.service, retries: 0, body: { session, ...(person ? { person } : {}), org_id: orgId() } }); return { ok: true, already: d?.already === true }; }
      catch (e) { return { ok: false, message: e?.status === 404 ? `no slot named ${name}` : (e?.message || 'failed'), status: e?.status || null }; }
    },
    async slotLeave(name, session) {
      const ep = resolveEndpoint('v1.slots.leave', { name });
      try { const d = await client.post(ep.path, { service: ep.service, retries: 0, body: { session, org_id: orgId() } }); return { ok: true, removed: d?.removed === true }; }
      catch (e) { return { ok: false, message: e?.message || 'failed', status: e?.status || null }; }
    },
    /** The rooms this session has joined (server truth, survives a restart). -> [{ slot_name, joined_at }]; throws on failure. */
    async slotRooms(session) {
      const ep = resolveEndpoint('v1.slots.rooms');
      const d = await client.get(ep.path, { service: ep.service, retries: 0, query: { session, org_id: orgId() } });
      return Array.isArray(d?.rooms) ? d.rooms : [];
    },
    /** Long-poll fallback for a server without the stream route (same call as `quox slot wait`). */
    async slotWait(name, { since = null, excludeFrom = null } = {}) {
      const ep = resolveEndpoint('v1.slots.wait', { name });
      return client.get(ep.path, { service: ep.service, retries: 0, timeout: 40000, query: { org_id: orgId(), since, exclude_from: excludeFrom, timeout_ms: 25000 } });
    },
    /** Last `limit` messages of a slot, oldest first (same call as `quox slot read`). Throws on failure. */
    async slotMessages(name, limit = 20) {
      const ep = resolveEndpoint('v1.slots.messages', { name });
      const rows = listOf(await client.get(ep.path, { service: ep.service, retries: 0, query: { org_id: orgId(), limit } }), 'messages');
      if (!rows) throw new Error('unexpected response');
      return rows;
    },
    /** The signed-in human's display name for slot lines (display_name, else the email's local part). */
    displayName() {
      try { const a = config.getAuth?.() || {}; return a.display_name || (a.email ? String(a.email).split('@')[0] : null); } catch { return null; }
    },
    /** `take` = the same signed-in user's other/renamed/restarted session takes a LIVE hold (stale holds of yours are reclaimed regardless). */
    async checkoutSlot(name, session, { take = false } = {}) {
      const ep = resolveEndpoint('v1.slots.checkout', { name });
      try {
        const data = await client.post(ep.path, { service: ep.service, body: { holder_session: session, holder_kind: 'interactive', host_id: null, org_id: orgId(), force: false, create: true, ...(take ? { take: true } : {}) } });
        recordHeldSlot(name, session);
        return { ok: true, slot: data?.slot || data, tookOver: data?.took_over || null };
      } catch (e) {
        if (e?.status === 409) {
          const d = e.detail || {};
          if (d.assigned_to) return { ok: false, message: `slot ${name} is assigned to ${d.assigned_to}` };
          return { ok: false, message: `slot ${name} is held by ${d.holder_session || 'another session'}`, held: { holder_session: d.holder_session || null, same_user: d.same_user === true, state: d.state || null, since: d.checked_out_at || null, last_seen: d.last_heartbeat_at || null } };
        }
        // Z2H-R5 C: a free install answers 403 "QuoxSlots is not licensed": say that, not a bare 403.
        if (slotsUnlicensed(e)) {
          return { ok: false, unlicensed: true, transient: false, status: 403, message: SLOTS_UNLICENSED };
        }
        // No answer, or the server failing (timeout, network, 5xx, e.g. a collector mid-redeploy): worth retrying.
        const st = e?.status || null;
        return { ok: false, message: e?.message || 'failed', status: st, transient: !st || st >= 500 || st === 429 || st === 408 };
      }
    },
    /** Keep a TUI-held slot alive (the hold lapses to stale after 15m without one). -> { ok } */
    async slotHeartbeat(name, session) {
      const ep = resolveEndpoint('v1.slots.heartbeat', { name });
      try { await client.post(ep.path, { service: ep.service, body: { holder_session: session, org_id: orgId() } }); return { ok: true }; }
      catch (e) { return { ok: false, message: e?.message || 'failed' }; }
    },
    /** quox#1183: the org's hats -> [{ id, key, name, definition }]. Same endpoint as `quox hat list`. */
    async hats() {
      const ep = resolveEndpoint('hat.list', { orgId: orgId() });
      const d = await client.get(ep.path, { service: ep.service });
      return Array.isArray(d?.hats) ? d.hats.filter(h => h.status !== 'archived') : [];
    },
    /** CUSTOM-HATS: create an org hat of your own -> { hat, warnings }. Throws the server's refusal unchanged. */
    async createHat({ key, name, definition, visibility = 'org' }) {
      const ep = resolveEndpoint('hat.create', { orgId: orgId() });
      return client.post(ep.path, { service: ep.service, retries: 0, body: { key, name, definition, visibility } });
    },
    /** CUSTOM-HATS: a new revision of a hat -> { hat, warnings }. */
    async updateHat(hatId, { definition, name, change_reason }) {
      const ep = resolveEndpoint('hat.update', { orgId: orgId(), hatId });
      return client.put(ep.path, { service: ep.service, retries: 0, body: { definition, ...(name ? { name } : {}), change_reason } });
    },
    /** CUSTOM-HATS: delete a custom hat -> { deleted: { key, revision, bindings_cleared, user_prefs_cleared } }. */
    async deleteHat(hatId) {
      const ep = resolveEndpoint('hat.delete', { orgId: orgId(), hatId });
      return client.delete(ep.path, { service: ep.service, retries: 0 });
    },
    /** quox#1183: the hat this conversation is on (or would start on) -> { key, name } | null. */
    async activeHat(conversationId) {
      const ep = resolveEndpoint('hat.resolve', { orgId: orgId() });
      const d = await client.get(ep.path, { service: ep.service, ...(conversationId ? { query: { conversation_id: conversationId } } : {}) });
      return d?.hat ? { key: d.hat.key, name: d.hat.name, source: d.source || null } : null;
    },
    /** quox#1183: the person's own hat switch for this conversation (audited on the server). Throws the refusal unchanged. */
    async bindHat(conversationId, hatId) {
      const ep = resolveEndpoint('hat.bind', { orgId: orgId(), conversationId });
      const d = await client.put(ep.path, { service: ep.service, retries: 0, body: { hat_id: hatId } });
      return d?.binding || d;
    },
    /** QUOXON-FW3: the orgs the signed-in user belongs to -> [{ id, name, slug, role }]. Same endpoint as `quox org list`. */
    async orgs() {
      const ep = resolveEndpoint('orgs.list');
      const d = await client.get(ep.path, { service: ep.service });
      const rows = Array.isArray(d) ? d : (d?.organizations || d?.orgs || d?.data || []);
      return Array.isArray(rows) ? rows : [];
    },
    /**
     * QUOXON-FW3, #1034: re-scope THIS WINDOW to another org. The org-scoped token is held in this window's memory
     * (windowOrg); the shared profile, its file and every other window keep their org. `quox org switch` in a shell is
     * the explicit way to change a profile's default. -> { id, name }. Throws the server's refusal unchanged.
     */
    async switchOrg(targetId) {
      if (!windowOrg) { const e = new Error('Org switching is not available in this mode.'); e.code = 'no_window_org'; throw e; }
      return windowOrg.switchTo(targetId);
    },
    /** The window's own org id when it differs from the profile's (carried across /restart), else null. */
    windowOrgId: () => windowOrg?.current()?.id || null,
    /** -> [{ id, name, description, edition, version, decayState }] ; the org's QSKL procedural skills (read-only list; Crystals are a separate store). */
    async skills() {
      const ep = resolveEndpoint('quoxflow.skills.list');
      const data = await client.get(ep.path, { service: ep.service, query: { orgId: orgId() } });
      const rows = data?.data || data?.records || data;
      return Array.isArray(rows) ? rows : [];
    },
    /** -> the full skill record, or null when unknown (404). */
    async skill(id) {
      const ep = resolveEndpoint('quoxflow.skills.get', { id });
      try { const d = await client.get(ep.path, { service: ep.service, query: { orgId: orgId() } }); return d?.data || d; }
      catch (e) { if (e?.status === 404) return null; throw e; }
    },
    /**
     * Roster of what is running for this org -> { rows, sources:[{ id, label, state:'connected'|'unavailable'|'error', count, note }] }.
     * Each source fails on its own; a source that cannot answer adds no rows (never a placeholder).
     */
    async roster(now = Date.now()) {
      const src = (id, label, fn) => fn().then(
        (rows) => ({ id, label, state: 'connected', rows, count: rows.length }),
        (e) => ({ id, label, rows: [], count: 0, state: missing(e) ? 'unavailable' : 'error', note: missing(e) ? 'no list endpoint on this server' : (e?.message || 'failed') }));
      const parts = await Promise.all([
        src('approvals', 'pending approvals (inbox)', async () => (await listApprovals()).map(i => fromApproval(i, now)).filter(Boolean)),
        src('objectives', 'objectives and loops (tasks)', async () => {
          const ep = resolveEndpoint('objectives.list');
          const d = await client.get(ep.path, { service: ep.service, query: { limit: 100 }, retries: 0 });
          const l = listOf(d, 'objectives'); if (!l) throw new Error('unexpected response');
          return l.map(o => fromObjective(o, now)).filter(Boolean);
        }),
        src('executions', 'workflow executions (quoxflow)', async () => {
          const ep = resolveEndpoint('executions.list');
          const d = await client.get(ep.path, { service: ep.service, retries: 0 });
          const l = listOf(d, 'data', 'items', 'executions'); if (!l) throw new Error('unexpected response');
          return l.map(e => fromExecution(e, now, { userId: userId() })).filter(Boolean);
        })
      ]);
      const unlisted = [
        { id: 'agents', label: 'attached agents', state: 'unavailable', count: 0, note: 'no org-wide list endpoint' },
        { id: 'devsessions', label: 'dev sessions', state: 'unavailable', count: 0, note: 'listed per host only (quox dev sessions <host>)' }
      ];
      return { rows: sortRows(parts.flatMap(p => p.rows)), sources: [...parts.map(({ rows, ...rest }) => rest), ...unlisted] };
    },
    /**
     * Stop one roster row through the governed route that exists for it.
     * -> { ok:true, message } | { ok:false, unavailable:true } | { ok:false, message }.
     */
    async stopRow(row) {
      if (row.source === 'objectives' && row.kind === 'loop') {
        try {
          const ep = resolveEndpoint('objectives.halt', { id: row.id });
          const r = await client.post(ep.path, { service: ep.service, body: { notes: 'via quoxon' }, retries: 0 });
          return r?.status === 'halted' ? { ok: true, message: `Loop halted: ${row.name}` } : { ok: false, message: `Not halted${r?.reason ? ` (${r.reason})` : ''}` };
        } catch (e) { return { ok: false, message: `halt refused: ${e?.message || 'failed'}` }; }
      }
      if (row.source === 'executions') {
        try {
          const ep = resolveEndpoint('runs.cancel', { orgId: orgId(), runId: row.id });
          await client.post(ep.path, { service: ep.service, body: { reason: 'via quoxon' }, retries: 0 });
          return { ok: true, message: `Cancel sent for ${row.name}` };
        } catch (e) { return { ok: false, message: `cancel refused: ${e?.message || 'failed'}` }; }
      }
      return { ok: false, unavailable: true };
    },
    /** /sitrep: the LUCID situation (cursor not moved) and the approvals inbox, each part on its own. */
    async sitrep() {
      const part = async (fn) => { try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, error: e?.status ? `HTTP ${e.status}` : /timed out/i.test(e?.message || '') ? 'timed out' : (e?.message || 'failed') }; } };
      const [situation, approvals] = await Promise.all([
        part(async () => { const ep = resolveEndpoint('lucid.situation'); return client.get(ep.path, { service: ep.service, query: { since: 'last', surface: 'cli' }, retries: 0, timeout: 12000 }); }),
        part(() => listApprovals())
      ]);
      return { situation, approvals };
    },
    /** PRESENCE: PUT /api/v1/presence (/afk, /sleep, /back, a typed turn). -> { ok:true, presence, notice } | { ok:false, message, status }. */
    async setPresence(state, { note, slots } = {}) {
      const ep = resolveEndpoint('presence.set');
      try {
        const d = await client.put(ep.path, { service: ep.service, retries: 0, timeout: 8000, body: { state, org_id: orgId(), ...(note ? { note } : {}), ...(Array.isArray(slots) && slots.length ? { slots } : {}) } });
        return { ok: true, presence: d?.presence || null, notice: d?.notice || null };
      } catch (e) { return { ok: false, message: e?.message || 'failed', status: e?.status || null }; }
    },
    noteActivity,
    /** E5 /away: GET /api/v1/away?since=<iso> -> { since, until, items, activity, blind }. Throws on non-2xx. */
    async away(since) {
      const ep = resolveEndpoint('away.digest');
      return client.get(ep.path, { service: ep.service, query: { since }, retries: 0, timeout: 15000 });
    },
    /** Facts for /observers, each part on its own: { lucid, learning:[{ id, label, state, text }] }. */
    async observers() {
      const part = async (fn) => { try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, unavailable: missing(e), error: e?.message || 'failed' }; } };
      const stat = (id, label, name) => part(async () => {
        const ep = resolveEndpoint(name); const d = await client.get(ep.path, { service: ep.service, retries: 0 });
        return { id, label, text: d?.primaryMetric?.label || null, fields: d?.fields || {} };
      });
      const [sit, lessons, reflect, learn, insight] = await Promise.all([
        part(async () => { const ep = resolveEndpoint('lucid.situation'); return client.get(ep.path, { service: ep.service, query: { since: 'last', surface: 'cli' }, retries: 0 }); }),
        part(async () => { const ep = resolveEndpoint('lucid.lessons'); return client.get(ep.path, { service: ep.service, retries: 0 }); }),
        stat('reflect', 'QuoxReflect', 'engine.reflect.stats'),
        stat('learn', 'QuoxLearn', 'engine.learn.stats'),
        stat('insight', 'QuoxInsight', 'engine.insight.stats')
      ]);
      return { situation: sit, lessons, learning: [reflect, learn, insight] };
    },
    /** /mind [id]: QuoxMind implants from the collector. -> { implants, health } | { implant }. Throws on non-2xx. */
    async mind(id) {
      if (id) { const ep = resolveEndpoint('mind.implant', { id }); return { implant: await client.get(ep.path, { service: ep.service, retries: 0, timeout: 15000 }) }; }
      const [l, h] = await Promise.all([resolveEndpoint('mind.implants'), resolveEndpoint('mind.health')].map((ep) => client.get(ep.path, { service: ep.service, retries: 0, timeout: 15000 })));
      return { implants: l.implants || [], health: h };
    },
    /** /mirror: the Mirror as CommanderQ sees it (compact System Status block + age). Throws on non-2xx. */
    async mirror() {
      const ep = resolveEndpoint('mind.mirror');
      return client.get(ep.path, { service: ep.service, retries: 0, timeout: 10000 });
    },
    /** #904 part 3: providers refusing turns right now (weekly limit, no credits). -> [{ provider, state, line }] | null on error. */
    async providerHealth() {
      try {
        const ep = resolveEndpoint('chat.status.list');
        const d = await client.get(ep.path, { service: ep.service, retries: 0, timeout: 8000 });
        return Array.isArray(d?.provider_health) ? d.provider_health : [];
      } catch { return null; }
    },
    async health(timeoutMs = 12000) {
      const url = joinServiceUrl(config.getServiceUrl('collector'), '/health');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try { const r = await fetch(url, { signal: ctrl.signal }); return { ok: r.ok, status: r.status, url: url.origin }; }
      catch (e) {
        const code = e.cause?.code || '';
        return { ok: false, absent: /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(code), status: e.name === 'AbortError' ? 'slow to answer' : (code || e.message), url: url.origin };
      } finally { clearTimeout(t); }
    },
    /** /capabilities (E1). -> { ok:true, capabilities } | { ok:false, status, missing?, error }. Never assumes. */
    async capabilities() {
      const ep = resolveEndpoint('v1.capabilities');
      try {
        const d = await client.get(ep.path, { service: ep.service, retries: 0 });
        const caps = listOf(d, 'capabilities');
        return caps ? { ok: true, capabilities: caps, computedAt: d?.computed_at || null } : { ok: false, error: 'unexpected response' };
      } catch (e) {
        return { ok: false, status: e?.status, missing: missing(e), error: e?.status ? `HTTP ${e.status} ${e.message || ''}`.trim() : (e?.message || 'failed') };
      }
    },
    /** /connect status: the org vault list (the only source a user can read). -> { ok:true, rows } | { ok:false, error }. */
    async connections() {
      try {
        const ep = resolveEndpoint('vault.list', { orgId: orgId() });
        const d = await client.get(ep.path, { service: ep.service, retries: 0 });
        const rows = listOf(d, 'credentials', 'data', 'items');
        return rows ? { ok: true, rows } : { ok: false, error: 'unexpected response' };
      } catch (e) { return { ok: false, error: e?.status ? `HTTP ${e.status} ${e.message || ''}`.trim() : (e?.message || 'failed') }; }
    },
    /**
     * Server-side live test of a key, nothing persisted (auth test-credentials, SECRETS_WRITE).
     * Sent once (no retries) and flagged sensitive so --debug never prints the body.
     */
    async testProviderKey({ type, credentials }) {
      const ep = resolveEndpoint('vault.test-credentials', { orgId: orgId() });
      try {
        const r = await client.post(ep.path, { service: ep.service, body: { integration_type: type, credentials }, retries: 0, sensitive: true });
        return { ok: r?.success === true, message: r?.message || null };
      } catch (e) { return { ok: false, status: e?.status, message: e?.message || 'failed' }; }
    },
    /** The governed vault write (same route as `quox vault create`): audited, AEE envelope carries type + label only. */
    async saveProviderKey({ type, label, credentials, isDefault, confirmPrivateOrigin }) {
      const ep = resolveEndpoint('vault.create', { orgId: orgId() });
      try {
        const r = await client.post(ep.path, { service: ep.service, body: { integration_type: type, label, credentials, is_default: Boolean(isDefault), ...(confirmPrivateOrigin ? { confirm_private_origin: confirmPrivateOrigin } : {}) }, retries: 0, sensitive: true });
        return { ok: Boolean(r?.id), id: r?.id || null, message: r?.id ? null : 'unexpected response' };
      } catch (e) { return vaultFailure(e); }
    },
    /** B3: refresh an existing vault credential (same governed route as `quox vault update`). */
    async updateProviderCredential({ id, credentials, isDefault, confirmPrivateOrigin }) {
      const ep = resolveEndpoint('vault.update', { orgId: orgId(), id });
      try {
        const r = await client.put(ep.path, { service: ep.service, body: { credentials, is_default: Boolean(isDefault), ...(confirmPrivateOrigin ? { confirm_private_origin: confirmPrivateOrigin } : {}) }, retries: 0, sensitive: true });
        return { ok: Boolean(r && (r.id || r.success || r.credential)), id, message: null };
      } catch (e) { return vaultFailure(e); }
    },
    /** Z2H: read the instance LAN-target gate -> { ok, enabled } | { ok:false, status, message }. */
    async lanTargets() {
      const ep = resolveEndpoint('admin.instance.lan_targets.get');
      try { const r = await client.get(ep.path, { service: ep.service, retries: 0 }); return { ok: true, enabled: Boolean(r?.enabled) }; }
      catch (e) { return { ok: false, status: e?.status, message: e?.message || 'failed' }; }
    },
    /** Z2H: set the instance LAN-target gate (instance admin only; audited server side). */
    async setLanTargets(on) {
      const ep = resolveEndpoint('admin.instance.lan_targets.set');
      try { const r = await client.put(ep.path, { service: ep.service, body: { enabled: Boolean(on) }, retries: 0 }); return { ok: true, enabled: Boolean(r?.enabled) }; }
      catch (e) { return { ok: false, status: e?.status, message: e?.message || 'failed' }; }
    },
    /** B3: server-side probe of an Ollama URL (GET <url>/api/tags). Nothing stored. */
    async ollamaProbe(baseUrl) {
      const ep = resolveEndpoint('chat.providers.ollama.probe');
      try { return await client.post(ep.path, { service: ep.service, body: { base_url: baseUrl }, retries: 0 }); }
      catch (e) { return { ok: false, status: e?.status, error: e?.code || null, message: e?.message || 'failed' }; }
    },
    /** B3: the saved Ollama connection's installed models -> { ok, host, default_model, models } | { ok:false, error, message }. */
    async ollamaModels() {
      const ep = resolveEndpoint('chat.providers.ollama.models');
      try { return await client.get(ep.path, { service: ep.service, retries: 0 }); }
      catch (e) { return { ok: false, status: e?.status, error: e?.code || null, message: e?.message || 'failed' }; }
    },
    /** QUOXON-MODEL: live model list for openai | anthropic -> { ok, models:[{id,family,created}], default_model } | { ok:false, error, message }. */
    async providerModels(provider, { refresh = false } = {}) {
      const ep = resolveEndpoint('chat.providers.models', { provider });
      try { return await client.get(ep.path, { service: ep.service, query: refresh ? { refresh: 1 } : undefined, retries: 0 }); }
      catch (e) { return { ok: false, status: e?.status, error: e?.code || null, message: e?.message || 'failed' }; }
    },
    /** B5: server-side probe of a self-hosted / custom OpenAI-compatible base URL (lmstudio|vllm|custom). Nothing stored. */
    async compatProbe(preset, baseUrl) {
      const ep = resolveEndpoint('chat.providers.compat.probe', { preset });
      try { return await client.post(ep.path, { service: ep.service, body: { base_url: baseUrl }, retries: 0 }); }
      catch (e) { return { ok: false, status: e?.status, error: e?.code || null, message: e?.message || 'failed' }; }
    },
    /** B5: the saved connection's models for a preset -> { ok, host, default_model, models:[{id,context_length,tools}] } | { ok:false, error, message }. */
    async compatModels(preset) {
      const ep = resolveEndpoint('chat.providers.compat.models', { preset });
      try { return await client.get(ep.path, { service: ep.service, retries: 0 }); }
      catch (e) { return { ok: false, status: e?.status, error: e?.code || null, message: e?.message || 'failed' }; }
    },
    /** /vm <verb> ...: the HYPERION Proxmox tools through POST /api/v1/tools/execute. Returns { lines, tone }. */
    async vm(argv) { return runVmCommand({ client, orgId: orgId(), argv }); },
    /** /hyperion: held VMs and who holds them, one line each (read only, GET /api/v1/proxmox/activity). */
    async hyperion() { const data = await fetchActivity(client); return { lines: heldLines(data), tone: data.nodes_error || data.pool_error ? 'warn' : undefined }; },
    approvals: listApprovals,
    /** Org-wide approvals awaiting a human (the dashboard header's server-side count, inbox stats awaiting_human). */
    async approvalStats() {
      const ep = resolveEndpoint('inbox.stats.list', { orgId: orgId() });
      const d = await client.get(ep.path, { service: ep.service });
      return { pending: Number(d?.pending_approvals ?? 0), awaiting: Number(d?.awaiting_human ?? 0) };
    },
    /** GET /api/v1/approvals/:id/result -> { status, result, executed_at } ; null when unknown (404) */
    async approvalResult(approvalId) {
      const ep = resolveEndpoint('v1.approvals.result', { id: approvalId });
      try { return await client.get(ep.path, { service: ep.service, query: { org_id: orgId() || undefined } }); }
      catch (e) { if (e?.status === 404) return null; throw e; }
    },
    /** quox ask: answer a decision with one of its option keys (and an optional note). */
    async answerDecision(itemId, option, { note = null, stepUp = null, bulk = false } = {}) {
      const ep = resolveEndpoint('inbox.respond', { orgId: orgId(), itemId });
      const r = await client.post(ep.path, { service: ep.service, headers: stepUp || {}, body: { action: 'answer', option, ...(bulk ? { bulk: true } : {}), ...(note ? { comment: String(note).slice(0, 4000) } : {}) } });
      if (stepUp && Object.keys(stepUp).length) noteActivity('answer', { quiet: true }); // PRESENCE: answering is the owner being back
      return r;
    },
    async respond(itemId, action, { via = null, stepUp = null, reason = null, bulk = false } = {}) {
      const ep = resolveEndpoint('inbox.respond', { orgId: orgId(), itemId });
      const tag = via ? `via quoxon ${via}` : 'via quoxon';
      const why = reason ? String(reason).trim().slice(0, 4000) : '';
      const r = await client.post(ep.path, { service: ep.service, headers: stepUp || {}, body: { action, ...(bulk ? { bulk: true } : {}), comment: why ? `${why} (${tag})` : tag, ...(why ? { reason: why } : {}) } });
      if (stepUp && Object.keys(stepUp).length) noteActivity('approval', { quiet: true }); // PRESENCE
      return r;
    },
    /** QUOXON-STEPUP: PIN -> short-lived step-up token. The PIN goes straight into the request body; never logged, never stored. */
    async stepUpVerify(pin, { orgId: org = null, scopes = ['approve'] } = {}) {
      const ep = resolveEndpoint('stepup.verify');
      const r = await client.post(ep.path, { service: ep.service, body: { pin, org_id: org || orgId() || undefined, scopes } });
      noteActivity('pin-step-up', { quiet: true }); // PRESENCE: a PIN step-up is a live human
      return r;
    },
    async stepUpStatus() {
      const ep = resolveEndpoint('stepup.status');
      return client.get(ep.path, { service: ep.service });
    },
    /** QUOXON-STEPUP part B: override ONE blocked action. Needs a live override-scoped step-up token. */
    async override({ blockId, blockType, reason, agentId = null, action = null, stepUp = {} }) {
      const ep = resolveEndpoint('safety.override');
      return client.post(ep.path, { service: ep.service, headers: stepUp, body: { block_id: blockId, block_type: blockType, reason, agent_id: agentId || undefined, action: action || undefined } });
    }
  };
}
