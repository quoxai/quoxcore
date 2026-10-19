/**
 * docsBrowser.js — DEVSUITE-DOCS Phase 1+2, documentation browser backend.
 *
 * Reads docs that already exist on disk — no new indexer:
 *   - `<repo>/CODEBASE_MAP.md` for every sibling repo under ~
 *     that has one (produced by `/codebase-mirror`, see CODEBASE_MAP.md's
 *     own header in this repo for the exact format).
 *   - `docs/STATUS_AND_LIMITS_<SURFACE>.md` in this repo.
 *
 * The collector's Docker container has ~ mounted at the SAME
 * path ~ (confirmed via `docker inspect quox-collector`), so
 * every sibling repo's files are reachable via normal Node `fs` calls —
 * no new mount or permission work needed.
 *
 * PATH SAFETY — mirrors skillPackInstaller.js's sanitizeRelPath() discipline
 * (itself mirroring quoxagent's sanitizeInputPath(), internal/runner/
 * runner.go): every `:repo` / `:name` route param is checked against an
 * ALLOWLIST of names actually discovered on disk (repo directory names /
 * STATUS_AND_LIMITS_* doc names — an attacker-controlled value can never
 * match an allowlist entry it didn't already produce by scanning the real
 * filesystem), AND the resulting path is re-verified to resolve inside its
 * expected base directory before any read — defence in depth, not "trust
 * the allowlist alone".
 *
 * DRIFT DETECTION — a repo's CODEBASE_MAP.md carries a
 * `<!-- Last verified: YYYY-MM-DD ... -->` header line (see this repo's own
 * CODEBASE_MAP.md line 1) written by `/codebase-mirror`. That date is
 * compared against the repo's actual last commit time
 * (`git -C <repo> log -1 --format=%ct`, run via execFileSync with an argv
 * array — never a shell string — and only ever against a path already
 * allowlist-validated above). No "Last verified" header falls back to the
 * map file's own mtime. A map dated/modified before the last real commit is
 * flagged stale.
 */

'use strict';

const { hostHome, hostPath } = require('../utils/runtimePaths.js');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_HOME_CONTROL = hostHome();

// The docs directory, resolved the SAME way the repo maps are.
//
// This used to be `path.join(__dirname, '..', '..', '..', 'docs')`, which is
// correct when the file sits at services/collector/lib in a checkout and wrong
// everywhere else. In the container the collector is flattened to /app, so
// __dirname is /app/lib and the path resolved to `/docs`, which does not exist.
// GET /api/v1/docs/status-and-limits therefore answered
// `{"count":0,"docs":[],"rollup":{"totalDocs":0}}` and the Dev Suite hub
// printed "No structured maturity data across 0 docs" while five
// STATUS_AND_LIMITS_*.md files sat right there in the mounted repo.
//
// Worse than a blank panel: STATUS_AND_LIMITS is the file the house rules call
// the source of truth for what works and what does not, so the one surface
// meant to report honest maturity was reporting that we track none.
//
// Deriving it from homeControl, like discoverRepoMaps already does, means the
// packaged layout and the checkout layout agree.
const DEFAULT_DOCS_DIR = path.join(DEFAULT_HOME_CONTROL, 'quox-dashboard', 'docs');

const LAST_VERIFIED_RE = /Last verified:\s*(\d{4}-\d{2}-\d{2})/i;
// Hyphen included 2026-08-19. STATUS_AND_LIMITS_DEV-SERVERS.md — the status
// doc for the Dev Suite hub ITSELF — was invisible in the Dev Suite's own docs
// panel: 43 files on disk, 42 listed, and the reader answered
// "unknown status-and-limits doc 'DEV-SERVERS'" for a file sitting right there.
//
// Safe against the traversal this pattern exists to prevent: the class still
// excludes '/' and '.', so '..' and any path separator remain unrepresentable,
// and the resolved name is re-checked against the discovered set before any
// read. A hyphen buys a legal filename, not an escape. ('-' sits last in the
// class so it is a literal, not a range.)
const STATUS_LIMITS_FILE_RE = /^STATUS_AND_LIMITS_([A-Z0-9_-]+)\.md$/;
const GIT_LOG_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Repo discovery + CODEBASE_MAP.md
// ---------------------------------------------------------------------------

// Globs ~/*/CODEBASE_MAP.md dynamically — never a hardcoded
// list, so a repo gaining or losing a map is picked up on the next request.
function discoverRepoMaps({ homeControl = DEFAULT_HOME_CONTROL } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(homeControl, { withFileTypes: true });
  } catch {
    return [];
  }
  const repos = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const mapPath = path.join(homeControl, entry.name, 'CODEBASE_MAP.md');
    if (!fs.existsSync(mapPath)) continue;

    // Skip git WORKTREES. A worktree is a second checkout of a repo that is
    // already in this list, so it carries the same CODEBASE_MAP.md and shows
    // up as a distinct "repo" that no customer has ever heard of.
    //
    // 2026-08-19: the hub listed 18 repos, three of which were worktrees —
    // quox-dashboard-aee-full, quox-dashboard-clean-main (map "verified"
    // 2026-03-30) and quoxflow-aee-full. They are internal working copies,
    // they read as abandoned products, and their stale maps padded the stale
    // count from 8 to 11.
    //
    // The discriminator is exact and cheap: a real repo has a .git DIRECTORY,
    // a worktree has a .git FILE containing "gitdir: ...". Verified against
    // all five candidates before relying on it.
    try {
      const gitPath = path.join(homeControl, entry.name, '.git');
      if (fs.existsSync(gitPath) && fs.statSync(gitPath).isFile()) continue;
    } catch {
      // Unreadable .git: fall through and list it rather than hide a repo
      // because of a permissions blip.
    }
    repos.push(entry.name);
  }
  return repos.sort();
}

// Resolves + validates a repo name into its CODEBASE_MAP.md path. Rejects,
// never escapes: the repo must be an exact match against a name discovered
// by discoverRepoMaps() above (the allowlist), and the joined path is
// re-verified to still resolve inside homeControl before being returned.
function resolveRepoMapPath(repo, deps = {}) {
  const { homeControl = DEFAULT_HOME_CONTROL } = deps;
  if (typeof repo !== 'string' || repo.length === 0) {
    throw new Error('docsBrowser: empty repo name');
  }

  const knownRepos = discoverRepoMaps({ homeControl });
  if (!knownRepos.includes(repo)) {
    throw new Error(`docsBrowser: unknown repo '${repo}'`);
  }

  const clean = path.normalize(repo);
  if (path.isAbsolute(clean) || clean === '..' || clean.includes(path.sep) || clean.includes('/')) {
    throw new Error(`docsBrowser: invalid repo path '${repo}'`);
  }

  const target = path.join(homeControl, clean, 'CODEBASE_MAP.md');
  const rel = path.relative(homeControl, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`docsBrowser: path traversal not allowed: ${repo}`);
  }

  return target;
}

function parseLastVerified(content) {
  const match = typeof content === 'string' ? content.match(LAST_VERIFIED_RE) : null;
  if (!match) return null;
  const d = new Date(`${match[1]}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Runs `git -C <repoDir> log -1 --format=%ct` (last commit, epoch seconds).
// repoDir must already be allowlist-validated by the caller (it's always
// derived from resolveRepoMapPath's own validated repo name here). Uses
// execFileSync with an argv array — never a shell string — so there is no
// injection surface regardless.
function defaultGitLastCommitEpochSeconds(repoDir) {
  // `-c safe.directory=<repoDir>` is required, not belt-and-braces.
  //
  // The collector runs as `quox` while the repos on the host are owned by
  // `control`, and git refuses to operate on a repo owned by another user:
  //   fatal: detected dubious ownership in repository at hostPath('QuoxBastion')
  // Every single call failed on that, so all 18 repos reported
  // `stale: null, reason: git_log_unavailable` and the Dev Suite hub showed
  // "DRIFT UNKNOWN" on every row. A status that is unknown for everything,
  // always, is indistinguishable from a broken feature — and it was one.
  //
  // Scoped to the one repoDir rather than the `*` wildcard: the caller has
  // already allowlist-validated this path, and a global exemption would apply
  // to any repository the process is ever pointed at.
  const out = execFileSync(
    'git',
    ['-c', `safe.directory=${repoDir}`, '-C', repoDir, 'log', '-1', '--format=%ct'],
    { encoding: 'utf8', timeout: GIT_LOG_TIMEOUT_MS },
  ).trim();
  return out;
}

// Compares a repo's CODEBASE_MAP.md "Last verified" header (or file mtime,
// if the header is absent) against the repo's actual last commit time.
// `gitLogFn` is dependency-injected for tests; production calls the real
// `git log`.
function computeDriftStatus(repo, deps = {}) {
  const { homeControl = DEFAULT_HOME_CONTROL, gitLogFn = defaultGitLastCommitEpochSeconds } = deps;

  const mapPath = resolveRepoMapPath(repo, { homeControl });

  let content;
  try {
    content = fs.readFileSync(mapPath, 'utf8');
  } catch (err) {
    return { repo, stale: null, reason: 'map_unreadable', error: err.message };
  }

  const lastVerified = parseLastVerified(content);
  const mapStat = fs.statSync(mapPath);
  const mapReferenceMs = lastVerified ? lastVerified.getTime() : mapStat.mtimeMs;
  const mapReferenceSource = lastVerified ? 'last_verified_header' : 'mtime';

  const repoDir = path.join(homeControl, repo);
  let lastCommitEpochSeconds;
  try {
    lastCommitEpochSeconds = gitLogFn(repoDir);
  } catch (err) {
    return {
      repo,
      stale: null,
      reason: 'git_log_unavailable',
      error: err.message,
      mapLastVerified: lastVerified ? lastVerified.toISOString() : null,
      mapReferenceSource,
    };
  }

  const lastCommitMs = lastCommitEpochSeconds ? Number(lastCommitEpochSeconds) * 1000 : NaN;
  if (!lastCommitEpochSeconds || Number.isNaN(lastCommitMs)) {
    return {
      repo,
      stale: null,
      reason: 'no_commits',
      mapLastVerified: lastVerified ? lastVerified.toISOString() : null,
      mapReferenceSource,
    };
  }

  return {
    repo,
    stale: mapReferenceMs < lastCommitMs,
    mapLastVerified: lastVerified ? lastVerified.toISOString() : null,
    mapReferenceSource,
    repoLastCommitAt: new Date(lastCommitMs).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// STATUS_AND_LIMITS_*.md
// ---------------------------------------------------------------------------

function listStatusAndLimitsDocs(deps = {}) {
  const { docsDir = DEFAULT_DOCS_DIR } = deps;
  let files;
  try {
    files = fs.readdirSync(docsDir);
  } catch {
    return [];
  }
  return files
    .map((f) => ({ file: f, match: f.match(STATUS_LIMITS_FILE_RE) }))
    .filter((entry) => entry.match)
    .map((entry) => ({ name: entry.match[1], file: entry.file }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Resolves + validates a STATUS_AND_LIMITS name into its file path, same
// allowlist + re-verify discipline as resolveRepoMapPath above.
function resolveStatusAndLimitsPath(name, deps = {}) {
  const { docsDir = DEFAULT_DOCS_DIR } = deps;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('docsBrowser: empty status-and-limits name');
  }

  const known = listStatusAndLimitsDocs({ docsDir }).map((d) => d.name);
  if (!known.includes(name)) {
    throw new Error(`docsBrowser: unknown status-and-limits doc '${name}'`);
  }

  const file = `STATUS_AND_LIMITS_${name}.md`;
  const target = path.join(docsDir, file);
  const rel = path.relative(docsDir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`docsBrowser: path traversal not allowed: ${name}`);
  }

  return target;
}

// ---------------------------------------------------------------------------
// Maturity table parsing — DEVSUITE-DOCS Phase 3
//
// Real STATUS_AND_LIMITS_*.md docs are NOT uniform. Confirmed by reading the
// full corpus (33 docs) rather than assuming the template:
//   - MAJORITY (24 docs) + the canonical STATUS_AND_LIMITS_TEMPLATE.md spec
//     use `## Maturity table` with a 3-column `| Capability | Status | Notes |`.
//   - A minority (4 docs, e.g. QSKL_SAFETY) predate the template and use
//     `## Capability maturity` with a 4-column
//     `| Capability | Tag | Evidence | Notes |`.
//   - Some (e.g. VAULT) ship SEVERAL `## Maturity table — <subsection>`
//     headings in one doc, and some of those subsection tables aren't
//     capability tables at all (VAULT's "Cross-org isolation" table is
//     `| Endpoint | Org check | Status |`, its "Adversarial test posture"
//     table is `| Test corpus | Count | What it covers |`) — same heading
//     prefix, different shape, must be skipped without crashing the rest.
//   - 8 docs (e.g. AGENTS, QUOXCLI, TEMPLATE itself) have NEITHER heading at
//     all and must resolve to an empty array, not an error.
//   - Status/tag cell values are often compound free text, not just the six
//     canonical words, e.g. "Broken (plan-vs-ground-truth gap)",
//     "Stub / accepted limitation", "Beta, one critical bug found-and-fixed
//     this pass". normalizeMaturityTag() below matches a canonical tag as a
//     WHOLE-WORD PREFIX of the cell (so rollups still bucket sensibly) and
//     falls back to the raw text when no canonical tag prefixes it, rather
//     than dropping the row.
// ---------------------------------------------------------------------------

const MATURITY_HEADING_RE = /^##\s+(Capability maturity|Maturity table)\b/i;
const TABLE_ROW_RE = /^\s*\|/;
const TABLE_SEPARATOR_RE = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const MATURITY_TAGS = ['Stable', 'Beta', 'Experimental', 'Stub', 'Broken', 'Not started'];

/**
 * Synonyms the corpus actually uses, mapped to the canonical six FOR COUNTING.
 *
 * 41 STATUS_AND_LIMITS docs have accumulated 19 distinct non-canonical tag
 * values across 40 capabilities, so a rollup reading "100 Stable, 275 Beta ...
 * 40 other" was quietly filing a sixth of its non-Beta answer under "other".
 * That is a maturity report being vague about maturity.
 *
 * Two rules keep this honest rather than tidy:
 *
 *   1. ONLY UNAMBIGUOUS SYNONYMS. "Live" means shipped and proven, which is
 *      Stable; "NOT SHIPPED" means Not started. But "Partial" and "Mixed" are
 *      genuinely undecided, and bucketing them would be inventing a judgement
 *      the doc's author declined to make. They stay uncounted, so the "other"
 *      bucket keeps meaning "nobody has said clearly".
 *
 *   2. DISPLAY KEEPS THE ORIGINAL WORDS. "NOT SHIPPED, explicitly deferred"
 *      says more than "Not started", and the row still shows what its author
 *      wrote. Only the count is normalised.
 *
 * "Removed" is deliberately absent: a capability that no longer exists is not
 * at some level of maturity, and folding it into Not started would imply work
 * is pending on something that was deleted.
 */
const MATURITY_TAG_SYNONYMS = new Map([
  ['live', 'Stable'],
  ['shipped', 'Stable'],
  ['not built', 'Not started'],
  ['not shipped', 'Not started'],
  ['missing', 'Not started'],
  ['planned', 'Not started'],
  ['reference / stub', 'Stub'],
]);

/**
 * The bucket a tag counts towards, or null when it is genuinely undecided.
 * Prefix-matched so "Missing (parked)", "NOT SHIPPED, explicitly deferred" and
 * "Live (write + gate logic)" land where they obviously belong, while anything
 * unrecognised stays out of the canonical counts rather than being guessed at.
 */
function canonicalMaturityTag(tag) {
  const clean = String(tag || '').trim();
  if (!clean) return null;
  if (MATURITY_TAGS.includes(clean)) return clean;
  const lower = clean.toLowerCase();
  for (const [synonym, canonical] of MATURITY_TAG_SYNONYMS) {
    if (lower === synonym) return canonical;
    if (lower.startsWith(synonym)) {
      const next = lower[synonym.length];
      // A word boundary only: "not started" must not swallow "not startedish",
      // and "live" must not swallow "livestock".
      if (!next || !/[a-z0-9]/i.test(next)) return canonical;
    }
  }
  return null;
}

// Splits one markdown table row into trimmed cells, honouring `\|` as an
// escaped literal pipe (seen for real in STATUS_AND_LIMITS_AUTH.md, e.g.
// `payload.mfa_verified \|\| false` inside a Notes cell) rather than a
// column delimiter.
function splitTableRowCells(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let current = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && inner[i + 1] === '|') {
      current += '|';
      i++;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function stripCellMarkup(cell) {
  return (cell || '').replace(/\*\*/g, '').trim();
}

// Matches a canonical maturity tag as a whole-word prefix of the cell text
// (so "Broken (plan-vs-ground-truth gap)" buckets as Broken) and otherwise
// returns the raw cleaned text rather than dropping the row.
function normalizeMaturityTag(raw) {
  const clean = stripCellMarkup(raw);
  if (!clean) return '';
  const lower = clean.toLowerCase();
  for (const tag of MATURITY_TAGS) {
    const t = tag.toLowerCase();
    if (lower === t) return tag;
    if (lower.startsWith(t)) {
      const nextChar = lower[t.length];
      if (!nextChar || !/[a-z0-9]/i.test(nextChar)) return tag;
    }
  }
  return clean;
}

// Extracts every `## Maturity table` / `## Capability maturity` section's
// data rows into `{ capability, tag, evidence, notes }`. Never throws — a
// doc with no matching heading, or a table under that heading whose header
// row doesn't include a recognizable Capability + Tag/Status column, simply
// contributes no rows for that section. Callers should treat an empty array
// as "no structured data, show raw markdown" rather than an error.
function parseMaturityTable(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return [];

  const lines = markdown.split(/\r?\n/);
  const rows = [];

  for (let i = 0; i < lines.length; i++) {
    if (!MATURITY_HEADING_RE.test(lines[i])) continue;

    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    if (j >= lines.length || !TABLE_ROW_RE.test(lines[j])) continue; // no table under this heading

    const headerCells = splitTableRowCells(lines[j]).map((c) => c.toLowerCase());
    j++;
    if (j >= lines.length || !TABLE_SEPARATOR_RE.test(lines[j].trim())) continue; // not a real table
    j++;

    const capIdx = headerCells.findIndex((c) => c.includes('capability'));
    const tagIdx = headerCells.findIndex((c) => c.includes('tag') || c.includes('status'));
    const evidenceIdx = headerCells.findIndex((c) => c.includes('evidence'));
    const notesIdx = headerCells.findIndex((c) => c.includes('notes'));

    // Header doesn't match the capability-maturity shape (e.g. VAULT's
    // "Endpoint | Org check | Status" or "Test corpus | Count | ..." tables
    // under a same-prefixed heading) — skip this table, keep scanning.
    if (capIdx === -1 || tagIdx === -1) continue;

    while (j < lines.length && TABLE_ROW_RE.test(lines[j])) {
      const cells = splitTableRowCells(lines[j]);
      const capability = stripCellMarkup(cells[capIdx]);
      if (capability) {
        const tag = normalizeMaturityTag(cells[tagIdx]);
        rows.push({
          capability,
          tag,
          // The bucket this tag counts towards, or null when it is genuinely
          // undecided. Sent alongside the author's own wording so the UI can
          // colour a row consistently with the rollup WITHOUT keeping a second
          // copy of the synonym map that would drift from this one.
          canonical_tag: canonicalMaturityTag(tag),
          evidence: evidenceIdx >= 0 ? stripCellMarkup(cells[evidenceIdx]) : '',
          notes: notesIdx >= 0 ? stripCellMarkup(cells[notesIdx]) : '',
        });
      }
      j++;
    }
  }

  return rows;
}

// Rolls up parsed maturity rows across every discovered STATUS_AND_LIMITS
// doc into simple tag counts — the closest buildable "readiness board" input
// per DEVSUITE-DOCS Phase 3 scope (no DoneEngine exists as real code).
function computeMaturityRollup(deps = {}) {
  const docs = listStatusAndLimitsDocs(deps);
  const { docsDir = DEFAULT_DOCS_DIR } = deps;
  const tagCounts = {};
  let totalCapabilities = 0;
  let docsWithMaturityData = 0;

  for (const doc of docs) {
    let content;
    try {
      content = fs.readFileSync(path.join(docsDir, doc.file), 'utf8');
    } catch {
      continue; // unreadable doc — skip, don't fail the whole rollup
    }
    const rows = parseMaturityTable(content);
    if (rows.length > 0) docsWithMaturityData++;
    for (const row of rows) {
      // Count under the canonical bucket when the tag clearly maps to one;
      // otherwise count the author's own words, so "other" keeps meaning
      // "nobody has said clearly" rather than "we could not be bothered".
      const bucket = canonicalMaturityTag(row.tag) || row.tag;
      tagCounts[bucket] = (tagCounts[bucket] || 0) + 1;
      totalCapabilities++;
    }
  }

  return {
    totalDocs: docs.length,
    docsWithMaturityData,
    totalCapabilities,
    tagCounts,
  };
}

// ---------------------------------------------------------------------------
// Express handlers
// ---------------------------------------------------------------------------

function createDocsReposListHandler(deps = {}) {
  return function docsReposListHandler(req, res) {
    try {
      const repos = discoverRepoMaps(deps);
      const withDrift = repos.map((repo) => {
        try {
          return computeDriftStatus(repo, deps);
        } catch (err) {
          return { repo, stale: null, reason: 'drift_check_failed', error: err.message };
        }
      });
      return res.json({ count: withDrift.length, repos: withDrift });
    } catch (err) {
      return res.status(500).json({ error: 'docs_repos_list_failed', detail: err.message });
    }
  };
}

function createDocsRepoMapHandler(deps = {}) {
  return function docsRepoMapHandler(req, res) {
    const { repo } = req.params;
    try {
      const mapPath = resolveRepoMapPath(repo, deps);
      const content = fs.readFileSync(mapPath, 'utf8');
      let drift;
      try {
        drift = computeDriftStatus(repo, deps);
      } catch {
        drift = { stale: null };
      }
      return res.json({ ...drift, repo, content });
    } catch (err) {
      if (/unknown repo|invalid repo|traversal/.test(err.message)) {
        return res.status(400).json({ error: 'invalid_repo', detail: err.message });
      }
      return res.status(404).json({ error: 'map_not_found', detail: err.message });
    }
  };
}

function createStatusAndLimitsListHandler(deps = {}) {
  return function statusAndLimitsListHandler(req, res) {
    try {
      const docs = listStatusAndLimitsDocs(deps);
      const rollup = computeMaturityRollup(deps);
      return res.json({ count: docs.length, docs, rollup });
    } catch (err) {
      return res.status(500).json({ error: 'status_and_limits_list_failed', detail: err.message });
    }
  };
}

function createStatusAndLimitsReadHandler(deps = {}) {
  return function statusAndLimitsReadHandler(req, res) {
    const { name } = req.params;
    try {
      const target = resolveStatusAndLimitsPath(name, deps);
      const content = fs.readFileSync(target, 'utf8');
      const maturity = parseMaturityTable(content);
      return res.json({ name, content, maturity });
    } catch (err) {
      if (/empty status-and-limits|unknown status-and-limits|traversal/.test(err.message)) {
        return res.status(400).json({ error: 'invalid_name', detail: err.message });
      }
      return res.status(404).json({ error: 'doc_not_found', detail: err.message });
    }
  };
}

module.exports = {
  discoverRepoMaps,
  resolveRepoMapPath,
  parseLastVerified,
  computeDriftStatus,
  listStatusAndLimitsDocs,
  resolveStatusAndLimitsPath,
  parseMaturityTable,
  normalizeMaturityTag,
  canonicalMaturityTag,
  computeMaturityRollup,
  MATURITY_TAGS,
  createDocsReposListHandler,
  createDocsRepoMapHandler,
  createStatusAndLimitsListHandler,
  createStatusAndLimitsReadHandler,
};
