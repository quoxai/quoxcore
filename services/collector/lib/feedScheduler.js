/**
 * The Feed scheduler — WP2, docs/STREAM_QUOXBRAIN_FEED_PLAN.md.
 *
 * Mirrors dreamScheduler.js's shape (services/quoxbrain/lib/dreamScheduler.js):
 * a warmup setTimeout followed by a recurring setInterval, both `.unref()`'d
 * so they never hold the process open or block a clean shutdown/test exit.
 * Ships dark by default — QUOXFEED_ENABLED must be explicitly 'true' AND
 * QUOXFEED_ORGS must list at least one org id, or startFeedScheduler()
 * schedules nothing and returns immediately.
 *
 * The service just recovered from an event-loop wedge (see plan doc
 * Guardrails) — this scheduler is deliberately best-effort and bounded:
 * every source ingester is called with a per-call batch cap
 * (QUOXFEED_MAX_ITEMS), every ingester call is wrapped in its own
 * try/catch (one source or org failing never blocks any other), and there
 * is no synchronous full-scan anywhere in the tick path.
 *
 * Source registry (dispatch map): SOURCE_INGESTERS maps a source_type to
 * its ingester function. F1 ships `conversation` only
 * (feedConversationSource.ingestConversations); F2 adds host-file sources
 * (transcript, git, automemory) by adding one line here, e.g.
 * `transcript: ingestTranscripts`. `deps.sourceIngesters` overrides the
 * whole map for tests, so no real AEE/brain calls happen under test.
 *
 * Phase C ("connect, don't configure" — docs/STREAM_QUOXBRAIN2_COCKPIT_DESIGN.md):
 * every ingester call is also handed that org's feed_sources.config (parsed
 * JSON, or null if the source has never been configured) as `opts.config`
 * — this is how a user-connected folder path (or any other per-source
 * config) reaches its ingester instead of being read from an env var.
 *
 * Per-(org, source_type) enable/disable is governed by the feed_sources
 * registry (feedWatermark.js) — an autopilot source with no row is
 * enabled by default (the plan's "autopilot sources default-enabled");
 * a row must exist with enabled=0 to actively skip a source. After every
 * ingester call (success or failure) the feed_sources row is upserted with
 * last_sync/last_status/last_count, which doubles as the F4 Settings
 * surface's observability data.
 */

'use strict';

const feedWatermark = require('./feedWatermark.js');
const { ingestConversations } = require('./feedConversationSource.js');
const { ingestTranscripts } = require('./feedTranscriptSource.js');
const { ingestFolder } = require('./feedFolderSource.js');
const { ingestAutoMemory } = require('./feedAutoMemorySource.js');
const { ingestDocs } = require('./feedDocsSource.js');
const { ingestObsidian } = require('./feedObsidianSource.js');
const { ingestFleet } = require('./feedFleetSource.js');
const { ingestMemory } = require('./feedMemorySource.js');
const { ingestWisdom } = require('./feedWisdomSource.js');
const { ingestGitHistory } = require('./feedGitSource.js');
const { ingestEmail } = require('./feedEmailSource.js');
const { ingestRepobrain } = require('./feedRepobrainSource.js');
const { ingestQuoxplan } = require('./feedQuoxplanSource.js');
const { ingestDbSource } = require('./feedDbSource.js');
const { DB_ADAPTER_SPECS } = require('./feedDbAdapters.js');
const { ingestNotion } = require('./feedNotionSource.js');
const { ingestGdrive } = require('./feedGdriveSource.js'); // BRAIN2-OAUTH-GDRIVE
const configResolver = require('./configResolver.js');

// Warmup: first tick fires ~60s after boot (lets the collector finish
// booting/health-checking before The Feed starts doing network/DB work).
const DEFAULT_WARMUP_MS = 60 * 1000;
// Interval: subsequent ticks every 30 minutes.
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
// Per-source batch cap — the bound that keeps every tick's work bounded
// regardless of how much backlog a source has.
const DEFAULT_MAX_ITEMS = 50;
const DEFAULT_QUOXPLAN_MAX_ITEMS = 200;

// INFRA-CPU (2026-08-30 CPU incident sweep): a sweep of this scheduler found
// a permanently-failing source retried at full 30min cadence forever (no
// cooldown/auto-disable), and no timeout around the ingester() call, so one
// wedged source could hang a tick indefinitely. Mirrors 8e1a0958
// (EmbedBackfill) / 88811f7f (ReflectionMining, same collector service).
//
// Every ingester call is bounded to this long — generous vs a typical
// batch-capped call, but well inside the 30min cadence so a wedged source
// can never hang a tick past the next one.
const DEFAULT_INGEST_TIMEOUT_MS = 2 * 60 * 1000;
// Per-(org, source_type) failure-streak cooldown cap. A source that just
// failed is skipped for `min(consecutiveFailures, cap)` ticks; success
// resets the streak. At the 30min default cadence, 4 ticks is a 2h backoff
// ceiling — long enough that a permanently-broken source stops burning a
// tick every 30 minutes, short enough that a source which recovers is
// retried within the same operating day.
const SOURCE_FAILURE_COOLDOWN_CAP_TICKS = 4;
// Whole-tick zero-progress backoff cap (any tick that pushed zero docs
// across every org/source). Same shape and rationale as
// SOURCE_FAILURE_COOLDOWN_CAP_TICKS above, applied at the tick level instead
// of per-source: real progress resets it immediately.
const ZERO_PROGRESS_BACKOFF_CAP_TICKS = 4;

// Dispatch registry: source_type -> ingester(orgId, opts, deps). F2 plugs
// in additional host-file sources by adding entries here (one line each),
// e.g. `transcript: ingestTranscripts`.
//
// L1 db-source adapters (docs/STREAM_QUOXBRAIN2_SOURCE_UNIVERSE.md Wave 2):
// each registered feedDbAdapters.js spec gets its own dispatch entry,
// closing over that one spec and delegating to the shared
// feedDbSource.ingestDbSource reader — no per-source ingester code, only
// the one-line registration below.
const DB_SOURCE_INGESTERS = Object.fromEntries(
  DB_ADAPTER_SPECS.map((spec) => [
    spec.sourceType,
    (orgId, opts, deps) => ingestDbSource(orgId, { ...opts, spec }, deps),
  ])
);

// quox#524: split into a base map (never gated) and the OAuth-only entries,
// so startFeedScheduler() below can rebuild its OWN dispatch map per-org
// (honouring a QUOXFEED_OAUTH_SOURCES_ENABLED org override) without
// touching the exported SOURCE_INGESTERS constant that feedApiHandlers.js
// reads for its catalog — see that export's own comment for why the
// catalog's env-only gating must stay exactly as-is.
const BASE_SOURCE_INGESTERS = {
  conversation: ingestConversations,
  transcript: ingestTranscripts,
  folder: ingestFolder,
  // ONE-BRAIN A3 (QuoxPlan #493): the auto-memory corpus (MEMORY.md + topic
  // files) had no recurring trigger at all — see feedAutoMemorySource.js's
  // header for the root cause. This is the fix: a normal Feed source, same
  // 30min cadence/backoff/cooldown as every other entry in this map.
  automemory: ingestAutoMemory,
  docs: ingestDocs,
  obsidian: ingestObsidian,
  fleet: ingestFleet,
  memory: ingestMemory,
  tasks_execution_wisdom: ingestWisdom,
  git: ingestGitHistory,
  // V2-8: InboxQ mail. Opt-in only (needs config.consent + user scope + owner), see feedEmailSource.js.
  email: ingestEmail,
  repobrain: ingestRepobrain,
  quoxplan: ingestQuoxplan,
  ...DB_SOURCE_INGESTERS,
};

const OAUTH_SOURCE_INGESTERS = { notion: ingestNotion, gdrive: ingestGdrive };

// SOURCE_INGESTERS: the module-load-time snapshot. feedApiHandlers.js's
// LIVE_SOURCE_TYPES derives its 'live' vs 'available' catalog status
// straight from this map's keys — registering notion/gdrive unconditionally
// would flip that catalog to 'live' for a source no deployment has ever
// actually synced (no OAuth app provisioned). This constant stays env-only
// and is ALSO the default startFeedScheduler() falls back to when it has no
// per-org signal to act on (deps.isOauthSourcesEnabledFn not injected, e.g.
// every existing test) — unchanged behaviour for anything not exercising
// the quox#524 per-org override path below.
const SOURCE_INGESTERS = {
  ...BASE_SOURCE_INGESTERS,
  ...(process.env.QUOXFEED_OAUTH_SOURCES_ENABLED === 'true' ? OAUTH_SOURCE_INGESTERS : {}),
};

/**
 * Parses a CSV env var into a clean list (trims whitespace, drops empty
 * entries) — same idiom as dreamScheduler.js's parseOrgIds.
 * @param {string} raw
 * @returns {string[]}
 */
function parseOrgIds(raw) {
  return String(raw || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

// Empty-string env (compose forwards `VAR=` when the host var is unset)
// MUST map to undefined -> fall through to default. Number('') is 0, which
// would wrongly zero out a batch cap or interval — guard empty/null
// explicitly, same as dreamScheduler.js's envNum().
function envNum(v) {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * VAULT-INTEG P13 slice 2: resolves ONE of this scheduler's instance-wide
 * numeric knobs through configResolver.getInstanceSetting() — stored
 * override wins, else env, else the registry's own declared default
 * (platformCapabilities.js) — at CALL TIME, never once at module load or
 * scheduler start. Mirrors resolveOrgConcurrency() in
 * memoryConsolidationScheduler.js / reflectionMiningScheduler.js in this
 * same collector service.
 */
function resolveInstanceNumber(key, fallback) {
  const parsed = Number(configResolver.getInstanceSetting(key).value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * feed_sources.config is stored as a raw JSON TEXT column (feedWatermark.js
 * never parses it) — mirrors feedApiHandlers.js's own safeParseConfig()
 * so a malformed/legacy row degrades to null config rather than throwing
 * and killing the tick for every source after it.
 */
function safeParseConfig(config) {
  if (config === null || config === undefined) return null;
  if (typeof config !== 'string') return config;
  try {
    return JSON.parse(config);
  } catch {
    return null;
  }
}

/**
 * Fresh per-(org, source_type) failure-cooldown + in-flight state. Owned by
 * the caller (startFeedScheduler keeps one across ticks in its closure) so
 * both the failure streak and the in-flight guard survive across calls to
 * runFeedTick — a new Map/Set per tick would forget every failure, and
 * forget any still-running ingest, the instant the tick ended.
 *
 * STABILITY-AUDITS #2: `inFlight` closes the re-entrancy gap withTimeout
 * (below) cannot close on its own — withTimeout races a promise, it does
 * not cancel it, so a wedged ingester call whose promise is still pending
 * when the next tick starts would otherwise both (a) keep consuming
 * whatever it's doing AND (b) be started a second time concurrently for
 * the same (org, source). `inFlight` blocks that re-entry per source.
 * @returns {{failureStreak: Map<string, number>, cooldownTicks: Map<string, number>, inFlight: Set<string>}}
 */
function createCooldownState() {
  return { failureStreak: new Map(), cooldownTicks: new Map(), inFlight: new Set() };
}

/**
 * Races `promise` against a timeout so one wedged ingester call can never
 * hang a tick indefinitely — mirrors reflectionMiningScheduler.js's
 * fetchWithTimeout. Unlike a bare Promise.race, this also aborts `signal`'s
 * controller when the timeout fires: an ingester that threads opts.signal
 * into its own fetch/db calls (see feedFleetSource.js / feedQuoxplanSource.js)
 * gets an actual cancellation, not just an abandoned promise. An ingester
 * that ignores opts.signal degrades to the old behaviour (its promise keeps
 * running in the background, unobserved) — the per-source in-flight guard
 * in runFeedTick is what keeps THAT case from being re-entered next tick.
 */
function withTimeout(promise, ms, label, controller) {
  let timer;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      if (controller && typeof controller.abort === 'function') {
        try { controller.abort(); } catch { /* already aborted */ }
      }
      reject(new Error(`ingest timed out after ${ms}ms${label ? ` (${label})` : ''}`));
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Whether (orgId, sourceType) should run this tick. FAIL CLOSED (BRAIN2-W5
 * 014): a source runs only when the org has an explicit feed_sources row that
 * is not disabled. An absent row means the source is not connected (the API
 * shows it as disconnected/disabled), and a registry read failure must not be
 * read as consent either. Never throws.
 */
function isSourceEnabled(orgId, sourceType, { dbPath, getSourceFn = feedWatermark.getSource } = {}) {
  try {
    const row = getSourceFn(orgId, sourceType, { dbPath });
    if (!row) return false; // not connected -> never ingest
    return row.enabled !== false && row.enabled !== 0;
  } catch (err) {
    console.error(`[Feed] org=${orgId} source=${sourceType}: registry read failed, failing closed (not running) — ${err.message}`);
    return false;
  }
}

/**
 * Runs one Feed tick: for each org, for each registered source, checks the
 * feed_sources registry (default enabled) and the per-(org,source) failure
 * cooldown — if both clear, runs the source's ingester (bounded to maxItems
 * AND to ingestTimeoutMs). Every source's result (success, failure, or
 * timeout) is written back to the feed_sources row so the registry doubles
 * as the observability surface. Never throws.
 *
 * INFRA-CPU (2026-08-30 CPU incident sweep): a permanently-failing source
 * was previously retried at full 30min cadence forever with no cooldown,
 * and the ingester() call had no timeout so a wedged source could hang a
 * tick indefinitely. Both are fixed here, same shape as
 * embeddingBackfillScheduler.js (8e1a0958) / reflectionMiningScheduler.js
 * (88811f7f) in this same collector service:
 *   - cooldownState (createCooldownState()) tracks a consecutive-failure
 *     streak per "orgId::sourceType" key; a streak growing past 0 skips the
 *     source for min(streak, SOURCE_FAILURE_COOLDOWN_CAP_TICKS) ticks. A
 *     success clears the streak entirely (fresh start, not a partial decay).
 *   - every ingester call is raced against ingestTimeoutMs (withTimeout) —
 *     a timeout rejects the same way a thrown error does, so it counts
 *     toward the failure streak and the feed_sources last_status the same
 *     way, and the tick moves on instead of hanging.
 *
 * @returns {{sourcesRun:number, sourcesSkipped:number, sourcesFailed:number, totalDocsPushed:number}}
 */
async function runFeedTick(orgIds, sourceIngesters, {
  maxItems = DEFAULT_MAX_ITEMS,
  dbPath,
  getSourceFn = feedWatermark.getSource,
  upsertSourceFn = feedWatermark.upsertSource,
  ingesterDeps = {},
  cooldownState = createCooldownState(),
  ingestTimeoutMs = DEFAULT_INGEST_TIMEOUT_MS,
  isSourceAllowedFn = null,
  maxItemsBySource = {},
} = {}) {
  let sourcesRun = 0;
  let sourcesSkipped = 0;
  let sourcesFailed = 0;
  let totalDocsPushed = 0;

  for (const orgId of orgIds) {
    for (const [sourceType, ingester] of Object.entries(sourceIngesters)) {
      // BRAIN2-W5 018: per-org dispatch gate (e.g. OAuth sources only for orgs
      // whose own flag resolved on), so one org's flag never activates
      // another org's connected sources.
      if (typeof isSourceAllowedFn === 'function' && !isSourceAllowedFn(orgId, sourceType)) {
        sourcesSkipped++;
        continue;
      }
      if (!isSourceEnabled(orgId, sourceType, { dbPath, getSourceFn })) {
        sourcesSkipped++;
        console.log(`[Feed] org=${orgId} source=${sourceType}: disabled — skipping`);
        continue;
      }

      const cooldownKey = `${orgId}::${sourceType}`;
      const cooldownRemaining = cooldownState.cooldownTicks.get(cooldownKey) || 0;
      if (cooldownRemaining > 0) {
        sourcesSkipped++;
        const nextRemaining = cooldownRemaining - 1;
        if (nextRemaining > 0) cooldownState.cooldownTicks.set(cooldownKey, nextRemaining);
        else cooldownState.cooldownTicks.delete(cooldownKey);
        console.log(`[Feed] org=${orgId} source=${sourceType}: cooling down after repeated failures — skipping (${nextRemaining} tick(s) remaining)`);
        continue;
      }

      // STABILITY-AUDITS #2: per-source in-flight guard. withTimeout below
      // races the ingester's promise against a timeout but cannot cancel an
      // ingester that ignores opts.signal — that promise keeps running in
      // the background. Without this guard, a still-wedged source from a
      // previous tick would be started AGAIN here, doubling up whatever
      // work (and side effects) it's doing. inFlight lives on cooldownState
      // so it survives across ticks the same way the failure streak does.
      if (cooldownState.inFlight.has(cooldownKey)) {
        sourcesSkipped++;
        console.warn(`[Feed] org=${orgId} source=${sourceType}: previous ingest still in flight — skipping this tick (source may be wedged)`);
        continue;
      }

      // Phase C: hand the source's own registry config through to the
      // ingester (config wins over any env-based default — see
      // feedFolderSource.js / feedTranscriptSource.js). A registry read
      // failure here degrades to no config (never blocks the ingester
      // call) — same best-effort contract as isSourceEnabled() above.
      let sourceConfig = null;
      let sourceScope = 'org';
      let sourceOwner = null;
      try {
        const row = getSourceFn(orgId, sourceType, { dbPath });
        sourceConfig = row ? safeParseConfig(row.config) : null;
        // BRAIN2-W5 016: the stored scope is the user's privacy choice; hand it
        // to the ingester instead of letting readers hardcode org scope.
        if (row && typeof row.scope === 'string' && row.scope) sourceScope = row.scope;
        if (row && row.owner_user_id) sourceOwner = row.owner_user_id;
      } catch (err) {
        console.error(`[Feed] org=${orgId} source=${sourceType}: registry read failed (config), proceeding with no config — ${err.message}`);
      }

      let result = null;
      let error = null;
      // STABILITY-AUDITS #2: an AbortController threaded through as
      // opts.signal — abort()'d by withTimeout when the timeout fires so an
      // ingester that honours opts.signal in its own fetch/db calls gets a
      // real cancellation (feedFleetSource.js / feedQuoxplanSource.js do
      // this today; other ingesters may ignore it and fall back to the
      // in-flight guard above for the re-entrancy protection).
      //
      // The in-flight guard is cleared when the INGESTER'S OWN promise
      // settles, not when withTimeout's race settles — those are different
      // moments for an ingester that ignores opts.signal. If cleared on the
      // race instead, a timed-out-but-still-running ingester would look
      // "free" to runFeedTick immediately, defeating the guard's purpose
      // for exactly the case it exists to cover.
      const controller = new AbortController();
      const sourceDeps = sourceOwner ? { ...ingesterDeps, userId: sourceOwner } : ingesterDeps;
      // BRAIN2-W12 B3: a private source with no stored owner (legacy row) must not
      // run silently or fall back to an org vault; surface it in last_status.
      const ownerless = sourceScope === 'user' && !sourceOwner;
      const ingesterPromise = ownerless
        ? Promise.resolve({ skipped: 'private source has no owner, reconnect it' })
        : Promise.resolve()
          .then(() => {
            const cap = maxItemsBySource[sourceType] ?? maxItems;
            return ingester(orgId, { maxConversations: cap, maxItems: cap, config: sourceConfig, scope: sourceScope, signal: controller.signal }, sourceDeps);
          });
      ingesterPromise.catch(() => {}).finally(() => cooldownState.inFlight.delete(cooldownKey));
      cooldownState.inFlight.add(cooldownKey);
      try {
        // maxConversations is feedConversationSource's own batch-cap opt
        // name; F2 sources may need a differently-named opt (documented
        // above the SOURCE_INGESTERS map). maxItems is the generic name
        // newer ingesters (transcript, folder) read. Wrapped in
        // withTimeout so one wedged source can never hang the whole tick.
        result = await withTimeout(ingesterPromise, ingestTimeoutMs, `${orgId}/${sourceType}`, controller);
        sourcesRun++;
      } catch (err) {
        error = err;
        sourcesFailed++;
        console.error(`[Feed] org=${orgId} source=${sourceType}: ingest failed — ${err.message}`);
      }

      const failed = Boolean(error) || Boolean(result?.error);
      if (failed) {
        // A source that RETURNED an error (not thrown) was still a failed run:
        // count it distinctly so the tick log never reads "ok" for it.
        if (!error) sourcesFailed++;
        const streak = (cooldownState.failureStreak.get(cooldownKey) || 0) + 1;
        cooldownState.failureStreak.set(cooldownKey, streak);
        const cooldownTicks = Math.min(streak, SOURCE_FAILURE_COOLDOWN_CAP_TICKS);
        cooldownState.cooldownTicks.set(cooldownKey, cooldownTicks);
        console.warn(`[Feed] org=${orgId} source=${sourceType}: failure streak ${streak}, cooling down ${cooldownTicks} tick(s)`);
      } else {
        cooldownState.failureStreak.delete(cooldownKey);
        cooldownState.cooldownTicks.delete(cooldownKey);
        totalDocsPushed += result?.docsPushed || 0;
      }

      try {
        // BRAIN2-W7 A 021: a reader that skipped (missing path, wrong host
        // org, ...) read nothing, so it must not stamp a successful sync.
        const skippedReason = !error && !result?.error && result?.skipped ? String(result.skipped) : null;
        const fields = {
          last_status: error ? `error: ${error.message}` : (result?.error ? `error: ${result.error}` : (skippedReason ? `skipped: ${skippedReason}` : (result?.oversize ? `ok (${result.oversize} oversize file(s) omitted)` : 'ok'))),
          last_count: result?.docsPushed || 0,
        };
        if (!skippedReason) fields.last_sync = new Date().toISOString();
        upsertSourceFn(orgId, sourceType, fields, { dbPath });
      } catch (err) {
        console.error(`[Feed] org=${orgId} source=${sourceType}: registry upsert failed — ${err.message}`);
      }
    }
  }

  console.log(`[Feed] tick complete: ${sourcesRun} source-run(s) ok, ${sourcesSkipped} skipped (disabled/cooling down), ${sourcesFailed} failed, ${orgIds.length} org(s)`);

  return { sourcesRun, sourcesSkipped, sourcesFailed, totalDocsPushed };
}

/**
 * quox#524: builds the dispatch map startFeedScheduler actually uses for a
 * tick, resolving QUOXFEED_OAUTH_SOURCES_ENABLED per (already-enabled) org
 * instead of the module-load-time env snapshot (the exported
 * SOURCE_INGESTERS constant, used only by feedApiHandlers.js's catalog —
 * see that constant's own comment for why it must stay env-only).
 *
 * Oauth sources are included if ANY org in `orgIds` resolves to enabled —
 * `deps.isOauthSourcesEnabledFn` defaults to a plain env read, and falls
 * back to the plain env value for any org where the resolver returns a
 * non-boolean or throws (same precedence contract as
 * platformCapabilities.resolveEffectiveCapability). Only ever called when
 * the caller has NOT injected its own deps.sourceIngesters (that remains a
 * full override/escape hatch, unchanged).
 *
 * @param {string[]} orgIds - orgs already resolved as QUOXFEED_ENABLED
 * @param {object} [deps]
 * @param {function} [deps.isOauthSourcesEnabledFn]
 * @returns {Promise<object>} the source_type -> ingester dispatch map
 */
async function resolveOauthEnabledOrgs(orgIds, deps = {}) {
  const envOauthEnabled = process.env.QUOXFEED_OAUTH_SOURCES_ENABLED === 'true';
  const isOauthSourcesEnabledFn = deps.isOauthSourcesEnabledFn || (() => envOauthEnabled);
  const enabledOrgs = new Set();
  for (const orgId of orgIds) {
    try {
      const resolved = await isOauthSourcesEnabledFn(orgId);
      if (resolved === true) enabledOrgs.add(orgId);
      else if (typeof resolved !== 'boolean' && envOauthEnabled) enabledOrgs.add(orgId);
    } catch (err) {
      console.error(`[Feed] org=${orgId}: QUOXFEED_OAUTH_SOURCES_ENABLED resolver failed, defaulting to env — ${err.message}`);
      if (envOauthEnabled) enabledOrgs.add(orgId);
    }
  }
  return enabledOrgs;
}

async function resolveSourceIngesters(orgIds, deps = {}) {
  const oauthEnabled = (await resolveOauthEnabledOrgs(orgIds, deps)).size > 0;
  return {
    ...BASE_SOURCE_INGESTERS,
    ...(oauthEnabled ? OAUTH_SOURCE_INGESTERS : {}),
  };
}

/**
 * Starts The Feed's collector-side scheduler. Dark by default: no timers
 * are created unless QUOXFEED_ENABLED === 'true' and QUOXFEED_ORGS resolves
 * to at least one org id.
 *
 * @param {object} [deps]
 * @param {number} [deps.warmupMs] - override the warmup delay (tests)
 * @param {number} [deps.intervalMs] - override the recurring interval (tests)
 * @param {number} [deps.maxItems] - override the per-source batch cap (tests)
 * @param {boolean} [deps.runNow] - skip the warmup timer and run one tick immediately (tests)
 * @param {object} [deps.sourceIngesters] - override the SOURCE_INGESTERS dispatch map (tests)
 * @param {string} [deps.dbPath] - override feed_sources/feed_watermark db path (tests)
 * @param {function} [deps.getSourceFn] - override feedWatermark.getSource (tests)
 * @param {function} [deps.upsertSourceFn] - override feedWatermark.upsertSource (tests)
 * @param {function} [deps.setTimeoutFn] - injectable for tests
 * @param {function} [deps.setIntervalFn] - injectable for tests
 * @param {function} [deps.listIdleConversationsFn] - forwarded to the conversation
 *   ingester (production wiring: server.js's reflectionMiningListIdleConversations)
 * @param {function} [deps.getConversationEnvelopesFn] - forwarded to the conversation
 *   ingester (production wiring: server.js's reflectionMiningGetConversationEnvelopes)
 * @param {number} [deps.ingestTimeoutMs] - override the per-ingester-call timeout (tests)
 * @param {number} [deps.runTimes] - with runNow, run this many sequential ticks
 *   in a row instead of one (tests — lets the per-source cooldown and
 *   whole-tick zero-progress backoff below be exercised across multiple
 *   ticks without needing real timers)
 * @param {function} [deps.isFeedEnabledFn] - quox#524: resolves the
 *   effective (settings-store-aware) QUOXFEED_ENABLED value for one org id.
 *   Defaults to a plain env read. A non-boolean/null result for an org
 *   falls back to the plain env value for that org (production wiring:
 *   server.js passes platformSettingsStore.getEffectiveFlag(voltDb, orgId,
 *   'QUOXFEED_ENABLED').on).
 * @param {function} [deps.isOauthSourcesEnabledFn] - quox#524: same shape as
 *   isFeedEnabledFn, for QUOXFEED_OAUTH_SOURCES_ENABLED — governs whether
 *   notion/gdrive are added to THIS scheduler's own dispatch map (the
 *   exported SOURCE_INGESTERS catalog constant is unaffected either way).
 */
async function startFeedScheduler(deps = {}) {
  const configuredOrgIds = parseOrgIds(process.env.QUOXFEED_ORGS);
  const envFeedEnabled = process.env.QUOXFEED_ENABLED === 'true';

  if (configuredOrgIds.length === 0) {
    console.log(envFeedEnabled
      ? '[Feed] scheduler enabled but no orgs configured (QUOXFEED_ORGS is empty) — no orgs configured'
      : '[Feed] scheduler disabled');
    return;
  }

  // quox#524: QUOXFEED_ENABLED is registered in platformCapabilities.js as
  // a per-org, Settings-store-overridable flag, but this raw env check used
  // to be the ONLY thing enforcing it — an org admin's stored override was
  // audited and shown in the Settings UI, but never actually consulted, not
  // even after a restart. Resolve it per configured org instead; a
  // null/non-boolean resolution (no override stored, or the resolver itself
  // failed) falls back to the plain env value, same precedence contract as
  // platformCapabilities.resolveEffectiveCapability.
  const isFeedEnabledFn = deps.isFeedEnabledFn || (() => envFeedEnabled);
  const orgIds = [];
  for (const orgId of configuredOrgIds) {
    let on = envFeedEnabled;
    try {
      const resolved = await isFeedEnabledFn(orgId);
      if (typeof resolved === 'boolean') on = resolved;
    } catch (err) {
      console.error(`[Feed] org=${orgId}: QUOXFEED_ENABLED resolver failed, defaulting to env — ${err.message}`);
    }
    if (on) orgIds.push(orgId);
  }

  if (orgIds.length === 0) {
    console.log('[Feed] scheduler disabled (QUOXFEED_ENABLED is off for every configured org)');
    return;
  }

  // Precedence for every knob: injected deps (tests) > configResolver
  // (stored override, else env, else the registry default) > local default.
  //
  // VAULT-INTEG P13 slice 2: QUOXFEED_MAX_ITEMS/QUOXFEED_INGEST_TIMEOUT_MS
  // used to be resolved here too (once, at scheduler start) — moved to
  // resolveInstanceNumber() calls INSIDE runCoreTick below so a stored/env
  // override applies from the very next tick, not just the next collector
  // restart. QUOXFEED_INTERVAL_MS stays resolved here: the value only ever
  // feeds the ONE setInterval created at the bottom of this function, which
  // cannot change cadence without being recreated, so a restart is
  // genuinely required either way (registry entry: requiresRestart: true).
  // VAULT-INTEG P17: was a bare process.env read (envNum) resolved once at
  // scheduler start — now resolveInstanceNumber() (configResolver.js), same
  // as QUOXFEED_INTERVAL_MS on the next line. Still resolved once here, not
  // per-tick: the value only ever feeds the ONE setTimeout that schedules
  // the first tick below, so a restart is genuinely required either way
  // (registry entry: requiresRestart: true).
  const warmupMs = Number.isFinite(deps.warmupMs) ? deps.warmupMs : resolveInstanceNumber('QUOXFEED_WARMUP_MS', DEFAULT_WARMUP_MS);
  const intervalMs = Number.isFinite(deps.intervalMs) ? deps.intervalMs : resolveInstanceNumber('QUOXFEED_INTERVAL_MS', DEFAULT_INTERVAL_MS);

  const sourceIngesters = deps.sourceIngesters || await resolveSourceIngesters(orgIds, deps);
  // BRAIN2-W5 018: the dispatch map above is the union across orgs; gate the
  // OAuth readers per org so an org whose own flag is off never runs them.
  const oauthEnabledOrgs = deps.sourceIngesters ? null : await resolveOauthEnabledOrgs(orgIds, deps);
  const isSourceAllowedFn = oauthEnabledOrgs
    ? (orgId, sourceType) => !(sourceType in OAUTH_SOURCE_INGESTERS) || oauthEnabledOrgs.has(orgId)
    : null;
  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const setIntervalFn = deps.setIntervalFn || setInterval;

  // Forwarded straight through to every ingester call — each ingester
  // destructures only the keys it needs and ignores the rest (mirrors
  // dreamScheduler.js forwarding its own top-level `deps` to consolidateOrg).
  const ingesterDeps = deps;

  // INFRA-CPU (2026-08-30 CPU incident sweep): per-(org,source) failure
  // cooldown state lives here, in the scheduler's own closure, so it
  // survives across ticks (a fresh Map per tick would forget every failure
  // the instant the tick ended). Same for the whole-tick zero-progress
  // backoff counters below — mirrors embeddingBackfillScheduler.js
  // (8e1a0958) / reflectionMiningScheduler.js (88811f7f).
  const cooldownState = deps.cooldownState || createCooldownState();
  let consecutiveStalledTicks = 0;
  let backoffTicksRemaining = 0;

  // VAULT-INTEG P13 slice 2: maxItems/ingestTimeoutMs are resolved fresh
  // INSIDE this arrow function (re-invoked every tick via runTick below),
  // not captured once in an outer const — a stored/env
  // QUOXFEED_MAX_ITEMS/QUOXFEED_INGEST_TIMEOUT_MS override therefore
  // applies from the very next tick, no restart needed.
  // BRAIN2-W7 A 017: connecting a source enrolls its org. Orgs with an
  // enabled feed_sources row but absent from QUOXFEED_ORGS are added each
  // tick (still subject to the per-org QUOXFEED_ENABLED resolution).
  const listEnrolledOrgsFn = deps.listEnrolledOrgsFn || (() => feedWatermark.listEnrolledOrgs({ dbPath: deps.dbPath }));
  const resolveTickOrgs = async () => {
    const out = [...orgIds];
    let enrolled = [];
    try { enrolled = listEnrolledOrgsFn() || []; } catch (err) {
      console.error(`[Feed] enrolled-org lookup failed, using configured orgs only — ${err.message}`);
    }
    for (const orgId of enrolled) {
      if (out.includes(orgId) || configuredOrgIds.includes(orgId)) continue;
      let on = envFeedEnabled;
      try {
        const resolved = await isFeedEnabledFn(orgId);
        if (typeof resolved === 'boolean') on = resolved;
      } catch (err) {
        console.error(`[Feed] org=${orgId}: QUOXFEED_ENABLED resolver failed, defaulting to env — ${err.message}`);
      }
      if (on) out.push(orgId);
    }
    return out;
  };
  const runCoreTick = async () => runFeedTick(await resolveTickOrgs(), sourceIngesters, {
    maxItems: Number.isFinite(deps.maxItems) ? deps.maxItems : resolveInstanceNumber('QUOXFEED_MAX_ITEMS', DEFAULT_MAX_ITEMS),
    dbPath: deps.dbPath,
    getSourceFn: deps.getSourceFn,
    upsertSourceFn: deps.upsertSourceFn,
    ingesterDeps,
    cooldownState,
    isSourceAllowedFn,
    ingestTimeoutMs: Number.isFinite(deps.ingestTimeoutMs) ? deps.ingestTimeoutMs : resolveInstanceNumber('QUOXFEED_INGEST_TIMEOUT_MS', DEFAULT_INGEST_TIMEOUT_MS),
    // ONE-BRAIN CX1 (2026-10-09): QuoxPlan carries hundreds of streams whose
    // notes change daily; at the shared per-source cap it lagged at 142 of
    // 410 streams for days. It gets its own cap (an injected deps.maxItems
    // still governs every source, for tests).
    maxItemsBySource: Number.isFinite(deps.maxItems) ? {} : {
      quoxplan: resolveInstanceNumber('QUOXFEED_QUOXPLAN_MAX_ITEMS', DEFAULT_QUOXPLAN_MAX_ITEMS),
    },
  });

  // Whole-tick zero-progress backoff: a tick that pushed zero docs across
  // every org/source this cycle achieved nothing real — back off the next
  // tick(s) entirely rather than spinning every source at full cadence for
  // no return. Any tick with real progress (totalDocsPushed > 0) resets the
  // counter immediately; capped at ZERO_PROGRESS_BACKOFF_CAP_TICKS so the
  // effective gap between real attempts is bounded.
  const runTick = async () => {
    if (backoffTicksRemaining > 0) {
      backoffTicksRemaining -= 1;
      console.log(`[Feed] tick skipped: backing off after ${consecutiveStalledTicks} consecutive zero-progress tick(s), ${backoffTicksRemaining} tick(s) of backoff remaining`);
      return;
    }
    const stats = await runCoreTick();
    const madeProgress = (stats?.totalDocsPushed || 0) > 0;
    // BRAIN2-W7 A 019: a healthy idle tick (sources ran clean, nothing new)
    // is not a stall. Only back off when zero progress came with failures,
    // otherwise a quiet brain would stretch the cadence up to 5x.
    if (madeProgress || (stats?.sourcesFailed || 0) === 0) {
      consecutiveStalledTicks = 0;
    } else {
      consecutiveStalledTicks += 1;
      backoffTicksRemaining = Math.min(consecutiveStalledTicks, ZERO_PROGRESS_BACKOFF_CAP_TICKS);
    }
    return stats;
  };

  const logMaxItems = Number.isFinite(deps.maxItems) ? deps.maxItems : resolveInstanceNumber('QUOXFEED_MAX_ITEMS', DEFAULT_MAX_ITEMS);
  const logIngestTimeoutMs = Number.isFinite(deps.ingestTimeoutMs) ? deps.ingestTimeoutMs : resolveInstanceNumber('QUOXFEED_INGEST_TIMEOUT_MS', DEFAULT_INGEST_TIMEOUT_MS);
  console.log(`[Feed] scheduler enabled for ${orgIds.length} org(s) (warmup ${Math.round(warmupMs / 1000)}s, every ${Math.round(intervalMs / 60000)}m, max ${logMaxItems} item(s)/source, ingest timeout ${Math.round(logIngestTimeoutMs / 1000)}s)`);

  if (deps.runNow) {
    const times = Number.isInteger(deps.runTimes) && deps.runTimes > 0 ? deps.runTimes : 1;
    for (let i = 0; i < times; i++) await runTick();
    return;
  }

  const warmupTimer = setTimeoutFn(() => {
    runTick();
    const intervalTimer = setIntervalFn(runTick, intervalMs);
    if (intervalTimer && typeof intervalTimer.unref === 'function') intervalTimer.unref();
  }, warmupMs);
  if (warmupTimer && typeof warmupTimer.unref === 'function') warmupTimer.unref();
}

module.exports = {
  startFeedScheduler,
  runFeedTick,
  isSourceEnabled,
  parseOrgIds,
  createCooldownState,
  resolveSourceIngesters,
  resolveOauthEnabledOrgs,
  SOURCE_INGESTERS,
  BASE_SOURCE_INGESTERS,
  OAUTH_SOURCE_INGESTERS,
  DEFAULT_WARMUP_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_ITEMS,
  DEFAULT_INGEST_TIMEOUT_MS,
  SOURCE_FAILURE_COOLDOWN_CAP_TICKS,
  ZERO_PROGRESS_BACKOFF_CAP_TICKS,
};
