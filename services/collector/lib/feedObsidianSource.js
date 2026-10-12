/**
 * feedObsidianSource.js, Phase 1 of stream OBSIDIAN
 * (docs/STREAM_OBSIDIAN_PLAN.md), the Obsidian-vault-specific ingester for
 * The Feed.
 *
 * Mirrors feedFolderSource.js almost line for line (same path-safety guard,
 * same bounded/watermarked walk, same best-effort per-file error handling,
 * same dryRun and push shape) via the shared resolveSafeFolderPath,
 * walkFolder and MAX_FILE_BYTES exports of that module. The one thing an
 * Obsidian vault has that a plain folder does not: `[[wikilinks]]` between
 * notes. This module ports the wikilink-only subset of
 * services/quoxbrain/lib/vaultParser.js (maskCode + the embed/wikilink half
 * of extractLinks + stripWikiTarget), that file is ESM and lives in a
 * separate service package the CJS collector cannot `require()` directly,
 * the same reason brainFeedClient.js itself is a port rather than an
 * import of the quoxbrain readers.
 *
 * IMPORTANT, what the resolved `links` field on each pushed document
 * actually is: metadata only. The durable note-to-note graph is built
 * server-side, in Qortex's own ingest pipeline (services/quoxbrain/lib/
 * ingest.js's ingestDocuments -> parseNote -> replaceNoteLinks ->
 * resolveVaultLinks), which re-parses the raw markdown we push and
 * resolves links vault-wide, including by note title as well as basename.
 * ingestDocuments does not currently read a caller-supplied `links` array
 * at all. We still compute and ship it here (a) so this ingester's own
 * result (linksFound/linksResolved) is honest and testable without a live
 * Qortex round-trip, and (b) as forward-compatible observability for a
 * later phase. Because our resolution only matches by basename (not by
 * title, which we do not have an index of at push time), our
 * linksResolved count can under-report slightly versus the server's own
 * eventual graph for links written in "by title" wikilink form.
 *
 * WATERMARK NAMESPACE, deliberately 'obsidian:<hash>', never 'folder:',
 * so connecting the same directory as both a folder AND an obsidian source
 * never shares a cursor (see watermarkKeyForVaultPath()).
 *
 * CROSS-TICK LINK RESOLUTION, a note ingested this tick can link to a
 * note that was already ingested (and watermark-advanced past) in an
 * earlier tick. To resolve that, the basename index used for link
 * resolution is built from every entry the walk finds this tick (bounded
 * by MAX_WALK_ENTRIES, same budget as the folder source), not just the
 * watermark-eligible batch actually being pushed, see buildVaultIndex().
 *
 * Dark by default like every other source: the scheduler itself only
 * fires when QUOXFEED_ENABLED='true' and QUOXFEED_ORGS is set, and this
 * ingester additionally no-ops ({skipped:'no path'}) until an org has
 * explicitly connected a vault path via PUT /api/feed/sources/obsidian.
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const realFs = require('fs');
const feedWatermark = require('./feedWatermark.js');
const brainFeedClient = require('./brainFeedClient.js');
const { resolveSafeFolderPath, walkFolder, MAX_FILE_BYTES } = require('./feedFolderSource.js');
const feedSweep = require('./feedSweep.js');

const SOURCE_TYPE = 'obsidian';
const OBSIDIAN_EXTENSIONS = ['.md', '.markdown'];
// Obsidian's own config/trash folders, never worth walking, and skipping
// them saves walk budget for actual notes.
const IGNORED_DIRS = ['.obsidian', '.trash'];
const DEFAULT_MAX_FILES = 50;

const WIKI_EMBED_RE = /!\[\[([^\]]+)\]\]/g;
const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;

/**
 * Derives a short, stable, path-specific watermark key in the 'obsidian:'
 * namespace, distinct from feedFolderSource's 'folder:' namespace so the
 * same directory connected as both source types never shares a cursor.
 */
function watermarkKeyForVaultPath(rawPath) {
  const hash = crypto.createHash('sha1').update(String(rawPath)).digest('hex').slice(0, 12);
  return `${SOURCE_TYPE}:${hash}`;
}

/**
 * Blanks the interior of fenced (``` / ~~~) code blocks and inline `code`
 * spans with spaces of equal length, so no wikilink pattern can match
 * inside them while line/offset structure is preserved. Ported from
 * services/quoxbrain/lib/vaultParser.js's maskCode (source of truth).
 */
function maskCode(body) {
  let masked = body;

  masked = masked.replace(/(^|\n)([ \t]*)(```|~~~)[^\n]*\n([\s\S]*?)\n\2\3[ \t]*(?=\n|$)/g,
    (match, lead, indent, fence, inner) => {
      const blanked = inner.replace(/[^\n]/g, ' ');
      return `${lead}${indent}${fence}   \n${blanked}\n${indent}${fence}   `;
    });

  masked = masked.replace(/`([^`\n]+)`/g, (match, inner) => '`' + ' '.repeat(inner.length) + '`');

  return masked;
}

/**
 * "Target|alias" -> "Target"; "Target#heading" -> "Target". Ported from
 * vaultParser.js's stripWikiTarget.
 */
function stripWikiTarget(raw) {
  let t = raw.split('|')[0];
  t = t.split('#')[0];
  return t.trim();
}

/**
 * Extracts `[[wikilinks]]` and `![[embeds]]` from raw note content
 * (code-fence/inline-code safe). Embeds are matched first so the
 * wikilink pass doesn't double-count the `[[...]]` tail of an `![[...]]`
 * embed. Ported from vaultParser.js's extractLinks (wikilink/embed half
 * only, markdown/html link forms are not an Obsidian-specific concern
 * and are out of scope for phase 1).
 *
 * @returns {Array<{targetRaw: string, type: 'wikilink'|'embed'}>}
 */
function extractWikilinks(content) {
  const masked = maskCode(String(content || ''));
  const links = [];
  const seenEmbedSpans = [];

  let m;
  WIKI_EMBED_RE.lastIndex = 0;
  while ((m = WIKI_EMBED_RE.exec(masked)) !== null) {
    seenEmbedSpans.push([m.index, m.index + m[0].length]);
    const target = stripWikiTarget(m[1]);
    if (target) links.push({ targetRaw: target, type: 'embed' });
  }

  WIKI_LINK_RE.lastIndex = 0;
  while ((m = WIKI_LINK_RE.exec(masked)) !== null) {
    const withinEmbed = seenEmbedSpans.some(([s, e]) => m.index >= s && m.index < e);
    if (withinEmbed) continue;
    const target = stripWikiTarget(m[1]);
    if (target) links.push({ targetRaw: target, type: 'wikilink' });
  }

  return links;
}

/**
 * Builds a lowercase-basename (extension stripped) -> vault-relative
 * relPath index from ALL walked vault entries (not just the entries
 * eligible for this tick's push), first-wins on duplicate basenames.
 * Mirrors services/quoxbrain/lib/linkResolver.js's buildNoteIndex
 * byBasename semantics, scoped down to basename-only (the collector has
 * no note-title index at push time).
 *
 * @param {Array<{relPath: string}>} entries
 * @returns {Map<string,string>} lowercase basename -> vault-relative relPath
 */
function buildVaultIndex(entries) {
  const index = new Map();
  for (const entry of entries || []) {
    if (!entry || !entry.relPath) continue;
    const base = path.basename(entry.relPath).replace(/\.(md|markdown)$/i, '').toLowerCase();
    if (!index.has(base)) index.set(base, entry.relPath);
  }
  return index;
}

/**
 * Resolves a note's extracted wikilinks against the vault-wide basename
 * index, returning collector-observable metadata (see the file header
 * for what this is NOT: the durable graph the server builds).
 *
 * @param {Array<{targetRaw: string, type: string}>} links
 * @param {Map<string,string>} index
 * @returns {Array<{targetRaw: string, type: string, targetRelPath: string|null, resolved: boolean}>}
 */
function resolveWikilinks(links, index) {
  return (links || []).map((link) => {
    const baseKey = path.basename(link.targetRaw).replace(/\.(md|markdown)$/i, '').toLowerCase();
    const match = index.get(baseKey) || null;
    return {
      targetRaw: link.targetRaw,
      type: link.type,
      targetRelPath: match ? `obsidian/${match}` : null,
      resolved: !!match,
    };
  });
}

/**
 * Ingests `.md`/`.markdown` notes (recursive, bounded) under a CONNECTED
 * Obsidian vault path, `opts.config.path`, written via the feed_sources
 * registry (PUT /api/feed/sources/obsidian). No path, no ingestion
 * (`{skipped:'no path'}`); an unsafe path is likewise skipped, never read.
 *
 * @param {string} orgId
 * @param {{maxItems?: number, config?: {path: string, name?: string}, dryRun?: boolean}} [opts]
 * @param {{
 *   fs?: object,
 *   walk?: Function,
 *   getWatermarkFn?: Function,
 *   setWatermarkFn?: Function,
 *   ensurePushVaultFn?: Function,
 *   pushDocumentsFn?: Function,
 *   fetchImpl?: Function,
 *   userId?: string,
 *   dbPath?: string,
 * }} [deps]
 * @returns {Promise<{filesRead: number, docsPushed: number, linksFound: number, linksResolved: number, skipped: string|null, error: string|null}>}
 */
async function ingestObsidian(orgId, opts = {}, deps = {}) {
  const result = { filesRead: 0, docsPushed: 0, linksFound: 0, linksResolved: 0, skipped: null, error: null };

  // BRAIN2-W12 B1: honour the stored scope. A private (user) source needs an owner
  // and must never fall through to an org-visible vault.
  const vaultScope = opts.scope === 'user' ? 'user' : 'org';
  if (vaultScope === 'user' && !deps.userId) {
    result.skipped = 'user scope requires a user';
    return result;
  }

  const config = opts.config || null;
  const rawPath = config?.path;
  if (!rawPath) {
    result.skipped = 'no path';
    return result;
  }

  const guard = resolveSafeFolderPath(rawPath, { orgId });
  if (!guard.ok) {
    result.skipped = `unsafe path, ${guard.error}`;
    console.error(`[FeedObsidianSource] org=${orgId}: ${result.skipped} (raw: ${rawPath})`);
    return result;
  }

  const {
    fs: fsImpl = realFs,
    walk,
    getWatermarkFn,
    setWatermarkFn,
    ensurePushVaultFn = brainFeedClient.ensurePushVault,
    pushDocumentsFn = brainFeedClient.pushDocuments,
    pushDeletionsFn = brainFeedClient.pushDeletions,
    stateStore,
    fetchImpl,
    userId,
    dbPath,
  } = deps;
  // Resumable sweep + tombstones need a durable state store (see feedSweep.js).
  const sweepStore = stateStore || ((dbPath || !getWatermarkFn) ? feedSweep.defaultStore(dbPath) : null);

  const watermarkKey = watermarkKeyForVaultPath(guard.path);
  const getWM = getWatermarkFn || ((org) => feedWatermark.getWatermark(org, watermarkKey, { dbPath }));
  const setWM = setWatermarkFn || ((org, ts) => feedWatermark.setWatermark(org, watermarkKey, ts, { dbPath }));

  const maxFiles = opts.maxItems ?? DEFAULT_MAX_FILES;
  const dryRun = !!opts.dryRun;

  let storedWatermark = null;
  try {
    storedWatermark = await getWM(orgId);
  } catch (err) {
    console.error(`[FeedObsidianSource] org=${orgId}: watermark read failed, treating as no watermark, ${err.message}`);
  }

  let plan = null;
  let entries = [];
  let eligible;
  let remaining;
  if (sweepStore && typeof walk !== 'function') {
    try {
      plan = await feedSweep.planRoot({
        store: sweepStore, orgId, key: watermarkKey, root: guard.path, fsImpl,
        walkOpts: { extensions: OBSIDIAN_EXTENSIONS, ignoreDirs: IGNORED_DIRS }, maxFiles, storedWatermark,
        maxFileBytes: MAX_FILE_BYTES, prefix: (rel) => `obsidian/${rel}`,
      });
    } catch (err) {
      result.error = `walk failed, ${err.message}`;
      console.error(`[FeedObsidianSource] org=${orgId}: ${result.error}`);
      return result;
    }
    // On a multi-page pass the link index covers the pages walked this tick.
    entries = plan.entries;
    eligible = plan.eligible;
    remaining = plan.remaining;
  } else {
    try {
      entries = typeof walk === 'function'
        ? (await walk(guard.path, fsImpl)) || []
        : walkFolder(guard.path, fsImpl, { extensions: OBSIDIAN_EXTENSIONS, ignoreDirs: IGNORED_DIRS });
    } catch (err) {
      result.error = `walk failed, ${err.message}`;
      console.error(`[FeedObsidianSource] org=${orgId}: ${result.error}`);
      return result;
    }
    // Compound (mtime, relPath) cursor, see feedFolderSource.js (BRAIN2-V3 A4).
    const allEligible = entries
      .filter((e) => feedWatermark.isAfterCursor(storedWatermark, e.mtimeIso, e.relPath) && e.sizeBytes <= MAX_FILE_BYTES)
      .sort((a, b) => feedWatermark.compareByTsId({ ts: a.mtimeIso, id: a.relPath }, { ts: b.mtimeIso, id: b.relPath }));
    eligible = allEligible.slice(0, maxFiles);
    remaining = allEligible.slice(maxFiles).map((e) => ({ ts: e.mtimeIso, id: e.relPath }));
  }

  // Vault-wide index (all walked entries) so links to notes ingested in
  // earlier ticks still resolve even though those notes are no longer
  // watermark-eligible this tick.
  const vaultIndex = buildVaultIndex(entries);

  const vaultName = config.name || `Obsidian: ${path.basename(guard.path)}`;
  const ensureVault = async () => ensurePushVaultFn(orgId, vaultName, { scope: vaultScope, userId, fetchImpl });
  const finishSweep = async () => {
    if (!plan) return;
    const r = await plan.finish({ ensureVault, pushDeletionsFn, pushOpts: { userId, fetchImpl }, setWM: (ts) => setWM(orgId, ts), dryRun });
    if (r.deleted > 0) result.deleted = r.deleted;
    if (r.error) { result.error = r.error; console.error(`[FeedObsidianSource] org=${orgId}: ${r.error}`); }
  };

  if (eligible.length === 0) { await finishSweep(); return result; }

  const docs = [];
  const processed = [];

  for (const entry of eligible) {
    try {
      const content = fsImpl.readFileSync(entry.filePath, 'utf8');
      const rawLinks = extractWikilinks(content);
      const resolvedLinks = resolveWikilinks(rawLinks, vaultIndex);
      result.linksFound += rawLinks.length;
      result.linksResolved += resolvedLinks.filter((l) => l.resolved).length;

      docs.push({
        relPath: `obsidian/${entry.relPath}`,
        content,
        // Title deliberately omitted: Qortex's own parseNote resolves
        // frontmatter.title > first H1 > filename, which is the
        // Obsidian-correct precedence (unlike the folder source, which
        // hardcodes the filename).
        kind: 'obsidian_note',
        sourceType: SOURCE_TYPE,
        occurredAt: entry.mtimeIso,
        links: resolvedLinks,
      });
      result.filesRead++;
      if (entry.mtimeIso && !entry.catchUp) processed.push({ ts: entry.mtimeIso, id: entry.relPath });
    } catch (err) {
      console.error(`[FeedObsidianSource] org=${orgId}: skipping ${entry.relPath}, ${err.message}`);
    }
  }

  if (docs.length === 0) { await finishSweep(); return result; }
  const newWatermark = feedWatermark.nextCursor(processed, remaining);

  if (dryRun) return result; // tallies filesRead/links, pushes/advances nothing

  try {
    const vaultId = await ensureVault();
    if (!vaultId) {
      result.error = 'ensurePushVault returned no vaultId';
      console.error(`[FeedObsidianSource] org=${orgId}: ${result.error}, not advancing watermark`);
      return result;
    }

    const pushResult = await pushDocumentsFn(orgId, vaultId, docs, { userId, fetchImpl });
    if (pushResult?.error) {
      result.error = pushResult.error;
      console.error(`[FeedObsidianSource] org=${orgId}: push failed, ${pushResult.error}, not advancing watermark`);
      return result;
    }

    result.docsPushed = docs.length;

    if (!(plan && plan.multiPage) && newWatermark && newWatermark !== storedWatermark) {
      try {
        await setWM(orgId, newWatermark);
      } catch (err) {
        console.error(`[FeedObsidianSource] org=${orgId}: watermark write failed, ${err.message}`);
      }
    }
    await finishSweep();
  } catch (err) {
    result.error = `push failed, ${err.message}`;
    console.error(`[FeedObsidianSource] org=${orgId}: ${result.error}, not advancing watermark`);
  }

  return result;
}

module.exports = {
  ingestObsidian,
  extractWikilinks,
  buildVaultIndex,
  resolveWikilinks,
  watermarkKeyForVaultPath,
  SOURCE_TYPE,
  OBSIDIAN_EXTENSIONS,
  IGNORED_DIRS,
  DEFAULT_MAX_FILES,
};
