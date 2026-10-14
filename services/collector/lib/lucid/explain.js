/**
 * LUCID explain: turn raw subjects into something a person can act on.
 *
 * Owner rule (2026-10-09): awareness for a human is not an error log. Every
 * item says WHO is asking, WHAT the problem is in plain words, WHY it is
 * happening, WHEN, and what to DO about it. Raw ids stay available as `ref`
 * for agents, never as the headline.
 *
 * v2: the wording is DATA. registry/ holds areas.json, kinds/*.json (one per
 * subject prefix), impact.json (who is affected) and measures.json (what you
 * can do). This file is the loader, a deliberately tiny template engine (no
 * eval, mustache-style {field} plus five helpers) and the ItemCard builder.
 *
 * Precedence per layer: lesson > feed-supplied (state.layers / state.card)
 * > registry template > fallback. Every layer records where it came from.
 */

const fs = require('fs');
const path = require('path');

const REG_DIR = path.join(__dirname, 'registry');

// ---- registry loading ------------------------------------------------------

let REG = null;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadRegistry({ force = false } = {}) {
  if (REG && !force) return REG;
  const areasFile = readJson(path.join(REG_DIR, 'areas.json'));
  const areas = [...areasFile.areas].sort((a, b) => a.order - b.order);
  const kinds = fs.readdirSync(path.join(REG_DIR, 'kinds')).filter((f) => f.endsWith('.json')).sort()
    .map((f) => readJson(path.join(REG_DIR, 'kinds', f)));
  const byKind = {};
  const prefixes = [];
  for (const k of kinds) {
    byKind[k.kind] = k;
    for (const p of k.prefixes || []) prefixes.push({ prefix: p, def: k });
  }
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
  REG = {
    areas,
    areaByKey: Object.fromEntries(areas.map((a) => [a.key, a])),
    outcomes: areasFile.outcomes || {},
    kinds: byKind,
    prefixes,
    impact: readJson(path.join(REG_DIR, 'impact.json')).edges || {},
    measures: readJson(path.join(REG_DIR, 'measures.json')).measures || {},
  };
  return REG;
}

function kindFor(subject) {
  const hit = loadRegistry().prefixes.find((p) => String(subject).startsWith(p.prefix));
  return hit ? hit.def : null;
}

// Kept for older importers: the area list and which feeds speak for each.
const AREAS = loadRegistry().areas.map(({ key, label }) => ({ key, label }));
const AREA_FEEDS = Object.fromEntries(loadRegistry().areas.map((a) => [a.key, a.feeds || []]));

// ---- small formatting helpers ----------------------------------------------

function dur(ms) {
  const n = Math.max(0, Number(ms) || 0);
  const m = Math.floor(n / 60000);
  if (m < 1) return `${Math.floor(n / 1000)}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d${h % 24}h` : `${d}d`;
}

// One formatter per zone: toLocaleString with a timeZone builds a new Intl.DateTimeFormat per call
// (~0.4 ms), and /lucid/situation calls this for every item (top CPU frame, 2026-10-10 profile).
const CLOCK_FORMATS = new Map();
function clockFormat(tz) {
  let f = CLOCK_FORMATS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    if (CLOCK_FORMATS.size < 50) CLOCK_FORMATS.set(tz, f);
  }
  return f;
}

function clockOf(ts, tz = 'Europe/London') {
  try {
    return clockFormat(tz).format(new Date(ts));
  } catch { return new Date(ts).toISOString(); }
}

function listWords(xs, joiner = 'and') {
  const a = (Array.isArray(xs) ? xs : String(xs == null ? '' : xs).split(',')).map((x) => String(x).trim()).filter(Boolean);
  return a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} ${joiner} ${a[a.length - 1]}`;
}

// A title is human text. A raw filesystem path (a systemd Description that is a script path, a cwd) is
// reduced to its basename; the full path stays in the detail layers. (gripe quox#812)
const PATH_TOKEN = /(^|[\s("'])(~?\/[^\s/"')]+(?:\/[^\s/"')]+)+)/g;
function looksLikePath(s) { return /^\s*~?\/[^\s/]+\/\S+\s*$/.test(String(s || '')); }
function humanTitle(s) {
  return String(s || '').replace(PATH_TOKEN, (_m, pre, p) => pre + p.slice(p.lastIndexOf('/') + 1));
}

function clip(s, n) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function agentName(id) {
  if (!id) return null;
  const s = String(id).replace(/^agent[:_-]/, '');
  return s.length <= 24 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Agent ids (ULIDs, slugs) become the assistant's real name when the assistants registry knows it.
let _assistantsTried = false;
function assistantName(id) {
  if (!id) return null;
  try {
    const loader = require('../entityAssistantLoader.js');
    let a = loader.getAssistant(String(id));
    if (!a && !_assistantsTried && !loader.listAssistants().length) {
      _assistantsTried = true;
      const log = console.log;
      console.log = () => {};
      try { loader.loadAssistants(); } finally { console.log = log; }
      a = loader.getAssistant(String(id));
    }
    const name = a && a.identity && a.identity.name;
    return name ? String(name) : null;
  } catch { return null; }
}

function resolveAgentName(id) {
  if (!id) return null;
  const named = assistantName(String(id).replace(/^agent[:_-]/, ''));
  if (named) return named;
  // A raw ULID or opaque id is not a name a person can use: say "An agent" rather than the id.
  if (/^[0-9A-HJKMNP-TV-Z]{20,}$/i.test(String(id))) return null;
  return agentName(id);
}

// ---- template engine --------------------------------------------------------
// {path}  {a|b|"literal"} (first non-empty)  {helper arg ...}
// helpers: dur clock name list plural. No eval, no loops, no logic.

const HELPERS = {
  dur: (ms) => (ms == null || ms === '' ? '' : dur(ms)),
  clock: (ts, _x, ctx) => (ts ? clockOf(Number(ts), ctx && ctx.tz) : ''),
  name: (id) => agentName(id) || '',
  list: (xs) => listWords(xs),
  plural: (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`,
};

function lookup(ctx, p) {
  let v = ctx;
  for (const part of String(p).split('.')) {
    if (v == null || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, part)) return undefined;
    v = v[part];
  }
  return v;
}

function tokens(expr) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(expr))) out.push(m[1] !== undefined ? { lit: m[1] } : { ref: m[2] });
  return out;
}

function evalAlt(alt, ctx) {
  const t = tokens(alt);
  if (!t.length) return '';
  const val = (tk) => (tk.lit !== undefined ? tk.lit : lookup(ctx, tk.ref));
  if (t.length > 1 && t[0].ref && HELPERS[t[0].ref]) {
    const args = t.slice(1).map(val);
    return HELPERS[t[0].ref](args[0], args[1], ctx);
  }
  const v = val(t[0]);
  if (Array.isArray(v)) return listWords(v);
  return v == null || typeof v === 'object' || typeof v === 'function' ? '' : String(v);
}

function render(tpl, ctx) {
  if (tpl == null) return '';
  return String(tpl)
    .replace(/\{([^{}]+)\}/g, (_, expr) => {
      for (const alt of expr.split('|')) {
        const v = evalAlt(alt.trim(), ctx);
        if (v !== '' && v != null) return v;
      }
      return '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}

function renderDeep(v, ctx) {
  if (typeof v === 'string') return render(v, ctx);
  if (Array.isArray(v)) return v.map((x) => renderDeep(x, ctx));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderDeep(x, ctx)]));
  return v;
}

// ---- rule matching (variants, urgency, needs) ---------------------------------

function matches(when, ctx) {
  if (!when) return true;
  for (const [k, want] of Object.entries(when)) {
    const have = ctx[k];
    if (want && typeof want === 'object' && !Array.isArray(want)) {
      if (want.re != null) { if (!new RegExp(want.re, 'i').test(String(have == null ? '' : have))) return false; }
      else if (want.ne != null) { if (String(have) === String(want.ne)) return false; }
      else return false;
    } else if (Array.isArray(want)) {
      if (!want.map(String).includes(String(have))) return false;
    } else if (String(have) !== String(want)) return false;
  }
  return true;
}

function firstRule(rules, ctx, dflt) {
  for (const r of rules || []) if (matches(r.when, ctx)) return r.is;
  return dflt;
}

// ---- per-kind derivers: turn state into template variables -------------------

function actionWords(tool, def) {
  const d = def || kindFor('approval:');
  for (const [re, words] of d.actions) if (new RegExp(re, 'i').test(tool || '')) return words;
  return tool ? `use ${tool}` : d.action_fallback;
}

// P4: a cached model summary of a long raw note replaces the clipped text; never computed here, never blocks.
function streamNote(raw) {
  let cached = null;
  try { cached = require('./synth.js').lookup(raw); } catch { cached = null; }
  return cached ? { note: cached, _synth: 'true' } : { note: clip(raw, 260) };
}

const DERIVE = {
  unit(s, st, def) {
    const unit = s.subject.replace(/^unit:(user\/)?/, '');
    const user = s.subject.startsWith('unit:user/');
    const friendly = def.friendly[unit] || {};
    const desc = looksLikePath(st.description) ? '' : st.description;
    const label = friendly.name || desc || unit.replace(/\.service$/, '');
    return {
      unit, user, ctl: user ? 'systemctl --user' : 'sudo systemctl', key: unit.replace(/\.service$/, ''),
      host: st.host || 'this box', usernote: user ? ' (your user services)' : '',
      label, desc_raw: st.description || label, notesp: friendly.note ? ` ${friendly.note}` : '',
      friendly_urgency: friendly.urgency || '',
      log_command: `journalctl ${user ? '--user ' : ''}-u ${unit} -n 50 --no-pager`,
    };
  },
  approval(s, st, def) {
    const tool = st.tool_name || st.action || '';
    const m = String(s.summary || '').match(/^(.{2,80}?) wants to:?\s*(.*)$/s);
    const src = String(st.preview || '').match(/Source:\s*([^\n]+)/);
    const rawWho = (m && m[1]) || (src && src[1]);
    const actorName = st.actor && st.actor.name;
    const forId = String(s.summary || '').match(/ for ([\w-]{3,40})$/);
    const agentId = st.agent || st.agent_id || st.requested_by || (forId && forId[1]);
    const who = actorName || resolveAgentName(agentId)
      || (rawWho ? clip(String(rawWho).replace(/^resident\+[^ ]+ via /, '').replace(/\s*\((dashboard chat|CLI)\)$/, '').replace(/\s*·.*$/, ''), 40) : 'An agent');
    const doing = actionWords(tool, def);
    return {
      tool, who, doing, label: who,
      who_line: who === 'An agent' ? 'An agent (it did not say which)' : who,
      what: clip((m && m[2]) || s.summary, 220) || `It wants to ${doing}.`,
      summary70: clip(s.summary, 70),
    };
  },
  stream(s, st) {
    const code = s.subject.replace(/^stream:/, '');
    const esc = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
      code, label: code, name: clip((s.summary || code).replace(new RegExp(`^${esc}\\s+`), ''), 80),
      status_words: String(s.status).toLowerCase().replace(/_/g, ' '),
      about: clip(st.about, 220), ...streamNote(st.last_note),
    };
  },
  sentry(s, st, def) {
    const key = s.subject.replace(/^sentry:/, '');
    const kind = Object.keys(def.plain).find((k) => key === k || key.startsWith(`${k}-`));
    const plain = def.plain[kind] || { title: clip(s.summary, 80), short: clip(s.summary, 60), why: def.plain_fallback.why };
    return {
      key, label: plain.title, plain_title: plain.title, plain_short: plain.short || plain.title, plain_why: plain.why,
      what: clip(String(s.summary || '').replace(/^[\w-]+:\s*/, ''), 220),
    };
  },
  host(s, st) {
    const host = s.subject.replace(/^host:/, '');
    return {
      host, label: host,
      what: `${Array.isArray(st.load) ? `Load ${st.load[0]}` : 'Load normal'}${st.disk_pct != null ? `, disk ${Math.round(st.disk_pct)}% full` : ''}.`,
    };
  },
  session(s, st) {
    const name = s.subject.replace(/^session:/, '');
    const status = String(s.status || '');
    const activity = typeof st.activity === 'string' ? st.activity : '';
    let phase = activity || 'other';
    if (!activity) phase = /^(active|running|working)$/.test(status) ? 'working' : status === 'idle' ? 'idle' : 'other';
    const onRaw = st.stream || (s.summary || '').split(': ').slice(1).join(': ');
    const now = st.__now || Date.now();
    return {
      name, label: name, phase, activity, ask: clip(st.ask, 200), slot: st.slot || '',
      on: onRaw ? ` on ${onRaw}` : '',
      work_line: onRaw ? `Working on ${onRaw}${st.last_tool ? `, last used ${st.last_tool}` : ''}.` : 'No stream given.',
      activity_age_ms: Math.max(0, now - (Number(st.activity_at) || Number(st.__since) || now)),
    };
  },
  run(s, st) {
    const a = st.actor && typeof st.actor === 'object' ? st.actor : {};
    const raw = a.name || a.id || '';
    // Workflow runs carry their name in the run id: VR_wf-<name>-<8 char id>_<ms>.
    const wf = String(s.subject).match(/^run:VR_wf-(.+)-[A-Z0-9]{8}_\d+$/);
    const agent_name = wf ? `The ${wf[1].replace(/-/g, ' ')} workflow`
      : (!raw || raw === 'unknown' || raw === 'an agent' ? 'An agent' : (assistantName(raw) || raw.charAt(0).toUpperCase() + raw.slice(1)));
    const run_error = clip(st.run_error, 160) || '';
    const plainMap = { 'quox.flow.failed': 'the workflow failed' };
    const plain_reason = plainMap[run_error.toLowerCase()] || run_error;
    const mapped = !!plainMap[run_error.toLowerCase()];
    const what_line = !plain_reason ? 'No reason was given.'
      : mapped ? `${plain_reason.charAt(0).toUpperCase()}${plain_reason.slice(1)}.` : `It stopped with: ${plain_reason}`;
    return { agent_name, label: agent_name, run_error, plain_reason, what_line };
  },
  build(s) {
    const last = s.subject.startsWith('build:last:');
    const target = last ? s.subject.replace('build:last:', '') : s.subject.replace(/^build:/, '');
    return { is_last: last ? 'true' : 'false', target, label: target, log_command: 'quox-build status' };
  },
  site(s, st) {
    const site = s.subject.replace(/^site:/, '');
    return { site, label: site, http_note: st.http_status ? ` (HTTP ${st.http_status})` : '', reason: clip(st.reason || st.error, 160) };
  },
  container(s, st) {
    const name = s.subject.replace(/^container:/, '');
    return { name, label: name, host: st.host || 'this box', log_command: `docker logs --tail 50 ${name}` };
  },
  call(s, st) {
    const caller = st.name || st.from || st.caller || 'an unknown number';
    return { caller, label: caller, is_voicemail: s.subject.startsWith('voicemail:') || st.voicemail ? 'true' : 'false' };
  },
  mail(s, st) {
    const from = st.from_name || st.from || 'someone';
    return { from, label: from, headline: clip(st.subject || st.text || s.summary || '(no subject)', 100), why: clip(st.why, 200), priority: String(st.priority || '').toLowerCase() };
  },
  security(s, st) {
    const category = clip(st.category || st.finding_category || st.finding_type || st.type, 60);
    const sev = String(st.severity || '').toLowerCase();
    return { category, category_why: category ? `It was flagged as ${/^[aeiou]/i.test(category) ? 'an' : 'a'} ${category} issue${sev ? ` (${sev} severity)` : ''}.` : '', severity: String(st.severity || '').toLowerCase(), headline: clip(st.title || s.summary, 100) || s.subject, who: clip(st.source, 60), why: clip(st.why, 200), label: clip(st.title || s.summary, 60) };
  },
};

// ---- areas ------------------------------------------------------------------

function areaOfLedger(ledger) {
  if (ledger === 'security') return 'security';
  if (ledger === 'vital') return 'systems';
  if (ledger === 'social') return 'messages';
  if (ledger === 'intentional') return 'plans';
  return 'systems';
}

function areaOf(subject, ledger) {
  // LUCID's own record of what it told the owner is not an area of the owner's life.
  if (String(subject).startsWith('herald:')) return 'none';
  const def = kindFor(subject);
  return def ? def.area : areaOfLedger(ledger);
}

// ---- lessons ----------------------------------------------------------------

const SCOPE_ORDER = { area: 0, kind: 1, subject: 2 };
const URGENCIES = ['now', 'today', 'this week', 'whenever', 'fyi'];

function lessonsFor(lessons, subject, kind, area) {
  return (lessons || [])
    .filter((l) => (l.scope === 'subject' && l.target === subject) || (l.scope === 'kind' && l.target === kind) || (l.scope === 'area' && l.target === area))
    .sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || a.ts - b.ts);
}

// ---- impact and measures ------------------------------------------------------

function normAffected(a, inferred) {
  if (typeof a === 'string') a = { label: a };
  if (!a || !a.label) return null;
  const out = { ref: a.ref || `thing:${String(a.label).toLowerCase().replace(/\W+/g, '-')}`, label: String(a.label), how: a.how || 'is affected' };
  if (inferred || a.inferred) out.inferred = true;
  return out;
}

function mergeAffected(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const a of list) {
      if (!a || seen.has(a.label)) continue; // declared lists come first, so declared wins
      seen.add(a.label);
      out.push(a);
    }
  }
  return out;
}

function buildMeasure(id, ctx, reg) {
  const m = reg.measures[id];
  if (!m) return null;
  for (const req of m.requires || []) if (!ctx[req]) return null;
  const out = { id, label: render(m.label, ctx), kind: m.kind, risk: m.risk };
  if (m.say) out.say = render(m.say, ctx);
  if (m.command) out.command = render(m.command, ctx);
  if (m.url) out.url = render(m.url, ctx);
  if (m.execute) out.execute = renderDeep(m.execute, ctx);
  return out;
}

function normFeedMeasure(x, ctx, reg) {
  if (typeof x === 'string') return buildMeasure(x, ctx, reg);
  if (!x || typeof x !== 'object' || !x.id || !x.label) return null;
  return { id: String(x.id), label: String(x.label), ...(x.say ? { say: String(x.say) } : {}), kind: x.kind || 'say', risk: x.risk || 'safe',
    ...(x.command ? { command: String(x.command) } : {}), ...(x.url ? { url: String(x.url) } : {}), ...(x.execute ? { execute: x.execute } : {}) };
}

// ---- the ItemCard builder ---------------------------------------------------------

const NEEDS = ['owner', 'any-human', 'agent', 'none'];

/**
 * subject: { subject, ledger, status, summary, state, feed, salience, status_since, first_seen, last_heard, expected_by }
 * opts: { now, tz, lessons, transitions, stale }
 * Returns an ItemCard. Non-enumerable `_x` carries internals for composers.
 */
function buildItem(s, opts = {}) {
  const reg = loadRegistry();
  const now = opts.now || Date.now();
  const tz = opts.tz || 'Europe/London';
  const st = (s.state && typeof s.state === 'object') ? s.state : {};
  const def = kindFor(s.subject);
  const area = def ? def.area : areaOfLedger(s.ledger);
  const kindName = def ? def.kind : 'unknown';
  const since = s.status_since || s.since || now;
  const waited = Math.max(0, now - since);
  const salience = s.salience || {};

  const ctx = {
    ...Object.fromEntries(Object.entries(st).filter(([k, v]) => k !== 'card' && k !== 'layers' && k !== 'affects' && k !== 'stats' && (v == null || typeof v !== 'object' || Array.isArray(v)))),
    subject: s.subject, ref: s.subject, code: String(s.subject).replace(/^[^:]*:/, ''), status: s.status, summary: s.summary || '',
    feed: s.feed || '', ledger: s.ledger, waited_ms: waited, since, now, tz, host: st.host || '',
  };
  const stWithNow = { ...st, __now: now, __since: since };
  if (def && DERIVE[def.derive]) Object.assign(ctx, DERIVE[def.derive](s, stWithNow, def));
  if (def && def.ok_statuses) ctx.is_ok = def.ok_statuses.map((x) => x.toLowerCase()).includes(String(s.status).toLowerCase()) ? 'true' : 'false';
  else if (def && def.attention_statuses) ctx.is_ok = def.attention_statuses.map((x) => x.toLowerCase()).includes(String(s.status).toLowerCase()) ? 'false' : 'true';

  const ls = lessonsFor(opts.lessons, s.subject, kindName, area);
  const applied = new Set();
  let muted = false;
  let watched = false;
  for (const l of ls) {
    if (l.field === 'label' && typeof l.value === 'string' && l.value.trim()) { ctx.label = l.value.trim(); applied.add(l.id); }
    if (l.field === 'mute') { muted = !!l.value; applied.add(l.id); }
    if (l.field === 'watched') { watched = !!l.value; applied.add(l.id); }
  }

  const variant = def ? (def.variants.find((v) => matches(v.when, ctx)) || def.variants[def.variants.length - 1]) : null;
  const layers = (st.layers && typeof st.layers === 'object') ? st.layers : {};
  const legacy = (st.card && typeof st.card === 'object') ? st.card : {};
  const fb = {
    L0: clip(s.summary || s.subject, 80), who: s.feed || 'unknown source', what: clip(s.summary, 220), why: '',
  };

  // L0: lesson > feed layer > legacy card > registry > fallback
  const prov = { L0: variant ? 'registry' : 'fallback', L1: variant ? 'registry' : 'fallback', L2: variant ? 'registry' : 'fallback' };
  let L0 = variant ? render(variant.L0, ctx) : fb.L0;
  if (typeof legacy.title === 'string' && legacy.title.trim()) { L0 = clip(legacy.title, 300); prov.L0 = 'feed'; }
  if (typeof layers.L0 === 'string' && layers.L0.trim()) { L0 = clip(layers.L0, 300); prov.L0 = 'feed'; }
  for (const l of ls) if (l.field === 'L0' && typeof l.value === 'string' && l.value.trim()) { L0 = clip(l.value, 300); prov.L0 = 'lesson'; applied.add(l.id); }
  L0 = humanTitle(L0);
  ctx.L0 = L0;

  // L1
  const base = variant ? renderDeep(variant.L1, ctx) : { who: fb.who, what: fb.what, why: fb.why };
  const L1txt = { ...base };
  for (const k of ['who', 'what', 'why']) {
    if (typeof legacy[k] === 'string' && legacy[k].trim()) { L1txt[k] = clip(legacy[k], 300); prov.L1 = 'feed'; }
    if (layers.L1 && typeof layers.L1[k] === 'string' && layers.L1[k].trim()) { L1txt[k] = clip(layers.L1[k], 300); prov.L1 = 'feed'; }
  }
  if (ctx._synth === 'true' && ctx.note && String(L1txt.why || '').includes(ctx.note) && prov.L1 !== 'feed') prov.L1 = 'synth';

  // urgency
  let urgency = variant ? firstRule(variant.urgency, ctx, 'fyi') : 'fyi';
  if (URGENCIES.includes(legacy.urgency)) urgency = legacy.urgency;
  // Old news is not today's news: a contradiction stops ranking TODAY after a week, and a decision
  // parked for two weeks has stopped being urgent whatever its status says.
  const capUrgency = (to) => { if (URGENCIES.indexOf(urgency) < URGENCIES.indexOf(to)) urgency = to; };
  if (String(s.subject).startsWith('epistemic:contradiction:')) {
    if (waited > 21 * 86400000) capUrgency('whenever');
    else if (waited > 7 * 86400000) capUrgency('this week');
  }
  if (s.ledger === 'intentional' && s.status === 'DECISION_NEEDED') {
    if (waited > 30 * 86400000) capUrgency('whenever');
    else if (waited > 14 * 86400000) capUrgency('this week');
  }
  for (const l of ls) if (l.field === 'urgency' && URGENCIES.includes(l.value)) { urgency = l.value; applied.add(l.id); }
  if (watched && URGENCIES.indexOf(urgency) > 1) urgency = 'today';

  // needs
  let needs = NEEDS.includes(salience.needs) ? salience.needs : null;
  if (!needs && def && def.needs_rules) needs = firstRule(def.needs_rules, ctx, null);
  if (!needs && s.ledger === 'intentional' && s.status === 'DECISION_NEEDED') needs = 'owner';
  if (!needs) needs = 'none';
  if (watched && needs === 'none') needs = 'owner';

  // affects: declared > static impact > inferred kind rules
  const declared = (Array.isArray(st.affects) ? st.affects : []).map((a) => normAffected(a)).filter(Boolean);
  const edgeKey = s.subject in reg.impact ? s.subject : s.subject.replace(/^unit:user\//, 'unit:');
  const staticEdges = (reg.impact[edgeKey] || []).map((a) => normAffected(a)).filter(Boolean);
  const rule = ((variant && variant.affects) || (def && def.affects) || []).map((a) => normAffected(renderDeep(a, ctx), true)).filter(Boolean);
  const lessonAffects = [];
  for (const l of ls) {
    if (l.field !== 'affects') continue;
    for (const a of Array.isArray(l.value) ? l.value : [l.value]) { const n = normAffected(a); if (n) lessonAffects.push(n); }
    applied.add(l.id);
  }
  const affected = mergeAffected(lessonAffects, declared, staticEdges, rule);

  // L2 measures
  let ids = variant ? (variant.measures || []) : [];
  let measures = ids.map((id) => (id && typeof id === 'object' ? normFeedMeasure(renderDeep(id, ctx), ctx, reg) : buildMeasure(id, ctx, reg))).filter(Boolean);
  if (Array.isArray(layers.L2) && layers.L2.length) {
    measures = layers.L2.map((x) => normFeedMeasure(x, ctx, reg)).filter(Boolean);
    prov.L2 = 'feed';
  }
  for (const l of ls) {
    if (l.field !== 'measure') continue;
    const v = l.value;
    if (typeof v === 'string' && v.startsWith('-')) measures = measures.filter((m) => m.id !== v.slice(1));
    else {
      const mm = normFeedMeasure(v && v.add ? v.add : v, ctx, reg);
      if (mm && !measures.some((m) => m.id === mm.id)) measures.push(mm);
    }
    prov.L2 = 'lesson';
    applied.add(l.id);
  }

  const gates = Array.isArray(salience.gates) ? salience.gates : [];
  const item = {
    ref: s.subject,
    kind: kindName,
    area,
    urgency,
    needs,
    L0,
    L1: {
      who: L1txt.who || '', what: L1txt.what || '', why: L1txt.why || '',
      when: { since, waited_ms: waited, ...(salience.deadline ? { deadline: salience.deadline } : {}), clock: clockOf(since, tz) },
      affected,
    },
    L2: { measures },
    L3: {
      status: s.status, state: st, feed: s.feed || '',
      confidence: { last_heard: s.last_heard || since, stale: !!opts.stale, ...(s.expected_by != null ? { expected_by: s.expected_by } : {}) },
      transitions: opts.transitions || [],
      gates,
      links: Array.isArray(st.links) ? st.links.map(String) : measures.filter((m) => m.url).map((m) => m.url),
    },
    provenance: prov,
    score: 0,
  };
  // Phone numbers never reach a card, whatever the source text said.
  const scrub = (t) => require('./journal.js').scrubPii(t);
  item.L0 = scrub(item.L0);
  for (const k of ['who', 'what', 'why']) item.L1[k] = scrub(item.L1[k]);
  for (const m of item.L2.measures) { if (m && m.say) m.say = scrub(m.say); if (m && m.label) m.label = scrub(m.label); }
  const deep = (v) => (typeof v === 'string' ? scrub(v) : Array.isArray(v) ? v.map(deep)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
  item.L3.state = deep(item.L3.state);
  if (watched) item.watched = true;
  if (muted) item.muted = true;

  let attn = false;
  if (def && def.ok_statuses) attn = ctx.is_ok === 'false';
  else if (def && def.attention_statuses) attn = ctx.is_ok === 'false';
  const how = (variant && variant.how) ? render(variant.how, ctx)
    : (measures[0] ? `${measures[0].say || measures[0].label}${measures[0].command ? `: ${measures[0].command}` : ''}` : '');
  Object.defineProperty(item, '_x', {
    enumerable: false,
    value: { ctx, short: lessonShort(variant, ctx, L0, prov), variant: variant ? variant.id : null, attn, muted, watched, how, applied: [...applied] },
  });
  return item;
}

function lessonShort(variant, ctx, L0, prov) {
  if (prov.L0 === 'lesson') return L0;
  return variant && variant.short ? render(variant.short, ctx) : L0;
}

/** Old card shape, kept one release so the panel and CLI keep working. */
function legacyCard(item) {
  return { title: item.L0, who: item.L1.who, what: item.L1.what, why: item.L1.why, how: item._x ? item._x.how : '', urgency: item.urgency, area: item.area, ref: item.ref };
}

/** Plain-language card for one subject row (v1 entry point, still used by older callers). */
function explain(s) {
  return legacyCard(buildItem(s, { now: Date.now() }));
}

module.exports = {
  AREAS, AREA_FEEDS, explain, areaOf, actionWords, loadRegistry, kindFor, buildItem, legacyCard,
  render, renderDeep, matches, dur, clockOf, listWords, clip, agentName, resolveAgentName,
};
