/**
 * feedTranscriptSource.js — The Feed's F2 host-file ingester (WP2,
 * docs/STREAM_QUOXBRAIN_FEED_PLAN.md).
 *
 * Ports services/quoxbrain/readers/transcriptReader.mjs's .jsonl parsing +
 * trimming (ESM, host-runnable script) into collector CJS so it can be
 * driven by feedScheduler.js instead of a one-shot CLI. Same signal
 * extraction (user/assistant text turns, thinking-block gist, tool_use
 * marker), same bulk-trimming discipline (tool_result payloads and
 * tool_use `input` payloads are never held onto — a session file can be
 * 200MB+ and is streamed line-by-line, never readFileSync'd).
 *
 * CORRECTNESS GUARD — read before touching this file: Claude session
 * transcripts under TRANSCRIPT_DIR are MACHINE-GLOBAL (one host directory,
 * not per-tenant), but feedScheduler.js fans out per org in QUOXFEED_ORGS.
 * Without a gate, every session would get duplicated into every configured
 * org's brain. QUOXFEED_HOST_ORG designates the single org this source is
 * allowed to feed; every other org gets an immediate, filesystem-free,
 * push-free no-op. See ingestTranscripts()'s host-org gate below.
 *
 * Watermarked by file mtime (NOT content-hash, NOT a line/byte cursor):
 * the currently-open session's .jsonl keeps growing while the session is
 * live, so its mtime keeps advancing — it re-qualifies as "newer than the
 * watermark" every tick and gets re-rendered + re-pushed. This is
 * deliberate (plan: "keeps current until it ends") and safe because
 * pushDocuments/the brain's ingest path is content-hash idempotent — an
 * unchanged render no-ops, a grown one updates in place.
 */

'use strict';

const { claudeProjectDir } = require('../utils/runtimePaths.js');
const path = require('path');
const readline = require('readline');
const realFs = require('fs');
const feedWatermark = require('./feedWatermark.js');
const feedSweep = require('./feedSweep.js');
const { resolveSafeFolderPath } = require('./feedFolderSource.js');
const brainFeedClient = require('./brainFeedClient.js');
const { redactSecrets } = require('./feedAiHistorySource.js');
const { cleanUserText } = require('./transcriptNoise.js');
const crypto = require('crypto');

const SOURCE_TYPE = 'transcript';
const VAULT_NAME = 'Dev Sessions';
const DEFAULT_TRANSCRIPT_DIR = claudeProjectDir();
const DEFAULT_MAX_SESSIONS = 20;
// Deletion brake: a live listing under half the manifest, with more than this
// many manifest entries, is treated as a bad listing, not a mass deletion.
const BRAKE_MIN_MANIFEST = 3;
// A large but NON-EMPTY shrink is confirmed, not refused forever: the same
// shrunken live set must be seen on this many consecutive ticks (the first
// sighting counts) before its tombstones are applied.
const SHRINK_CONFIRM_TICKS = 2;
// Authoritative-root marker. An unmounted/missing bind mount looks like an
// empty dir (Docker creates one), so "empty" alone never proves "user deleted
// everything". `.quoxfeed-root` (JSON {createdAt, writer}) in the staging root
// proves the dir was a real, readable mount. The staging writer SHOULD create
// it; the ingester also creates it the first time it sees a NON-empty
// readable dir, so existing installs gain it automatically. Empty + marker +
// readable is an authoritative empty snapshot (confirmed over
// SHRINK_CONFIRM_TICKS ticks, tombstoned in bounded batches).
const ROOT_MARKER = '.quoxfeed-root';
const MAX_TOMBSTONES_PER_TICK = 200;

// Same caps as transcriptReader.mjs.
const MAX_TURN_CHARS = 4000;
const MAX_NOTE_BYTES = 150 * 1024;
// BRAIN2-W7 A 049: assistant `thinking` blocks are never captured (internal
// reasoning must not become durable shared knowledge).

// One-time warning (soak convenience) when QUOXFEED_HOST_ORG is unset —
// logged once per process, not once per tick/org.
let warnedNoHostOrg = false;

function truncate(text, max) {
  const str = String(text == null ? '' : text);
  if (str.length <= max) return str;
  return `${str.slice(0, max)}\n…[truncated]`;
}

/**
 * Extracts genuine user prompt text from a `type:'user'` event's
 * `message.content`. Returns null when the line is noise: a
 * <system-reminder> string, a tool_result block, an attachment, or an
 * otherwise-empty message. Ported verbatim from transcriptReader.mjs.
 */
function extractUserText(message) {
  const content = message?.content;
  if (typeof content === 'string') {
    return cleanUserText(content);
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        const t = cleanUserText(block.text);
        if (t) parts.push(t);
      }
      // tool_result / image / attachment / other block types: bulk noise,
      // deliberately never read beyond `block.type`.
    }
    return parts.length ? parts.join('\n\n') : null;
  }
  return null;
}

/**
 * Extracts the visible signal from a `type:'assistant'` event's
 * `message.content` array: text blocks in full, thinking blocks as a short
 * gist, tool_use blocks as a one-line `[tool: <name>]` marker (never the
 * `input` payload). tool_result / other block types are skipped entirely —
 * this IS the "trim the megabyte" behavior the plan calls out: the raw
 * tool_result/tool_use-input bulk is never read into a string at all.
 * Ported verbatim from transcriptReader.mjs.
 */
function extractAssistantText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      const t = block.text.trim();
      if (t) parts.push(t);
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      parts.push(`[tool: ${block.name}]`);
    }
    // tool_result and anything else: skipped — bulk noise.
  }
  return parts.length ? parts.join('\n\n') : null;
}

/**
 * Streams a single transcript .jsonl file line-by-line (never
 * readFileSync — session files can run to 200MB+) and reduces it to an
 * ordered list of {role, text} turns plus the session title. `fsImpl` is
 * injectable so tests can hand in an in-memory createReadStream.
 *
 * @param {string} filePath
 * @param {object} fsImpl - object exposing createReadStream (fs-shaped)
 * @returns {Promise<{title: string|null, turns: Array<{role:string,text:string}>, malformedLines: number}>}
 */
async function parseTranscriptFile(filePath, fsImpl) {
  const rl = readline.createInterface({
    input: fsImpl.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let title = null;
  const turns = [];
  let assistantBuffer = [];
  let malformedLines = 0;

  // BRAIN2-W7 A 044/048: a long turn is split into consecutive same-role
  // chunks (nothing past the limit is dropped) and every chunk is redacted.
  function pushTurn(role, rawText) {
    const text = redactSecrets(rawText);
    for (let i = 0; i < text.length; i += MAX_TURN_CHARS) {
      turns.push({ role, text: text.slice(i, i + MAX_TURN_CHARS) });
    }
  }

  function flushAssistant() {
    if (assistantBuffer.length === 0) return;
    const text = assistantBuffer.join('\n\n');
    assistantBuffer = [];
    if (text.trim()) pushTurn('assistant', text);
  }

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }

    switch (event.type) {
      case 'custom-title':
        if (typeof event.customTitle === 'string' && event.customTitle.trim()) {
          title = event.customTitle.trim();
        }
        break;

      case 'user': {
        if (event.message?.role !== 'user') break;
        const text = extractUserText(event.message);
        if (text) {
          flushAssistant();
          pushTurn('user', text);
        }
        break;
      }

      case 'assistant': {
        if (event.message?.role !== 'assistant') break;
        const text = extractAssistantText(event.message);
        if (text) assistantBuffer.push(text);
        break;
      }

      // system, attachment, file-history-snapshot, queue-operation,
      // bridge-session, agent-name, mode, permission-mode, last-prompt:
      // intentionally ignored — no signal.
      default:
        break;
    }
  }

  flushAssistant();
  return { title, turns, malformedLines };
}

function renderTurn(turn) {
  const label = turn.role === 'user' ? '**You:**' : '**Assistant:**';
  return `${label} ${turn.text}`;
}

/**
 * Renders an ordered turn list into one or more markdown note bodies,
 * splitting at turn boundaries whenever a part would exceed MAX_NOTE_BYTES
 * (~150KB). Never splits inside a single turn. Ported verbatim from
 * transcriptReader.mjs.
 *
 * @param {string} title
 * @param {Array<{role:string,text:string}>} turns
 * @returns {string[]}
 */
function buildNoteParts(title, turns) {
  const baseHeading = `# ${title}`;
  const partTurns = [];
  let current = [];
  let currentBytes = Buffer.byteLength(baseHeading, 'utf8');

  for (const turn of turns) {
    const rendered = renderTurn(turn);
    const renderedBytes = Buffer.byteLength(rendered, 'utf8') + 2; // blank-line separator
    if (current.length > 0 && currentBytes + renderedBytes > MAX_NOTE_BYTES) {
      partTurns.push(current);
      current = [];
      currentBytes = Buffer.byteLength(baseHeading, 'utf8');
    }
    current.push(rendered);
    currentBytes += renderedBytes;
  }
  if (current.length > 0 || partTurns.length === 0) partTurns.push(current);

  const multiPart = partTurns.length > 1;
  return partTurns.map((renderedTurns, i) => {
    const heading = multiPart ? `${baseHeading} (part ${i + 1})` : baseHeading;
    return [heading, '', ...renderedTurns].join('\n\n');
  });
}

/**
 * Lists `*.jsonl` files directly under `dir` with their mtime (ISO), the
 * unit the transcript watermark is keyed on. `fsImpl` is injectable for
 * tests (existsSync/readdirSync/statSync).
 */
function listTranscriptFiles(dir, fsImpl) {
  if (!fsImpl.existsSync(dir)) return [];
  return fsImpl.readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.jsonl'))
    .map((name) => {
      const filePath = path.join(dir, name);
      const stat = fsImpl.statSync(filePath);
      return {
        filePath,
        sessionId: name.slice(0, -'.jsonl'.length),
        mtimeIso: stat.mtime.toISOString(),
      };
    });
}

/**
 * Streams + reduces one session transcript file into its push-ingest
 * document payload(s) (0 docs if the session had zero extracted turns, 1
 * doc otherwise, or N parts if it exceeded MAX_NOTE_BYTES). relPath is
 * `transcript/<sessionId>.md`, or `transcript/<sessionId>.partN.md` for a
 * split session.
 */
async function collectSessionDocuments(entry, fsImpl) {
  const { title, turns, malformedLines } = await parseTranscriptFile(entry.filePath, fsImpl);
  const resolvedTitle = title || entry.sessionId;

  if (turns.length === 0) {
    return { docs: [], supersededPaths: [], sessionId: entry.sessionId, malformedLines };
  }

  const noteParts = buildNoteParts(resolvedTitle, turns);
  const multiPart = noteParts.length > 1;

  const docs = noteParts.map((content, i) => ({
    relPath: multiPart ? `transcript/${entry.sessionId}.part${i + 1}.md` : `transcript/${entry.sessionId}.md`,
    content,
    title: multiPart ? `${resolvedTitle} (part ${i + 1})` : resolvedTitle,
    kind: 'transcript_session',
    sourceType: SOURCE_TYPE,
    occurredAt: entry.mtimeIso,
  }));

  // BRAIN2-W7 A 045: a session that grew into parts supersedes its old
  // single-note path; ingest tombstones it after a successful push.
  const supersededPaths = multiPart ? [`transcript/${entry.sessionId}.md`] : [];

  return { docs, supersededPaths, sessionId: entry.sessionId, malformedLines };
}

/**
 * Ingests Claude session transcripts (host-file, machine-global) newer
 * than The Feed's transcript watermark (keyed by file mtime) into the
 * "Dev Sessions" push vault, bounded to `maxSessions` per call.
 *
 * HOST-ORG GATE: if QUOXFEED_HOST_ORG is set and `orgId` doesn't match it,
 * this returns immediately with no filesystem read and no push — see the
 * module header for why (transcripts are machine-global, not per-tenant).
 * If QUOXFEED_HOST_ORG is unset, a one-time warning is logged and
 * ingestion proceeds anyway (soak convenience — production must set it
 * before enabling more than one org).
 *
 * @param {string} orgId
 * @param {{maxItems?: number, maxConversations?: number, dryRun?: boolean, config?: {path?: string}}} [opts]
 *   opts.config.path — the connected source's path from the feed_sources
 *   registry (Phase C: "connect, don't configure"). Takes priority over
 *   TRANSCRIPT_DIR when set; TRANSCRIPT_DIR remains the dev-box fallback
 *   for as long as no folder has been explicitly connected.
 * @param {{
 *   fs?: object,                     // injectable fs-shaped module (tests)
 *   listFiles?: Function,            // (dir, fsImpl) => Array<{filePath,sessionId,mtimeIso}> (tests)
 *   transcriptDir?: string,          // overrides TRANSCRIPT_DIR env (tests)
 *   getWatermarkFn?: Function,       // (orgId) => string|null
 *   setWatermarkFn?: Function,       // (orgId, ts) => void
 *   ensurePushVaultFn?: Function,    // defaults to brainFeedClient.ensurePushVault
 *   pushDocumentsFn?: Function,      // defaults to brainFeedClient.pushDocuments
 *   fetchImpl?: Function,            // forwarded to the brain client (test injection)
 *   userId?: string,
 *   dbPath?: string,                 // forwarded to feedWatermark (tests)
 * }} [deps]
 * @returns {Promise<{sessionsRead: number, docsPushed: number, skipped: string|null, error: string|null}>}
 */
async function ingestTranscripts(orgId, opts = {}, deps = {}) {
  const result = { sessionsRead: 0, docsPushed: 0, skipped: null, error: null };

  // BRAIN2-W3 B (009): host-wide data fails CLOSED. Without a designated
  // QUOXFEED_HOST_ORG nothing flows, unless this org explicitly connected its
  // own folder (opts.config.path, guarded) which is not machine-global.
  const hostOrg = process.env.QUOXFEED_HOST_ORG;
  if (hostOrg) {
    if (orgId !== hostOrg) {
      result.skipped = 'not host org';
      return result;
    }
  } else if (!opts.config?.path) {
    result.skipped = 'host org not designated';
    return result;
  }

  const {
    fs: fsImpl = realFs,
    listFiles,
    transcriptDir,
    getWatermarkFn = (org) => feedWatermark.getWatermark(org, SOURCE_TYPE, { dbPath: deps.dbPath }),
    setWatermarkFn = (org, ts) => feedWatermark.setWatermark(org, SOURCE_TYPE, ts, { dbPath: deps.dbPath }),
    ensurePushVaultFn = brainFeedClient.ensurePushVault,
    pushDocumentsFn = brainFeedClient.pushDocuments,
    pushDeletionsFn = brainFeedClient.pushDeletions,
    listVaultRelPathsFn = brainFeedClient.listVaultRelPaths,
    stateStore,
    fetchImpl,
    userId,
  } = deps;
  // Deletion manifest lives in the feed watermark store (`transcript:manifest`),
  // like feedFolderSource. Tests that inject their own watermark fns without a
  // dbPath get no durable store, so reconciliation is off for them.
  const manifestStore = stateStore || ((deps.dbPath || !deps.getWatermarkFn) ? feedSweep.defaultStore(deps.dbPath) : null);
  const manifestKey = `${SOURCE_TYPE}:manifest`;

  // Precedence: deps.transcriptDir (test-only override) > opts.config.path
  // (connected source, Phase C) > TRANSCRIPT_DIR (dev-box env fallback) >
  // the hardcoded default. Config wins over env — see module/opts docs.
  if (!transcriptDir && opts.config?.path) {
    // A configured (org-supplied) path goes through the same safety floor and
    // realpath allowlist as folder sources; env/default dirs are operator-set.
    const guard = resolveSafeFolderPath(opts.config.path, { orgId });
    if (!guard.ok) {
      console.error(`[FeedTranscriptSource] org=${orgId}: unsafe path, ${guard.error}`);
      result.skipped = `unsafe path, ${guard.error}`;
      return result;
    }
  }
  const dir = transcriptDir || opts.config?.path || process.env.TRANSCRIPT_DIR || DEFAULT_TRANSCRIPT_DIR;
  const maxSessions = opts.maxItems ?? opts.maxConversations ?? DEFAULT_MAX_SESSIONS;
  const dryRun = !!opts.dryRun;

  let storedWatermark = null;
  try {
    storedWatermark = await getWatermarkFn(orgId);
  } catch (err) {
    console.error(`[FeedTranscriptSource] org=${orgId}: watermark read failed, treating as no watermark — ${err.message}`);
  }

  let entries = [];
  // A listing may drive deletions only if the directory exists and was read
  // without error. A missing/unreadable dir must never look like "all deleted".
  let listingComplete = false;
  let markerPresent = false;
  let markerPath = null;
  try {
    entries = typeof listFiles === 'function'
      ? (await listFiles(dir, fsImpl)) || []
      : listTranscriptFiles(dir, fsImpl);
    listingComplete = !!fsImpl.existsSync(dir);
    markerPath = path.join(dir, ROOT_MARKER);
    try { markerPresent = listingComplete && !!fsImpl.existsSync(markerPath); } catch { markerPresent = false; }
    if (listingComplete && !markerPresent && entries.length > 0 && !dryRun && typeof fsImpl.writeFileSync === 'function') {
      // Non-empty readable dir is proof the mount is real: record it.
      try {
        fsImpl.writeFileSync(markerPath, JSON.stringify({ createdAt: new Date().toISOString(), writer: 'feedTranscriptSource' }));
        markerPresent = true;
        console.log(`[FeedTranscriptSource] org=${orgId}: created ${ROOT_MARKER} in ${dir}`);
      } catch (err) {
        console.error(`[FeedTranscriptSource] org=${orgId}: could not create ${ROOT_MARKER} (${err.message}), empty-dir deletions stay held`);
      }
    }
  } catch (err) {
    result.error = `list transcript files failed — ${err.message}`;
    result.deletionBlocked = `deletions held: transcript dir read error (${err.message})`;
    console.error(`[FeedTranscriptSource] org=${orgId}: ${result.error}`);
    return result;
  }

  // Strictly-after: sessions with mtime > watermark only. The live
  // session's mtime keeps advancing, so it re-qualifies every tick — see
  // module header.
  // Compound (mtime, sessionId) cursor: sessions tied on mtime beyond the
  // cap are owed to the next tick, not lost (BRAIN2-V3 A4).
  const allEligible = entries
    .filter((e) => feedWatermark.isAfterCursor(storedWatermark, e.mtimeIso, e.sessionId))
    .sort((a, b) => feedWatermark.compareByTsId({ ts: a.mtimeIso, id: a.sessionId }, { ts: b.mtimeIso, id: b.sessionId }));
  const eligible = allEligible.slice(0, maxSessions);
  const remaining = allEligible.slice(maxSessions).map((e) => ({ ts: e.mtimeIso, id: e.sessionId }));
  const processed = [];

  const sessionPaths = new Map(); // sessionId -> relPaths rendered this tick

  /**
   * ONE-BRAIN CX1: tombstone brain notes of sessions whose file vanished from
   * a COMPLETE listing (mirrors feedSweep: manifest of the previous complete
   * pass, explicit pushDeletions, never on partial/errored, none on first pass).
   * Manifest shape: { [sessionId]: relPaths[] }; a session not rendered this
   * tick keeps its previously recorded relPaths.
   */
  async function reconcileDeletions(vaultIdHint) {
    const tag = `[FeedTranscriptSource] org=${orgId}`;
    if (!manifestStore) { console.log(`${tag}: no durable state store, deletion reconciliation disabled`); return; }
    if (!listingComplete) {
      console.error(`${tag}: listing incomplete (dir ${dir} missing or unreadable), NOT reconciling deletions`);
      try {
        const raw = await manifestStore.get(orgId, manifestKey);
        const m = raw ? JSON.parse(raw) : null;
        const n = Array.isArray(m) ? m.length : (m && typeof m === 'object' ? Object.keys(m).length : 0);
        if (n > BRAKE_MIN_MANIFEST) result.deletionBlocked = `transcript dir missing or unreadable (${n} in manifest)`;
      } catch { /* surfaced by the log above */ }
      return;
    }
    let prevRaw = null;
    try { prevRaw = await manifestStore.get(orgId, manifestKey); } catch (err) {
      console.error(`${tag}: manifest read failed, NOT reconciling deletions, ${err.message}`);
      return;
    }
    let prev = null;
    if (prevRaw) {
      try {
        const parsed = JSON.parse(prevRaw);
        if (Array.isArray(parsed)) prev = Object.fromEntries(parsed.map((id) => [id, [`transcript/${id}.md`]]));
        else if (parsed && typeof parsed === 'object') prev = parsed;
      } catch { prev = null; }
    }
    const next = {};
    for (const e of entries) {
      next[e.sessionId] = sessionPaths.get(e.sessionId) || prev?.[e.sessionId] || [`transcript/${e.sessionId}.md`];
    }
    const persist = async () => {
      try { await manifestStore.set(orgId, manifestKey, JSON.stringify(next)); } catch (err) {
        console.error(`${tag}: manifest write failed, ${err.message}`);
      }
    };
    if (!prev) {
      console.log(`${tag}: first complete listing (${entries.length} sessions), recording manifest, no tombstones`);
      if (!dryRun) await persist();
      return;
    }
    const goneIds = Object.keys(prev).filter((id) => !(id in next));
    if (goneIds.length === 0) {
      if (!dryRun) await persist();
      return;
    }
    const prevCount = Object.keys(prev).length;
    // An empty readable dir is NOT exempt: an unmounted volume looks exactly
    // like that and would wipe every transcript note. The last few sessions
    // (manifest <= BRAKE_MIN_MANIFEST) still delete; a larger drop is refused.
    const pendingKey = `${SOURCE_TYPE}:pendingShrink`;
    if (prevCount > BRAKE_MIN_MANIFEST && entries.length < prevCount / 2) {
      const detail = `${entries.length} live vs ${prevCount} in manifest`;
      if (entries.length === 0 && !markerPresent) {
        // Held until the root marker proves the mount is real: an unmounted volume looks exactly like this.
        result.deletionSkipped = `partial session list (${detail})`;
        result.deletionBlocked = `deletions held: empty transcript dir without ${ROOT_MARKER} (${detail})`;
        console.error(`${tag}: ${result.deletionBlocked}, NOT deleting ${goneIds.length} sessions (manifest kept)`);
        if (!dryRun) { try { await manifestStore.set(orgId, pendingKey, ''); } catch { /* best effort */ } }
        return;
      }
      const fp = crypto.createHash('sha256').update(Object.keys(next).sort().join('\n')).digest('hex');
      let pending = null;
      try { pending = JSON.parse((await manifestStore.get(orgId, pendingKey)) || 'null'); } catch { pending = null; }
      const seen = pending && pending.fp === fp ? (Number(pending.count) || 0) + 1 : 1;
      if (seen < SHRINK_CONFIRM_TICKS) {
        if (!dryRun) {
          try { await manifestStore.set(orgId, pendingKey, JSON.stringify({ fp, count: seen })); } catch (err) {
            console.error(`${tag}: pendingShrink write failed, ${err.message}`);
          }
        }
        result.deletionSkipped = `partial session list (${detail})`;
        result.deletionBlocked = `large shrink (${detail}), awaiting confirmation ${seen}/${SHRINK_CONFIRM_TICKS}`;
        console.error(`${tag}: ${result.deletionBlocked}, NOT deleting ${goneIds.length} sessions yet (manifest kept)`);
        return;
      }
      console.log(`${tag}: shrink (${detail}) confirmed over ${seen} consecutive ticks, applying tombstones`);
    }
    // Authoritative empty snapshot: bound the batch; leftovers stay in the
    // manifest and drain on following ticks.
    let batchIds = goneIds;
    let leftover = false;
    if (entries.length === 0 && goneIds.length > MAX_TOMBSTONES_PER_TICK) {
      batchIds = goneIds.slice(0, MAX_TOMBSTONES_PER_TICK);
      leftover = true;
    }
    const relPaths = new Set();
    for (const id of batchIds) {
      relPaths.add(`transcript/${id}.md`);
      for (const rp of prev[id] || []) relPaths.add(rp);
    }
    let vaultId = vaultIdHint || null;
    try {
      if (!vaultId && !dryRun) vaultId = await ensurePushVaultFn(orgId, VAULT_NAME, { scope: 'org', userId, fetchImpl });
      // Best effort: pick up parts a legacy manifest never recorded.
      if (vaultId) {
        const known = await listVaultRelPathsFn(orgId, vaultId, { userId, fetchImpl });
        if (Array.isArray(known)) {
          for (const id of batchIds) {
            const re = new RegExp(`^transcript/${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.part\\d+\\.md$`);
            for (const rp of known) if (re.test(rp)) relPaths.add(rp);
          }
        }
      }
    } catch (err) {
      console.error(`${tag}: vault lookup failed, ${err.message}`);
    }
    if (dryRun) {
      result.wouldDelete = { sessions: batchIds.length, notes: relPaths.size };
      console.log(`${tag}: DRY RUN would tombstone ${batchIds.length} vanished sessions (${relPaths.size} notes), nothing sent`);
      return;
    }
    if (!vaultId) { console.error(`${tag}: ensurePushVault returned no vaultId, tombstones not sent`); return; }
    const del = await pushDeletionsFn(orgId, vaultId, [...relPaths], { userId, fetchImpl });
    if (del?.error) { console.error(`${tag}: tombstones failed, ${del.error} (manifest kept, will retry)`); return; }
    result.sessionsDeleted = batchIds.length;
    result.docsDeleted = relPaths.size;
    console.log(`${tag}: tombstoned ${batchIds.length} vanished sessions (${relPaths.size} notes)`);
    if (leftover) {
      const kept = Object.fromEntries(Object.entries(prev).filter(([id]) => !batchIds.includes(id)));
      try { await manifestStore.set(orgId, manifestKey, JSON.stringify(kept)); } catch (err) {
        console.error(`${tag}: manifest write failed, ${err.message}`);
      }
      result.deletionBlocked = `deletions continuing: ${goneIds.length - batchIds.length} sessions remain`;
      return;
    }
    await persist();
    try { await manifestStore.set(orgId, pendingKey, ''); } catch { /* best effort */ }
  }

  if (eligible.length === 0) {
    // BRAIN2 P2c: this return was silent while the watermark sat frozen for
    // weeks — every zero-doc tick must say why (no-silent-fallback rule).
    console.log(`[FeedTranscriptSource] org=${orgId}: 0 eligible of ${entries.length} sessions (dir=${dir}, watermark=${storedWatermark || 'none'}) — nothing to push`);
    await reconcileDeletions();
    return result;
  }

  const docs = [];
  const superseded = [];
  let newWatermark = storedWatermark || null;

  for (const entry of eligible) {
    try {
      const { docs: sessionDocs, supersededPaths } = await collectSessionDocuments(entry, fsImpl);
      docs.push(...sessionDocs);
      sessionPaths.set(entry.sessionId, sessionDocs.map((d) => d.relPath));
      superseded.push(...supersededPaths);
      result.sessionsRead++;
      if (entry.mtimeIso) processed.push({ ts: entry.mtimeIso, id: entry.sessionId });
    } catch (err) {
      console.error(`[FeedTranscriptSource] org=${orgId}: skipping session ${entry.sessionId} — ${err.message}`);
    }
  }

  newWatermark = feedWatermark.nextCursor(processed, remaining) || newWatermark;

  if (docs.length === 0) {
    console.log(`[FeedTranscriptSource] org=${orgId}: ${eligible.length} eligible sessions yielded 0 docs (sessionsRead=${result.sessionsRead}) — watermark NOT advancing past them`);
    await reconcileDeletions();
    return result;
  }

  if (dryRun) {
    console.log(`[FeedTranscriptSource] org=${orgId}: DRY RUN — ${docs.length} docs from ${result.sessionsRead} sessions, nothing pushed, watermark unchanged`);
    await reconcileDeletions();
    return result; // tallies sessionsRead, pushes/advances nothing
  }

  try {
    const vaultId = await ensurePushVaultFn(orgId, VAULT_NAME, { scope: 'org', userId, fetchImpl });
    if (!vaultId) {
      result.error = 'ensurePushVault returned no vaultId';
      console.error(`[FeedTranscriptSource] org=${orgId}: ${result.error} — not advancing watermark`);
      return result;
    }

    const pushResult = await pushDocumentsFn(orgId, vaultId, docs, { userId, fetchImpl });
    if (pushResult?.error) {
      result.error = pushResult.error;
      console.error(`[FeedTranscriptSource] org=${orgId}: push failed — ${pushResult.error} — not advancing watermark`);
      return result;
    }

    result.docsPushed = docs.length;
    if (superseded.length > 0) {
      const del = await pushDeletionsFn(orgId, vaultId, superseded, { userId, fetchImpl });
      if (del?.error) console.error(`[FeedTranscriptSource] org=${orgId}: superseded-note tombstone failed, ${del.error}`);
    }
    await reconcileDeletions(vaultId);
    console.log(`[FeedTranscriptSource] org=${orgId}: pushed ${docs.length} docs from ${result.sessionsRead} sessions to vault ${vaultId} (watermark ${storedWatermark || 'none'} -> ${newWatermark})`);

    if (newWatermark && newWatermark !== storedWatermark) {
      try {
        await setWatermarkFn(orgId, newWatermark);
      } catch (err) {
        console.error(`[FeedTranscriptSource] org=${orgId}: watermark write failed — ${err.message}`);
      }
    }
  } catch (err) {
    result.error = `push failed — ${err.message}`;
    console.error(`[FeedTranscriptSource] org=${orgId}: ${result.error} — not advancing watermark`);
  }

  return result;
}

module.exports = {
  ingestTranscripts,
  parseTranscriptFile,
  buildNoteParts,
  collectSessionDocuments,
  listTranscriptFiles,
  extractUserText,
  extractAssistantText,
  truncate,
  SOURCE_TYPE,
  VAULT_NAME,
  DEFAULT_TRANSCRIPT_DIR,
  DEFAULT_MAX_SESSIONS,
  _resetWarnedNoHostOrgForTest: () => { warnedNoHostOrg = false; },
};
