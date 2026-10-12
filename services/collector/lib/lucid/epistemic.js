/**
 * LUCID epistemic watcher (P2): "what does not add up".
 *
 * Contract: docs/LUCID_P2.md section 2. Deterministic, no model, read-only on the world: it
 * only reads the journal and writes `epistemic:*` subjects back into it.
 *
 *   epistemic:silent:<feed>   a feed that should be speaking has gone quiet
 *   epistemic:failing:<feed>  a feed is speaking, but reporting that its own read failed
 *   epistemic:unwired:<feed>  a feed we expect has never spoken
 *   epistemic:contradiction:<rule>:<id>  two things I was told that cannot both be true
 *       committed-not-running   code on origin/main is newer than the last good build
 *       complete-no-status-doc  a stream was marked COMPLETE with no STATUS_AND_LIMITS doc
 *       in-progress-idle        streams IN_PROGRESS that nobody has touched for 7 days (one finding for the pile)
 *       healthy-vs-probe        a container reports healthy while its site probe is down
 *
 * Every subject carries state { claimed, observed, sources[], since } and the plain words of its
 * card (headline, what_line, why_line, how_line), so a person can see both sides of the mismatch.
 * A subject is retracted the moment the mismatch disappears; a recovered feed leaves history.
 *
 * Loop hygiene (the triad): a failed emit is counted apart from "nothing to do" and backs that
 * subject off (capped); an unchanged finding is not re-emitted (fingerprint); resolved findings
 * are retracted once and never re-attempted. Nothing here throws into the collector.
 */

const journal = require('./journal.js');

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TICK_MS = 60 * 1000;
const BACKOFF_CAP_MS = 15 * MIN;
const PREFIX = 'epistemic:';
const GRACE_MS = 30 * MIN;          // a commit needs half an hour before "not built yet" is a mismatch
const URGENT_NOT_RUNNING_MS = DAY;  // code committed but not running for more than a day
const IDLE_MS = 7 * DAY;
const MAX_PER_RULE = 8;
const SOURCE = { surface: 'collector', feed: 'epistemic', writer: 'epistemic.js' };

const _stats = { ticks: 0, ok_ticks: 0, failed_ticks: 0, emitted: 0, retracted: 0, emit_failed: 0, skipped_unchanged: 0, backoff_skips: 0, last_error: null, last_error_at: null };
const _fp = new Map();      // org|subject -> fingerprint of what was last emitted
const _bo = new Map();      // org|subject -> { fails, nextAt }
function getStats() { return { ..._stats }; }
function _resetForTests() {
  _fp.clear(); _bo.clear();
  for (const k of Object.keys(_stats)) _stats[k] = (k === 'last_error' || k === 'last_error_at') ? null : 0;
}

function dur(ms) {
  const n = Math.max(0, Number(ms) || 0);
  const m = Math.floor(n / MIN);
  if (m < 1) return `${Math.floor(n / 1000)}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d${h % 24}h` : `${d}d`;
}

function clock(ts) {
  try { return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; } catch { return String(ts); }
}

// ---- findings ---------------------------------------------------------------------------

function finding(subject, cls, headline, f) {
  return {
    subject, cls, headline, urgent: !!f.urgent,
    state: {
      class: cls, rule: f.rule || cls, claimed: f.claimed, observed: f.observed, sources: f.sources || [],
      ...(f.since != null ? { since: f.since } : {}),
      urgent: f.urgent ? 'true' : 'false', headline,
      what_line: f.what, why_line: f.why, how_line: f.how,
    },
  };
}

function feedFindings(orgId, now, expectedFeeds) {
  const out = [];
  const feeds = journal.listFeeds(orgId).filter((f) => f.feed !== SOURCE.feed);
  const byName = new Map(feeds.map((f) => [f.feed, f]));
  const expected = new Set([...(expectedFeeds || []), ...journal.listExpected(orgId)]);
  for (const f of feeds) {
    if (f.last_error) {
      out.push(finding(`${PREFIX}failing:${f.feed}`, 'failing', `The ${f.feed} feed is failing`, {
        claimed: `The ${f.feed} feed is expected to report`, observed: `It is reporting an error: ${String(f.last_error).slice(0, 160)}`,
        sources: [`feed:${f.feed}`], since: f.last_error_at || now,
        what: `The ${f.feed} feed is speaking, but its own read is failing (${String(f.last_error).slice(0, 160)}).`,
        why: `Whatever ${f.feed} normally tells me is missing, so I may be out of date there.`,
        how: `Check why ${f.feed} cannot read its source; I will clear this when it recovers.`,
      }));
    } else if (f.expected_by != null && f.expected_by < now) {
      out.push(finding(`${PREFIX}silent:${f.feed}`, 'silent', `The ${f.feed} feed has gone quiet`, {
        claimed: `The ${f.feed} feed should have reported by ${clock(f.expected_by)}`, observed: `Last heard ${dur(now - f.last_heard)} ago`,
        sources: [`feed:${f.feed}`], since: f.expected_by,
        what: `I have not heard from ${f.feed} for ${dur(now - f.last_heard)}.`,
        why: `Anything ${f.feed} would have told me is unknown, so I may be out of date there.`,
        how: `Check that the ${f.feed} reporter is running; I will clear this when it speaks again.`,
      }));
    }
  }
  for (const name of expected) {
    if (name === SOURCE.feed || byName.has(name)) continue;
    out.push(finding(`${PREFIX}unwired:${name}`, 'unwired', `The ${name} feed has never reported`, {
      claimed: `The ${name} feed is expected`, observed: 'Never heard from it',
      sources: [`feed:${name}`],
      what: `I expect to hear from ${name} but it has never spoken.`,
      why: `Whatever it covers is invisible to me.`,
      how: `Connect ${name}, or stop expecting it.`,
    }));
  }
  return out;
}

function stateOf(s) { return (s && s.state && typeof s.state === 'object') ? s.state : {}; }

function contradictionFindings(orgId, now) {
  const out = [];
  const open = journal.listOpenSubjects(orgId);
  const by = (p) => open.filter((s) => s.subject.startsWith(p));

  // (a) committed-not-running
  const builds = new Map(by('build:last:').map((s) => [s.subject.slice('build:last:'.length), s]));
  const queue = open.find((s) => s.subject === 'build:queue');
  const inFlight = queue && /^(running|queued)$/i.test(String(queue.status)) ? String(queue.summary || '') : '';
  for (const r of by('repo:')) {
    const st = stateOf(r);
    const name = r.subject.slice('repo:'.length);
    const mainTs = Number(st.main_ts_ms);
    const targets = Array.isArray(st.targets) ? st.targets.map(String) : [];
    if (!Number.isFinite(mainTs) || !targets.length) continue;
    const wins = targets.map((t) => ({ t, at: Number(stateOf(builds.get(t)).last_success_at) })).filter((x) => Number.isFinite(x.at) && x.at > 0);
    if (!wins.length) continue; // no good build on record is "unknown", not a contradiction
    const best = wins.reduce((a, b) => (b.at > a.at ? b : a));
    if (mainTs <= best.at || now - mainTs < GRACE_MS) continue;
    if (inFlight && targets.some((t) => inFlight.includes(t))) continue; // a build is already on it
    const lag = mainTs - best.at;
    out.push(finding(`${PREFIX}contradiction:committed-not-running:${name}`, 'contradiction', `${name} has code on main that is not running yet`, {
      rule: 'committed-not-running', urgent: now - mainTs > URGENT_NOT_RUNNING_MS, since: mainTs,
      claimed: `The newest ${name} code is on main (committed ${clock(mainTs)}${st.head ? `, ${String(st.head).slice(0, 8)}` : ''})`,
      observed: `The last good ${best.t} build finished ${clock(best.at)}, ${dur(lag)} before that commit; nothing newer has built`,
      sources: [r.subject, `build:last:${best.t}`],
      what: `The newest code in ${name} was committed ${dur(now - mainTs)} ago, but the last good ${best.t} build is ${dur(lag)} older than it.`,
      why: 'Committed is not running: the change you think is live may not be.',
      how: `Run quox-build ${best.t} (or check why the build did not start), then confirm the running thing.`,
    }));
  }

  // (b) complete-without-status-doc
  for (const p of by('plandocs:')) {
    const st = stateOf(p);
    if (String(p.status) !== 'missing') continue;
    const id = st.stream || p.subject.slice('plandocs:'.length);
    out.push(finding(`${PREFIX}contradiction:complete-no-status-doc:${id}`, 'contradiction', `${id} is marked complete but has no status doc`, {
      rule: 'complete-no-status-doc', urgent: true, since: Number(st.completed_at) || p.status_since,
      claimed: `${id} was marked COMPLETE${st.completed_at ? ` (${clock(Number(st.completed_at))})` : ''}`,
      observed: `docs/STATUS_AND_LIMITS_${id}.md does not exist in ${st.repo || 'quox-dashboard'}`,
      sources: [`stream:${id}`, p.subject],
      what: `${id} was marked complete, but there is no STATUS_AND_LIMITS document for it.`,
      why: 'A stream is not complete until its honest maturity map is written down.',
      how: `Write docs/STATUS_AND_LIMITS_${id}.md, or reopen ${id}.`,
    }));
  }

  // (c) in-progress-but-idle
  const repoMentions = by('repo:').map((r) => stateOf(r)).filter((st) => Array.isArray(st.mentions));
  if (repoMentions.length) {
    const mentioned = new Set(repoMentions.flatMap((st) => st.mentions.map(String)));
    const sessionText = by('session:').map((s) => `${stateOf(s).stream || ''} ${s.summary || ''}`).join(' \n ');
    const idle = [];
    for (const s of by('stream:')) {
      if (String(s.status) !== 'IN_PROGRESS') continue;
      const id = s.subject.slice('stream:'.length);
      const touched = Number(stateOf(s).touched_at_ms) || s.status_since;
      if (now - touched < IDLE_MS) continue;
      const hit = [...mentioned].some((m) => m === id || m.startsWith(`${id}-`));
      if (hit || sessionText.includes(id)) continue;
      idle.push({ id, touched });
    }
    idle.sort((a, b) => a.touched - b.touched);
    if (idle.length) {
      // One finding for the whole pile: forty separate cards about stale plans would bury the rest.
      const oldest = idle[0];
      const sample = idle.slice(0, MAX_PER_RULE).map((x) => x.id);
      out.push(finding(`${PREFIX}contradiction:in-progress-idle:streams`, 'contradiction',
        idle.length === 1 ? `${oldest.id} says in progress but nothing is moving` : `${idle.length} streams say in progress but nothing is moving`, {
          rule: 'in-progress-idle', since: oldest.touched,
          claimed: `${idle.length === 1 ? oldest.id + ' is' : idle.length + ' streams are'} IN_PROGRESS`,
          observed: `Untouched for 7 days or more (oldest ${oldest.id}, ${dur(now - oldest.touched)}); no open session and no commit in the last 7 days mentions ${idle.length === 1 ? 'it' : 'them'}`,
          sources: [...sample.map((id) => `stream:${id}`), 'repo:commits', 'session:*'],
          what: `${idle.length === 1 ? oldest.id + ' is' : idle.length + ' streams are'} marked in progress, but nobody has touched ${idle.length === 1 ? 'it' : 'them'} for a week and no session or commit mentions ${idle.length === 1 ? 'it' : 'them'}. Oldest: ${sample.join(', ')}.`,
          why: 'The plan says work is happening; the evidence says it is not, so the plan may be wrong.',
          how: 'Resume them, or move them to blocked or planned (quoxplan status <id> <STATUS>).',
        }));
    }
  }

  // (d) healthy-claim-vs-probe
  const healthy = new Set(by('container:summary').flatMap((s) => (Array.isArray(stateOf(s).healthy) ? stateOf(s).healthy.map(String) : [])));
  for (const site of by('site:')) {
    const st = stateOf(site);
    if (String(site.status) !== 'down' || !st.container || !healthy.has(String(st.container))) continue;
    const name = site.subject.slice('site:'.length);
    out.push(finding(`${PREFIX}contradiction:healthy-vs-probe:${name}`, 'contradiction', `${st.container} says healthy but ${name} is down`, {
      rule: 'healthy-vs-probe', since: Number(st.since) || site.status_since,
      claimed: `Container ${st.container} is running and healthy`,
      observed: `The probe of ${st.url || name} is failing${st.error ? ` (${String(st.error).slice(0, 100)})` : ''}`,
      sources: [`container:${st.container}`, site.subject],
      what: `${st.container} reports healthy, but the outside probe of ${name} fails.`,
      why: 'The health check is not testing what visitors actually reach, so "healthy" cannot be trusted for this site.',
      how: `Check what sits between ${st.container} and the internet (proxy, DNS, certificate).`,
    }));
  }
  return out;
}

// ---- emit -------------------------------------------------------------------------------

/**
 * One pass for one org. Never throws. Returns { ok, emitted, retracted, unchanged, failures[], findings }.
 * ok=false means something FAILED (not "nothing to say").
 * deps: { now(), expectedFeeds: string[] | () => string[], log }
 */
function runEpistemic(orgId, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const log = deps.log || ((m) => console.error(m));
  const res = { ok: true, emitted: 0, retracted: 0, unchanged: 0, backed_off: 0, failures: [], findings: 0 };
  _stats.ticks += 1;
  let found;
  try {
    if (!journal.isReady()) throw new Error('journal not ready');
    const exp = typeof deps.expectedFeeds === 'function' ? deps.expectedFeeds() : (deps.expectedFeeds || []);
    found = [...feedFindings(orgId, now, exp), ...contradictionFindings(orgId, now)];
  } catch (err) {
    res.ok = false;
    res.failures.push(`read: ${err && err.message ? err.message : err}`);
    _stats.failed_ticks += 1; _stats.last_error = res.failures[0]; _stats.last_error_at = now;
    log(`[LUCID/Epistemic] ${orgId}: ${res.failures[0]}`);
    return res;
  }
  res.findings = found.length;
  const key = (s) => `${orgId}|${s}`;
  const attempt = (subject, fn, onOk) => {
    const k = key(subject);
    const bo = _bo.get(k);
    if (bo && bo.nextAt > now) { res.backed_off += 1; _stats.backoff_skips += 1; return; }
    try {
      fn();
      _bo.delete(k);
      onOk();
    } catch (err) {
      const fails = (bo ? bo.fails : 0) + 1;
      _bo.set(k, { fails, nextAt: now + Math.min(TICK_MS * 2 ** fails, BACKOFF_CAP_MS) });
      res.ok = false;
      res.failures.push(`${subject}: ${err && err.message ? err.message : err}`);
      _stats.emit_failed += 1;
    }
  };

  const live = new Set();
  for (const f of found) {
    live.add(f.subject);
    const fp = JSON.stringify([f.headline, f.state.class, f.state.urgent, f.state.observed, f.state.claimed, f.state.what_line]);
    if (_fp.get(key(f.subject)) === fp) { res.unchanged += 1; _stats.skipped_unchanged += 1; continue; }
    attempt(f.subject, () => {
      journal.append({ org_id: orgId, ledger: 'epistemic', subject: f.subject, kind: 'state', ts: now, source: SOURCE, summary: f.headline, state: { status: 'open', ...f.state } });
    }, () => { _fp.set(key(f.subject), fp); res.emitted += 1; _stats.emitted += 1; });
  }

  // Retire what is no longer true: once, and only what I own.
  let openMine = [];
  try { openMine = journal.listOpenSubjects(orgId, { ledger: 'epistemic' }).filter((s) => s.subject.startsWith(PREFIX)); } catch (err) {
    res.ok = false; res.failures.push(`list: ${err && err.message ? err.message : err}`);
  }
  for (const s of openMine) {
    if (live.has(s.subject)) continue;
    attempt(s.subject, () => {
      journal.append({ org_id: orgId, ledger: 'epistemic', subject: s.subject, kind: 'retract', ts: now, source: SOURCE, state: { status: 'resolved' } });
    }, () => { _fp.delete(key(s.subject)); res.retracted += 1; _stats.retracted += 1; });
  }
  // A subject I remember emitting that is no longer open (retracted elsewhere) is forgotten, so it can reopen.
  const openSet = new Set(openMine.map((s) => key(s.subject)));
  for (const k of [..._fp.keys()]) if (k.startsWith(`${orgId}|`) && !openSet.has(k)) _fp.delete(k);

  if (res.failures.length) {
    _stats.failed_ticks += 1; _stats.last_error = res.failures[0]; _stats.last_error_at = now;
    log(`[LUCID/Epistemic] ${orgId}: ${res.failures.length} emit(s) failed, backing those off: ${res.failures.slice(0, 3).join('; ')}`);
  } else _stats.ok_ticks += 1;
  return res;
}

/**
 * Start the watcher loop. orgIdsFn: () => string[] (sync or async).
 * Wiring (server.js, after journal.ensure): require('./lib/lucid/epistemic.js').startEpistemic(() => <org ids>, { expectedFeeds: [...] })
 * Returns { stop, stats }.
 */
function startEpistemic(orgIdsFn, deps = {}) {
  const intervalMs = deps.intervalMs || TICK_MS;
  let stopped = false;
  let running = false;
  let timer = null;
  const loop = async () => {
    if (stopped) return;
    if (!running) {
      running = true;
      try {
        const ids = await orgIdsFn();
        for (const id of ids || []) runEpistemic(id, deps);
      } catch (err) {
        _stats.failed_ticks += 1;
        _stats.last_error = `orgs: ${err && err.message ? err.message : err}`;
        _stats.last_error_at = Date.now();
        console.error('[LUCID/Epistemic] loop error:', err && err.message);
      } finally { running = false; }
    }
    if (!stopped) { timer = setTimeout(loop, intervalMs); if (timer.unref) timer.unref(); }
  };
  timer = setTimeout(loop, deps.initialDelayMs != null ? deps.initialDelayMs : 45000);
  if (timer.unref) timer.unref();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); }, stats: getStats };
}

module.exports = { runEpistemic, startEpistemic, getStats, _resetForTests, feedFindings, contradictionFindings, GRACE_MS, IDLE_MS };
