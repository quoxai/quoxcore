'use strict';

/**
 * InboxQ sync worker — the durable IMAP poll loop.
 *
 * MANDATORY loop triad (repo CLAUDE.md, 2026-08-30 CPU incident sweep; same
 * shape as xInboundPoller.js / xScheduledPublish.js):
 *
 *  1. Failure counting DISTINCT from empty results. A fetch that THROWS
 *     (network, auth, credential-resolve) increments the folder's
 *     consecutive_failures. A successful fetch that returns ZERO new messages
 *     is NOT a failure — it clears the streak. Conflating the two would hide a
 *     dead credential behind an honest-looking "0 new" line forever.
 *  2. Capped backoff on failure. A failed folder is not retried until
 *     next_attempt_at, computed as a capped exponential (with jitter) of the
 *     failure streak. A success clears the streak and next_attempt_at.
 *  3. Durable retirement. (a) A folder that fails RETIRE_AFTER times in a row
 *     is marked retired and skipped until a human re-enables it — no infinite
 *     re-attempt. (b) The UID cursor (last_seen_uid) advances ONLY to the
 *     highest UID that was actually persisted this pass, so a mid-pass failure
 *     never silently loses a message; it is re-fetched (and de-duped by the
 *     store's UNIQUE(account,folder,uid)) next pass.
 *
 * No browser timers (server-side only). The scheduler is DARK by default: no
 * timer is created unless sync is enabled (env dev-switch today; a governed
 * org-scoped Settings toggle is the GA surface — see SURFACED note below).
 */

const { moveMessages, indexOlder: indexOlderImpl, INDEX_BATCH, listFoldersDetailed: listFoldersDetailedImpl, fetchFolderState: fetchFolderStateImpl } = require('./imap');

// INBOXQ full-import backfill (owner 2026-10-05): bounded batches per scheduler
// tick so a large mailbox is indexed over time without ever running a tight
// loop (the CPU-incident lesson). The scheduler paces ticks; this just caps how
// much one tick does.
const BACKFILL_BATCHES_PER_TICK = 3;
// INBOXQ reverse-reflection: cap FETCH-FLAGS reconciles per account per tick, and
// don't re-reconcile a folder more often than this (reflection latency, not real-
// time — a tidy in Apple Mail shows in InboxQ within ~a tick or two).
const RECONCILE_FOLDERS_PER_TICK = 3;
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;
// Loop-triad (2026-08-30 CPU incident): the per-message classify loop can run a
// long stretch fully synchronously (reputation/rule fast-paths take no await and
// better-sqlite3 inserts block), so a big mailbox would hold the shared event
// loop for the whole batch — the collector "froze" symptom. Yield to the event
// loop every this-many processed messages so other collector requests breathe.
const EVENT_LOOP_YIELD_EVERY = 25;
const { findMatchingRule } = require('./rules');

// Capped exponential backoff in minutes, indexed by (failure streak - 1).
const BACKOFF_MINUTES = [1, 5, 15, 30, 60];
const RETIRE_AFTER = 8; // consecutive failures before a folder is retired
// A COLD START (no cursor yet) seeds a bigger window than an incremental poll:
// on a real inbox a 200-message first pull feels empty. This is a STOPGAP — the
// real fix for large mailboxes is paginated "load older" backfill (on the plan),
// not an ever-larger single fetch. Kept a plain constant (no env/Settings knob)
// until the backfill work gives it a proper home.
const COLD_START_LIMIT = 500;

function computeBackoffMinutes(streak) {
  const idx = Math.min(Math.max(streak, 1) - 1, BACKOFF_MINUTES.length - 1);
  return BACKOFF_MINUTES[idx];
}

function withJitterIso(baseMinutes, nowMs) {
  // +/- up to 20% jitter so a fleet of folders does not thundering-herd.
  const jitter = 1 + ((deterministicRandom(nowMs) - 0.5) * 0.4);
  const ms = baseMinutes * 60 * 1000 * jitter;
  return new Date(nowMs + ms).toISOString();
}

// Date.now-seeded pseudo-random usable inside deterministic tests via `now`.
function deterministicRandom(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

/**
 * Sync a single account across all its folders. Pure orchestration over
 * injected deps so it is fully testable without a real IMAP server.
 *
 * @param {object} deps
 * @param {object} deps.store          the inboxq store module
 * @param {object} deps.account        hydrated account row
 * @param {Function} deps.resolveCredential async (account) -> {imap_host, imap_port, username, password}
 * @param {Function} deps.fetchSince   async ({...}) -> {uidvalidity, highestUid, reset, messages}
 * @param {Function} deps.classify     async (msg, opts) -> {zone, flags, by}
 * @param {Function} [deps.llm]        optional llm classifier
 * @param {object}   [deps.budget]     { remaining } per-run LLM budget
 * @param {number}   [deps.limit=200]  max messages per folder per pass
 * @param {Function} [deps.onWatchHit] async (account, msg) -> void
 * @param {Function} [deps.moveMessages] async ({...}) -> {moved} — the real
 *   IMAP UID move imap.js exports; test seam for the P3 rules engine's
 *   'move' action (defaults to the real imap.js moveMessages).
 * @param {number}   [deps.now]        injectable clock (ms) for tests
 * @returns {Promise<{accountId, folders: Array, llmCalls:number}>}
 */
async function syncAccount(deps) {
  const {
    store, account, resolveCredential, fetchSince, classify,
    llm = null, budget = null, limit = 200, onWatchHit = null,
    now = Date.now(),
  } = deps;
  const orgId = account.orgId;
  const folders = Array.isArray(account.folders) && account.folders.length ? account.folders : ['INBOX'];
  const results = [];
  const startingBudget = budget ? budget.remaining : 0;

  // codex F14: watches were accepted by the store but never matched on the real
  // sync path (hSync passed no onWatchHit). Load the account's active watches
  // once and match each newly-ingested message against them here, so a watch is
  // functional out of the box. onWatchHit stays as an optional extra sink.
  const activeWatches = store.listWatches(orgId, { activeOnly: true })
    .filter((w) => !w.accountId || w.accountId === account.id);

  // P3 rules engine: the account's enabled auto-sort rules, evaluated
  // highest-priority-first (store.listRules' order) against every freshly
  // ingested message below. Loaded once per account, same shape as
  // activeWatches above.
  const activeRules = store.listRules(orgId, account.id).filter((r) => r.enabled);

  // P3 physical filing engine: OFF by default, org-scoped opt-in
  // (inboxq_settings.physical_filing_enabled — same shape as
  // syncEnabled/classifierModel). Loaded once per account; when disabled,
  // sync behaviour is completely unchanged (no moves are ever queued).
  const filingEnabled = Boolean(store.getSettings(orgId).physicalFilingEnabled);

  // codex F09: determine which folders are eligible (not retired, not inside a
  // backoff window) BEFORE decrypting the credential. If none can run, skip the
  // vault decrypt entirely so repeated /sync on a fully-retired/backed-off
  // account cannot keep hitting the vault. (A durable per-account lease to stop
  // concurrent /sync racing the failure counters is a separate, deferred fix.)
  const eligible = folders.filter((folder) => {
    const st = store.getFolderState(orgId, account.id, folder);
    if (!st) return true;
    if (st.retired) return false;
    if (st.next_attempt_at && new Date(st.next_attempt_at).getTime() > now) return false;
    return true;
  });
  if (eligible.length === 0) {
    for (const folder of folders) {
      const st = store.getFolderState(orgId, account.id, folder) || {};
      results.push({ folder, skipped: st.retired ? 'retired' : 'backoff', nextAttemptAt: st.next_attempt_at || null });
    }
    return { accountId: account.id, folders: results, llmCalls: 0 };
  }

  // Resolve the credential ONCE per account. A resolve failure fails every
  // folder this pass (all get a backoff bump) rather than hammering auth.
  let cred = null;
  let credError = null;
  try {
    cred = await resolveCredential(account);
    if (!cred || !cred.imap_host || !cred.username || !cred.password) {
      credError = 'credential_incomplete';
    }
  } catch (e) {
    credError = 'credential_resolve_failed';
  }

  for (const folder of folders) {
    const state = store.getFolderState(orgId, account.id, folder) || {};
    if (state.retired) {
      results.push({ folder, skipped: 'retired' });
      continue;
    }
    if (state.next_attempt_at && new Date(state.next_attempt_at).getTime() > now) {
      results.push({ folder, skipped: 'backoff', nextAttemptAt: state.next_attempt_at });
      continue;
    }

    if (credError) {
      recordFailure(store, orgId, account.id, folder, state, credError, now);
      results.push({ folder, failed: true, error: credError });
      continue;
    }

    try {
      const res = await fetchSince({
        host: cred.imap_host,
        port: cred.imap_port,
        user: cred.username,
        pass: cred.password,
        folder,
        sinceUid: state.last_seen_uid || 0,
        expectedUidvalidity: state.uidvalidity || null,
        // Cold start (no cursor): seed the bigger newest window; thereafter poll
        // incrementally at the normal limit.
        limit: (state.last_seen_uid || 0) === 0 ? Math.max(limit, COLD_START_LIMIT) : limit,
      });

      // codex F03: UIDVALIDITY changed => the old generation's UIDs are unrelated
      // to the new ones. Clear the old rows BEFORE ingesting, or INSERT OR IGNORE
      // collides on (account,folder,uid) and silently drops the new-generation
      // message while the cursor advances past it (proven data loss).
      if (res.reset) {
        store.deleteFolderMessages(orgId, account.id, folder);
      }

      // Durable cursor: process oldest-first, advance only past persisted msgs.
      const ordered = [...(res.messages || [])].sort((a, b) => a.uid - b.uid);
      let persistedHighUid = res.reset ? 0 : (state.last_seen_uid || 0);
      let inserted = 0;
      // P3 rules engine: a 'move' rule's target folder is resolved once per
      // distinct targetFolder value this pass (not per message) and queued
      // here; the real IMAP moves run AFTER the loop, once the messages are
      // durably stored (see "Rule-engine 'move' action" below).
      const pendingMoves = []; // { id, uid, targetPath }
      const folderRefCache = new Map();
      let processedInFolder = 0;
      for (const m of ordered) {
        // Sender-reputation fast path (INBOXQ_CLASSIFIER_IMPROVEMENTS.md §3.1):
        // consulted BEFORE the rules engine / content rules / LLM. Priority
        // order (repo brief): trusted > rule > reputation-block > classify.
        const repVerdict = store.getReputationVerdict(orgId, { accountId: account.id, fromAddr: m.fromAddr });
        let cls;
        let matchedRule = null;
        if (repVerdict.verdict === 'focus') {
          // Trusted-sender allow (store.markSenderTrusted) wins over
          // EVERYTHING below it, including a rule that would screen/block/
          // move this sender's mail — an explicit human trust decision must
          // never be silently overridden by a rule.
          // confidence: 0.95, mirroring getReputationVerdict's own trusted
          // tier — carried through mainly for shape-consistency with every
          // other cls below; zone 'focus' is never confidence-gated (see
          // store.zoneToFolder), so this value has no filing effect.
          cls = { zone: repVerdict.verdict, flags: [], by: 'reputation', confidence: repVerdict.confidence };
        } else {
          matchedRule = findMatchingRule(activeRules, m);
          if (matchedRule && matchedRule.action === 'block') {
            // Rule errors must never break ingestion — best-effort, isolated.
            try { store.markBlocked({ orgId, accountId: account.id, target: m.fromAddr, type: 'sender' }); } catch { /* non-fatal */ }
            // confidence: 1 — an explicit, human-authored rule match is the
            // most certain signal this pipeline has (shape-consistency only;
            // zone 'screened' is confidence-independent in zoneToFolder).
            cls = { zone: 'screened', flags: [], by: 'rule', confidence: 1 };
          } else if (matchedRule && matchedRule.action === 'screen') {
            cls = { zone: 'screened', flags: [], by: 'rule', confidence: 1 };
          } else {
            // No rule matched, OR the matched rule is a 'move' (which never
            // overrides the zone — it only queues a physical relocation
            // after insert, below). Falls through to the reputation-block
            // verdict, then classify() — the folder is a first-class
            // classification signal (INBOX.Spam -> screened) and fetchSince's
            // message objects do NOT carry it, so it MUST be threaded in
            // here — omitting it silently disables the folder rule for every
            // message (caught live on hottubshampshire: 28 Spam msgs
            // classified as focus because folder defaulted to INBOX).
            cls = repVerdict.verdict
              ? { zone: repVerdict.verdict, flags: [], by: 'reputation', confidence: repVerdict.confidence }
              : await classify({ ...m, folder }, { llm, budget });
          }
        }
        // Generated up front (rather than left to insertMessage's internal
        // default) so a matched 'move' rule can queue the physical relocation
        // against the real stored row id below.
        const msgId = store.generateId('inbmsg');
        const ok = store.insertMessage({
          id: msgId,
          orgId,
          accountId: account.id,
          folder,
          uid: m.uid,
          messageId: m.messageId,
          fromAddr: m.fromAddr,
          fromName: m.fromName,
          subject: m.subject,
          dateTs: m.dateTs,
          snippet: m.snippet,
          bodyHtml: m.bodyHtml,
          bodyText: m.bodyText,
          attachments: m.attachments,
          security: m.security,
          phishingRisk: m.phishingRisk,
          labels: m.labels,     // Gmail X-GM-LABELS (null on non-Gmail)
          gmailId: m.gmailId,   // Gmail X-GM-MSGID (null on non-Gmail)
          seen: m.seen,         // \Seen read-state captured at sync time
          zone: cls.zone,
          flags: cls.flags,
          classifiedBy: cls.by,
          confidence: cls.confidence,
        });
        if (ok) {
          inserted += 1;
          // ContactsQ P3b: inbound touchpoint when the sender is a known contact. Fail-soft and
          // synchronous-cheap (cached in-process resolve); never throws into the sync loop. Forward sync only:
          // the historical backfill below deliberately writes none.
          try { require('../contactsq/identityShim.js').recordInbound(orgId, { fromAddr: m.fromAddr, messageId: msgId, dateTs: m.dateTs }); } catch { /* ContactsQ must never break ingestion */ }
          // Feed the reputation table from this ingest: the junk-folder /
          // classifier-verdict ground truth (§3.2.1). Best-effort — a
          // reputation write failure must never break ingestion.
          try {
            store.bumpReputation({
              orgId, accountId: account.id, fromAddr: m.fromAddr,
              zone: cls.zone, folder, hasListUnsub: Boolean(m.hasListUnsub),
            });
          } catch { /* non-fatal */ }
          // Rule-engine 'move' action: resolve+cache the target folder and
          // queue a real IMAP move. A folder reference that no longer
          // resolves (deleted/renamed) is silently skipped for this message —
          // a rule error must never break ingestion.
          if (matchedRule && matchedRule.action === 'move') {
            try {
              let targetFolder = folderRefCache.get(matchedRule.targetFolder);
              if (targetFolder === undefined) {
                targetFolder = store.resolveFolderRef(orgId, account.id, matchedRule.targetFolder);
                folderRefCache.set(matchedRule.targetFolder, targetFolder);
              }
              if (targetFolder) {
                pendingMoves.push({ id: msgId, uid: m.uid, targetPath: targetFolder.imapPath, kind: 'rule' });
              }
            } catch { /* non-fatal */ }
          } else if (filingEnabled) {
            // P3 physical filing: a rule 'move' (above) always WINS over the
            // zone map — a message a rule explicitly claimed is never also
            // queued for a filing move. Otherwise, confidence-gate the
            // FINAL zone this message actually landed in (cls.zone/
            // cls.confidence, after trusted/rule/reputation/classify all had
            // their say) into a real InboxQ/* folder. Resolution+caching
            // mirrors the rule-move block above; a target that does not
            // resolve (filing was never enabled via /filing/enable, so the
            // folders were never created/synced) is silently skipped for
            // this message — filing errors must never break ingestion.
            try {
              const filingTarget = store.zoneToFolder(cls.zone, cls.confidence);
              if (filingTarget) {
                let targetFolder = folderRefCache.get(filingTarget);
                if (targetFolder === undefined) {
                  targetFolder = store.resolveFolderRef(orgId, account.id, filingTarget);
                  folderRefCache.set(filingTarget, targetFolder);
                }
                if (targetFolder) {
                  pendingMoves.push({ id: msgId, uid: m.uid, targetPath: targetFolder.imapPath, kind: 'filing' });
                }
              }
            } catch { /* non-fatal */ }
          }
        }
        // Watches fire on ingest (dedup: only a newly-inserted message fires).
        let watchedHit = false;
        if (ok && activeWatches.length) {
          for (const w of activeWatches) {
            if (watchMatches(w.match, { ...m, zone: cls.zone })) {
              watchedHit = true;
              try { store.recordWatchHit(orgId, w.id); } catch { /* non-fatal */ }
            }
          }
        }
        if (ok) {
          try { require('../lucid/emit.js').emailEvent(orgId, { id: msgId, folder, m, cls, watched: watchedHit }); } catch { /* LUCID must never break ingestion */ }
        }
        if (ok && onWatchHit) {
          try { await onWatchHit(account, { ...m, zone: cls.zone, flags: cls.flags }); } catch { /* watch failure never breaks sync */ }
        }
        // The message is now durably stored (or already was) -> safe to advance.
        if (m.uid > persistedHighUid) persistedHighUid = m.uid;
        // Yield to the event loop periodically (see EVENT_LOOP_YIELD_EVERY): the
        // paths above are largely synchronous, so without this a large batch
        // starves every other collector request until the folder is done.
        if ((++processedInFolder % EVENT_LOOP_YIELD_EVERY) === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      // Rule-engine 'move' action + P3 physical filing: run the queued real
      // IMAP moves for this folder pass now that every message above is
      // durably stored, grouped by target path so one target's failure (bad
      // credential, deleted mailbox) is isolated from the rest. This never
      // affects the cursor — persistedHighUid was already computed above
      // independent of move outcome — and a failure here is swallowed, never
      // thrown: neither a rule error nor a filing error may break ingestion.
      // ruleMoved/filingMoved are counted separately (by each item's `kind`)
      // even though both share one execution pass, so callers/tests can tell
      // "the spamfilter-blocker rule moved N" from "physical filing moved M"
      // without one silently inflating the other's metric.
      let ruleMoved = 0;
      let filingMoved = 0;
      if (pendingMoves.length && cred) {
        const doMove = deps.moveMessages || moveMessages;
        const byTarget = new Map();
        for (const pm of pendingMoves) {
          if (!byTarget.has(pm.targetPath)) byTarget.set(pm.targetPath, []);
          byTarget.get(pm.targetPath).push(pm);
        }
        for (const [targetPath, items] of byTarget) {
          try {
            const uids = items.map((i) => i.uid);
            const moveRes = await doMove({
              host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password,
              folder, uids, targetPath,
            });
            for (const item of items) {
              // AQ-9E P1 (move-identity fix): the destination uid from the
              // server's COPYUID mapping, or null when unresolved — NEVER
              // the stale source uid, which would address the WRONG message
              // once the item lives in targetPath.
              const destUid = moveRes && moveRes.uidMap ? moveRes.uidMap[String(item.uid)] : undefined;
              const resolvedUid = Number.isFinite(Number(destUid)) ? Number(destUid) : null;
              store.updateMessageFolder(orgId, item.id, { folder: targetPath, uid: resolvedUid, uidvalidity: (moveRes && moveRes.destUidValidity) || null });
              if (item.kind === 'filing') filingMoved += 1; else ruleMoved += 1;
            }
          } catch { /* this target's move failed — isolated, other targets still tried */ }
        }
      }

      // SUCCESS (including 0 new): clear the failure streak, advance cursor.
      store.upsertFolderState(orgId, account.id, folder, {
        uidvalidity: res.uidvalidity || state.uidvalidity || null,
        last_seen_uid: persistedHighUid,
        last_sync_at: new Date(now).toISOString(),
        consecutive_failures: 0,
        next_attempt_at: null,
        backoff_stage: 0,
        last_error: null,
      });
      results.push({ folder, new: inserted, reset: Boolean(res.reset), ruleMoved, filingMoved });
    } catch (e) {
      recordFailure(store, orgId, account.id, folder, state, 'fetch_failed', now);
      results.push({ folder, failed: true, error: 'fetch_failed' });
    }
  }

  const llmCalls = budget ? Math.max(0, startingBudget - budget.remaining) : 0;
  return { accountId: account.id, folders: results, llmCalls };
}

/**
 * Match a message against a watch's match spec. Supported keys (all optional,
 * ANDed, case-insensitive substring): from, subject, zone (exact). An empty
 * spec never matches (avoids a watch that fires on everything by accident).
 */
function watchMatches(match, msg) {
  if (!match || typeof match !== 'object') return false;
  const keys = Object.keys(match).filter((k) => match[k] != null && match[k] !== '');
  if (keys.length === 0) return false;
  const lc = (s) => (s || '').toString().toLowerCase();
  for (const k of keys) {
    const want = lc(match[k]);
    if (k === 'from') { if (!lc(msg.fromAddr).includes(want) && !lc(msg.fromName).includes(want)) return false; }
    else if (k === 'subject') { if (!lc(msg.subject).includes(want)) return false; }
    else if (k === 'zone') { if (lc(msg.zone) !== want) return false; }
    else return false; // unknown key => do not match (fail closed)
  }
  return true;
}

function recordFailure(store, orgId, accountId, folder, state, errorCode, now) {
  const streak = (state.consecutive_failures || 0) + 1;
  const retired = streak >= RETIRE_AFTER ? 1 : 0;
  const backoffMin = computeBackoffMinutes(streak);
  store.upsertFolderState(orgId, accountId, folder, {
    consecutive_failures: streak,
    backoff_stage: Math.min(streak, BACKOFF_MINUTES.length),
    next_attempt_at: withJitterIso(backoffMin, now),
    retired,
    // Store an error CODE only — never a raw error object that could carry
    // credential material or PII.
    last_error: errorCode,
  });
}

/**
 * Run one sync tick across every pollable account in the store (all orgs).
 * failure/empty accounting is per-folder inside syncAccount; this just fans out.
 */
async function runSyncTick(deps) {
  const { store, perTickLlmBudget = 25 } = deps;
  const accounts = store.listAllPollableAccounts();
  const budget = { remaining: perTickLlmBudget };
  const summaries = [];
  for (const account of accounts) {
    try {
      const s = await syncAccount({ ...deps, account, budget });
      summaries.push(s);
    } catch (e) {
      // syncAccount already contains per-folder try/catch; a throw here is
      // unexpected — record it against the account but never stop the tick.
      summaries.push({ accountId: account.id, error: 'account_sync_crashed' });
    }
  }
  return { accounts: accounts.length, summaries };
}

/**
 * INBOXQ full-import backfill (owner 2026-10-05). The forward sync (syncAccount)
 * seeds the newest COLD_START_LIMIT messages and then ingests only NEW mail — so
 * a large existing mailbox never mirrored reality. backfillAccount walks each
 * folder's UID space DOWNWARD below what forward sync has stored, envelope-only
 * (via indexOlder), inserting lightweight UNPROCESSED rows (zone:null, no body,
 * no classifier, no LLM budget touched). IMPORT is decoupled from PROCESS: these
 * rows are immediately visible/searchable/movable; body + zone come later from a
 * separate bounded pass.
 *
 * Loop-triad discipline (the 2026-08-30 CPU incident): BOUNDED batches per tick
 * (no tight loop — the scheduler paces ticks); a durable per-folder floor cursor
 * so work is never re-done; failure is SURFACED, never swallowed into a false
 * "done"; retired/complete folders are skipped. Terminates when indexOlder
 * reports reachedBottom.
 *
 * @param {object} deps
 * @param {object} deps.store            the inboxq store (needs getFolderState,
 *   lowestIndexedUid, setBackfillFloor, setBackfillDone, insertMessage)
 * @param {object} deps.account          hydrated account row
 * @param {Function} deps.resolveCredential async (account) -> cred
 * @param {Function} [deps.indexOlder]    test seam (defaults to imap.indexOlder)
 * @param {number}   [deps.batchesPerTick]
 * @param {number}   [deps.batchSize]
 * @param {number}   [deps.now]
 * @returns {Promise<{accountId, indexed:number, folders:Array}>}
 */
async function backfillAccount(deps) {
  const {
    store, account, resolveCredential,
    indexOlder = indexOlderImpl,
    batchesPerTick = BACKFILL_BATCHES_PER_TICK,
    batchSize = INDEX_BATCH,
  } = deps;
  const orgId = account.orgId;
  const folders = Array.isArray(account.folders) && account.folders.length ? account.folders : ['INBOX'];

  let cred;
  try {
    cred = await resolveCredential(account);
  } catch {
    return { accountId: account.id, indexed: 0, error: 'credential_resolve_failed', folders: [] };
  }
  if (!cred || !cred.imap_host || !cred.username || !cred.password) {
    return { accountId: account.id, indexed: 0, error: 'credential_incomplete', folders: [] };
  }

  let totalIndexed = 0;
  const perFolder = [];
  // Per-ACCOUNT batch budget shared across folders. With folder auto-discovery an
  // account can have many folders; capping per-folder would let folder count
  // multiply the per-tick IMAP load. Instead the WHOLE account does at most
  // `batchesPerTick` envelope fetches per tick, spent folder-by-folder — so a
  // 2-folder and a 20-folder account cost the same per tick (it just takes more
  // ticks to finish the big one). Keeps every tick bounded regardless of shape.
  let budget = batchesPerTick;
  for (const folder of folders) {
    if (budget <= 0) { perFolder.push({ folder, skipped: 'tick_budget_spent' }); continue; }
    const state = store.getFolderState(orgId, account.id, folder) || {};
    if (state.backfill_done) { perFolder.push({ folder, done: true }); continue; }
    if (state.retired) { perFolder.push({ folder, skipped: 'retired' }); continue; }

    // Floor = the lowest UID already indexed; we only ever backfill BELOW it.
    // A folder with nothing stored yet must be seeded by the forward sync first
    // (which grabs the newest window) — we don't start backfill from thin air.
    let floor = (state.backfill_floor_uid != null && Number(state.backfill_floor_uid) > 0)
      ? Number(state.backfill_floor_uid)
      : store.lowestIndexedUid(orgId, account.id, folder);
    if (floor == null) { perFolder.push({ folder, skipped: 'awaiting_forward_seed' }); continue; }
    if (floor <= 1) { store.setBackfillDone(orgId, account.id, folder); perFolder.push({ folder, done: true }); continue; }

    let indexedThisFolder = 0;
    let outcome = { folder, done: false, indexed: 0, floor };
    while (budget > 0) {
      budget -= 1;
      let res;
      try {
        res = await indexOlder({
          host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password,
          folder, belowUid: floor, limit: batchSize,
        });
      } catch (e) {
        // Surface, do NOT mark done. Leave the cursor; the next tick retries.
        // One failed batch ends THIS folder's backfill for THIS tick — the
        // scheduler's cadence is the backoff, so there is no tight retry loop.
        outcome = { folder, failed: true, error: e && e.message ? e.message : String(e), floor };
        break;
      }
      let sinceYield = 0;
      for (const m of res.messages || []) {
        const inserted = store.insertMessage({
          orgId, accountId: account.id, folder,
          uid: m.uid, messageId: m.messageId,
          fromAddr: m.fromAddr, fromName: m.fromName, subject: m.subject,
          dateTs: m.dateTs, snippet: null,
          labels: m.labels,     // Gmail X-GM-LABELS captured during envelope index
          gmailId: m.gmailId,   // Gmail X-GM-MSGID
          zone: null, // IMPORTED, not processed — classification is a separate bounded pass
        });
        if (inserted) { indexedThisFolder++; totalIndexed++; }
        // A backfill batch is up to INDEX_BATCH (1000) synchronous inserts with
        // no await between them; yield periodically so the whole-mailbox import
        // never freezes other collector requests (loop-triad, gap c).
        if ((++sinceYield % EVENT_LOOP_YIELD_EVERY) === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      floor = Number(res.newFloor) || 1;
      store.setBackfillFloor(orgId, account.id, folder, floor);
      if (res.reachedBottom) {
        store.setBackfillDone(orgId, account.id, folder);
        outcome = { folder, done: true, indexed: indexedThisFolder };
        break;
      }
      outcome = { folder, done: false, indexed: indexedThisFolder, floor };
    }
    perFolder.push(outcome);
  }
  return { accountId: account.id, indexed: totalIndexed, folders: perFolder };
}

/**
 * INBOXQ folder auto-discovery (owner 2026-10-05): "sync entire mailboxes" means
 * InboxQ mirrors EVERY folder the server shows, not just INBOX + in-app folders.
 * Lists the account's real server folders and UNIONS any new selectable ones into
 * account.folders so the forward sync + backfill cover them. Idempotent (no-op
 * when nothing new). Never REMOVES a folder (a server folder that briefly fails
 * to list must not silently drop out of sync). Skips \Noselect container folders
 * (unselectable — e.g. Gmail's "[Gmail]" parent). INBOX is always kept.
 *
 * @returns {Promise<{folders?:string[], added?:number, error?:string}>}
 */
async function reconcileAccountFolders(deps) {
  const { store, account, resolveCredential, listFoldersDetailed = listFoldersDetailedImpl } = deps;
  const orgId = account.orgId;
  let cred;
  try { cred = await resolveCredential(account); } catch { return { error: 'credential_resolve_failed' }; }
  if (!cred || !cred.imap_host || !cred.username || !cred.password) return { error: 'credential_incomplete' };

  let serverFolders;
  try {
    serverFolders = await listFoldersDetailed({ host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password });
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
  // GMAIL MODEL (owner 2026-10-05): Gmail has labels, not folders. Every message
  // lives once in [Gmail]/All Mail (specialUse "\All") and appears under its labels
  // as redundant IMAP "folders". Syncing those label-views re-reads the same mail
  // and thrashes each message's folder. So for a Gmail account we sync the ONE
  // canonical archive (All Mail); each message carries its Gmail labels (captured
  // in fetchSince/indexOlder). The inbox is "has the INBOX label" — a view, not a
  // separate copy. (Presenting labels as the folder UI for Gmail is a follow-up.)
  const allMail = (serverFolders || []).find((f) => f && f.path && f.specialUse === '\\All');
  if (allMail) {
    const gmailFolders = [allMail.path];
    const existingG = Array.isArray(account.folders) ? account.folders : [];
    const sameSet = existingG.length === gmailFolders.length && gmailFolders.every((p) => existingG.includes(p));
    if (!sameSet) {
      try { store.updateAccountFolders(orgId, account.id, gmailFolders); } catch { /* non-fatal */ }
    }
    return { folders: gmailFolders, added: sameSet ? 0 : gmailFolders.length, gmail: true };
  }

  const selectable = (serverFolders || [])
    .filter((f) => f && f.path && !(Array.isArray(f.flags) && f.flags.some((fl) => String(fl).toLowerCase() === '\\noselect')))
    .map((f) => f.path);

  const existing = Array.isArray(account.folders) && account.folders.length ? account.folders : ['INBOX'];
  const merged = existing.slice();
  let added = 0;
  for (const p of selectable) {
    if (!merged.includes(p)) { merged.push(p); added += 1; }
  }
  if (!merged.includes('INBOX')) merged.unshift('INBOX');
  if (added > 0) {
    try { store.updateAccountFolders(orgId, account.id, merged); } catch { /* non-fatal: next tick retries */ }
  }
  return { folders: merged, added };
}

/**
 * INBOXQ reverse-reflection (owner 2026-10-05): make InboxQ mirror changes made in
 * OTHER clients. The forward sync only ever ADDS new mail; it never notices a
 * message the user deleted or moved away in Apple Mail/Gmail, nor read/unread
 * changes. This pass reads each folder's CURRENT server state (one cheap FETCH of
 * uid+\Seen, via fetchFolderState) and reconciles the store against it:
 *   - a stored UID no longer on the server -> removed (deleted or moved elsewhere);
 *   - read/unread mirrored from \Seen.
 * Loop-triad: BOUNDED folders per tick, a per-folder throttle (RECONCILE_INTERVAL),
 * failure surfaced not swallowed, retired folders skipped. A UIDVALIDITY change is
 * left to the forward sync's reset path (never diffed across generations).
 *
 * @returns {Promise<{accountId, removed:number, seenChanged:number, folders:Array}>}
 */
async function reconcileAccountPresence(deps) {
  const {
    store, account, resolveCredential,
    fetchFolderState = fetchFolderStateImpl,
    foldersPerTick = RECONCILE_FOLDERS_PER_TICK,
    reconcileIntervalMs = RECONCILE_INTERVAL_MS,
    now = Date.now(),
  } = deps;
  const orgId = account.orgId;
  const folders = Array.isArray(account.folders) && account.folders.length ? account.folders : ['INBOX'];

  let cred;
  try { cred = await resolveCredential(account); } catch { return { accountId: account.id, removed: 0, seenChanged: 0, error: 'credential_resolve_failed', folders: [] }; }
  if (!cred || !cred.imap_host || !cred.username || !cred.password) return { accountId: account.id, removed: 0, seenChanged: 0, error: 'credential_incomplete', folders: [] };

  let budget = foldersPerTick;
  let removedTotal = 0;
  let seenChangedTotal = 0;
  const perFolder = [];
  for (const folder of folders) {
    if (budget <= 0) break;
    const state = store.getFolderState(orgId, account.id, folder) || {};
    if (state.retired) continue;
    if (state.last_reconciled_at && (now - new Date(state.last_reconciled_at).getTime()) < reconcileIntervalMs) continue;
    const stored = store.getFolderUidState(orgId, account.id, folder);
    if (!stored.length) { store.markReconciled(orgId, account.id, folder, new Date(now).toISOString()); continue; }

    budget -= 1;
    let serverState;
    try {
      serverState = await fetchFolderState({ host: cred.imap_host, port: cred.imap_port, user: cred.username, pass: cred.password, folder });
    } catch (e) {
      perFolder.push({ folder, failed: true, error: e && e.message ? e.message : String(e) });
      continue;
    }
    // UIDVALIDITY changed => a different UID generation; the forward sync owns the
    // wipe/resync. Diffing across generations would delete valid mail — skip.
    if (state.uidvalidity && serverState.uidvalidity && state.uidvalidity !== serverState.uidvalidity) {
      perFolder.push({ folder, skipped: 'uidvalidity_changed' });
      continue;
    }
    const serverMap = new Map(serverState.entries.map((e) => [e.uid, e.seen]));
    const toDelete = [];
    const seenUids = [];
    const unseenUids = [];
    for (const s of stored) {
      if (!serverMap.has(s.uid)) { toDelete.push(s.uid); continue; }
      const srvSeen = serverMap.get(s.uid);
      if (srvSeen !== s.seen) (srvSeen ? seenUids : unseenUids).push(s.uid);
    }
    const removed = toDelete.length ? store.deleteMessagesByUids(orgId, account.id, folder, toDelete) : 0;
    const seenChanged = (seenUids.length || unseenUids.length) ? store.setSeenByUids(orgId, account.id, folder, { seenUids, unseenUids }) : 0;
    store.markReconciled(orgId, account.id, folder, new Date(now).toISOString());
    removedTotal += removed;
    seenChangedTotal += seenChanged;
    perFolder.push({ folder, removed, seenChanged });
  }
  return { accountId: account.id, removed: removedTotal, seenChanged: seenChangedTotal, folders: perFolder };
}

module.exports = {
  syncAccount,
  backfillAccount,
  reconcileAccountFolders,
  reconcileAccountPresence,
  runSyncTick,
  computeBackoffMinutes,
  watchMatches,
  BACKOFF_MINUTES,
  BACKFILL_BATCHES_PER_TICK,
  RETIRE_AFTER,
  _deterministicRandom: deterministicRandom,
};
