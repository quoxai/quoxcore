'use strict';
/**
 * QUOXON-ASK J2 (quox#852) + P2: the few quox CLI leaves that fit an ask, ranked, so the
 * model picks among a handful by name instead of guessing among ~850 commands.
 *
 * Corpus, first that exists:
 *   1. SITE-CLI's plain-words asks per leaf: config/cliUtterances.json (vendored, ships in
 *      the collector image; scripts/sync-cli-utterances.mjs, drift-tested against
 *      docs/matrix/sources/cli-utterances.json), else that docs file in a repo checkout,
 *      else a directory of *.json in either accepted shape:
 *      [{ leaf|path, utterances|asks: [...] }] | { rows: [...] } | { "slot checkout": [...] }.
 *   2. the leaf tree itself (path words + description).
 * Ranking: BM25 over one document per leaf (its asks, its path words weighted up, its
 * description), dependency-free, built once per process and kept in memory (~2-5 ms to
 * score an ask). Never-class leaves are not indexed.
 */
const fs = require('node:fs');
const path = require('node:path');
const { loadTree, loadPolicy, classifyLeaf } = require('./policy.js');

const COLLECTOR_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_UTTERANCE_SOURCES = [
  path.join(COLLECTOR_ROOT, 'config', 'cliUtterances.json'),
  path.join(COLLECTOR_ROOT, '..', '..', 'docs', 'matrix', 'sources', 'cli-utterances.json'),
  path.join(COLLECTOR_ROOT, 'config', 'cliUtterances'),
  path.join(COLLECTOR_ROOT, '..', '..', 'docs', 'matrix', 'sources', 'utterances'),
];
const STOP = new Set(('a an the and or to of in on for with me my we our you your is are do does what which who how can please hey i it '
  + 'this that there have has be any all some am was were will would could should just from at by as so if into about up out get '
  + 'want need show tell give see let know us them they their its im ive id dont thing things one ones now right currently '
  + 'quox').split(' '));
const PATH_WEIGHT = 3;
const K1 = 1.2;
const WRITE_ON_READ = 0.7;
const OTHER_SURFACE = 0.7;
const B = 0.75;

function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed') && !w.endsWith('eed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
const terms = (text) => String(text || '').toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/)
  .filter((w) => w.length > 1 && !STOP.has(w)).map(stem);

// REACH: an ask that IS a corpus utterance, word for word (case, punctuation, apostrophes aside).
const normAsk = (text) => String(text || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function addRows(byLeaf, raw) {
  const add = (leaf, list) => {
    if (typeof leaf !== 'string' || !Array.isArray(list)) return;
    const key = leaf.replace(/^quox\s+/, '').trim();
    byLeaf.set(key, [...(byLeaf.get(key) || []), ...list.filter((u) => typeof u === 'string')]);
  };
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw && raw.rows) ? raw.rows : null;
  if (rows) for (const r of rows) add(r && (r.leaf || r.path), r && (r.utterances || r.asks));
  else if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) add(k, v);
}

/** A file or a directory of JSON files -> Map(leaf -> asks[]) | null. */
function readUtterances(source) {
  let stat;
  try { stat = fs.statSync(source); } catch { return null; }
  const byLeaf = new Map();
  const files = stat.isDirectory()
    ? (() => { try { return fs.readdirSync(source).filter((f) => f.endsWith('.json')).map((f) => path.join(source, f)); } catch { return []; } })()
    : [source];
  for (const f of files) {
    try { addRows(byLeaf, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { /* a bad file is skipped */ }
  }
  return byLeaf.size ? byLeaf : null;
}

/**
 * Build the index. exclude: Set of "leaf\u0000ask" pairs left out (held-out evaluation).
 * -> { source, docs:[{leaf,class,description,len,tf:Map,group,verb,flags}], df:Map, n, avgdl }
 */
function buildIndex({ utterancesDir = null, exclude = null } = {}) {
  const tree = loadTree();
  const policy = loadPolicy();
  let source = 'leaf_tree';
  let asks = null;
  for (const src of utterancesDir ? [utterancesDir] : DEFAULT_UTTERANCE_SOURCES) {
    const u = readUtterances(src);
    if (u) { source = 'utterances'; asks = u; break; }
  }
  const docs = [];
  const exact = new Map(); // normalized utterance -> Set(doc index)
  for (const [leaf, def] of Object.entries(tree.leaves || {})) {
    const cls = classifyLeaf(leaf, { tree, policy });
    if (cls.class === 'never') continue;
    if (asks && !asks.has(leaf)) continue;
    const tf = new Map();
    const bump = (t, w) => tf.set(t, (tf.get(t) || 0) + w);
    let len = 0;
    const pathTerms = terms(leaf.replace(/-/g, ' '));
    for (const t of pathTerms) { bump(t, PATH_WEIGHT); len += PATH_WEIGHT; }
    for (const t of terms(def.description || '')) { bump(t, 1); len += 1; }
    for (const a of (asks && asks.get(leaf)) || []) {
      if (exclude && exclude.has(`${leaf}\u0000${a}`)) continue;
      for (const t of terms(a)) { bump(t, 1); len += 1; }
      const key = normAsk(a);
      if (key) exact.set(key, new Set([...(exact.get(key) || []), docs.length]));
    }
    const parts = leaf.split(' ');
    const flags = (def.options || []).map((o) => String(o.long || '').replace(/^--/, '')).flatMap((v) => v.split('-'));
    docs.push({ leaf, class: cls.class, description: def.description || '', len, tf, group: stem(parts[0]), verb: new Set(parts[parts.length - 1].split('-')), flags: new Set(flags) });
  }
  const df = new Map();
  const postings = new Map(); // term -> doc indexes (only docs containing the term are scored)
  docs.forEach((d, i) => {
    for (const t of d.tf.keys()) {
      df.set(t, (df.get(t) || 0) + 1);
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t).push(i);
    }
  });
  const avgdl = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length);
  return { source, docs, df, postings, n: docs.length, avgdl, groups: new Set(docs.map((d) => d.group)), exact };
}

let _cache = null;
function corpus(utterancesDir) {
  const key = utterancesDir || 'default';
  if (_cache && _cache.key === key) return _cache.value;
  const value = buildIndex({ utterancesDir });
  _cache = { key, value };
  return value;
}

let _acts = null;
function actionWords() {
  if (_acts) return _acts;
  const { ACTION_WORDS } = require('./directIntent.js');
  _acts = { ACTION_WORDS, all: new Set(Object.entries(ACTION_WORDS).flatMap(([k, v]) => [k, ...v]).map(stem)) };
  return _acts;
}

// #914: a write leaf whose own words (3+) are ALL in the ask is being asked about, not run:
// "what app url is this server configured with" is the read of `server config app-url`.
function namesWholeLeaf(leaf, q) {
  const w = leaf.replace(/-/g, ' ').split(' ').map(stem);
  return w.length >= 3 && w.every((x) => q.some((t) => t === x || (x.length >= 6 && t.length >= 6 && t.slice(0, 6) === x.slice(0, 6))));
}

/** Rank against a given index (exported for held-out evaluation). */
function rankWithIndex(c, message, { k = 5 } = {}) {
  const q = [...new Set(terms(message))];
  // An ask with no action word ("which engagements do we have") is a read: reads lead ties.
  const { ACTION_WORDS, all } = actionWords();
  const isAct = q.some((t) => all.has(t));
  const scores = new Map();
  const tree = c.source === 'leaf_tree';
  for (const t of q) {
    const list = c.postings.get(t);
    if (!list) continue;
    const df = list.length;
    const idf = Math.log(1 + (c.n - df + 0.5) / (df + 0.5));
    // The leaf-tree fallback (no corpus: one short line per leaf) keeps J2's plain
    // idf-weighted overlap; BM25 length normalization over one-line docs ranks worse there.
    const flatIdf = Math.log(1 + c.n / df);
    for (const i of list) {
      const d = c.docs[i];
      const f = d.tf.get(t);
      scores.set(i, (scores.get(i) || 0) + (tree ? flatIdf : idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / c.avgdl)))));
    }
  }
  const namedGroups = q.filter((t) => c.groups && c.groups.has(t));
  const said = (v) => q.includes(stem(v)) || (ACTION_WORDS[v] || []).some((w) => q.includes(stem(w)));
  const scored = [];
  for (const [i, base] of scores) {
    const d = c.docs[i];
    let score = base;
    // The ask names this leaf's group (+0.5); its action word names the leaf's verb (+1.5)
    // or one of its flags (+1, "make" -> --create).
    if (q.includes(d.group)) score += tree ? 1 : 0.5;
    // quox#882: the ask names a surface ("workflow") and this leaf belongs to another one it
    // doesn't name ("quoxbox workflows", "x search"): that leaf only shares a word, so it steps
    // back behind the named surface's own leaves. Naming the family ("quoxbox workflows") undoes it.
    else if (namedGroups.length && !tree) score *= OTHER_SURFACE;
    if (isAct) { if ([...d.verb].some(said)) score += tree ? 3 : 1.5; else if ([...d.flags].some(said)) score += tree ? 2 : 1; }
    // A question with no action word is almost always "show me": writes step back (J2).
    else if (d.class !== 'read' && !tree && !namesWholeLeaf(d.leaf, q)) score *= WRITE_ON_READ;
    scored.push({ leaf: d.leaf, class: d.class, description: d.description, score: Math.round(score * 100) / 100 });
  }
  // Near-ties: reads before writes on a non-action ask, then the listing verbs.
  const verbRank = (leaf) => { const v = leaf.split(' ').pop(); return v === 'list' ? 0 : ['show', 'status', 'get'].includes(v) ? 1 : 2; };
  const classRank = (cls) => (cls === 'read' ? 0 : 1);
  scored.sort((a, b) => (tree && !isAct && (classRank(a.class) - classRank(b.class))) || (b.score - a.score) || (!isAct && (classRank(a.class) - classRank(b.class))) || (verbRank(a.leaf) - verbRank(b.leaf)) || a.leaf.localeCompare(b.leaf));
  // The best score this ask could reach (every word matched at full weight); a word the
  // corpus never saw counts at full idf, so off-topic chat normalizes low.
  let maxScore = 0;
  for (const t of q) { const df = (c.postings.get(t) || []).length; maxScore += Math.log(1 + (c.n - df + 0.5) / (df + 0.5)) * (K1 + 1); }
  // REACH: a verbatim corpus utterance of exactly one leaf leads, whatever BM25 made of it
  // ("what should I work on now" scores on "work" alone and ranked plan focus nowhere).
  const hits = c.exact && c.exact.get(normAsk(message));
  let exact = null;
  if (hits && hits.size === 1) {
    const d = c.docs[[...hits][0]];
    const at = scored.findIndex((x) => x.leaf === d.leaf);
    const row = at >= 0 ? scored.splice(at, 1)[0] : { leaf: d.leaf, class: d.class, description: d.description, score: 0 };
    scored.unshift(row);
    exact = row.leaf;
  }
  return { source: c.source, candidates: scored.slice(0, Math.max(1, k)), maxScore, terms: q, exact };
}

function rankCandidateLeaves(message, { k = 5, utterancesDir = null } = {}) {
  return rankWithIndex(corpus(utterancesDir), message, { k });
}

// One ask is ranked once per turn even though the offer, the catalogue and the hint all ask.
let _memo = { message: null, k: 0, value: null };
function topCandidates(message, k = 5) {
  if (_memo.message !== message || _memo.k < k) {
    let value;
    try { value = rankCandidateLeaves(message, { k: Math.max(k, 5) }); } catch { value = { source: 'none', candidates: [], maxScore: 0, terms: [] }; }
    _memo = { message, k: Math.max(k, 5), value };
  }
  return { ..._memo.value, candidates: _memo.value.candidates.slice(0, k) };
}

// A match strong enough that the CLI is worth offering on its own (D3). Calibrated on
// held-out corpus asks (scripts/eval-cli-candidates.mjs --strong): the top leaf must reach
// STRONG_SHARE of the ask's best possible score, beat the runner-up by STRONG_MARGIN, and
// the ask must name one of the leaf's own path words (its surface), so chat such as
// "what time is it" (top: memory timeline) never turns the CLI on.
const STRONG_SHARE = 0.5;
const STRONG_MARGIN = 1.1;
/** -> the top candidate when the utterance corpus matches the ask strongly, else null. */
function strongCliMatch(message) {
  const r = topCandidates(message, 2);
  if (r.source !== 'utterances' || !r.candidates.length) return null;
  // A verbatim corpus utterance is the strongest evidence there is: the corpus says so.
  if (r.exact && r.candidates[0].leaf === r.exact) return { ...r.candidates[0], exact: true };
  if (!r.maxScore) return null;
  const [a, b] = r.candidates;
  if (a.score / r.maxScore < STRONG_SHARE) return null;
  if (b && a.score < b.score * STRONG_MARGIN) return null;
  const pathWords = new Set(terms(a.leaf.replace(/-/g, ' ')));
  if (!(r.terms || []).some((t) => pathWords.has(t))) return null;
  return a;
}

// Path words people never type: the ask says the human word.
const PATH_ALIASES = { tg: ['telegram'], sso: ['single', 'signon'] };
const LEAF_VERBS = new Set(['list', 'show', 'get', 'status', 'read', 'view', 'ls', 'info', 'stats']);
const sameWord = (a, b) => a === b || (a.length >= 6 && b.length >= 6 && a.slice(0, 6) === b.slice(0, 6));
/**
 * #914: the top-ranked leaf whose own words all appear in the ask ("which slot bridges
 * exist" -> slot bridge list). Weaker than strongCliMatch's score test, stricter on words;
 * it is the cure for "I don't have a tool", so the caller also gets the words for its
 * dedicated-tool check. A lone short word ("add") is not evidence unless its group is named.
 * -> { leaf, class, words } or null.
 */
function leafNamedMatch(message) {
  const r = topCandidates(message, 1);
  if (r.source !== 'utterances' || !r.candidates.length) return null;
  const a = r.candidates[0];
  if (a.class === 'never') return null;
  const raw = a.leaf.replace(/-/g, ' ').split(' ');
  const parts = raw.map(stem);
  const asked = r.terms || [];
  const has = (w) => asked.some((t) => sameWord(t, w)) || (PATH_ALIASES[w] || []).some((al) => asked.some((t) => sameWord(t, stem(al))));
  const rest = raw.slice(1).filter((w) => !LEAF_VERBS.has(w)).map(stem);
  const words = rest.length ? rest : [parts[0]];
  if (!words.every(has)) return null;
  if (words.length === 1 && rest.length && !has(parts[0]) && words[0].length < 7) return null;
  return { leaf: a.leaf, class: a.class, words: [...new Set([parts[0], ...words])] };
}

/**
 * The per-turn hint appended to quox_cli / quox_cli_write descriptions: the top leaves by
 * name with their usage and class, so the model calls the right leaf on its first try.
 */
function candidateHint(message, { k = 5 } = {}) {
  const r = topCandidates(message, k);
  if (!r.candidates.length) return '';
  const tree = loadTree();
  const usage = (leaf) => {
    const def = tree.leaves[leaf] || {};
    const pos = (def.args || []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ');
    return `quox ${leaf}${pos ? ` ${pos}` : ''}${needsHost(leaf) ? ' --host <hostId>' : ''}`;
  };
  // REACH: a leaf that defaults --host from a local resident profile has none here (each call
  // runs in a fresh HOME as the caller), so the flag is required in chat.
  const needsHost = (leaf) => {
    const def = tree.leaves[leaf] || {};
    return (def.options || []).some((o) => o.long === '--host') && !(def.args || []).some((a) => /host/i.test(a.name));
  };
  const lines = r.candidates.map((c) => `${usage(c.leaf)} (${c.class === 'read' ? 'read: quox_cli' : c.class === 'immediate' ? 'immediate: quox_cli_write' : 'write: quox_cli_write'})${c.description ? `: ${c.description.slice(0, 90)}` : ''}`);
  const hostNote = r.candidates.some((c) => needsHost(c.leaf))
    ? ' A --host <hostId> leaf has no default here: pass args {"host":"<hostId>"} with the host id from fleet_status.' : '';
  return `Likely commands for this ask, best first: ${lines.join('; ')}. Call one by its words as path (e.g. ["${r.candidates[0].leaf.split(' ').join('","')}"]), values in positional.${hostNote}`;
}

module.exports = {
  rankCandidateLeaves, rankWithIndex, buildIndex, topCandidates, strongCliMatch, leafNamedMatch, candidateHint, terms, STRONG_SHARE, STRONG_MARGIN,
  _resetCache: () => { _cache = null; _memo = { message: null, k: 0, value: null }; },
};
