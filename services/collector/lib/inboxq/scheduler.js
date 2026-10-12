'use strict';

/**
 * InboxQ background sync scheduler.
 *
 * Two-level gating (SURFACED model):
 *   - MASTER: env INBOXQ_SYNC_ENABLED must be '1' for the scheduler to arm at all
 *     (operator kill-switch; registered in envRegistry).
 *   - PER-ORG: only orgs whose inboxq_settings.sync_enabled = 1 are synced, at
 *     their own sync_interval_min cadence and llm_budget_per_tick.
 *
 * Loop-triad compliance: the actual work is syncAccount(), which already carries
 * the triad (failure!=empty accounting, capped backoff+jitter, durable retirement,
 * cursor advances only past persisted messages). This scheduler only decides WHEN
 * an org is due; it never re-implements retry. Timers are .unref()'d so they never
 * hold the process open, and it is DARK by default (no timer unless the master
 * flag is set), so a container restart cannot re-arm a wedge.
 */

const { syncAccount: syncAccountImpl, backfillAccount: backfillAccountImpl, reconcileAccountFolders: reconcileAccountFoldersImpl, reconcileAccountPresence: reconcileAccountPresenceImpl } = require('./syncWorker');
const store = require('./store');

const DEFAULT_WARMUP_MS = 60 * 1000;      // let the collector finish booting first
const BASE_TICK_MS = 5 * 60 * 1000;       // check which orgs are due every 5 min

/**
 * @param {object} deps
 * @param {Function} deps.resolveCredential async (account) -> creds
 * @param {Function} deps.fetchSince
 * @param {Function} deps.classify
 * @param {Function} [deps.llm]        flat llm(msg) fn — used when llmForOrg is absent
 * @param {Function} [deps.llmForOrg]  (orgId) -> llm(msg) fn — selectable classifier
 *                                     model (cost control): built fresh per org so the
 *                                     org's inboxq_settings.classifier_model is honoured.
 *                                     Takes precedence over the flat deps.llm when present.
 * @param {Function} [deps.now]  () -> ms (injectable clock for tests)
 * @param {Function} [deps.logger]
 */
function createInboxqScheduler(deps = {}) {
  const { resolveCredential, fetchSince, classify, llm: baseLlm = null, llmForOrg = null } = deps;
  const syncAccount = deps.syncAccount || syncAccountImpl; // injectable for tests
  const backfillAccount = deps.backfillAccount || backfillAccountImpl; // injectable for tests
  const reconcileAccountFolders = deps.reconcileAccountFolders || reconcileAccountFoldersImpl; // injectable for tests
  const reconcileAccountPresence = deps.reconcileAccountPresence || reconcileAccountPresenceImpl; // injectable for tests
  const now = deps.now || (() => Date.now());
  const log = deps.logger || ((m) => console.log(m));
  const lastRun = new Map(); // orgId -> ms of last run
  let warmup = null;
  let timer = null;
  let ticking = false; // in-flight guard (#9): never overlap two ticks

  // LUCID liveness for the `inboxq` feed. This is the loop that actually syncs mail, so the beat lives HERE
  // (runSyncTick is not what the collector runs). One beat per org per due run; ttl covers two intervals so a
  // stalled scheduler reads as silent, a failing one as failing. Never throws into the sync.
  function heartbeat(org, extra) {
    try {
      const ttl = Math.max(5, org.syncIntervalMin || 15) * 60 * 2 + 300;
      require('../lucid/emit.js').emit({ org_id: org.orgId, kind: 'heartbeat', ttl_s: ttl, source: { surface: 'inboxq', feed: 'inboxq' }, ...extra });
    } catch { /* LUCID must never break mail sync */ }
  }

  async function tick() {
    // A slow tick must not have a second tick fire on top of it — overlapping
    // runs would double-process accounts and race cursor/failure updates.
    if (ticking) return { skipped: 'in_flight' };
    ticking = true;
    try {
      let orgs = [];
      try {
        orgs = store.listSyncEnabledOrgs();
      } catch (e) {
        // A store-read failure is a real fault, not "0 orgs due" — surface it so
        // a down dependency cannot hide behind a silent empty tick (#8).
        log(`[inboxq] scheduler: listSyncEnabledOrgs failed: ${e?.message || e}`);
        return { orgs: 0, synced: 0, failed: 0, error: 'orgs_read_failed' };
      }
      let synced = 0;
      let failed = 0;
      for (const org of orgs) {
        const intervalMs = Math.max(5, org.syncIntervalMin || 15) * 60 * 1000;
        const last = lastRun.get(org.orgId) || 0;
        if (now() - last < intervalMs) continue; // not due yet
        lastRun.set(org.orgId, now());
        let accounts = [];
        try {
          accounts = store.listAccounts(org.orgId, { includeDisabled: false });
        } catch (e) {
          log(`[inboxq] scheduler: listAccounts failed for org ${org.orgId}: ${e?.message || e}`);
          failed += 1;
          heartbeat(org, { error: 'could not read the mailbox list' });
          continue;
        }
        const budget = { remaining: org.llmBudgetPerTick ?? 25 };
        let acctFailed = 0;
        const llm = typeof llmForOrg === 'function' ? llmForOrg(org.orgId) : baseLlm;
        for (const account of accounts) {
          try {
            // INBOXQ folder auto-discovery (owner 2026-10-05): mirror every server
            // folder before syncing, so the forward sync + backfill cover the WHOLE
            // mailbox, not just INBOX. Isolated try/catch (a discovery fault must
            // never break the sync); updates account.folders in place for this pass.
            try {
              const disc = await reconcileAccountFolders({ store, account, resolveCredential });
              if (disc && Array.isArray(disc.folders)) account.folders = disc.folders;
            } catch (e) {
              log(`[inboxq] scheduler: reconcileAccountFolders threw for ${account.id}: ${e?.message || e}`);
            }
            const res = await syncAccount({ store, account, resolveCredential, fetchSince, classify, llm, budget, now: now() });
            // Count a real sync only when at least one folder actually synced; an
            // all-failed or all-skipped account is not a success (#8). The triad
            // in syncAccount already records each folder's failure durably.
            const folders = Array.isArray(res?.folders) ? res.folders : [];
            const okFolders = folders.filter((f) => !f.failed && !f.skipped).length;
            const failFolders = folders.filter((f) => f.failed).length;
            if (okFolders > 0) synced += 1;
            else if (failFolders > 0) { failed += 1; acctFailed += 1; }

            // INBOXQ full-import (owner 2026-10-05): after the forward sync has
            // seeded each folder's newest window, run ONE bounded backfill pass
            // to index older mail downward (envelope-only, no LLM). Isolated in
            // its own try/catch — a backfill fault must never break the forward
            // sync tick, and it consumes no LLM budget (import != process).
            try {
              await backfillAccount({ store, account, resolveCredential, now: now() });
            } catch (e) {
              log(`[inboxq] scheduler: backfillAccount threw for ${account.id}: ${e?.message || e}`);
            }

            // INBOXQ reverse-reflection (owner 2026-10-05): mirror external deletes/
            // moves/read-state back into the store. Isolated try/catch + bounded +
            // throttled inside reconcileAccountPresence — never breaks the tick.
            try {
              await reconcileAccountPresence({ store, account, resolveCredential, now: now() });
            } catch (e) {
              log(`[inboxq] scheduler: reconcileAccountPresence threw for ${account.id}: ${e?.message || e}`);
            }
          } catch (e) {
            failed += 1; acctFailed += 1;
            log(`[inboxq] scheduler: syncAccount threw for ${account.id}: ${e?.message || e}`);
          }
        }
        heartbeat(org, accounts.length > 0 && acctFailed === accounts.length
          ? { error: `all ${accounts.length} mailbox${accounts.length === 1 ? '' : 'es'} failed to sync` } : {});
      }
      return { orgs: orgs.length, synced, failed };
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (process.env.INBOXQ_SYNC_ENABLED !== '1') {
      log('[inboxq] scheduler DARK (INBOXQ_SYNC_ENABLED != 1); manual sync only');
      return;
    }
    warmup = setTimeout(() => {
      tick().catch(() => {});
      timer = setInterval(() => { tick().catch(() => {}); }, BASE_TICK_MS);
      if (timer.unref) timer.unref();
    }, DEFAULT_WARMUP_MS);
    if (warmup.unref) warmup.unref();
    log('[inboxq] scheduler armed (master on; per-org inboxq_settings gates each run)');
  }

  function stop() {
    if (warmup) clearTimeout(warmup);
    if (timer) clearInterval(timer);
    warmup = null;
    timer = null;
  }

  return { start, stop, tick, _lastRun: lastRun };
}

module.exports = { createInboxqScheduler, BASE_TICK_MS };
