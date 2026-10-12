/**
 * `quox lucid blind`: what LUCID can and cannot hear, and what does not add up.
 * Pure: renderBlind({ situation, feeds, expected }, { now }) -> string (plain text, no colour,
 * so it pastes anywhere and reads the same in a pipe).
 *
 * A source is live, silent (expected but quiet), failing (speaking, but its own read is
 * failing) or never heard. Contradictions list both sides of each mismatch.
 */

function ago(ms, now) {
  if (ms == null) return '';
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const nameOf = (x) => (typeof x === 'string' ? x : (x && (x.feed || x.name)) || '');

/** Rows: { source, state, last, note } sorted worst first. */
export function blindRows({ situation, feeds = [], expected = [] } = {}, now = Date.now()) {
  const cs = (situation && situation.cannot_see) || {};
  const byFeed = new Map(feeds.map((f) => [f.feed, f]));
  const failing = new Map((cs.failing || []).map((x) => [nameOf(x), x]));
  const silent = new Set((cs.silent || []).map(nameOf));
  const unwired = new Set((cs.unwired || []).map(nameOf));
  const names = new Set([...byFeed.keys(), ...expected, ...failing.keys(), ...silent, ...unwired]);
  const rows = [];
  for (const source of names) {
    if (!source) continue;
    const f = byFeed.get(source);
    const last = f && f.last_heard != null ? ago(f.last_heard, now) : '';
    if (failing.has(source)) rows.push({ rank: 0, source, state: 'failing', last, note: (failing.get(source) || {}).error || (f && f.last_error) || '' });
    else if (silent.has(source)) rows.push({ rank: 1, source, state: 'silent', last, note: 'expected, but gone quiet' });
    else if (unwired.has(source) || !f) rows.push({ rank: 2, source, state: 'never heard', last: '', note: 'expected, has never reported' });
    else rows.push({ rank: 3, source, state: 'live', last, note: '' });
  }
  return rows.sort((a, b) => a.rank - b.rank || a.source.localeCompare(b.source));
}

export function renderBlind(data = {}, { now = Date.now() } = {}) {
  const sit = data.situation || {};
  const cov = (sit.cannot_see && sit.cannot_see.coverage) || null;
  const rows = blindRows(data, now);
  const out = [];
  out.push(`SOURCES${cov ? ` (${cov.live} of ${cov.expected} speaking)` : ''}`);
  if (!rows.length) out.push('  I have not heard from any source yet. That is not "all quiet".');
  else {
    const w = Math.max(6, ...rows.map((r) => r.source.length));
    out.push(`  ${'SOURCE'.padEnd(w)}  ${'STATE'.padEnd(11)}  ${'LAST HEARD'.padEnd(10)}  NOTE`);
    for (const r of rows) out.push(`  ${r.source.padEnd(w)}  ${r.state.padEnd(11)}  ${r.last.padEnd(10)}  ${r.note}`.trimEnd());
  }
  const stale = (sit.cannot_see && sit.cannot_see.stale) || [];
  if (stale.length) out.push('', `Stale claims (source quiet, so these may be out of date): ${stale.map((s) => nameOf({ name: s.subject })).join(', ')}`);

  const da = sit.doesnt_add_up || [];
  out.push('', `DOESN'T ADD UP${da.length ? ` (${da.length})` : ''}`);
  if (!da.length) out.push('  Nothing I can see contradicts anything else. I can only compare what the sources tell me.');
  da.forEach((x, i) => {
    out.push(`  ${i + 1}. ${x.L0}${x.urgent ? '  [TODAY]' : ''}`);
    out.push(`     Claimed   ${x.claimed}`);
    out.push(`     Observed  ${x.observed}`);
    if (x.sources && x.sources.length) out.push(`     Sources   ${x.sources.join(', ')}`);
    if (x.why) out.push(`     Why       ${x.why}`);
    if (x.how) out.push(`     Settle    ${x.how}`);
  });
  return `${out.join('\n')}\n`;
}
