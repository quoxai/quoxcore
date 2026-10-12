/**
 * feedGitSource.js, The Feed's git repository ingester (catalog sourceType
 * 'git', connector 'host', requiresConfig true).
 *
 * Mirrors feedFolderSource.js/feedObsidianSource.js's control flow (guard,
 * watermark-per-path, strictly-after filter, ascending sort, bounded
 * slice, dryRun early return, ensurePushVault, pushDocuments, watermark
 * advanced only on a clean push), swapping the filesystem walk for a
 * single bounded `git log` read. The path-safety guard is reused as-is
 * from feedFolderSource.js (resolveSafeFolderPath), so FEED_FOLDER_ALLOWED_ROOTS
 * fences connected repo paths too.
 *
 * GIT READ, one bounded exec per tick: `git -c safe.directory=* -C <path>
 * log -n <MAX_LOG_COMMITS> --no-merges --name-only --format=...`. The
 * safe.directory=* flag mirrors server.js's own gitExec() (the collector's
 * only other git caller): the container mounts host repos read-only at a
 * different uid, so git otherwise refuses with a dubious-ownership error.
 * The commit cap (-n) bounds the exec itself, not just the result set, so
 * a repository with a huge history can't turn one tick into an unbounded
 * read.
 *
 * PARSING, the format string uses \x1e (record separator) between commits
 * and \x1f (field separator) between fields, with a trailing \x1f after
 * the body so --name-only's file list is always the last, unambiguous
 * segment of each record. A malformed record (wrong field count) is
 * skipped, never aborts the batch, same best-effort contract as every
 * other ingester's per-item try/catch.
 *
 * WATERMARK, keyed 'git:<sha1(path)-first12>', same per-path namespacing
 * as feedFolderSource's 'folder:' and feedObsidian's 'obsidian:' keys, so
 * two connected repos (or the same repo reconnected under a different
 * config) never share a cursor. Committer dates come from git's %cI
 * (strict ISO 8601 with the committer's local offset) and are normalized
 * to UTC via `new Date(raw).toISOString()` before comparison, so the
 * watermark filter is a plain lexicographic string compare like every
 * other source, matching wall-clock order regardless of the commit's
 * original offset.
 *
 * KNOWN LIMITS (documented, not fixed here): a rebase or force-push that
 * rewrites history can carry committer dates older than the stored
 * watermark, those rewritten commits are never ingested; an amended
 * commit gets a new sha, so the old note for it lingers in the vault as a
 * stale, orphaned entry. Acceptable for an autopilot notes source. A repo
 * path that exists on the host but isn't under the container's read-only
 * mount degrades to git exit 128, treated as zero commits (a silent
 * connected-but-empty result, not an error), same degrade-on-128 the
 * server.js gitExec() caller already relies on.
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const feedWatermark = require('./feedWatermark.js');
const brainFeedClient = require('./brainFeedClient.js');
const { resolveSafeFolderPath } = require('./feedFolderSource.js');

const SOURCE_TYPE = 'git';
const DEFAULT_MAX_COMMITS = 50;
// Bounds the `git log` read itself, not just the pushed result set, so a
// repo with a huge history can't turn one tick into an unbounded read.
const MAX_LOG_COMMITS = 200;
// A commit body is truncated (never grown) past this many bytes before
// being rendered into a note.
const MAX_BODY_BYTES = 8192;
// The rendered "changed files" list is truncated at this many entries,
// with a "plus N more" trailer, past this cap.
const MAX_FILES_PER_COMMIT = 100;

const RECORD_SEP = '\x1e';
const FIELD_SEP = '\x1f';
const GIT_LOG_FORMAT = `${RECORD_SEP}%H${FIELD_SEP}%h${FIELD_SEP}%an${FIELD_SEP}%cI${FIELD_SEP}%s${FIELD_SEP}%b${FIELD_SEP}`;

/**
 * Derives a short, stable, path-specific watermark key in the 'git:'
 * namespace, so two different connected repos (or the same repo
 * reconnected under a new config) never share a cursor.
 */
function watermarkKeyForRepoPath(rawPath) {
  const hash = crypto.createHash('sha1').update(String(rawPath)).digest('hex').slice(0, 12);
  return `${SOURCE_TYPE}:${hash}`;
}

/**
 * Runs `git log` against repoPath with the fixed record/field-separated
 * format, bounded to MAX_LOG_COMMITS commits. Resolves to '' (never
 * rejects) on exit code 128 (not a git repo, dubious ownership, missing
 * path), mirroring server.js's own gitExec(). Injectable via deps for
 * tests.
 *
 * @param {string} repoPath
 * @returns {Promise<string>} raw stdout, or '' on a degrade-worthy failure
 */
function execGitRaw(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { maxBuffer: 4 * 1024 * 1024, timeout: 15000, shell: false, ...opts }, (err, stdout) => {
      if (err) {
        if (err.code === 128) return resolve('');
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

/**
 * BRAIN2-W7 A 032: the read window is the OLDEST MAX_LOG_COMMITS commits at or
 * after `afterIso` (the stored cursor's timestamp), not the newest N. With
 * no cursor that is the oldest commits of the whole history, so initial
 * history and long outages drain across ticks instead of leaving a gap
 * behind the newest 200. `git log` lists newest first, so the oldest window
 * is `--skip=<count - N>`.
 */
async function execGit(repoPath, { afterIso = null } = {}) {
  const base = ['-c', 'safe.directory=*', '-C', repoPath];
  const range = ['--no-merges'];
  if (afterIso) {
    const t = new Date(afterIso).getTime();
    if (Number.isFinite(t)) range.push(`--since=${new Date(t - 1000).toISOString()}`);
  }
  const countOut = await execGitRaw([...base, 'rev-list', '--count', ...range, 'HEAD']);
  const total = parseInt(String(countOut).trim(), 10);
  const skip = Number.isFinite(total) && total > MAX_LOG_COMMITS ? total - MAX_LOG_COMMITS : 0;
  return execGitRaw([
    ...base, 'log', '-n', String(MAX_LOG_COMMITS), ...(skip ? ['--skip', String(skip)] : []),
    ...range, '--name-only', `--format=${GIT_LOG_FORMAT}`,
  ]);
}

/**
 * Parses the raw `git log` stdout produced by execGit() into an array of
 * commit records. Each record is split by the field separator into
 * exactly 7 parts (sha, shortSha, author, raw committer date, subject,
 * body, file-list text); a record with the wrong field count is skipped,
 * never aborts the parse. The committer date is normalized to a UTC ISO
 * string via `new Date(raw).toISOString()` so watermark comparisons are a
 * plain lexicographic compare.
 *
 * @param {string} raw
 * @returns {Array<{sha:string, shortSha:string, author:string, committedAtIso:string, subject:string, body:string, files:string[]}>}
 */
function parseGitLog(raw) {
  if (!raw) return [];
  const commits = [];
  const records = raw.split(RECORD_SEP).filter((r) => r.length > 0);

  for (const record of records) {
    try {
      const parts = record.split(FIELD_SEP);
      // format emits 7 fields (sha, short, author, date, subject, body, files); a
      // trailing empty string from the format's own trailing separator is
      // acceptable, anything short of 7 fields is malformed.
      if (parts.length < 7) continue;
      const [sha, shortSha, author, rawDate, subject, body, fileListText] = parts;
      if (!sha || !rawDate) continue;

      const parsedDate = new Date(rawDate);
      if (Number.isNaN(parsedDate.getTime())) continue;

      const files = String(fileListText || '')
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean);

      commits.push({
        sha,
        shortSha: shortSha || sha.slice(0, 7),
        author: author || 'unknown',
        committedAtIso: parsedDate.toISOString(),
        subject: subject || '(no subject)',
        body: body || '',
        files,
      });
    } catch {
      continue; // malformed record, skip, never abort the batch
    }
  }

  return commits;
}

/**
 * Renders one parsed commit into a Qortex push document. The body is
 * truncated at MAX_BODY_BYTES, the file list at MAX_FILES_PER_COMMIT (with
 * a "plus N more" trailer past the cap), so a pathological commit can
 * never blow the note past a bounded size.
 *
 * @param {{sha:string, shortSha:string, author:string, committedAtIso:string, subject:string, body:string, files:string[]}} commit
 * @param {string} repoBasename
 * @returns {{relPath:string, content:string, title:string, kind:string, sourceType:string, occurredAt:string}}
 */
function renderCommitNote(commit, repoBasename) {
  const truncatedBody = Buffer.byteLength(commit.body, 'utf8') > MAX_BODY_BYTES
    ? Buffer.from(commit.body, 'utf8').slice(0, MAX_BODY_BYTES).toString('utf8')
    : commit.body;

  const shownFiles = commit.files.slice(0, MAX_FILES_PER_COMMIT);
  const extraFiles = commit.files.length - shownFiles.length;
  const fileLines = shownFiles.map((f) => `- ${f}`).join('\n')
    + (extraFiles > 0 ? `\n- plus ${extraFiles} more` : '');

  const content = [
    `# ${commit.subject}`,
    '',
    `Repo: ${repoBasename}`,
    `Commit: ${commit.sha}`,
    `Author: ${commit.author}`,
    `Date: ${commit.committedAtIso}`,
    '',
    'Changed files:',
    fileLines || '(none)',
    '',
    truncatedBody.trim(),
  ].join('\n');

  return {
    relPath: `git/${repoBasename}/${commit.shortSha}.md`,
    content,
    title: `${commit.shortSha} ${commit.subject}`.slice(0, 120),
    kind: 'git_commit',
    sourceType: SOURCE_TYPE,
    occurredAt: commit.committedAtIso,
  };
}

/**
 * Ingests recent commit history (bounded, watermarked) from a CONNECTED
 * git repository, `opts.config.path`, written via the feed_sources
 * registry (PUT /api/feed/sources/git). No path, no ingestion
 * (`{skipped:'no path'}`); an unsafe path is likewise skipped, never
 * read.
 *
 * @param {string} orgId
 * @param {{maxItems?: number, config?: {path: string, name?: string}, dryRun?: boolean}} [opts]
 * @param {{
 *   execGitFn?: Function,            // (repoPath) => Promise<string> raw git log stdout (tests)
 *   getWatermarkFn?: Function,
 *   setWatermarkFn?: Function,
 *   ensurePushVaultFn?: Function,
 *   pushDocumentsFn?: Function,
 *   fetchImpl?: Function,
 *   userId?: string,
 *   dbPath?: string,
 * }} [deps]
 * @returns {Promise<{commitsRead:number, docsPushed:number, skipped:string|null, error:string|null}>}
 */
const MAX_REPOS_PER_TICK = 10;

async function ingestGitHistory(orgId, opts = {}, deps = {}) {
  // Several repositories (config.roots, already validated by the sources PUT
  // like every host path): each root is ingested on its own, into its own
  // vault with its own per-path watermark, and the counts are summed. One
  // unsafe or failing root never stops the others.
  const roots = Array.isArray(opts.config?.roots)
    ? [...new Set(opts.config.roots.filter((r) => typeof r === 'string' && r))].slice(0, MAX_REPOS_PER_TICK)
    : [];
  if (roots.length === 0) return ingestOneRepo(orgId, opts, deps);
  const total = { commitsRead: 0, docsPushed: 0, skipped: null, error: null };
  const skipped = [];
  const errors = [];
  for (const root of roots) {
    const { roots: _drop, name: _name, ...rest } = opts.config;
    const r = await ingestOneRepo(orgId, { ...opts, config: { ...rest, path: root } }, deps);
    total.commitsRead += r.commitsRead;
    total.docsPushed += r.docsPushed;
    if (r.skipped) skipped.push(`${path.basename(root)}: ${r.skipped}`);
    if (r.error) errors.push(`${path.basename(root)}: ${r.error}`);
  }
  if (skipped.length === roots.length) total.skipped = skipped.join('; ');
  if (errors.length) total.error = errors.join('; ');
  return total;
}

async function ingestOneRepo(orgId, opts = {}, deps = {}) {
  const result = { commitsRead: 0, docsPushed: 0, skipped: null, error: null };

  const config = opts.config || null;
  const rawPath = config?.path;
  if (!rawPath) {
    result.skipped = 'no path';
    return result;
  }

  const guard = resolveSafeFolderPath(rawPath, { orgId });
  if (!guard.ok) {
    result.skipped = `unsafe path, ${guard.error}`;
    console.error(`[FeedGitSource] org=${orgId}: ${result.skipped} (raw: ${rawPath})`);
    return result;
  }

  const {
    execGitFn = execGit,
    getWatermarkFn,
    setWatermarkFn,
    ensurePushVaultFn = brainFeedClient.ensurePushVault,
    pushDocumentsFn = brainFeedClient.pushDocuments,
    fetchImpl,
    userId,
    dbPath,
  } = deps;

  const watermarkKey = watermarkKeyForRepoPath(guard.path);
  const getWM = getWatermarkFn || ((org) => feedWatermark.getWatermark(org, watermarkKey, { dbPath }));
  const setWM = setWatermarkFn || ((org, ts) => feedWatermark.setWatermark(org, watermarkKey, ts, { dbPath }));

  const maxCommits = opts.maxItems ?? DEFAULT_MAX_COMMITS;
  const dryRun = !!opts.dryRun;

  let storedWatermark = null;
  try {
    storedWatermark = await getWM(orgId);
  } catch (err) {
    console.error(`[FeedGitSource] org=${orgId}: watermark read failed, treating as no watermark, ${err.message}`);
  }

  let raw = '';
  try {
    raw = (await execGitFn(guard.path, { afterIso: feedWatermark.parseCursor(storedWatermark)?.ts || null })) || '';
  } catch (err) {
    result.error = `git log failed, ${err.message}`;
    console.error(`[FeedGitSource] org=${orgId}: ${result.error}`);
    return result;
  }

  const commits = parseGitLog(raw);

  // Compound (committer time, sha) cursor (BRAIN2-W5 033): commits tied on one
  // timestamp beyond the per-tick cap are still owed on the next tick.
  const allEligible = commits
    .filter((c) => feedWatermark.isAfterCursor(storedWatermark, c.committedAtIso, c.sha))
    .sort((a, b) => feedWatermark.compareByTsId({ ts: a.committedAtIso, id: a.sha }, { ts: b.committedAtIso, id: b.sha }));
  const eligible = allEligible.slice(0, maxCommits);
  const remaining = allEligible.slice(maxCommits).map((c) => ({ ts: c.committedAtIso, id: c.sha }));
  const processed = [];

  if (eligible.length === 0) return result;

  const repoBasename = path.basename(guard.path);
  const docs = [];
  let newWatermark = storedWatermark || null;

  for (const commit of eligible) {
    try {
      docs.push(renderCommitNote(commit, repoBasename));
      result.commitsRead++;
      processed.push({ ts: commit.committedAtIso, id: commit.sha });
    } catch (err) {
      console.error(`[FeedGitSource] org=${orgId}: skipping commit ${commit.shortSha}, ${err.message}`);
    }
  }

  newWatermark = feedWatermark.nextCursor(processed, remaining) || newWatermark;

  if (docs.length === 0) return result;

  if (dryRun) return result; // tallies commitsRead, pushes/advances nothing

  try {
    const vaultName = config.name || `Git History: ${repoBasename}`;
    const vaultId = await ensurePushVaultFn(orgId, vaultName, { scope: 'org', userId, fetchImpl });
    if (!vaultId) {
      result.error = 'ensurePushVault returned no vaultId';
      console.error(`[FeedGitSource] org=${orgId}: ${result.error}, not advancing watermark`);
      return result;
    }

    const pushResult = await pushDocumentsFn(orgId, vaultId, docs, { userId, fetchImpl });
    if (pushResult?.error) {
      result.error = pushResult.error;
      console.error(`[FeedGitSource] org=${orgId}: push failed, ${pushResult.error}, not advancing watermark`);
      return result;
    }

    result.docsPushed = docs.length;

    if (newWatermark && newWatermark !== storedWatermark) {
      try {
        await setWM(orgId, newWatermark);
      } catch (err) {
        console.error(`[FeedGitSource] org=${orgId}: watermark write failed, ${err.message}`);
      }
    }
  } catch (err) {
    result.error = `push failed, ${err.message}`;
    console.error(`[FeedGitSource] org=${orgId}: ${result.error}, not advancing watermark`);
  }

  return result;
}

module.exports = {
  ingestGitHistory,
  parseGitLog,
  renderCommitNote,
  watermarkKeyForRepoPath,
  SOURCE_TYPE,
  GIT_LOG_FORMAT,
  DEFAULT_MAX_COMMITS,
  MAX_LOG_COMMITS,
  MAX_REPOS_PER_TICK,
  MAX_BODY_BYTES,
  MAX_FILES_PER_COMMIT,
};
