'use strict';

/**
 * NotesQ scheduler (AQ-9D P4): creates a note from a template for each due
 * schedule. Loop hygiene: failures are counted distinctly from empty ticks,
 * a failed due-fetch backs the interval off (doubling, capped at 10 min), an
 * in-progress tick makes the next one skip, and every schedule is claimed
 * (per period) before work so a period is never produced twice.
 * The brain's service-only schedule routes are called directly here (headers
 * X-Service-Key + the schedule's X-Org-Id); note creation goes through the
 * governed notesqCall so licence, author kind and evidence stay in one place.
 */

const { varsFor, renderTemplate, resolveTemplate } = require('./templates.js');

const MAX_BACKOFF_MS = 10 * 60 * 1000;
const DUE_LIMIT = 50;

function createNotesqScheduler(deps) {
  const {
    notesqCall, isPluginLicensed, audit,
    intervalMs = 60000,
  } = deps || {};
  for (const [k, v] of Object.entries({ notesqCall, isPluginLicensed })) {
    if (typeof v !== 'function') throw new Error(`createNotesqScheduler requires deps.${k}`);
  }
  const fetchImpl = deps.fetchImpl || fetch;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const brainUrl = String(deps.brainUrl || process.env.QUOXBRAIN_URL || 'http://quoxbrain:3106').replace(/\/$/, '');
  const serviceKey = deps.serviceKey !== undefined ? deps.serviceKey : (process.env.INTERNAL_SERVICE_KEY || '');
  const log = deps.log || ((m) => console.log(m));
  const logErr = deps.logErr || ((m) => console.error(m));

  let timer = null;
  let running = false;
  let currentInterval = intervalMs;

  async function brain(method, path, orgId, body) {
    const headers = { 'Content-Type': 'application/json', 'X-Service-Key': serviceKey };
    if (orgId) headers['X-Org-Id'] = orgId;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetchImpl(brainUrl + path, opts);
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    if (res.status < 200 || res.status >= 300) throw new Error(`brain ${method} ${path.split('?')[0]} -> ${res.status}`);
    return json || {};
  }

  async function report(s, period, outcome, previous, error) {
    try {
      await brain('POST', `/notesq/schedules/${encodeURIComponent(s.id)}/result`, s.org_id, {
        period, outcome, previous_period: previous, ...(error ? { error: String(error).slice(0, 300) } : {}),
      });
    } catch (e) {
      logErr(`[NotesqScheduler] result report failed for schedule ${s.id}: ${e?.message}`);
    }
  }

  async function runOne(s) {
    if (!(await isPluginLicensed(s.org_id, 'notesq'))) {
      // Never claimed: keep the stored period as it is.
      await report(s, s.period, 'skip', s.last_period ?? null);
      return 'skipped';
    }
    const claim = await brain('POST', `/notesq/schedules/${encodeURIComponent(s.id)}/claim`, s.org_id, { period: s.period });
    if (!claim.claimed) {
      // Period already done (e.g. the last 'ok' report was lost after the note was
      // written): advance next_run_at with 'ok' so the row stops being due every
      // tick. 'ok' never touches last_period, so this cannot re-open the period.
      await report(s, s.period, 'ok', s.last_period ?? null);
      return 'skipped';
    }
    const previous = claim.previous_period === undefined ? null : claim.previous_period;
    try {
      const ctx = { orgId: s.org_id, userId: s.user_id, actor: 'agent', agentId: 'notesq-scheduler', isAdmin: false };
      const listUserTemplates = async () => {
        const out = await notesqCall({ ctx, method: 'GET', path: '/notesq/notes', query: { scope: 'all', limit: 200, archived: 'exclude' }, scope: 'all' });
        if (out.status !== 200) return [];
        return (out.json?.notes || []).filter((n) => n && n.properties && n.properties.template === true);
      };
      const loadNote = async (id) => {
        const out = await notesqCall({ ctx, method: 'GET', path: `/notesq/notes/${encodeURIComponent(id)}`, noteId: id });
        const j = out.json || {};
        return out.status === 200 ? (j.markdown || j.note?.markdown || j.revision?.markdown || '') : '';
      };
      const tpl = await resolveTemplate(s.template, { listUserTemplates, loadNote });
      if (!tpl) throw new Error('template_not_found');
      const pattern = s.title_pattern || tpl.title_pattern;
      const r = renderTemplate({ ...tpl, title_pattern: pattern }, varsFor(Date.parse(s.next_run_at) || now(), s.tz));
      const properties = { from_template: tpl.name, schedule_id: s.id, period: s.period };
      if (s.collection) properties.collection = s.collection;
      const out = await notesqCall({
        ctx, method: 'POST', path: '/notesq/notes', intent: 'quox.notes.create', authored: true, scope: s.scope,
        body: { scope: s.scope, markdown: r.markdown, properties },
      });
      if (out.status < 200 || out.status >= 300) throw new Error(`create failed: ${out.status} ${out.json?.error || ''}`.trim());
      await report(s, s.period, 'ok', previous);
      return 'created';
    } catch (e) {
      await report(s, s.period, 'error', previous, e?.message || 'unknown');
      return 'failed';
    }
  }

  async function tick() {
    if (running) return { skippedOverlap: true };
    running = true;
    try {
      let due;
      try {
        const j = await brain('GET', `/notesq/schedules-due?now=${encodeURIComponent(new Date(now()).toISOString())}&limit=${DUE_LIMIT}`, null);
        due = Array.isArray(j.schedules) ? j.schedules : [];
        currentInterval = intervalMs;
      } catch (e) {
        currentInterval = Math.min(currentInterval * 2, MAX_BACKOFF_MS);
        logErr(`[NotesqScheduler] tick: due fetch FAILED (${e?.message}); next interval ${currentInterval}ms`);
        return { fetchFailed: true };
      }
      let created = 0; let skipped = 0; let failed = 0;
      for (const s of due) {
        try {
          const o = await runOne(s);
          if (o === 'created') created += 1; else if (o === 'skipped') skipped += 1; else failed += 1;
        } catch (e) {
          failed += 1;
          logErr(`[NotesqScheduler] schedule ${s && s.id} failed: ${e?.message}`);
        }
      }
      log(`[NotesqScheduler] tick: ${due.length} due, created ${created}, skipped ${skipped}, failed ${failed}`);
      if (audit && due.length && (created || failed)) {
        try {
          audit({ from: 'service.notesq', type: 'event', intent: 'quox.notes.schedule.tick', payload: { due: due.length, created, skipped, failed } });
        } catch { /* evidence is best effort here; creates are already witnessed */ }
      }
      return { due: due.length, created, skipped, failed };
    } finally {
      running = false;
    }
  }

  function arm() {
    timer = setTimeout(async () => {
      try { await tick(); } catch (e) { logErr(`[NotesqScheduler] tick crashed: ${e?.message}`); }
      if (timer) arm();
    }, currentInterval);
    if (timer.unref) timer.unref();
  }
  function start() { if (!timer) arm(); }
  function stop() { if (timer) clearTimeout(timer); timer = null; }

  return { tick, start, stop, getInterval: () => currentInterval };
}

module.exports = { createNotesqScheduler };
