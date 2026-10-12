/**
 * GitHub Pull Request Tool Executor — QDIS-NEXT Phase 3
 *
 * Native executor for github_create_pull_request. This is the only code path
 * in the collector that lets an agent write code to a real repository, so it
 * carries its own hard safety invariants on top of the approval gate that
 * wraps it in agentTools.js:
 *
 *   1. It NEVER writes directly to an existing branch. It always creates a
 *      brand-new branch off `base` first, commits every file change onto
 *      THAT new branch via the Contents API, and only ever opens a pull
 *      request from the new branch back to `base`. There is no function or
 *      branch in this file that skips branch creation or the PR step.
 *   2. `branch === base` is refused before any GitHub API write happens.
 *   3. There is no merge capability anywhere in this file — no merge
 *      endpoint call, no merge parameter, no auto-merge path. Opening the
 *      PR is the full scope of what this executor can do.
 *
 * Credentials: resolved the same way the existing github connector tools do
 * (services/collector/lib/connectors/bridge.js resolveConnectorCredentials
 * against the 'github' connector, backed by the vault). This module does not
 * invent a new credential path — the caller (agentTools.js) resolves
 * credentials and passes them in.
 */

const GITHUB_API = 'https://api.github.com';

async function ghFetch(path, credentials, options = {}) {
  const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${credentials.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = new Error(`GitHub API ${resp.status}: ${body.slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }

  if (resp.status === 204) return {};
  const text = await resp.text();
  return text ? JSON.parse(text) : {};
}

/**
 * Look up a file's current blob sha on a given branch, so an update can be
 * committed via the Contents API (which requires `sha` for existing files).
 * Returns null when the file does not exist yet on that branch (new file).
 */
async function getFileSha(repo, filePath, branch, credentials) {
  try {
    const data = await ghFetch(
      `/repos/${repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`,
      credentials
    );
    return data && data.sha ? data.sha : null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Propose a fix: create a new branch off base, commit the given file
 * changes onto it, and open a pull request. Never merges. Never writes to
 * `base` directly.
 *
 * @param {object} input - { repo, base, branch, files, commit_message, title, body }
 *   files: [{ path, content }] — content is the FULL new file content (not a diff)
 * @param {object} credentials - { token }
 * @returns {Promise<object>} { success, pr: {number, url, title, state}, branch, base, files_changed }
 */
async function githubProposeFix(input, credentials) {
  const { repo, files, commit_message: commitMessage, title, body } = input || {};
  let { base, branch } = input || {};

  // SEC: `repo` is interpolated raw into every /repos/${repo}/... URL below
  // and cannot be encodeURIComponent'd (its slash is a real path separator).
  // A loose "contains a slash" check let a crafted value like
  // "a/b/../../someone-else" survive, and WHATWG URL normalisation then
  // collapses the `..` segments so the request lands on a DIFFERENT repo or
  // endpoint than the one that was approved, using the same org token.
  // Pin it to GitHub's actual owner/name charset instead.
  if (!repo || typeof repo !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/.test(repo)) {
    return { success: false, error: 'repo must be "owner/name" (letters, digits, ., _ and - only)' };
  }
  if (!branch || typeof branch !== 'string') {
    return { success: false, error: 'branch is required — this tool always proposes a fix via a new branch and a pull request' };
  }
  // Branch names reach `refs/heads/${branch}` and the PR head; keep them to a
  // conservative git-ref-safe charset rather than trusting caller input.
  if (!/^[A-Za-z0-9._\-/]+$/.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) {
    return { success: false, error: 'branch must be a simple git ref (letters, digits, ., _, -, /), no ".." segments' };
  }
  if (!Array.isArray(files) || files.length === 0) {
    return { success: false, error: 'files must be a non-empty array of {path, content}' };
  }
  if (!commitMessage || !title) {
    return { success: false, error: 'commit_message and title are required' };
  }
  if (!credentials || !credentials.token) {
    return { success: false, error: 'No GitHub credentials resolved for this org' };
  }

  // Resolve the repo's actual default branch rather than assuming 'main' —
  // only when base was not explicitly supplied.
  if (!base) {
    let repoInfo;
    try {
      repoInfo = await ghFetch(`/repos/${repo}`, credentials);
    } catch (err) {
      return { success: false, error: `Failed to read repository ${repo}: ${err.message}` };
    }
    base = repoInfo.default_branch || 'main';
  }

  // Hard safety invariant (see file header): this tool NEVER writes commits
  // directly onto the base branch. Refuse before any write happens at all
  // rather than relying on GitHub's own "no commits between X and X" 422 once
  // files are already pushed.
  if (branch === base) {
    return {
      success: false,
      error: `branch ("${branch}") must not equal base ("${base}") — this tool only proposes changes via a new branch and a pull request, it never writes directly to an existing branch.`,
    };
  }

  // 1. Resolve the base branch's current commit sha.
  let baseRef;
  try {
    baseRef = await ghFetch(`/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`, credentials);
  } catch (err) {
    return { success: false, error: `Failed to read base branch "${base}": ${err.message}` };
  }
  const baseSha = baseRef?.object?.sha;
  if (!baseSha) {
    return { success: false, error: `Could not resolve sha for base branch "${base}"` };
  }

  // 2. Create the new branch ref off base. This is the ONLY ref this
  // function ever creates or writes to — it never PATCHes an existing ref
  // and never targets `base`.
  try {
    await ghFetch(`/repos/${repo}/git/refs`, credentials, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
    });
  } catch (err) {
    return { success: false, error: `Failed to create branch "${branch}": ${err.message}` };
  }

  // 3. Commit each file change onto the new branch via the Contents API.
  const committed = [];
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
      return { success: false, error: `Invalid file change: ${JSON.stringify(file)}`, branch, base, files_changed: committed };
    }
    let existingSha = null;
    try {
      existingSha = await getFileSha(repo, file.path, branch, credentials);
    } catch (err) {
      return { success: false, error: `Failed to check existing file "${file.path}": ${err.message}`, branch, base, files_changed: committed };
    }
    try {
      await ghFetch(`/repos/${repo}/contents/${encodeURIComponent(file.path)}`, credentials, {
        method: 'PUT',
        body: JSON.stringify({
          message: commitMessage,
          content: Buffer.from(file.content, 'utf8').toString('base64'),
          branch,
          ...(existingSha ? { sha: existingSha } : {}),
        }),
      });
      committed.push(file.path);
    } catch (err) {
      return { success: false, error: `Failed to commit "${file.path}": ${err.message}`, branch, base, files_changed: committed };
    }
  }

  // 4. Open the pull request — base <- branch. This is the terminal action.
  // There is no merge call anywhere in this file.
  let pr;
  try {
    pr = await ghFetch(`/repos/${repo}/pulls`, credentials, {
      method: 'POST',
      body: JSON.stringify({ title, head: branch, base, body: body || '' }),
    });
  } catch (err) {
    return {
      success: false,
      error: `Branch "${branch}" was created and ${committed.length} file(s) committed, but opening the PR failed: ${err.message}`,
      branch,
      base,
      files_changed: committed,
    };
  }

  return {
    success: true,
    pr: { number: pr.number, url: pr.html_url, title: pr.title, state: pr.state },
    branch,
    base,
    files_changed: committed,
  };
}

module.exports = { githubProposeFix, ghFetch, getFileSha };
