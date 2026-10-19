/**
 * LUCID situation v2: the deterministic answer to "what is my situation".
 *
 * Built from the journal with no model. The contract is docs/LUCID_CONTRACT_v2.md:
 * a spoken briefing (L0), ranked ItemCards that need you, one AreaSnapshot per
 * area whose L0 NAMES things, what changed (grouped per subject, with outcome
 * words), what is in motion, what is shelved, and the cannot_see floor.
 * There is no bare "all clear": coverage and blind spots are always stated.
 *
 * Backward compatibility for one release: situation.board, situation.briefing,
 * changed_latest, and the legacy fields on every item (subject, summary, status,
 * gates, waited_ms, since, stale, card) so the current panel and CLI keep working
 * until they switch to the v2 shape.
 */

const journal = require('./journal.js');
const E = require('./explain.js');

const { dur, loadRegistry, buildItem, legacyCard, render, clockOf } = E;

const URGENCY_RANK = { now: 0, today: 1, 'this week': 2, whenever: 3, fyi: 4 };
const NEEDS_HUMAN = new Set(['owner', 'any-human']);
const STREAM_NEEDS = { DECISION_NEEDED: 2 };
// Blocked streams are not actionable now; they stay visible on a shelf until finished.
const SHELVED = new Set(['BLOCKED']);
const TERMINAL = new Set(['succeeded', 'success', 'failed', 'error', 'done', 'completed', 'complete', 'idle',
  'cancelled', 'canceled', 'gone', 'resolved', 'approved', 'denied', 'expired', 'ended']);
// A tool gate that changes the world outranks one that only reads it.
const HIGH_IMPACT = /(deploy|send|publish|post|exec|delete|remove|write|merge|push|restart|pay|charge|transfer|call|email)/i;
const DAY = 86400000;
const ACT_URGENT = new Set(['now', 'today', 'this week']);

function gateWeight(gates = []) {
  let w = 1;
  for (const g of gates) {
    if (g.startsWith('tool:') && HIGH_IMPACT.test(g.slice(5))) w = Math.max(w, 8);
    else if (g.startsWith('deploy:')) w = Math.max(w, 8);
    else if (g.startsWith('stream:')) w = Math.max(w, 3);
  }
  return w;
}

// Salience v1 = wait x gates. Log of the wait so a long-ignored low-stakes ask
// does not drown a fresh one that blocks real work.
function score(weight, waitedMs, unitMs = 60000) {
  const units = Math.max(0, waitedMs) / unitMs;
  return weight * (1 + Math.log(1 + units));
}

// Operational things nobody promised to keep reporting (no expected_by) cannot stay "running" forever.
const MAX_AGE = [['run:', 6 * 3600000], ['session:', 12 * 3600000]];

function isStale(s, now) {
  if (s.expected_by != null) return s.expected_by < now;
  if (s.ledger === 'intentional' || TERMINAL.has(String(s.status).toLowerCase())) return false;
  if (s.salience && NEEDS_HUMAN.has(s.salience.needs)) return false;
  const rule = MAX_AGE.find(([p]) => String(s.subject).startsWith(p));
  return !!rule && s.last_heard != null && now - s.last_heard > rule[1];
}

function feedHealth(feeds, expectedFeeds, now) {
  const byName = new Map(feeds.map((f) => [f.feed, f]));
  const names = new Set([...(expectedFeeds || []), ...byName.keys()]);
  const silent = [];
  const failing = [];
  const unwired = [];
  let live = 0;
  for (const name of [...names].sort()) {
    const f = byName.get(name);
    if (!f) { unwired.push(name); continue; }
    if (f.last_error) { failing.push({ feed: name, error: f.last_error, since: f.last_error_at }); continue; }
    if (f.expected_by != null && f.expected_by < now) { silent.push({ feed: name, last_heard: f.last_heard, silent_ms: now - f.last_heard }); continue; }
    live += 1;
  }
  return { coverage: { live, expected: names.size }, silent, failing, unwired };
}

// ---- entries ------------------------------------------------------------------

function legacyFields(item, s, staleNow, now) {
  const gates = (s.salience && s.salience.gates) || [];
  return Object.assign(item, {
    subject: s.subject, ledger: s.ledger, summary: s.summary, status: s.status, gates,
    waited_ms: now - s.status_since, since: s.status_since, stale: staleNow, card: legacyCard(item),
  });
}

function urgRank(item) {
  return URGENCY_RANK[item.urgency] ?? 4;
}

function nameList(names, max = 3) {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  const head = shown.length <= 1 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : head;
}

function nonInferredAffects(item) {
  return item.L1.affected.filter((a) => !a.inferred).map((a) => a.label);
}

// ---- area composition ---------------------------------------------------------

function composeGroups(spec, ents) {
  const live = ents.filter((e) => !e.stale && e._x.ctx.phase !== 'ended');
  const parts = [];
  for (const g of spec.groups) {
    const names = live.filter((e) => String(e._x.ctx.phase) === String(g.when.phase)).map((e) => e._x.ctx.label);
    if (names.length) parts.push(`${nameList(names)} ${g.label}`);
  }
  return parts.length ? parts.join('; ') : spec.empty;
}

function composePhrases(spec, ents, attn, shelvedCount) {
  const sorted = [...attn].sort((a, b) => urgRank(a) - urgRank(b) || b.waited_ms - a.waited_ms);
  const phrases = sorted.map((e) => {
    if (spec.item) return render(spec.item, e._x.ctx);
    const aff = nonInferredAffects(e);
    return aff.length ? `${e._x.short} (${aff.join(', ')})` : e._x.short;
  });
  const joiner = spec.joiner || '; ';
  const shown = phrases.slice(0, 3);
  const rest = phrases.length - shown.length;
  let text;
  if (phrases.length) text = `${spec.prefix || ''}${shown.join(joiner)}${rest > 0 ? ` and ${rest} more` : ''}`;
  else if (spec.fallback_subject) {
    const fb = ents.find((e) => e.subject === spec.fallback_subject);
    text = fb ? ((spec.fallback_map || {})[String(fb.status).toLowerCase()] || fb.L0) : spec.empty;
  } else text = spec.empty;
  if (spec.aside && shelvedCount) text += `; ${render(spec.aside, { n: shelvedCount })}`;
  return text;
}

function selectEntries(sel, ctxSets) {
  if (sel === 'needs') return ctxSets.needs;
  if (sel === 'open') return ctxSets.open;
  if (sel === 'attention') return ctxSets.attn;
  if (sel === 'shelved') return ctxSets.shelved;
  if (sel && sel.status) return ctxSets.open.filter((e) => sel.status.map((x) => x.toLowerCase()).includes(String(e.status).toLowerCase()));
  if (sel && sel.phase) return ctxSets.open.filter((e) => String(e._x.ctx.phase) === String(sel.phase));
  return [];
}

function computeStats(spec, sets, ents) {
  const out = {};
  for (const [key, def] of Object.entries(spec || {})) {
    if (def.count !== undefined) out[key] = selectEntries(def.count, sets).length;
    else if (def.names !== undefined) out[key] = selectEntries(def.names, sets).map((e) => String(e._x.ctx.label || e._x.ctx.code || e.subject));
    else if (def.oldest !== undefined) {
      const sel = selectEntries(def.oldest, sets);
      out[key] = sel.length ? dur(Math.max(...sel.map((e) => e.waited_ms))) : 'none';
    }
  }
  // Numbers a feed supplied itself ride along; they never override what I computed.
  for (const e of ents) {
    const fs = e.L3.state && e.L3.state.stats;
    if (fs && typeof fs === 'object' && !Array.isArray(fs)) {
      for (const [k, v] of Object.entries(fs)) if (!(k in out) && (typeof v === 'number' || typeof v === 'string' || Array.isArray(v))) out[k] = v;
    }
  }
  return out;
}

function outcomeFor(reg, row) {
  const o = reg.outcomes[String(row.status).toLowerCase()];
  if (o) return o;
  return row.kind === 'retract' ? 'dealt with' : undefined;
}

/**
 * A retract row carries only {status: 'gone'}, so its words would come out as blank template slots
 * ("Proof Matrix: of jobs proven in chat"). Describe it by what the subject last was: the newest earlier
 * row in the tail, else the subject's own history.
 */
function wordsRow(r, recent, orgId) {
  if (r.kind !== 'retract') return r;
  const usable = (x) => x.subject === r.subject && x.kind !== 'retract' && x.kind !== 'heartbeat' && x.seq < r.seq;
  const was = (recent || []).filter(usable).sort((a, b) => b.seq - a.seq)[0];
  if (was) return was;
  try {
    const h = journal.subjectHistory(orgId, r.subject, { limit: 20 }).filter(usable);
    if (h.length) return h[h.length - 1];
  } catch { /* no history: fall back to the row itself */ }
  return r;
}

function feedsInPlay(reg, feeds, expectedFeeds) {
  const host = reg.hostFeeds || new Set();
  const heard = new Set(feeds.map((f) => f.feed));
  const declared = new Set(expectedFeeds || []);
  return (name) => !host.has(name) || declared.has(name) || heard.has(name);
}

function buildAreas({ orgId, reg, entries, needs, shelved, feeds, health, recent, lessons, now, tz, inPlay = () => true }) {
  const needSet = new Set(needs);
  const badFeeds = new Set([...health.silent.map((x) => x.feed), ...health.failing.map((x) => x.feed)]);
  const knownFeeds = new Set(feeds.map((f) => f.feed));
  return reg.areas.map((a) => {
    const mine = entries.filter((e) => e.area === a.key);
    const sh = shelved.filter((e) => e.area === a.key);
    const need = needs.filter((e) => e.area === a.key);
    const attn = mine.filter((e) => !e._x.muted && !e.stale && (needSet.has(e) || e._x.attn) && !sh.includes(e));
    const sets = { needs: need, open: mine.filter((e) => !sh.includes(e)), attn, shelved: sh };

    const names = [...new Set([...(a.feeds || []), ...mine.map((e) => e.L3.feed).filter(Boolean)])];
    const known = names.filter((n) => knownFeeds.has(n));
    const feedsOut = {
      live: known.filter((n) => !badFeeds.has(n)),
      silent: known.filter((n) => badFeeds.has(n)),
      unwired: (a.feeds || []).filter((n) => inPlay(n) && !knownFeeds.has(n)),
    };
    const missing = [...feedsOut.unwired, ...feedsOut.silent];

    let state;
    let L0;
    const composed = a.L0.composer === 'groups' ? composeGroups(a.L0, mine) : composePhrases(a.L0, mine, attn, sh.length);
    if (!known.length) { state = 'unknown'; L0 = `Not connected yet: ${a.unwired}`; }
    else if (known.every((n) => badFeeds.has(n))) { state = 'blind'; L0 = `Not reporting (${composed})`; }
    else {
      // Callers waiting for review are low urgency but not "all clear": People is never ok while any wait.
      const waiting = mine.filter((e) => e._x.variant === 'unknown_callers' && !e._x.muted && !e.stale && !sh.includes(e));
      state = attn.concat(need).some((e) => ACT_URGENT.has(e.urgency)) || waiting.length ? 'attention' : 'ok';
      L0 = waiting.length && composed === a.L0.empty ? waiting[0].L0 : composed;
      // Honesty floor: an area is only "ok" when every feed that speaks for it is speaking.
      if (missing.length) {
        const gap = `Partly connected: I can't see ${E.listWords(missing)}`;
        if (state === 'ok') state = 'partial';
        L0 = `${L0.replace(/[.]$/, '')}. ${gap}`;
      }
    }

    const lead = need[0] || attn[0];
    let last = null;
    for (const r of recent) {
      if (r.kind === 'heartbeat' || r.subject.startsWith('legacy:')) continue;
      if (E.areaOf(r.subject, r.ledger) !== a.key) continue;
      const src = wordsRow(r, recent, orgId);
      const it = buildItem({ subject: r.subject, ledger: r.ledger, status: src.status, summary: src.summary || r.summary, state: src.state, feed: r.source && r.source.feed, status_since: r.ts, last_heard: r.ts },
        { now, tz, lessons });
      const out = outcomeFor(reg, r);
      let lastL0 = it.L0.replace(/^Approval needed: /, '');
      // #968: a generic retract ('dealt with') means an operational problem was CLEARED. Pre-fix
      // rows kept the FAILURE summary as the row text, so an area's `last` surfaced e.g. "The
      // approvals list could not be read (fetch failed)" and chat read a resolved problem as
      // current. Lead such a resolved event with "Resolved:" so it cannot be misread. Approval
      // retracts (outcome 'approved'/'denied', L0 is the ask) are untouched.
      if (out === 'dealt with' && !/^(resolved|no longer|recovered)\b/i.test(lastL0)) {
        lastL0 = `Resolved: ${lastL0}`;
      }
      last = { L0: lastL0, ts: r.ts, ref: r.subject, ...(out ? { outcome: out } : {}) };
      break;
    }

    const affected = [];
    const seen = new Set();
    for (const e of [...need, ...attn]) for (const x of e.L1.affected) if (!seen.has(x.label)) { seen.add(x.label); affected.push(x); }

    return {
      area: a.key, label: a.label, state, L0,
      L1: { needs: need, open: mine.filter((e) => !need.includes(e)).slice(0, 50), affected },
      L2: { measures: lead ? lead.L2.measures : [] },
      last,
      stats: computeStats(a.stats, sets, mine),
      feeds: feedsOut,
    };
  });
}

/**
 * "Doesn't add up": two things I was told that cannot both be true (epistemic:contradiction:*).
 * Urgent ones (something the owner was told is done that is not; code committed but not running
 * for a day) come first, then the oldest.
 */
function doesntAddUp(entries) {
  return entries.filter((e) => e.ref.startsWith('epistemic:contradiction:')).map((e) => {
    const st = (e.L3 && e.L3.state) || {};
    return {
      ref: e.ref, rule: st.rule || e.ref.split(':')[2] || '', L0: e.L0, who: 'LUCID', what: e.L1.what, why: e.L1.why, how: (e._x && e._x.how) || '',
      claimed: st.claimed || '', observed: st.observed || '', sources: Array.isArray(st.sources) ? st.sources : [],
      since: Number(st.since) || e.since, urgent: (st.urgent === 'true' || e.urgency === 'today') && e.urgency === 'today', urgency: e.urgency,
    };
  }).sort((a, b) => (b.urgent - a.urgent) || a.since - b.since);
}

function missingNames(health) {
  return [...new Set([...health.unwired, ...health.silent.map((x) => x.feed), ...health.failing.map((x) => x.feed)])].sort();
}

function coverageSentence(health) {
  const gone = missingNames(health);
  if (!gone.length) return '';
  return `I can see ${health.coverage.live} of ${health.coverage.expected} sources; not connected or not reporting: ${gone.join(', ')}.`;
}

function briefingOf(needs, areas, reg, health) {
  const low = needs.filter((n) => n.urgency === 'whenever' || n.urgency === 'fyi');
  const act = needs.filter((n) => n.urgency !== 'whenever' && n.urgency !== 'fyi');
  const parts = [];
  if (!needs.length) parts.push('Nothing needs you right now.');
  else {
    // The count is what NEEDS YOU lists, so the headline and the list always agree.
    parts.push(`${needs.length} thing${needs.length === 1 ? ' needs' : 's need'} you${low.length ? `, ${low.length} ${low.length === 1 ? 'is' : 'are'} low priority` : ''}.`);
    act.slice(0, 3).forEach((n, i) => parts.push(`${['First', 'Second', 'Third'][i]}: ${n.L0}.`));
    if (act.length > 3) parts.push(`And ${act.length - 3} more.`);
  }
  const quiet = (st) => areas.filter((b) => b.state === st && (reg.areaByKey[b.area].brief_unwired !== false || st !== 'unknown')).map((b) => b.label.toLowerCase());
  const unknown = quiet('unknown');
  const blind = quiet('blind');
  if (unknown.length) parts.push(`I can't see your ${E.listWords(unknown, 'or')} yet, they are not connected.`);
  if (blind.length) parts.push(`${E.listWords(blind, 'or').replace(/^./, (c) => c.toUpperCase())} stopped reporting, so I may be out of date there.`);
  const cov = coverageSentence(health);
  if (cov) parts.push(cov);
  return parts.join(' ');
}

// ---- the situation --------------------------------------------------------------

// The viewer-independent core (every open subject explained, ranked and shelved) is the
// expensive part and is the same for every caller, so it is built at most once per few
// seconds per org and shared: the herald, decks, the page, CommanderQ and the phone all
// read it. A new journal row refreshes it after CORE_MIN_MS; otherwise it lives CORE_MAX_MS.
const CORE_MIN_MS = 3000;
const CORE_MAX_MS = 30000;
const _core = new Map();
const _rowItems = new Map();
function clearCoreCache() { _core.clear(); _rowItems.clear(); }

function computeCore(orgId, now, tz, injected) {
  const reg = loadRegistry();
  // injected = { open, recent } lets replay.js build a past picture from folded journal rows.
  const open = injected ? injected.open : journal.listOpenSubjects(orgId);
  const lessons = journal.listLessons(orgId);
  const recent = injected ? injected.recent : journal.recentJournal(orgId, { limit: 300 });

  const trans = new Map();
  for (const r of [...recent].reverse()) {
    if (r.kind === 'heartbeat') continue;
    if (!trans.has(r.subject)) trans.set(r.subject, []);
    trans.get(r.subject).push({ from: r.prev_status, to: r.status, ts: r.ts, ...(r.held_ms != null ? { held_ms: r.held_ms } : {}) });
  }

  const stale = [];
  const needs = [];
  const motion = [];
  const shelved = [];
  const entries = [];
  const applied = new Set();

  for (const s of open) {
    // #984: a provider limit with a stated reset time is over once that time passes, even when no successful
    // turn ever retracted it (the limit record expires silently), so it stops being open.
    if (s.subject.startsWith('provider:') && s.state && s.state.resets_at && Date.parse(s.state.resets_at) <= now) continue;
    const staleNow = isStale(s, now);
    if (staleNow) stale.push({ subject: s.subject, ledger: s.ledger, summary: s.summary, last_heard: s.last_heard, silent_ms: now - s.last_heard });
    const item = legacyFields(buildItem(s, { now, tz, lessons, stale: staleNow, transitions: (trans.get(s.subject) || []).slice(-10) }), s, staleNow, now);
    for (const id of item._x.applied) applied.add(id);
    entries.push(item);
    const gates = item.gates;
    const waited = item.waited_ms;
    const muted = item._x.muted;
    if (s.ledger === 'intentional') {
      if (SHELVED.has(s.status)) shelved.push(item);
      else if (STREAM_NEEDS[s.status] && !muted) { item.score = score(STREAM_NEEDS[s.status], waited, DAY); needs.push(item); }
    } else if (!muted && ((s.salience && NEEDS_HUMAN.has(s.salience.needs)) || item._x.watched || (item.needs !== 'none' && NEEDS_HUMAN.has(item.needs)))) {
      item.score = score(gateWeight(gates), waited);
      needs.push(item);
    } else if (s.ledger === 'operational' && !staleNow && !TERMINAL.has(String(s.status).toLowerCase()) && item._x.ctx.activity !== 'ended') {
      motion.push(Object.assign(item, { for_ms: waited }));
    }
  }
  // One problem, one item: a sentry "unit failed" note is the same thing as the unit's own item.
  const unitKey = (subj) => String(subj).replace(/^(unit:(user\/)?|sentry:unit-failed-)/, '').replace(/\.service$/, '');
  const unitOwn = new Set(entries.filter((e) => e.subject.startsWith('unit:') && (needs.includes(e) || e._x.attn)).map((e) => unitKey(e.subject)));
  for (let i = needs.length - 1; i >= 0; i -= 1) {
    if (needs[i].subject.startsWith('sentry:unit-failed-') && unitOwn.has(unitKey(needs[i].subject))) needs.splice(i, 1);
  }
  // What can be acted on now comes first; within the same urgency, salience decides.
  needs.sort((a, b) => urgRank(a) - urgRank(b) || b.score - a.score || a.since - b.since);
  for (const n of needs) n.score = Math.round(n.score * 100) / 100;
  shelved.sort((a, b) => a.since - b.since);
  return { reg, open, lessons, recent, stale, needs, motion, shelved, entries, applied };
}

/** L0 + kind + actor id; null = never merge (the WHO is a fallback nobody can tell apart). */
function mergeKey(it) {
  const st = (it.L3 && it.L3.state) || {};
  const a = st.actor && typeof st.actor === 'object' ? (st.actor.id && st.actor.id !== 'unknown' ? st.actor.id : st.actor.name) : st.actor;
  let id = String(st.agent_id || st.agent || a || st.requested_by || '').trim().toLowerCase();
  if (!id || id === 'unknown' || id === 'an agent' || id === 'agent') id = '';
  const who = String((it.L1 && it.L1.who) || '');
  const fallback = /^an agent\b/i.test(who) || /did not say which/i.test(who) || /^an agent\b/i.test(String(it.L0 || ''));
  if (fallback && !id) return null;
  return `${it.L0}|${it.kind || ''}|${id}`;
}

function coreFor(orgId, now, tz) {
  const key = `${journal.generation()}|${orgId}|${tz}`;
  const seq = journal.latestSeq(orgId);
  const lessonsN = journal.listLessons(orgId).length;
  const needsGen = journal.needsGeneration();
  const hit = _core.get(key);
  if (hit && hit.lessonsN === lessonsN && hit.needsGen === needsGen && ((hit.seq === seq && now - hit.at < CORE_MAX_MS) || now - hit.at < CORE_MIN_MS)) return hit.core;
  const core = computeCore(orgId, now, tz);
  if (_core.size > 100) _core.clear();
  _core.set(key, { at: now, seq, lessonsN, needsGen, core });
  return core;
}

function buildSituation(orgId, { now = Date.now(), sinceSeq = 0, expectedFeeds = [], changedLimit = 200, tz = 'Europe/London', injected = null } = {}) {
  const { reg, open, lessons, recent, stale, needs, motion, shelved, entries, applied } = injected ? computeCore(orgId, now, tz, injected) : coreFor(orgId, now, tz);
  const doesnt_add_up = doesntAddUp(entries);

  // changed: grouped per subject, latest state wins, count of moves, plain outcome
  const tail = injected && injected.tail ? injected.tail : journal.journalTail(orgId, { afterSeq: sinceSeq, limit: changedLimit });
  const rows = tail.rows;
  const bySubject = new Map();
  for (const r of rows) {
    const prev = bySubject.get(r.subject);
    bySubject.set(r.subject, prev ? { r, changes: prev.changes + 1, first_from: prev.first_from } : { r, changes: 1, first_from: r.prev_status });
  }
  const changed = [...bySubject.values()].map(({ r, changes, first_from }) => {
    // A journal row never changes, so its explanation is cached by seq (lessons change the key).
    const ck = `${journal.generation()}|${orgId}|${r.seq}|${lessons.length}|${tz}`;
    let it = _rowItems.get(ck);
    if (!it) {
      const src = wordsRow(r, recent, orgId);
      it = buildItem({ subject: r.subject, ledger: r.ledger, status: src.status, summary: src.summary || r.summary, state: src.state, feed: r.source && r.source.feed, status_since: r.ts, last_heard: r.ts },
        { now, tz, lessons });
      if (_rowItems.size > 5000) _rowItems.clear();
      _rowItems.set(ck, it);
    }
    const outcome = outcomeFor(reg, r);
    return {
      ref: r.subject, subject: r.subject, L0: it.L0, from: r.prev_status, to: r.status, ts: r.ts,
      ...(r.held_ms != null ? { held_ms: r.held_ms } : { held_ms: null }), ...(outcome ? { outcome } : {}), changes,
      seq: r.seq, ledger: r.ledger, kind: r.kind, summary: r.summary, first_from, urgency: it.urgency, area: it.area,
    };
  }).sort((a, b) => a.seq - b.seq);

  const feeds = injected && injected.feeds ? injected.feeds : journal.listFeeds(orgId);
  const health = feedHealth(feeds, expectedFeeds, now);
  // The honesty floor counts every feed an area relies on, not only the ones someone declared.
  // A host feed (dev-suite gatherer, tail, hooks) is only part of this install once declared or heard:
  // a customer install must not be told it is missing feeds it never ships.
  const inPlay = feedsInPlay(reg, feeds, expectedFeeds);
  const coverage = feedHealth(feeds, [...new Set([...(expectedFeeds || []), ...reg.areas.flatMap((a) => (a.feeds || []).filter(inPlay))])], now);
  const areas = buildAreas({ orgId, reg, entries, needs, shelved, feeds, health, recent, lessons, now, tz, inPlay });
  // The same thing happening several times is one item with a count, not a wall of repeats.
  const grouped = [];
  const byL0 = new Map();
  for (const it of needs) {
    // Approvals each need their own yes or no, so they are never merged. Neither are items whose
    // WHO is a fallback ("An agent"): two unnamed agents are not known to be one.
    const key = it.kind === 'approval' ? null : mergeKey(it);
    const prev = key == null ? null : byL0.get(key);
    if (prev) { prev.repeats += 1; prev.also.push(it.ref); continue; }
    const g = { ...it, repeats: 1, also: [] };
    if (key != null) byL0.set(key, g);
    grouped.push(g);
  }
  for (const g of grouped) if (g.repeats > 1) g.L0 = `${g.L0} (${g.repeats} times)`;
  const L0 = briefingOf(grouped, areas, reg, coverage);
  const board = areas.map((a) => ({ area: a.area, label: a.label, state: a.state, headline: a.L0, needs: a.L1.needs.length,
    latest: a.last ? { title: a.last.outcome ? `${a.last.L0}: ${a.last.outcome}` : a.last.L0, ts: a.last.ts, ref: a.last.ref } : null }));

  return {
    v: 2,
    org_id: orgId,
    generated_at: now,
    viewer: 'owner',
    surface: 'api',
    cursor: { from: Number(sinceSeq) || 0, to: tail.lastSeq },
    L0,
    needs_you: grouped,
    areas,
    changed,
    in_motion: motion,
    shelved,
    doesnt_add_up,
    // #968: the honesty floor, not the narrow declared view — cannot_see counts every feed any
    // area relies on (19), so a 5-live org reads 5 of 19, consistent with the coverage field below.
    cannot_see: { ...coverage, stale },
    lessons_applied: applied.size,
    // ---- compat, one release ----
    board,
    briefing: L0,
    coverage: { live: coverage.coverage.live, expected: coverage.coverage.expected, missing: missingNames(coverage) },
    changed_total: tail.total,
    changed_rows: rows.length,
    changed_latest: changed,
  };
}

/** One item with its full account, measures and evidence trail (the "why" drill-down). */
function itemFor(orgId, ref, { now = Date.now(), tz = 'Europe/London' } = {}) {
  const s = journal.getSubject(orgId, ref);
  if (!s) return null;
  const lessons = journal.listLessons(orgId);
  const hist = journal.subjectHistory(orgId, ref, { limit: 50 }).filter((r) => r.kind !== 'heartbeat')
    .map((r) => ({ from: r.prev_status, to: r.status, ts: r.ts, ...(r.held_ms != null ? { held_ms: r.held_ms } : {}) }));
  const staleNow = s.resolved_at == null && isStale(s, now);
  const item = legacyFields(buildItem(s, { now, tz, lessons, stale: staleNow, transitions: hist }), s, staleNow, now);
  const gates = item.gates;
  item.score = Math.round(score(s.ledger === 'intentional' ? (STREAM_NEEDS[s.status] || 1) : gateWeight(gates), item.waited_ms, s.ledger === 'intentional' ? DAY : 60000) * 100) / 100;
  return item;
}

// ---- renderers --------------------------------------------------------------------

const GLYPH = { ok: '✔', partial: '◐', attention: '⚠', unknown: '?', blind: '✖', replay: '·' };
const URGENCY_LABEL = { now: 'NOW', today: 'TODAY', 'this week': 'THIS WEEK', whenever: 'WHENEVER', fyi: 'FYI' };

function label(item) {
  return item.summary || item.subject;
}

function gateLabel(g) {
  return g.replace(/^(tool|stream|deploy):/, '');
}

function ago(ms) {
  if (ms < 60000) return 'just now';
  return `${dur(ms)} ago`;
}

function pad(s, n) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t.padEnd(n);
}

/** Compact, id-rich form: for agents and logs. */
function renderCompact(sit, { now = sit.generated_at || Date.now(), maxChanged = 15, maxNeeds = 8 } = {}) {
  const out = [];
  const n = sit.needs_you;
  out.push(`NEEDS YOU (${n.length})`);
  if (!n.length) out.push('  nothing is waiting on you that I can see (see the last section for what I cannot see)');
  n.slice(0, maxNeeds).forEach((x, i) => {
    const gates = x.gates.length ? ` · gates ${x.gates.map(gateLabel).join(', ')}` : '';
    const st = x.ledger === 'intentional' ? ` · ${x.status}` : '';
    out.push(`  ${i + 1}. ${label(x)} · ${x.ref} · ${x.urgency}${st} · waiting ${dur(x.waited_ms)}${gates}${x.stale ? ' · STALE, source silent' : ''}`);
    if (x.L2.measures.length) out.push(`     measures: ${x.L2.measures.map((m) => m.id).join(', ')}`);
  });
  if (n.length > maxNeeds) out.push(`  … and ${n.length - maxNeeds} more, lower ranked (quox lucid subjects)`);

  const c = sit.changed;
  out.push('');
  const truncated = sit.changed_rows != null && sit.changed_total > sit.changed_rows;
  out.push(truncated
    ? `CHANGED SINCE YOU LAST LOOKED (latest ${sit.changed_rows} of ${sit.changed_total} changes since you last looked, ${c.length} ${c.length === 1 ? 'thing' : 'things'})`
    : `CHANGED SINCE YOU LAST LOOKED (${c.length} ${c.length === 1 ? 'thing' : 'things'}, ${sit.changed_total} ${sit.changed_total === 1 ? 'change' : 'changes'})`);
  if (!c.length) out.push('  nothing has changed since you last looked');
  const shown = c.slice(-maxChanged);
  if (c.length > shown.length) out.push(`  … ${c.length - shown.length} earlier things not shown`);
  for (const x of shown) {
    const many = x.changes > 1 ? ` (${x.changes} changes)` : '';
    const move = x.from == null ? `new, ${x.to}` : (x.from === x.to ? `${x.to}, updated` : `${x.from} → ${x.to}${x.held_ms != null ? ` after ${dur(x.held_ms)}` : ''}`);
    out.push(`  · ${label(x)} · ${x.ref} · ${move}${many} · ${dur(now - x.ts)} ago`);
  }

  const m = sit.in_motion;
  out.push('');
  out.push(`IN MOTION (${m.length})`);
  if (!m.length) out.push('  nothing in motion that I can see');
  for (const x of m) out.push(`  · ${x.L0} · ${x.ref} · ${x.status} ${dur(x.for_ms)}`);

  const sh = sit.shelved || [];
  if (sh.length) {
    out.push('');
    out.push(`SHELVED (${sh.length} blocked, kept until finished)`);
    out.push(`  ${sh.map((x) => x.subject.replace(/^stream:/, '')).join(', ')}`);
  }

  out.push('');
  out.push('AREAS');
  for (const a of sit.areas) out.push(`  ${a.area} [${a.state}] ${a.L0}`);

  const da = sit.doesnt_add_up || [];
  if (da.length) {
    out.push('');
    out.push(`DOESN'T ADD UP (${da.length})`);
    for (const x of da) out.push(`  · ${x.L0} · ${x.ref}${x.urgent ? ' · URGENT' : ''} · claimed: ${x.claimed} · observed: ${x.observed} · sources ${x.sources.join(', ')}`);
  }

  const cs = sit.cannot_see;
  out.push('');
  out.push('WHAT I CANNOT SEE');
  out.push(`  ${cs.coverage.live}/${cs.coverage.expected} feeds speaking`);
  if (cs.silent.length) out.push(`  silent: ${cs.silent.map((s) => `${s.feed}: silent ${dur(s.silent_ms)}`).join(' · ')}`);
  if (cs.failing.length) out.push(`  failing: ${cs.failing.map((f) => `${f.feed} (${f.error})`).join(' · ')}`);
  if (cs.unwired.length) out.push(`  never heard: ${cs.unwired.join(', ')}`);
  if (cs.stale.length) out.push(`  stale claims: ${cs.stale.map((s) => `${s.subject} (last heard ${dur(s.silent_ms)} ago)`).join(' · ')}`);
  if (!cs.silent.length && !cs.failing.length && !cs.unwired.length && !cs.stale.length) {
    out.push('  every feed I know of is speaking; I only know what they report');
  }
  return out.join('\n');
}

function measureLines(measures, indent) {
  const out = [];
  measures.forEach((m, i) => {
    out.push(`${indent}${i + 1}. ${m.label}${m.say ? `: ${m.say}` : ''}${m.risk !== 'safe' ? ` [${m.risk}]` : ''}`);
    if (m.command) out.push(`${indent}   $ ${m.command}`);
    else if (m.url) out.push(`${indent}   ${m.url}`);
  });
  return out;
}

/** For a person: plain words, an area table, and WHO/WHAT/WHY/WHEN/AFFECTED/what you can do per item. */
function renderSituation(sit, { now = sit.generated_at || Date.now(), tz = 'Europe/London', maxNeeds = 6, maxChanged = 8 } = {}) {
  const out = [];
  out.push(`In short: ${sit.L0}`);
  out.push('');
  out.push('AT A GLANCE');
  out.push(`  ${pad('AREA', 11)}${pad('NOW', 46)}${pad('LAST', 44)}WHEN`);
  for (const a of sit.areas) {
    const last = a.last ? (a.last.outcome ? `${a.last.L0}: ${a.last.outcome}` : a.last.L0) : (a.state === 'unknown' ? '' : 'nothing yet');
    out.push(`  ${pad(a.label, 11)}${pad(`${GLYPH[a.state] || ' '} ${a.L0}`, 46)}${pad(last, 44)}${a.last ? ago(now - a.last.ts) : ''}`);
  }

  const n = sit.needs_you;
  out.push('');
  out.push(n.length ? `NEEDS YOU (${n.length})` : 'NEEDS YOU: nothing right now');
  n.slice(0, maxNeeds).forEach((x, i) => {
    out.push('');
    out.push(`  ${i + 1}. ${x.L0}   [${URGENCY_LABEL[x.urgency] || x.urgency}]`);
    out.push(`     Who   ${x.L1.who}`);
    out.push(`     What  ${x.L1.what}`);
    if (x.L1.why) out.push(`     Why   ${x.L1.why}`);
    out.push(`     When  ${ago(x.L1.when.waited_ms)} (${clockOf(x.L1.when.since, tz)})${x.L3.confidence.stale ? ', source has gone quiet so this may be out of date' : ''}`);
    if (x.L1.affected.length) out.push(`     Affected  ${x.L1.affected.map((a) => `${a.label} (${a.how}${a.inferred ? ', inferred' : ''})`).join('; ')}`);
    if (x.L2.measures.length) {
      out.push('     What you can do');
      out.push(...measureLines(x.L2.measures, '       '));
    }
  });
  if (n.length > maxNeeds) out.push(`\n  …and ${n.length - maxNeeds} more lower down (quox lucid subjects)`);

  const ch = sit.changed.filter((c) => c.urgency !== 'fyi' || c.subject.startsWith('approval:') || c.subject.startsWith('build:last:'));
  out.push('');
  out.push(ch.length ? 'SINCE YOU LAST LOOKED' : 'SINCE YOU LAST LOOKED: nothing important changed');
  for (const c of ch.slice(-maxChanged).reverse()) {
    const what = c.outcome ? c.outcome : c.from == null ? 'new' : c.from === c.to ? 'updated' : `now ${String(c.to).toLowerCase().replace(/_/g, ' ')}`;
    out.push(`  · ${c.L0.replace(/^Approval needed: /, '')}: ${what}${c.changes > 1 ? ` (${c.changes} changes)` : ''} · ${ago(now - c.ts)}`);
  }

  if ((sit.shelved || []).length) {
    out.push('');
    out.push(`SHELVED: ${sit.shelved.length} blocked plans, kept here until they are finished (quox lucid subjects --ledger intentional)`);
  }

  const da = sit.doesnt_add_up || [];
  if (da.length) {
    out.push('');
    out.push(`DOESN'T ADD UP (${da.length})`);
    da.slice(0, 5).forEach((x, i) => {
      out.push('');
      out.push(`  ${i + 1}. ${x.L0}${x.urgent ? '   [TODAY]' : ''}`);
      out.push(`     Who      ${x.who}`);
      out.push(`     Claimed  ${x.claimed}`);
      out.push(`     Observed ${x.observed}`);
      out.push(`     Why      ${x.why}`);
      out.push(`     Settle   ${x.how}`);
    });
    if (da.length > 5) out.push(`\n  …and ${da.length - 5} more (quox lucid blind)`);
  }

  const cs = sit.cannot_see;
  out.push('');
  out.push(`HOW SURE I AM: ${cs.coverage.live} of ${cs.coverage.expected} sources reporting.${cs.unwired.length ? ` Not connected: ${cs.unwired.join(', ')}.` : ''}${cs.silent.length ? ` Gone quiet: ${cs.silent.map((x) => `${x.feed} (${dur(x.silent_ms)})`).join(', ')}.` : ''}${cs.failing.length ? ` Failing: ${cs.failing.map((x) => x.feed).join(', ')}.` : ''}`);
  return out.join('\n');
}

/** For the phone: sentences only, no tables, no ids. L0s only; drill down with spokenMore / spokenMeasures. */
function renderSpoken(sit) {
  const parts = [sit.L0];
  const glance = sit.areas.filter((a) => a.state !== 'unknown').map((a) => `${a.label}: ${a.L0}`);
  if (glance.length) parts.push(`At a glance. ${glance.join('. ')}.`);
  const da = sit.doesnt_add_up || [];
  if (da.length) {
    const first = String(da[0].L0).replace(/[.]$/, '');
    parts.push(da.length === 1 ? `One thing doesn't add up: ${first}.` : `${da.length} things don't add up, starting with: ${first}.`);
  }
  const cv = sit.coverage || (sit.cannot_see && { live: sit.cannot_see.coverage.live, expected: sit.cannot_see.coverage.expected, missing: missingNames(sit.cannot_see) });
  // The briefing (first part) already ends with the coverage sentence when anything is missing: say it once.
  if (cv && !/I can see \d+ of \d+ sources/.test(parts[0] || '')) parts.push(`I can see ${cv.live} of ${cv.expected} sources; not connected: ${cv.missing.length ? cv.missing.join(', ') : 'none'}.`);
  return parts.join('\n');
}

function findItem(ref, opts = {}) {
  if (ref && typeof ref === 'object' && ref.L1) return ref;
  if (opts.item) return opts.item;
  const sit = opts.sit;
  if (sit) {
    const pool = [...sit.needs_you, ...sit.in_motion, ...sit.shelved, ...sit.areas.flatMap((a) => [...a.L1.needs, ...a.L1.open])];
    const hit = pool.find((x) => x.ref === ref);
    if (hit) return hit;
  }
  if (opts.orgId && journal.isReady()) return itemFor(opts.orgId, ref, { now: opts.now });
  return null;
}

/** "Tell me more": the L1 account as sentences. */
function spokenMore(ref, opts = {}) {
  const it = findItem(ref, opts);
  if (!it) return 'I could not find that item any more.';
  const a = it.L1;
  const s = [`${it.L0.replace(/[.]$/, '')}.`];
  if (a.who) s.push(`This is from ${a.who}.`);
  if (a.what) s.push(/[.!?]$/.test(a.what) ? a.what : `${a.what}.`);
  if (a.why) s.push(a.why);
  s.push(`It has been like this for ${dur(a.when.waited_ms)}.`);
  if (a.affected.length) s.push(`That affects ${a.affected.map((x) => `${x.label} (${x.how})`).join(', ')}.`);
  return s.join(' ');
}

/** "What can I do": the L2 measures as sentences. Dangerous ones are never offered by voice. */
function spokenMeasures(ref, opts = {}) {
  const it = findItem(ref, opts);
  if (!it) return 'I could not find that item any more.';
  const ms = it.L2.measures.filter((m) => m.risk !== 'dangerous');
  if (!ms.length) return 'There is nothing I can do about this from here.';
  const s = ['Here is what you can do.'];
  ms.forEach((m, i) => s.push(`${['One', 'Two', 'Three', 'Four', 'Five', 'Six'][i] || i + 1}: ${m.say || m.label}${m.risk === 'gated' ? ' That one needs your approval first.' : ''}`));
  return s.join(' ');
}

module.exports = {
  clearCoreCache,
  isStale, MAX_AGE, buildSituation, itemFor, renderSituation, renderCompact, renderSpoken, spokenMore, spokenMeasures, gateWeight, dur,
};
