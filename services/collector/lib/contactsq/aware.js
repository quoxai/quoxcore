'use strict';

/**
 * ContactsQ -> LUCID (Quoxify dimension 21, AWARE). Called from the existing wall-clock scheduler tick
 * (scheduler.js); it owns NO timer and is never boot-triggered.
 *
 * Per org that has ContactsQ data:
 *   - a heartbeat on feed `contacts` (ttl > the scheduler interval) so silence is a fact;
 *   - one status subject `contacts:status` whose STATE carries the volatile counts (never the summary);
 *   - ask subjects, with stable ids, only while ContactsQ genuinely needs a person:
 *       contacts:sync:<source_id>   a sync source was retired after repeated failures
 *       contacts:retention          the retention reaper failed, or items were retired_failed
 *       contacts:unknown-callers    unknown callers await review (low urgency, refreshed at most daily)
 *     each is retracted the moment the need goes away.
 *
 * No-PII rule (same as evidence.js): ids, counts and provider names only. Never a contact name, number, email,
 * a source label or a credential. Nothing here fires per lookup, tool call or email.
 */

const FEED = 'contacts';
const HEARTBEAT_TTL_S = 900; // three scheduler ticks (5 min each)
const STATUS_SUBJECT = 'contacts:status';
const SOURCE_PREFIX = 'contacts:sync:';
const RETENTION_SUBJECT = 'contacts:retention';
const CALLERS_SUBJECT = 'contacts:unknown-callers';
const DAY_MS = 86400000;
const PERSON_PREFIX = 'person:';
const MAX_PERSON_ASKS = 5; // newest unknown callers raised individually; the aggregate subject covers the rest

const PROVIDER_WORDS = { icloud: 'iCloud', carddav: 'CardDAV' };

/**
 * @param {{ store: object, compliance: object, merge: object, listSources: Function, retentionStatus: Function,
 *           lucid?: object, journal?: object, now?: Function, log?: Function }} deps
 */
/** One-way short key for a contact id; the raw id never appears in the journal. */
function personKey(id) { return require('crypto').createHash('sha256').update(String(id)).digest('hex').slice(0, 12); }

function createContactsqAware(deps) {
  const { store, compliance, merge, listSources, retentionStatus } = deps;
  const now = deps.now || Date.now;
  const log = deps.log || ((m) => console.error(m));
  const lastCallersEmit = new Map(); // org -> ms of the last unknown-callers refresh
  const personEmitted = new Map(); // org -> Set of person subjects already raised (repeat ticks journal nothing)
  const personRefresh = new Map(); // org -> ms of the last person refresh
  const stats = { ticks: 0, orgs: 0, failures: 0 };

  const lucid = () => deps.lucid || require('../lucid/emit.js');
  const journal = () => deps.journal || require('../lucid/journal.js');
  const src = { feed: FEED };

  function orgIds() {
    const db = store.getDb();
    const rows = db.prepare('SELECT org_id FROM contacts UNION SELECT org_id FROM sync_sources').all();
    return rows.map((r) => r.org_id).filter(Boolean);
  }

  function counts(orgId) {
    const st = store.stats(orgId);
    const bands = compliance.buildBands(orgId);
    const dupes = merge.findDuplicates(orgId, { limit: 100 });
    const sources = listSources(orgId);
    return {
      candidates_to_review: st.candidates || 0,
      notices_overdue: bands.notice_overdue ? bands.notice_overdue.count : 0,
      consents_expiring_30d: bands.consents_expiring_30d ? bands.consents_expiring_30d.count : 0,
      duplicates: dupes.length,
      sync_sources: sources.length,
      sync_sources_failing: sources.filter((s) => s.retired_at || s.consecutive_failures > 0).length,
      sync_sources_retired: sources.filter((s) => s.retired_at).length,
      sources,
    };
  }

  function ask(orgId, subject, issue, summary, state, urgency) {
    return lucid().emit({
      org_id: orgId, ledger: 'operational', subject, kind: 'ask', source: src,
      state: { status: 'needs_you', issue, urgency, actor: { type: 'system', id: 'contactsq', name: 'ContactsQ' }, ...state },
      summary, salience: { needs: 'owner', gates: [] },
    });
  }

  function clear(orgId, subject) {
    return lucid().emit({ org_id: orgId, ledger: 'operational', subject, kind: 'retract', source: src, state: { status: 'resolved' } });
  }

  function tickOrg(orgId, t) {
    const c = counts(orgId);
    const j = journal();
    j.declareExpected(orgId, [FEED]);
    lucid().emit({ org_id: orgId, kind: 'heartbeat', ttl_s: HEARTBEAT_TTL_S, source: src });
    // Volatile numbers live in state; the summary is constant so it never churns the journal.
    lucid().emit({
      org_id: orgId, ledger: 'operational', subject: STATUS_SUBJECT, kind: 'state', source: src,
      state: {
        status: 'running', candidates_to_review: c.candidates_to_review, notices_overdue: c.notices_overdue,
        consents_expiring_30d: c.consents_expiring_30d, duplicates: c.duplicates, sync_sources: c.sync_sources,
        sync_sources_failing: c.sync_sources_failing, actor: { type: 'system', id: 'contactsq', name: 'ContactsQ' },
      },
      summary: 'ContactsQ is running', salience: { needs: 'none', gates: [] },
    });

    const wanted = new Set([STATUS_SUBJECT]);

    for (const s of c.sources) {
      if (!s.retired_at) continue;
      const subject = `${SOURCE_PREFIX}${s.id}`;
      wanted.add(subject);
      const provider = PROVIDER_WORDS[s.provider] || 'CardDAV';
      ask(orgId, subject, 'sync_retired', `${provider} sync stopped after repeated failures`,
        { provider, failed_runs: s.consecutive_failures, source_id: s.id, since: Date.parse(s.retired_at) || undefined }, 'today');
    }

    const ret = retentionStatus(orgId);
    const retFailed = ret && ret.last_status && ret.last_status !== 'ok';
    const retiredItems = ret && ret.pending ? ret.pending.retired_failed || 0 : 0;
    if (retFailed || retiredItems > 0) {
      wanted.add(RETENTION_SUBJECT);
      ask(orgId, RETENTION_SUBJECT, 'retention_failed', retFailed ? 'The contact retention clean-up failed' : 'Some contacts could not be erased on schedule',
        { last_status: ret.last_status || null, consecutive_failures: ret.consecutive_failures || 0, retired_failed: retiredItems }, 'today');
    }

    if (c.candidates_to_review > 0) {
      wanted.add(CALLERS_SUBJECT);
      const last = lastCallersEmit.get(orgId) || 0;
      if (now() - last >= DAY_MS) {
        lastCallersEmit.set(orgId, now());
        ask(orgId, CALLERS_SUBJECT, 'unknown_callers', 'Unknown callers are waiting for your review', { candidates_to_review: c.candidates_to_review }, 'whenever');
      }
    } else { lastCallersEmit.delete(orgId); }

    // Per-person asks: each waiting candidate is its own subject so it can be retracted on its own.
    // WHO is always "an unknown caller": a candidate's display name is the raw number/address, which never
    // enters the journal. The subject id is a one-way hash of the contact id, not the id itself.
    const seen = personEmitted.get(orgId) || new Set();
    const refresh = now() - (personRefresh.get(orgId) || 0) >= DAY_MS;
    if (refresh) personRefresh.set(orgId, now());
    const waiting = store.getDb().prepare(
      "SELECT id, created_at FROM contacts WHERE org_id = ? AND status = 'candidate' ORDER BY created_at DESC, rowid DESC LIMIT ?"
    ).all(orgId, MAX_PERSON_ASKS);
    const nowSeen = new Set();
    for (const r of waiting) {
      const subject = `${PERSON_PREFIX}${personKey(r.id)}`;
      wanted.add(subject); nowSeen.add(subject);
      if (refresh || !seen.has(subject)) {
        ask(orgId, subject, 'unknown_caller', 'An unknown caller is waiting for your review',
          { who: 'an unknown caller', since: Date.parse(r.created_at) || undefined }, 'whenever');
      }
    }
    personEmitted.set(orgId, nowSeen);

    // Reconcile: anything of ours still open that is no longer wanted has been dealt with.
    for (const s of j.listOpenSubjects(orgId, { ledger: 'operational' })) {
      if (!(s.subject.startsWith('contacts:') || s.subject.startsWith(PERSON_PREFIX)) || wanted.has(s.subject)) continue;
      clear(orgId, s.subject);
      t.cleared += 1;
    }
  }

  /** One scheduler wake-up. Failures are counted and logged, never silent, and never thrown into the scheduler. */
  function tick() {
    const t = { orgs: 0, failed: 0, cleared: 0 };
    stats.ticks += 1;
    let orgs = [];
    try { orgs = orgIds(); } catch (e) { t.failed += 1; log(`[contactsq] aware: listing orgs failed code=${(e && e.code) || 'error'}`); }
    for (const orgId of orgs) {
      try { tickOrg(orgId, t); t.orgs += 1; } catch (e) {
        t.failed += 1;
        log(`[contactsq] aware: org tick failed org=${orgId} code=${(e && e.code) || 'error'}`);
      }
    }
    stats.orgs = t.orgs; stats.failures += t.failed;
    return t;
  }

  return { tick, stats, FEED };
}

module.exports = { createContactsqAware, FEED, HEARTBEAT_TTL_S, STATUS_SUBJECT, SOURCE_PREFIX, RETENTION_SUBJECT, CALLERS_SUBJECT };
