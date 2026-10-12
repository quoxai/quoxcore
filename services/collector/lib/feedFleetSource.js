/**
 * feedFleetSource.js — The Feed's Phase E fleet ingester
 * (docs/STREAM_QUOXBRAIN2_OVERNIGHT_BUILD.md Phase E,
 *  docs/STREAM_QUOXBRAIN_FEED_PLAN.md F3: "QuoxAgent fleet source").
 *
 * Pulls recent per-host activity from the QuoxAgent fleet (the same
 * heartbeat-backed `agents` Map + `/api/v1/agents/:hostId/logs` route this
 * collector already serves — see server.js's `GET /api/v1/agents` and
 * `GET /api/v1/agents/:hostId/logs`) into the brain, so "all these machines
 * and their chat logs" (owner mandate) feed Qortex.
 *
 * MECHANISM — localhost HTTP, not in-process: `agents` (the heartbeat Map)
 * and the SSH-backed log fetch live entirely inside server.js's module
 * scope and are never exported (server.js has no module.exports — it's the
 * app entrypoint). Refactoring server.js to export that state is out of
 * scope for this ingester. Instead this mirrors the collector's OWN
 * established precedent for reaching fleet data from a `lib/` module —
 * quoxagentExecutor.js — which calls `${COLLECTOR_URL}/api/v1/agents` and
 * `${COLLECTOR_URL}/api/v1/agents/:hostId/logs` over localhost HTTP with an
 * `X-Service-Key` header (those routes are NOT collectorAuthGate-allowlisted,
 * so a service key is required once COLLECTOR_AUTH_ENFORCE=enforce — see
 * utils/collectorAuthGate.js). `listHostsFn`/`getHostLogsFn` are injectable
 * so tests never touch the network.
 *
 * NOTE: there is no `GET /api/v1/agents/sessions` route on this collector
 * today (only a fire-and-forget `POST .../agents/sessions` bridge to the
 * external QuoxAgent API on :9847 — see server.js's emitAgentSession). So
 * this source ingests per-host LOGS only, not session summaries; a
 * sessions-based fleet doc is future work if/when that route exists.
 *
 * HOST-ORG GATE — copied verbatim from feedTranscriptSource.js: the fleet
 * is one instance-global registry (all heartbeating hosts), not scoped per
 * tenant, but feedScheduler.js fans this ingester out per configured org.
 * Without a gate every org would get every host's logs duplicated into its
 * brain. QUOXFEED_HOST_ORG designates the single org allowed to feed from
 * the fleet; every other org gets an immediate, network-free, push-free
 * no-op. See ingestFleet()'s host-org gate below.
 *
 * PER-HOST WATERMARK — a bare `source_type` of 'fleet' would give every
 * host the same cursor, so one busy host's watermark would silently starve
 * ingestion of a quieter host's older-but-still-new lines (or worse, skip
 * them entirely once the busy host's timestamp raced ahead). Every
 * watermark read/write here is keyed by `fleet:<sha1(hostId)-first12>` (see
 * watermarkKeyForHost()) — one cursor per host, mirroring
 * feedFolderSource.js's per-path watermark keying.
 *
 * TRIM DISCIPLINE — mirrors feedTranscriptSource.js: only log lines with a
 * parseable leading `journalctl -o short-iso` timestamp are kept (anything
 * else — continuation lines, stack-trace wrapping, blank lines — is noise
 * and dropped rather than guessed at); each kept line is truncated to
 * MAX_LINE_CHARS; the rendered doc as a whole is capped at MAX_NOTE_BYTES.
 * Bounded throughout: hosts capped at maxHosts, each host's log fetch
 * capped at a bounded `lines` window (never "the whole history"), one
 * try/catch per host so a single host's failure never aborts the fleet
 * tick — best-effort, exactly like every other Feed source.
 */

'use strict';

const crypto = require('crypto');
const feedWatermark = require('./feedWatermark.js');
const brainFeedClient = require('./brainFeedClient.js');

const SOURCE_TYPE = 'fleet';
const VAULT_NAME = 'Fleet';

const DEFAULT_MAX_HOSTS = 20;
const DEFAULT_LOG_LINES = 100;
// Defense-in-depth cap on the per-host log window we request — the
// /api/v1/agents/:hostId/logs route itself already clamps to 1000
// server-side, this just keeps our own default request bounded too.
const MAX_LOG_LINES = 500;
// Same caps as feedTranscriptSource.js's MAX_TURN_CHARS/MAX_NOTE_BYTES,
// sized for log lines instead of chat turns.
const MAX_LINE_CHARS = 2000;
const MAX_NOTE_BYTES = 150 * 1024;

// One-time warning (soak convenience) when QUOXFEED_HOST_ORG is unset —
// logged once per process, not once per tick/org. Separate flag from
// feedTranscriptSource.js's (independent module, independent warning).
let warnedNoHostOrg = false;

function getCollectorUrl() {
  return process.env.COLLECTOR_URL || 'http://localhost:9848';
}

function serviceKeyHeaders() {
  const key = process.env.INTERNAL_SERVICE_KEY || '';
  return key ? { 'X-Service-Key': key } : {};
}

function truncate(text, max) {
  const str = String(text == null ? '' : text);
  if (str.length <= max) return str;
  return `${str.slice(0, max)}…[truncated]`;
}

/**
 * Derives a short, stable, per-host watermark key so every heartbeating
 * host gets its own cursor (never a shared 'fleet' cursor) — see module
 * header. Not reversible/guessable-sensitive, just a cursor key.
 */
function watermarkKeyForHost(hostId) {
  const hash = crypto.createHash('sha1').update(String(hostId)).digest('hex').slice(0, 12);
  return `${SOURCE_TYPE}:${hash}`;
}

/**
 * Sanitizes a host id for use as a vault relPath segment — heartbeat
 * `host_id` values are agent-supplied (see server.js's POST /heartbeat)
 * and are never validated as path-safe today. Strips anything but
 * alnum/dash/underscore/dot so a hostile or malformed host_id can never
 * produce a relPath escaping the `fleet/` prefix.
 */
function sanitizeHostIdForPath(hostId) {
  const cleaned = String(hostId || '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned || 'unknown-host';
}

/**
 * Extracts a leading `journalctl -o short-iso` timestamp from a log line
 * (e.g. `2026-07-19T14:32:01+0100 host quoxagent[123]: message`), returning
 * `{ tsIso, rest }` (tsIso normalized to a UTC ISO string so watermark
 * string-comparison stays valid) or `null` if the line carries no
 * parseable leading timestamp — such lines are noise per the module's trim
 * discipline and are dropped by the caller, never guessed at.
 */
function extractLineTimestamp(line) {
  const match = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:?\d{2}|Z)?)\s*(.*)$/.exec(line);
  if (!match) return null;
  const parsed = new Date(match[1].replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) return null;
  return { tsIso: parsed.toISOString(), rest: match[2] || '' };
}

/**
 * Default fleet client: lists heartbeating hosts via this collector's own
 * `GET /api/v1/agents` (localhost HTTP, X-Service-Key — see module
 * header). Bounded to `maxHosts`. Overridable via deps.listHostsFn (tests
 * inject a fake fleet client and never touch the network).
 */
async function defaultListHosts(maxHosts, { fetchImpl = fetch, signal } = {}) {
  const res = await fetchImpl(`${getCollectorUrl()}/api/v1/agents`, {
    headers: serviceKeyHeaders(),
    // STABILITY-AUDITS #2: combine the per-call 10s timeout with the
    // feedScheduler-level abort signal (fired when the whole ingester call
    // overruns its ingestTimeoutMs) so a tick-level timeout stops this
    // fetch immediately rather than waiting out its own 10s budget.
    signal: signal ? AbortSignal.any([AbortSignal.timeout(10000), signal]) : AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GET /api/v1/agents failed HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  const list = Array.isArray(body?.agents) ? body.agents : [];
  return list.slice(0, maxHosts).map((a) => ({ hostId: a.host_id }));
}

/**
 * Default fleet client: fetches a bounded recent-lines window of one
 * host's logs via `GET /api/v1/agents/:hostId/logs` (localhost HTTP,
 * X-Service-Key). Overridable via deps.getHostLogsFn.
 */
async function defaultGetHostLogs(hostId, lines, { fetchImpl = fetch, signal } = {}) {
  const res = await fetchImpl(`${getCollectorUrl()}/api/v1/agents/${encodeURIComponent(hostId)}/logs?lines=${lines}`, {
    headers: serviceKeyHeaders(),
    // STABILITY-AUDITS #2: see defaultListHosts above — combine the per-call
    // timeout with the tick-level abort signal.
    signal: signal ? AbortSignal.any([AbortSignal.timeout(10000), signal]) : AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GET /api/v1/agents/${hostId}/logs failed HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  return Array.isArray(body?.logs) ? body.logs : [];
}

/**
 * Reduces one host's raw log lines to the subset newer than its stored
 * watermark, sorted ascending by extracted timestamp. Lines with no
 * parseable timestamp are noise and dropped (see module header).
 */
function selectEligibleLines(logLines, storedWatermark) {
  const parsed = [];
  for (const line of logLines) {
    const extracted = extractLineTimestamp(line);
    if (!extracted) continue; // noise — no leading timestamp, dropped
    if (storedWatermark && extracted.tsIso <= storedWatermark) continue;
    parsed.push({ tsIso: extracted.tsIso, line: truncate(line, MAX_LINE_CHARS) });
  }
  parsed.sort((a, b) => (a.tsIso < b.tsIso ? -1 : a.tsIso > b.tsIso ? 1 : 0));
  return parsed;
}

/**
 * Renders one host's eligible (new-since-watermark) lines into a single
 * push-ingest document. Caps total body bytes at MAX_NOTE_BYTES (dropping
 * the oldest lines first) — mirrors feedTranscriptSource.js's per-note
 * byte discipline, sized for a log digest instead of a chat transcript.
 * relPath is `fleet/<hostId>/<ts>.md` — one doc per tick per host with new
 * activity, timestamped by the newest line in the batch, so it never
 * collides with (or overwrites) a prior tick's digest for the same host.
 */
function renderHostDocument(hostId, eligibleLines) {
  const safeHostId = sanitizeHostIdForPath(hostId);
  const newestTs = eligibleLines[eligibleLines.length - 1].tsIso;
  const heading = `# Fleet: ${hostId}`;

  const kept = [];
  let bytes = Buffer.byteLength(heading, 'utf8');
  // Prefer the newest lines if the batch would overflow the note cap —
  // walk from the end (newest) and stop once the byte budget is spent.
  for (let i = eligibleLines.length - 1; i >= 0; i--) {
    const rendered = `- \`${eligibleLines[i].tsIso}\` ${eligibleLines[i].line}`;
    const renderedBytes = Buffer.byteLength(rendered, 'utf8') + 1;
    if (kept.length > 0 && bytes + renderedBytes > MAX_NOTE_BYTES) break;
    kept.unshift(rendered);
    bytes += renderedBytes;
  }

  const relPath = `fleet/${safeHostId}/${newestTs.replace(/[:.]/g, '-')}.md`;
  return {
    relPath,
    content: [heading, '', ...kept].join('\n'),
    title: `Fleet: ${hostId}`,
    kind: 'fleet_activity',
    sourceType: SOURCE_TYPE,
    occurredAt: newestTs,
  };
}

/**
 * Ingests recent per-host activity (bounded log windows) from the
 * QuoxAgent fleet into the "Fleet" push vault, one host at a time,
 * incrementally per host's own watermark.
 *
 * HOST-ORG GATE: if QUOXFEED_HOST_ORG is set and `orgId` doesn't match it,
 * this returns immediately with no fleet API call and no push — the fleet
 * is instance-global, not per-tenant (see module header). If unset, a
 * one-time warning is logged and ingestion proceeds anyway (soak
 * convenience, matching feedTranscriptSource.js's contract).
 *
 * @param {string} orgId
 * @param {{config?: {maxHosts?: number, linesPerHost?: number}, maxItems?: number, dryRun?: boolean}} [opts]
 * @param {{
 *   listHostsFn?: Function,          // (maxHosts, {fetchImpl}) => Array<{hostId}> (tests)
 *   getHostLogsFn?: Function,        // (hostId, lines, {fetchImpl}) => string[] (tests)
 *   getWatermarkFn?: Function,       // (orgId, hostId) => string|null
 *   setWatermarkFn?: Function,       // (orgId, hostId, ts) => void
 *   ensurePushVaultFn?: Function,    // defaults to brainFeedClient.ensurePushVault
 *   pushDocumentsFn?: Function,      // defaults to brainFeedClient.pushDocuments
 *   fetchImpl?: Function,            // forwarded to the brain client + default fleet client (test injection)
 *   userId?: string,
 *   dbPath?: string,                 // forwarded to feedWatermark (tests)
 * }} [deps]
 * @returns {Promise<{hostsRead: number, docsPushed: number, skipped: string|null, error: string|null}>}
 */
async function ingestFleet(orgId, opts = {}, deps = {}) {
  const result = { hostsRead: 0, hostsFailed: 0, docsPushed: 0, skipped: null, error: null };

  // BRAIN2-W3 B (010): the fleet is instance-global; fail CLOSED when no
  // host org is designated.
  const hostOrg = process.env.QUOXFEED_HOST_ORG;
  if (!hostOrg || orgId !== hostOrg) {
    result.skipped = hostOrg ? 'not host org' : 'host org not designated';
    return result;
  }

  const {
    listHostsFn = defaultListHosts,
    getHostLogsFn = defaultGetHostLogs,
    getWatermarkFn = (org, hostId) => feedWatermark.getWatermark(org, watermarkKeyForHost(hostId), { dbPath: deps.dbPath }),
    setWatermarkFn = (org, hostId, ts) => feedWatermark.setWatermark(org, watermarkKeyForHost(hostId), ts, { dbPath: deps.dbPath }),
    ensurePushVaultFn = brainFeedClient.ensurePushVault,
    pushDocumentsFn = brainFeedClient.pushDocuments,
    fetchImpl,
    userId,
  } = deps;

  const config = opts.config || null;
  const maxHosts = config?.maxHosts || opts.maxItems || DEFAULT_MAX_HOSTS;
  const linesPerHost = Math.min(config?.linesPerHost || DEFAULT_LOG_LINES, MAX_LOG_LINES);
  const dryRun = !!opts.dryRun;

  let hosts = [];
  try {
    hosts = (await listHostsFn(maxHosts, { fetchImpl, signal: opts.signal })) || [];
  } catch (err) {
    result.error = `list hosts failed — ${err.message}`;
    console.error(`[FeedFleetSource] org=${orgId}: ${result.error}`);
    return result;
  }
  hosts = hosts.slice(0, maxHosts);

  const docs = [];
  let lastHostError = null;
  const watermarkAdvances = []; // { hostId, ts } — applied only after a successful push

  for (const host of hosts) {
    const hostId = host?.hostId;
    if (!hostId) continue;

    try {
      let storedWatermark = null;
      try {
        storedWatermark = await getWatermarkFn(orgId, hostId);
      } catch (err) {
        console.error(`[FeedFleetSource] org=${orgId} host=${hostId}: watermark read failed, treating as no watermark — ${err.message}`);
      }

      const logLines = (await getHostLogsFn(hostId, linesPerHost, { fetchImpl, signal: opts.signal })) || [];
      result.hostsRead++;

      const eligible = selectEligibleLines(logLines, storedWatermark);
      if (eligible.length === 0) continue; // no new activity for this host this tick

      docs.push(renderHostDocument(hostId, eligible));
      watermarkAdvances.push({ hostId, ts: eligible[eligible.length - 1].tsIso });
    } catch (err) {
      // One host failing (log fetch error, malformed response, etc.) never
      // aborts the rest of the fleet tick — logged and skipped.
      result.hostsFailed++;
      lastHostError = err.message;
      console.error(`[FeedFleetSource] org=${orgId} host=${hostId}: skipping — ${err.message}`);
    }
  }

  // Failure accounting: hosts that errored are counted DISTINCTLY from hosts
  // with no new activity. If every host we tried failed (nothing read), that
  // is a failed source run, not an empty one: surface it so the scheduler's
  // failure streak/backoff engages instead of logging a silent "0 docs".
  if (result.hostsFailed > 0) {
    console.warn(`[FeedFleetSource] org=${orgId}: ${result.hostsFailed} of ${hosts.length} host(s) failed, ${result.hostsRead} read ok`);
    if (result.hostsRead === 0) result.error = `all ${result.hostsFailed} host(s) failed — last: ${lastHostError}`;
  }

  if (docs.length === 0) return result;

  if (dryRun) return result; // tallies hostsRead, pushes/advances nothing

  try {
    const vaultId = await ensurePushVaultFn(orgId, VAULT_NAME, { scope: 'org', userId, fetchImpl });
    if (!vaultId) {
      result.error = 'ensurePushVault returned no vaultId';
      console.error(`[FeedFleetSource] org=${orgId}: ${result.error} — not advancing watermarks`);
      return result;
    }

    const pushResult = await pushDocumentsFn(orgId, vaultId, docs, { userId, fetchImpl });
    if (pushResult?.error) {
      result.error = pushResult.error;
      console.error(`[FeedFleetSource] org=${orgId}: push failed — ${pushResult.error} — not advancing watermarks`);
      return result;
    }

    result.docsPushed = docs.length;

    for (const { hostId, ts } of watermarkAdvances) {
      try {
        await setWatermarkFn(orgId, hostId, ts);
      } catch (err) {
        console.error(`[FeedFleetSource] org=${orgId} host=${hostId}: watermark write failed — ${err.message}`);
      }
    }
  } catch (err) {
    result.error = `push failed — ${err.message}`;
    console.error(`[FeedFleetSource] org=${orgId}: ${result.error} — not advancing watermarks`);
  }

  return result;
}

module.exports = {
  ingestFleet,
  extractLineTimestamp,
  selectEligibleLines,
  renderHostDocument,
  watermarkKeyForHost,
  sanitizeHostIdForPath,
  truncate,
  SOURCE_TYPE,
  VAULT_NAME,
  DEFAULT_MAX_HOSTS,
  DEFAULT_LOG_LINES,
  MAX_LOG_LINES,
  MAX_NOTE_BYTES,
  _resetWarnedNoHostOrgForTest: () => { warnedNoHostOrg = false; },
};
