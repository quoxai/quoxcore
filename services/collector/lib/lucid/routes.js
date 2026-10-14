/**
 * LUCID HTTP surface. Mounted from server.js with the collector's own auth
 * helpers so org scoping is identical to every other org-scoped route.
 *
 *   POST /api/internal/lucid/events      service key; host gatherers (org explicit)
 *   POST /api/v1/lucid/events            user or service; a user can only write as feed user:<id>
 *   GET  /api/v1/lucid/situation         ?since=last|<seq>|3h &surface= &advance=1
 *   GET  /api/internal/lucid/situation   service key, ?org_id= &viewer=
 *   GET  /api/v1/lucid/subjects | /journal | /feeds
 *   POST /api/v1/lucid/ack               advance the caller's cursor to a seq
 *   GET  /api/v1/lucid/item?ref=         one ItemCard with its full account (the "why")
 *   POST /api/v1/lucid/measure           {ref, measure_id}: do or describe one of an item's measures
 *   GET  /api/v1/lucid/lessons | POST /api/v1/lucid/teach | DELETE /api/v1/lucid/lessons/:id
 */

const journal = require('./journal.js');
const { buildSituation, itemFor, renderSituation, renderCompact, renderSpoken } = require('./situation.js');

// The collector hosts the HITL hook in-process, so its feed is expected everywhere.
const BUILTIN_FEEDS = ['hitl'];

function lucidErr(res, err) {
  const map = { bad_request: 400, forbidden: 403, not_found: 404, store_not_initialised: 503, file_failed: 502 };
  const status = map[err && err.code];
  if (status) return res.status(status).json({ error: err.code, message: err.message });
  console.error('[LUCID] error:', err && err.message);
  return res.status(500).json({ error: 'lucid operation failed' });
}

function viewerOf(req) {
  const u = req.user;
  if (u) return `user:${u.id || u.sub || u.user_id || 'unknown'}`;
  const v = typeof req.query.viewer === 'string' && req.query.viewer.trim() ? req.query.viewer.trim() : 'owner';
  return v.slice(0, 120);
}

function surfaceOf(req) {
  const s = typeof req.query.surface === 'string' && req.query.surface.trim() ? req.query.surface.trim() : 'api';
  return s.slice(0, 40);
}

/**
 * since: "last" (default) = the viewer's cursor on this surface; a bare integer
 * is a journal seq; "<n>m|h|d" is a wall-clock window.
 */
function resolveSince(orgId, since, viewer, surface, now) {
  const raw = since == null || since === '' ? 'last' : String(since).trim();
  if (raw === 'last') return journal.getCursor(orgId, viewer, surface);
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = raw.match(/^(\d+)\s*([mhd])$/i);
  if (m) {
    const ms = Number(m[1]) * { m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()];
    const first = journal.journalSince(orgId, now - ms, { limit: 1 })[0];
    return first ? first.seq - 1 : journal.latestSeq(orgId);
  }
  const e = new Error('since must be last, a seq, or a window like 3h');
  e.code = 'bad_request';
  throw e;
}

// Read-only views are memoised briefly: panels, decks, agents and the phone poll the same
// picture, and building it is not free. Any new journal row changes the key, so a real
// change is never hidden; only waits and ages can be up to SITUATION_TTL_MS old.
const SITUATION_TTL_MS = 10000;
const _situationMemo = new Map();
function clearSituationMemo() { _situationMemo.clear(); }

// What goes over the wire. The server keeps full cards (itemFor, the herald), but responses
// were 313KB per poll: every open item's full card repeated inside its area, the change list
// twice, evidence on items nobody expands. Clients read the full card via /lucid/item.
function slimItem(it) {
  if (!it) return it;
  const { L3, _x, ...rest } = it;
  return rest;
}
function refOnly(it) {
  return it ? { ref: it.ref, L0: it.L0, urgency: it.urgency, area: it.area, status: it.L3 ? it.L3.status : it.status } : it;
}
function wireSituation(sit) {
  const { changed_latest, ...rest } = sit;
  return {
    ...rest,
    in_motion: (sit.in_motion || []).map(slimItem),
    shelved: (sit.shelved || []).map(refOnly),
    areas: (sit.areas || []).map((a) => ({ ...a, L1: { ...a.L1, needs: (a.L1.needs || []).map(refOnly), open: (a.L1.open || []).map(refOnly) } })),
  };
}

// Serialised once per memo entry, with a content hash as ETag: an unchanged poll costs a 304.
function wireOf(value) {
  if (!value._wire) {
    const body = JSON.stringify({ ...value, situation: wireSituation(value.situation) });
    const etag = `W/"${require('crypto').createHash('sha1').update(body).digest('base64').slice(0, 27)}"`;
    Object.defineProperty(value, '_wire', { value: { body, etag }, enumerable: false });
  }
  return value._wire;
}

function sendSituation(req, res, value) {
  const { body, etag } = wireOf(value);
  res.set('ETag', etag);
  res.set('Cache-Control', 'private, no-cache');
  if ((req.headers || {})['if-none-match'] === etag) return res.status(304).end();
  return res.type('application/json').send(body);
}

function situationFor(orgId, { since, viewer, surface, advance }) {
  const now = Date.now();
  // The collector answering IS the HITL feed being alive.
  journal.append({ org_id: orgId, kind: 'heartbeat', source: { surface: 'collector', feed: 'hitl' }, ts: now });
  // quox#827: the approvals SET comes from the one server-side function; refresh it in the background (gap-limited).
  try { require('./approvalsSync.js').kick(orgId); } catch (e) { console.error('[LUCID] approvals refresh not started:', e && e.message); }
  const sinceSeq = resolveSince(orgId, since, viewer, surface, now);
  const key = !advance ? `${journal.generation()}|${orgId}|${viewer}|${surface}|${sinceSeq}|${journal.latestSeq(orgId)}|${journal.listLessons ? journal.listLessons(orgId).length : 0}` : null;
  if (key) {
    const hit = _situationMemo.get(key);
    if (hit && now - hit.at < SITUATION_TTL_MS) { noteDelivery(orgId, viewer, surface, advance, hit.value); return hit.value; }
  }
  const expected = [...new Set([...BUILTIN_FEEDS, ...journal.listExpected(orgId)])];
  const sit = buildSituation(orgId, { now, sinceSeq, expectedFeeds: expected });
  sit.viewer = viewer;
  sit.surface = surface;
  if (advance) journal.advanceCursor(orgId, viewer, surface, sit.cursor.to);
  // text: for a person; text_agent: compact and id-rich; spoken: sentences for the phone.
  const value = { situation: sit, text: renderSituation(sit, { now }), text_agent: renderCompact(sit, { now }), spoken: renderSpoken(sit) };
  if (key) {
    if (_situationMemo.size > 200) _situationMemo.clear();
    _situationMemo.set(key, { at: now, value });
  }
  noteDelivery(orgId, viewer, surface, advance, value);
  return value;
}

// Person-facing deliveries are recorded as "briefing issued" (advancing views and the sitrep surface;
// phone/agent/morning reads record themselves). The witness dedupes memo hits inside 10 minutes.
function noteDelivery(orgId, viewer, surface, advance, value) {
  if (!advance && surface !== 'sitrep') return;
  require('./witness.js').briefingIssued(orgId, { viewer, surface, kind: advance ? 'view' : 'sitrep' }, value);
}

/**
 * Carry out one measure of one item, honestly.
 *   safe / say / reply / decide : describe it (say, command, url); status 'opened' if it has a url, else 'manual'
 *   approve / deny             : 'manual' with the Approvals url. LUCID never decides an approval for you.
 *   run (gated)                : files a HITL approval ONLY when a real filer is wired (deps.fileApproval);
 *                                otherwise 'manual' with the exact command, and it says nothing was filed.
 *   dangerous                  : always 'manual'; never offered by voice.
 */
async function runMeasure(orgId, item, m, { fileApproval, requestedBy } = {}) {
  const out = { ref: item.ref, measure_id: m.id };
  for (const k of ['say', 'command', 'url']) if (m[k]) out[k] = m[k];
  if (m.risk === 'dangerous') return { ...out, status: 'manual', note: 'This one is dangerous: it is never run from here. Do it yourself.' };
  if (m.kind === 'approve' || m.kind === 'deny') {
    return { ...out, status: 'manual', note: 'Answer on the Approvals page. LUCID does not decide an approval for you.' };
  }
  if (m.kind === 'run' && m.risk !== 'safe' && m.execute && m.execute.via === 'hitl') {
    if (typeof fileApproval !== 'function') {
      return { ...out, status: 'manual', note: 'Nothing was run and no approval was filed: this install has no approval filer wired for LUCID. Run the command yourself.' };
    }
    const filed = await fileApproval(orgId, {
      tool_name: m.execute.tool_name, params: m.execute.params || {}, area: item.area, ref: item.ref, measure_id: m.id,
      host: (item.L3 && item.L3.state && item.L3.state.host) || null,
      title: `${m.label}: ${item.L0}`, body_md: `${item.L1.what}

Why: ${item.L1.why}

Command: ${m.command || ''}`, requested_by: requestedBy,
    });
    if (filed && filed.unavailable) {
      return { ...out, status: 'manual', note: `Nothing was run and no approval was filed: ${filed.unavailable}. Run the command yourself.` };
    }
    if (!filed || !filed.approval_id) throw Object.assign(new Error('approval could not be filed'), { code: 'file_failed' });
    return { ...out, status: 'filed', approval_id: filed.approval_id };
  }
  return { ...out, status: m.url ? 'opened' : 'manual' };
}

function ingest(orgId, body, opts = {}) {
  // One transaction per post: a gatherer post carries hundreds of events.
  return journal.transaction(() => ingestInner(orgId, body, opts));
}

function ingestInner(orgId, body, { forceFeed } = {}) {
  const results = [];
  const withFeed = (ev) => (forceFeed ? { ...ev, source: { ...(ev.source || {}), feed: forceFeed, writer: forceFeed } } : ev);
  if (Array.isArray(body.expected_feeds)) {
    if (forceFeed) { const e = new Error('expected_feeds is service-only'); e.code = 'bad_request'; throw e; }
    journal.declareExpected(orgId, body.expected_feeds);
  }
  if (Array.isArray(body.retired_feeds)) {
    if (forceFeed) { const e = new Error('retired_feeds is service-only'); e.code = 'bad_request'; throw e; }
    journal.undeclareExpected(orgId, body.retired_feeds);
  }
  const events = Array.isArray(body.events) ? body.events : (body.kind ? [body] : []);
  if (forceFeed) {
    // A person's feed may only speak about its own subjects; security:*, approval:* and the rest belong to their feeds.
    for (const ev of events.slice(0, 500)) {
      const subj = ev && typeof ev.subject === 'string' ? ev.subject.trim() : '';
      if (ev && ev.kind !== 'heartbeat' && !/^(user|note):/.test(subj)) {
        const e = new Error('system subjects are owned by their feed');
        e.code = 'forbidden';
        throw e;
      }
    }
  }
  for (const ev of events.slice(0, 500)) results.push(journal.append({ ...withFeed(ev), org_id: orgId }));
  const snaps = Array.isArray(body.snapshots) ? body.snapshots : [];
  if (snaps.length && forceFeed) { const e = new Error('snapshots are service-only'); e.code = 'bad_request'; throw e; }
  for (const s of snaps.slice(0, 50)) results.push(journal.applySnapshot({ ...s, org_id: orgId }));
  return { ok: true, results };
}

// Default deny: only a service caller or a user whose role is admin/owner. The JWT role is surfaced as
// req.user.dashboardRole (utils/httpAuth.js never populates req.user.role); a user with no role is NOT admin.
const isAdminish = (req) => !!req && (req.service === true
  || (!!req.user && ['admin', 'owner'].includes(String(req.user.dashboardRole || req.user.role || '').toLowerCase())));

// Security and approval items are the ones a quiet lesson could hide something dangerous in.
function teachesProtectedKind({ scope, target }) {
  const t = String(target || '').trim();
  if (scope === 'kind') return t === 'security' || t === 'approval';
  if (scope === 'area') return t === 'security' || t === 'approvals';
  if (scope === 'subject') {
    const def = require('./explain.js').kindFor(t);
    return !!def && (def.kind === 'security' || def.kind === 'approval');
  }
  return false;
}

function mount(app, { requireServiceOrUserAuth, resolveSlotOrgId, hasInternalServiceKey, dbReady, fileApproval }) {
  const ready = (res) => {
    if (!dbReady() || !journal.isReady()) { res.status(503).json({ error: 'storage unavailable' }); return false; }
    return true;
  };
  const orgOr400 = (req, res) => {
    const orgId = resolveSlotOrgId(req);
    if (!orgId) res.status(400).json({ error: 'org could not be resolved' });
    return orgId;
  };

  app.post('/api/internal/lucid/events', (req, res) => {
    if (!hasInternalServiceKey(req)) return res.status(401).json({ error: 'service key required' });
    if (!ready(res)) return;
    const body = req.body || {};
    const orgId = typeof body.org_id === 'string' ? body.org_id.trim() : '';
    if (!orgId) return res.status(400).json({ error: 'org_id required' });
    try { res.json(ingest(orgId, body)); } catch (err) { lucidErr(res, err); }
  });

  app.post('/api/v1/lucid/events', requireServiceOrUserAuth(), (req, res) => {
    if (!ready(res)) return;
    const orgId = orgOr400(req, res);
    if (!orgId) return;
    // Source ownership: a user cannot speak as a system feed (the v0 ledger was spoofable).
    const forceFeed = req.user ? viewerOf(req) : null;
    try { res.json(ingest(orgId, req.body || {}, { forceFeed })); } catch (err) { lucidErr(res, err); }
  });

  // P2 replay: what LUCID knew at a moment, and what it told the owner over a window (witnessed).
  app.get('/api/v1/lucid/replay', requireServiceOrUserAuth(), (req, res) => {
    if (!ready(res)) return;
    const orgId = orgOr400(req, res);
    if (!orgId) return;
    try { require('./replay.js').replayHandler(req, res, orgId); } catch (err) { lucidErr(res, err); }
  });

  app.get('/api/v1/lucid/told', requireServiceOrUserAuth(), (req, res) => {
    if (!ready(res)) return;
    const orgId = orgOr400(req, res);
    if (!orgId) return;
    try { require('./replay.js').toldHandler(req, res, orgId); } catch (err) { lucidErr(res, err); }
  });

  app.get('/api/v1/lucid/situation', requireServiceOrUserAuth(), (req, res) => {
    if (!ready(res)) return;
    const orgId = orgOr400(req, res);
    if (!orgId) return;
    try {
      sendSituation(req, res, situationFor(orgId, { since: req.query.since, viewer: viewerOf(req), surface: surfaceOf(req), advance: req.query.advance === '1' || req.query.advance === 'true' }));
    } catch (err) { lucidErr(res, err); }
  });

  app.get('/api/internal/lucid/situation', (req, res) => {
    if (!hasInternalServiceKey(req)) return res.status(401).json({ error: 'service key required' });
    if (!ready(res)) return;
    const orgId = typeof req.query.org_id === 'string' ? req.query.org_id.trim() : '';
    if (!orgId) return res.status(400).json({ error: 'org_id required' });
    try {
      sendSituation(req, res, situationFor(orgId, { since: req.query.since, viewer: viewerOf(req), surface: surfaceOf(req), advance: req.query.advance === '1' || req.query.advance === 'true' }));
    } catch (err) { lucidErr(res, err); }
  });

  app.post('/api/v1/lucid/ack', requireServiceOrUserAuth(), (req, res) => {
    if (!ready(res)) return;
    const orgId = orgOr400(req, res);
    if (!orgId) return;
    try {
      const seq = Number((req.body || {}).seq);
      if (!Number.isFinite(seq) || seq < 0) return res.status(400).json({ error: 'seq required' });
      res.json({ ok: true, cursor: journal.advanceCursor(orgId, viewerOf(req), surfaceOf(req), Math.min(seq, journal.latestSeq(orgId))) });
    } catch (err) { lucidErr(res, err); }
  });

  app.get('/api/v1/lucid/subjects', requireServiceOrUserAuth(), (req, res) => {
    if (!ready(res)) return;
    const orgId = orgOr400(req, res);
    if (!orgId) return;
    try {
      const ledger = typeof req.query.ledger === 'string' && req.query.ledger ? req.query.ledger : undefined;
      res.json({ subjects: journal.listOpenSubjects(orgId, { ledger }) });
    } catch (err) { lucidErr(res, err); }
  });

  app.get('/api/v1/lucid/journal', requireServiceOrUserAuth(), (req, res) => {
    if (!ready(res)) return;
    const orgId = orgOr400(req, res);
    if (!orgId) return;
    try {
      res.json({ entries: journal.listJournal(orgId, { afterSeq: Number(req.query.after) || 0, limit: req.query.limit }) });
    } catch (err) { lucidErr(res, err); }
  });

  app.get('/api/v1/lucid/feeds', requireServiceOrUserAuth(), (req, res) => {
    if (!ready(res)) return;
    const orgId = orgOr400(req, res);
    if (!orgId) return;
    try {
      res.json({ feeds: journal.listFeeds(orgId), expected: journal.listExpected(orgId) });
    } catch (err) { lucidErr(res, err); }
  });

  app.get('/api/v1/lucid/item', requireServiceOrUserAuth(), (req, res) => {
    if (!ready(res)) return;
    const orgId = orgOr400(req, res);
    if (!orgId) return;
    try {
      const ref = typeof req.query.ref === 'string' ? req.query.ref.trim() : '';
      if (!ref) return res.status(400).json({ error: 'ref required' });
      const item = itemFor(orgId, ref);
      if (!item) return res.status(404).json({ error: 'not found' });
      res.json({ item });
    } catch (err) { lucidErr(res, err); }
  });

  app.post('/api/v1/lucid/measure', requireServiceOrUserAuth(), async (req, res) => {
    if (!ready(res)) return;
    const orgId = orgOr400(req, res);
    if (!orgId) return;
    try {
      const { ref, measure_id: measureId } = req.body || {};
      if (typeof ref !== 'string' || !ref || typeof measureId !== 'string' || !measureId) return res.status(400).json({ error: 'ref and measure_id required' });
      const item = itemFor(orgId, ref.trim());
      if (!item) return res.status(404).json({ error: 'not found' });
      const m = item.L2.measures.find((x) => x.id === measureId);
      if (!m) return res.status(404).json({ error: 'measure_not_offered', message: `${measureId} is not one of the measures offered for ${ref}` });
      res.json(await runMeasure(orgId, item, m, { fileApproval, requestedBy: viewerOf(req) }));
    } catch (err) { lucidErr(res, err); }
  });

  app.get('/api/v1/lucid/lessons', requireServiceOrUserAuth(), (req, res) => {
    if (!ready(res)) return;
    const orgId = orgOr400(req, res);
    if (!orgId) return;
    try { res.json({ lessons: journal.listLessons(orgId) }); } catch (err) { lucidErr(res, err); }
  });

  app.post('/api/v1/lucid/teach', requireServiceOrUserAuth(), (req, res) => {
    if (!ready(res)) return;
    const orgId = orgOr400(req, res);
    if (!orgId) return;
    try {
      const b = req.body || {};
      if ((b.field === 'mute' || b.field === 'urgency') && teachesProtectedKind(b) && !isAdminish(req)) {
        return res.status(403).json({ error: 'forbidden', message: 'org admin or owner required to mute or re-rank security and approval items' });
      }
      // The org is the caller's, never the body's: a user cannot teach another org.
      res.json({ lesson: journal.addLesson(orgId, { scope: b.scope, target: b.target, field: b.field, value: b.value, reason: b.reason, author: viewerOf(req) }) });
    } catch (err) { lucidErr(res, err); }
  });

  app.delete('/api/v1/lucid/lessons/:id', requireServiceOrUserAuth(), (req, res) => {
    if (!ready(res)) return;
    const orgId = orgOr400(req, res);
    if (!orgId) return;
    try {
      if (!journal.deleteLesson(orgId, String(req.params.id))) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    } catch (err) { lucidErr(res, err); }
  });
  // ---- Herald (P3): settings, escalations, and the L2/L3 steps for the host runner ----------
  const herald = () => require('./herald.js');

  app.get('/api/v1/lucid/herald', requireServiceOrUserAuth(), (req, res) => {
    if (!ready(res)) return;
    const orgId = orgOr400(req, res);
    if (!orgId) return;
    try { res.json({ settings: herald().getSettings(orgId), escalations: herald().describeEscalations(orgId), stats: herald().getStats() }); } catch (err) { lucidErr(res, err); }
  });

  app.post('/api/v1/lucid/herald/settings', requireServiceOrUserAuth(), (req, res) => {
    if (!ready(res)) return;
    if (!isAdminish(req)) return res.status(403).json({ error: 'org admin or owner required' });
    const orgId = orgOr400(req, res);
    if (!orgId) return;
    try { res.json({ settings: herald().updateSettings(orgId, req.body || {}) }); } catch (err) { lucidErr(res, err); }
  });

  app.post('/api/v1/lucid/herald/test', requireServiceOrUserAuth(), (req, res) => {
    if (!ready(res)) return;
    const orgId = orgOr400(req, res);
    if (!orgId) return;
    try { res.json(herald().dryRun(orgId)); } catch (err) { lucidErr(res, err); }
  });

  app.get('/api/internal/lucid/herald/due', async (req, res) => {
    if (!hasInternalServiceKey(req)) return res.status(401).json({ error: 'service key required' });
    if (!ready(res)) return;
    const orgId = typeof req.query.org_id === 'string' ? req.query.org_id.trim() : '';
    if (!orgId) return res.status(400).json({ error: 'org_id required' });
    try { res.json({ steps: await herald().dueSteps(orgId) }); } catch (err) { lucidErr(res, err); }
  });

  app.post('/api/internal/lucid/herald/done', (req, res) => {
    if (!hasInternalServiceKey(req)) return res.status(401).json({ error: 'service key required' });
    if (!ready(res)) return;
    const b = req.body || {};
    const orgId = typeof b.org_id === 'string' ? b.org_id.trim() : '';
    if (!orgId) return res.status(400).json({ error: 'org_id required' });
    try { res.json(herald().recordDone(orgId, b)); } catch (err) { lucidErr(res, err); }
  });
}

module.exports = { mount, situationFor, clearSituationMemo, wireSituation, wireOf, resolveSince, ingest, runMeasure, _isAdminish: isAdminish };
