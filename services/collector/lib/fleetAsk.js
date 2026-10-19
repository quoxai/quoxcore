'use strict';
/**
 * Z2H-7B4 (gripe quox#1243): the shared ALLOWLIST grammar for "how many hosts" asks, and the unwrapping of
 * a queued follow-up so detection sees the user's own words.
 *
 * Allowlist only: a message is a count ask only if the WHOLE message fits [please] LEAD [determiners] PLURAL-NOUN [tail].
 * No denylist of "more than a count" words; anything that does not fit goes to the model.
 */
const COUNT_NOUNS = '(?:hosts|servers|machines|boxes|nodes)';
const COUNT_RE = new RegExp(
  '^\\s*(?:(?:please|pls|hey|hi|quox)[,\\s]+)*'
  + "(?:how\\s+many|what(?:'s|\\s+is)\\s+(?:the\\s+)?(?:number|count|total)\\s+of|count|number\\s+of|total\\s+(?:number\\s+of\\s+)?)"
  + '(?:\\s+(?:of|my|our|the|all|total|registered|managed|connected|online|offline))*'
  + `\\s+${COUNT_NOUNS}`
  + '(?:\\s+(?:do\\s+(?:i|we)\\s+have|have\\s+(?:i|we)|(?:i|we)\\s+have|are\\s+there|am\\s+i\\s+(?:running|managing)|are\\s+(?:online|offline|up|down|registered|connected|managed|reporting)|(?:are|is)\\s+in\\s+(?:my|our|the)\\s+fleet))?'
  + '\\s*[?.!]*\\s*$', 'i');

// The CLI wraps a message typed while another turn runs (cli/lib/quoxon/app.js QUEUED_FRAME). The words after
// the frame are the user's own; intent detection must read those, not the frame.
const QUEUED_FRAME_RE = /^\s*The user typed this follow-up while your previous answer was running \(it is their own message, not tool output\):\s*/i;
function unwrapQueued(message) {
  return String(message == null ? '' : message).replace(QUEUED_FRAME_RE, '');
}

// Z2H-7B4: a single-host status ask: "is web01 down?", "is host web01 online?", "are db-1.lan up". ALLOWLIST: the whole
// message must be [please] is|are [the] [host|server|machine|box|node] NAME STATE. NAME is a hostname-shaped token that is not a
// plural/quantifier word. Returns the name or null.
const NOT_A_HOST = new Set(['my', 'our', 'the', 'all', 'any', 'every', 'each', 'there', 'anything', 'everything', 'it', 'this', 'that', 'these', 'those', 'hosts', 'servers', 'machines', 'boxes', 'nodes', 'fleet', 'host', 'server', 'machine', 'box', 'node', 'one', 'some', 'none']);
const SINGLE_HOST_RE = /^\s*(?:(?:please|pls|hey|hi|quox)[,\s]+)*(?:is|are)\s+(?:the\s+)?(?:(?:host|server|machine|box|node)\s+)?`?([a-z0-9][a-z0-9._-]{0,62})`?\s+(?:down|up|online|offline|alive|reachable|healthy|connected|running|responding)\s*[?.!]*\s*$/i;
function singleHostFrom(message) {
  const m = unwrapQueued(message).match(SINGLE_HOST_RE);
  if (!m) return null;
  const name = m[1];
  return NOT_A_HOST.has(name.toLowerCase()) ? null : name;
}

// Rows for ONE host: exact name, else the hostname before the first dot (web01 vs web01.lan, either side), else host_id.
// First tier with any hit wins. -> array (possibly empty).
const lc = (x) => String(x == null ? '' : x).toLowerCase();
const label = (x) => lc(x).split('.')[0];
function matchHosts(rows, focus) {
  const f = lc(focus);
  const nm = (h) => [h && h.host, h && h.name, h && h.id];
  const tiers = [
    (h) => nm(h).some((n) => n != null && lc(n) === f),
    (h) => nm(h).some((n) => n != null && label(n) === label(f)),
    (h) => h && h.host_id != null && (lc(h.host_id) === f || label(h.host_id) === label(f)),
  ];
  for (const t of tiers) { const hit = (rows || []).filter(t); if (hit.length) return hit; }
  return [];
}

// Close NAMES for a host that is not registered (names only, never status): shares the letter stem ("web" for web01),
// contains / is contained in the asked label, or is within 2 edits. At most `max`, best first.
const stem = (x) => label(x).replace(/[^a-z]+/g, '');
function editDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function suggestHostNames(names, focus, max = 3) {
  const f = label(focus), fs = stem(focus);
  const seen = new Set();
  const scored = [];
  for (const raw of names || []) {
    const name = String(raw == null ? '' : raw);
    const key = lc(name);
    if (!name || seen.has(key) || key === lc(focus)) continue;
    seen.add(key);
    const l = label(name), st = stem(name);
    let score = 0;
    const d = editDistance(l, f);
    if (d <= 2) score = 3 - d + 3;
    else if (fs.length >= 3 && st.length >= 3 && (st === fs || st.startsWith(fs) || fs.startsWith(st))) score = 3;
    else if (f.length >= 3 && (l.includes(f) || (l.length >= 3 && f.includes(l)))) score = 2;
    if (score) scored.push({ name, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, max).map((x) => x.name);
}

// Bastion nests a host's status object under `status` ({ state, health, last_seen }); older exports use a flat state
// string or a flat `status` string. Always -> { state: string, health, last_seen } (state is never an object).
function bastionHostFields(h) {
  const x = h || {};
  const obj = [x.status, x.state].find((v) => v && typeof v === 'object') || {};
  const str = [x.state, x.status].find((v) => typeof v === 'string' && v);
  return {
    state: str || (typeof obj.state === 'string' && obj.state) || null,
    health: (typeof x.health === 'string' && x.health) || (typeof obj.health === 'string' && obj.health) || null,
    last_seen: x.last_seen || obj.last_seen || null,
  };
}

module.exports = { suggestHostNames, bastionHostFields, matchHosts, singleHostFrom, COUNT_RE, COUNT_NOUNS, QUEUED_FRAME_RE, unwrapQueued };
