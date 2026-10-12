/**
 * GitHub Proxy Routes — Phase R1 + R2
 *
 * Proxies all GitHub API calls through the collector so that:
 * 1. The PAT never reaches the browser
 * 2. Rate limiting and error handling are centralised
 * 3. Credential storage is server-side only
 *
 * Token resolution order (R2 — org-aware; VAULT-INTEG P3 removed the
 * plaintext-file fallback that used to sit between the vault and env — a
 * PAT written unencrypted to config/github.json on disk, never read back
 * once the org vault or connector bridge vault had it):
 *   1. Org-scoped vault credential (via github_org_mappings → integration_credentials)
 *   2. Connector bridge vault (via auth service)
 *   3. process.env.GITHUB_TOKEN
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../utils/httpAuth');
const { resolveConnectorCredentials, executeConnectorTool, _emitConnectorEvidence } = require('../lib/connectors/bridge');
// QUOXTRUST MF-3 (owner-blessed, trust-proof-self-audit): the WRITE routes
// below used to call ghFetch() -> api.github.com DIRECTLY, never crossing the
// governed choke (referenceMonitor.mediateGovernancePolicy ->
// entitlement/rate-limit -> vault -> withApprovalGate -> execution ledger ->
// AEE/WARD receipt) that lib/connectors/bridge.js's executeConnectorTool
// already enforces for every other path to a connector tool (agent chat,
// lib/fleetGripeHandler.js). An org policy such as "require approval before
// closing issues" was therefore silently ineffective against this dashboard
// widget, and these writes were unwitnessed. create_issue/update_issue/
// create_release have equivalent tools on the github connector
// (lib/connectors/types/github.js), so those four write routes below now go
// through executeConnectorTool('github', <tool>, input, context) — the exact
// same choke, not a reimplementation of it. POST /releases/generate-notes has
// NO equivalent connector tool (it only returns computed text, it creates no
// GitHub resource) and keeps the ghFetch call, now wrapped with the same
// referenceMonitor.mediateGovernancePolicy() decision + _emitConnectorEvidence
// receipt the bridge choke itself uses (see the POST /releases/generate-notes
// route below for the fallback). Read (GET) routes are unchanged.
const referenceMonitor = require('../lib/referenceMonitor');
const { checkStorePolicies, isSafeUnderPolicyOutage, createApprovalRequest } = require('../lib/approvalGate');

const router = express.Router();

const GITHUB_API = 'https://api.github.com';
const AUTH_BASE_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`;
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'github.json');
const POLICY_LOG_PATH = path.join(__dirname, '..', 'logs', 'github-policy.jsonl');
const MAX_CONCURRENT_REPO_FETCHES = 3;

// Ensure logs directory exists
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

/**
 * Log a policy evaluation event to the JSONL log file.
 */
function logPolicyEvent(event) {
  const entry = { ...event, timestamp: new Date().toISOString() };
  try {
    fs.appendFileSync(POLICY_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.warn('[GitHubProxy] Failed to write policy log:', err.message);
  }
}

/**
 * Read the user's policy config from the local github.json config file.
 * Returns an object with policy flags.
 */
function readPolicies() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return config.policies || {};
    }
  } catch (err) {
    console.warn('[GitHubProxy] Failed to read policies:', err.message);
  }
  return {};
}

// In-memory token cache (populated from vault, config file, or env)
// Keyed by orgId for org-scoped tokens, '_global' for fallback
const _tokenCache = new Map();

// ─── Token Resolution ───────────────────────────────────────────────

/**
 * Resolve the GitHub PAT from available sources.
 * R2: org-scoped credentials take priority.
 * Priority: org mapping vault → connector bridge vault → config file → env var
 *
 * @param {string|null} orgId - Quox org ID (from JWT)
 */
async function getGitHubToken(orgId) {
  // 1. Try org-scoped credential from vault (R2)
  if (orgId && orgId !== 'default') {
    const cacheKey = `org:${orgId}`;
    if (_tokenCache.has(cacheKey)) {
      return _tokenCache.get(cacheKey);
    }

    try {
      // Look up the org's OWN GitHub mapping via auth's service-key internal
      // route, then resolve its credential with the org-checked resolve-by-id
      // (2026-10-05: the old path called the user-authenticated mappings route
      // with no user token (always 401) and decrypted with an AUTH_SERVICE_KEY
      // the collector never had, so NO org ever used its own credential; every
      // call fell through to the shared fallback below).
      const { buildInternalServiceHeaders } = require('../lib/internalServiceHeaders');
      const resp = await fetch(`${AUTH_BASE_URL}/api/internal/orgs/${encodeURIComponent(orgId)}/github/mappings`, {
        headers: buildInternalServiceHeaders({ 'Content-Type': 'application/json' }),
        signal: AbortSignal.timeout(5000),
      });

      if (resp.ok) {
        const data = await resp.json();
        const mappings = data.mappings || [];
        const mapping = mappings.find(m => m.credential_id);
        if (mapping) {
          const byId = await fetch(`${AUTH_BASE_URL}/api/setup/internal/resolve-by-id`, {
            method: 'POST',
            headers: buildInternalServiceHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ credential_id: mapping.credential_id, org_id: orgId }),
            signal: AbortSignal.timeout(5000),
          });
          if (byId.ok) {
            const cred = await byId.json();
            const f = cred.fields || {};
            const token = f.token || f.access_token || f.api_key || cred.key;
            if (token) {
              const entry = { token, source: 'vault-org' };
              _tokenCache.set(cacheKey, entry);
              return entry;
            }
          }
        }
      }
    } catch (err) {
      // Org-scoped vault not available — continue to fallbacks
      console.warn('[GitHubProxy] Org-scoped vault lookup failed:', err.message);
    }
  }

  // 2. Try global cached token
  if (_tokenCache.has('_global')) {
    return _tokenCache.get('_global');
  }

  // 3. Try vault via connector bridge
  try {
    const resolved = await resolveConnectorCredentials(orgId || 'default', 'github');
    if (!resolved.error && resolved.credentials?.token) {
      const entry = { token: resolved.credentials.token, source: 'vault' };
      _tokenCache.set('_global', entry);
      return entry;
    }
  } catch (err) {
    // Vault not available — continue to fallbacks
  }

  // 4. Fall back to environment variable
  if (process.env.GITHUB_TOKEN) {
    const entry = { token: process.env.GITHUB_TOKEN, source: 'env' };
    _tokenCache.set('_global', entry);
    return entry;
  }

  return { token: null, source: null };
}

/**
 * Remember a validated GitHub token for this process's lifetime.
 *
 * VAULT-INTEG P3: this used to ALSO write the token to CONFIG_PATH
 * (config/github.json) in plaintext — the removed step 3 of
 * getGitHubToken()'s resolution order above used to read it back. Now it's
 * an in-memory-only cache (source 'session'): a token entered without an
 * org context (see GitHubPanel.jsx's SetupWizard — the org-scoped vault
 * write is the durable path when an org IS available) survives for the
 * running collector process but not a restart, rather than surviving a
 * restart via an unencrypted file on disk. Honest degradation, not a
 * silent one: getGitHubToken() no longer claims a durability this file
 * never actually gave once the vault or connector bridge had the token
 * anyway.
 */
function storeToken(token, meta = {}) {
  _tokenCache.set('_global', { token, source: 'session', ...meta });
}

/**
 * Clear cached token (for rotation/disconnect)
 */
function clearTokenCache() {
  _tokenCache.clear();
}

// ─── GitHub Fetch Helper ────────────────────────────────────────────

/**
 * Fetch from api.github.com with Bearer auth, rate limit tracking, pagination.
 *
 * @param {string} urlPath - API path (e.g., /user/orgs) or full URL
 * @param {string} token - GitHub PAT
 * @param {object} options - fetch options + { paginate: boolean }
 * @returns {{ data: any, rateLimit: { remaining: number, reset: Date } }}
 */
async function ghFetch(urlPath, token, options = {}) {
  const { paginate = false, ...fetchOpts } = options;
  const url = urlPath.startsWith('http') ? urlPath : `${GITHUB_API}${urlPath}`;

  const resp = await fetch(url, {
    ...fetchOpts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(fetchOpts.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });

  const rateLimit = {
    remaining: parseInt(resp.headers.get('X-RateLimit-Remaining') || '-1', 10),
    reset: resp.headers.get('X-RateLimit-Reset')
      ? new Date(parseInt(resp.headers.get('X-RateLimit-Reset'), 10) * 1000)
      : null,
  };

  // Rate limit exceeded
  if (resp.status === 403 && rateLimit.remaining === 0) {
    const retryAfter = resp.headers.get('Retry-After');
    const err = new Error(`GitHub rate limit exceeded. Resets at ${rateLimit.reset?.toISOString() || 'unknown'}`);
    err.status = 429;
    err.rateLimit = rateLimit;
    err.retryAfter = retryAfter ? parseInt(retryAfter, 10) : null;
    throw err;
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = new Error(`GitHub API ${resp.status}: ${body.slice(0, 300)}`);
    err.status = resp.status;
    err.rateLimit = rateLimit;
    throw err;
  }

  // 204 No Content
  if (resp.status === 204) return { data: null, rateLimit };

  let data = await resp.json();

  // Auto-paginate: follow Link headers, collect all pages
  if (paginate && Array.isArray(data)) {
    let nextUrl = parseLinkNext(resp.headers.get('Link'));
    while (nextUrl) {
      const nextResp = await fetch(nextUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!nextResp.ok) break;
      const nextData = await nextResp.json();
      if (!Array.isArray(nextData) || nextData.length === 0) break;
      data = data.concat(nextData);
      // Safety: cap at 1000 items to avoid runaway pagination
      if (data.length > 1000) break;
      nextUrl = parseLinkNext(nextResp.headers.get('Link'));
      // Update rate limit from latest response
      rateLimit.remaining = parseInt(nextResp.headers.get('X-RateLimit-Remaining') || '-1', 10);
    }
  }

  return { data, rateLimit };
}

/**
 * Parse the "next" URL from a GitHub Link header.
 */
function parseLinkNext(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

/**
 * Run promises with a concurrency limit.
 */
async function parallelLimit(fns, limit) {
  const results = [];
  const executing = new Set();
  for (const fn of fns) {
    const p = fn().then(r => { executing.delete(p); return r; });
    executing.add(p);
    results.push(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

// ─── QUOXTRUST MF-3: governed-write helpers ─────────────────────────

/**
 * The authoritative org for a write, resolved from the AUTHENTICATED
 * request (the JWT requireAuth() already verified) — never from req.body.
 * Matches requireGitHubToken's own resolution below, which is the existing
 * convention in this file for the org a GitHub credential/policy applies to.
 */
function resolveOrgId(req) {
  return req.user?.org_id || req.query.orgId || null;
}

/**
 * Map an executeConnectorTool() result — or the equivalent
 * referenceMonitor.mediateGovernancePolicy() decision on the
 * generate-notes fallback path — to an HTTP status. Mirrors the
 * vocabulary those already return rather than inventing a new one.
 */
function statusForGovernedResult(result) {
  if (!result) return 502;
  if (result.success === true) return 200;
  if (result.pending) return 202; // held for human approval
  if (result.licenseRequired) return 402;
  if (result.rate_limited) return 429;
  if (result._policy && result._policy.effect === 'deny') return 403;
  return 502;
}

// ─── Middleware ──────────────────────────────────────────────────────

/**
 * Middleware that resolves and injects the GitHub token into req.ghToken.
 * R2: reads orgId from JWT (req.user.org_id) for org-scoped credential lookup.
 * Returns 503 if no token is configured.
 */
async function requireGitHubToken(req, res, next) {
  const orgId = req.user?.org_id || req.query.orgId || null;
  const { token } = await getGitHubToken(orgId);
  if (!token) {
    return res.status(503).json({
      error: 'github_not_configured',
      message: 'No GitHub token configured. Complete setup via the GitHub plugin.',
    });
  }
  req.ghToken = token;
  next();
}

// Apply auth to all routes
router.use(requireAuth());

// ─── Routes ─────────────────────────────────────────────────────────

/**
 * POST /github/test-connection
 * Test a token and optionally store it. Used by setup wizard.
 * Body: { token }
 */
router.post('/test-connection', async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    const [userResp, orgsResp] = await Promise.all([
      ghFetch('/user', token.trim()),
      ghFetch('/user/orgs', token.trim()),
    ]);

    // Store the validated token
    storeToken(token.trim(), { user: userResp.data.login });

    res.json({
      success: true,
      user: { login: userResp.data.login, avatar_url: userResp.data.avatar_url },
      orgs: (orgsResp.data || []).map(o => ({ login: o.login, id: o.id, avatar_url: o.avatar_url })),
    });
  } catch (err) {
    console.error('[GitHubProxy] test-connection failed:', err.message);
    res.status(err.status || 502).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * GET /github/orgs
 */
router.get('/orgs', requireGitHubToken, async (req, res) => {
  try {
    const { data, rateLimit } = await ghFetch('/user/orgs', req.ghToken);
    res.json((data || []).map(o => ({ login: o.login, id: o.id, avatar_url: o.avatar_url })));
  } catch (err) {
    console.error('[GitHubProxy] /orgs failed:', err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

/**
 * GET /github/repos/:org
 * Auto-paginates to return all repos.
 */
router.get('/repos/:org', requireGitHubToken, async (req, res) => {
  const { org } = req.params;
  const { page = 1, per_page = 100 } = req.query;
  try {
    const { data, rateLimit } = await ghFetch(
      `/orgs/${encodeURIComponent(org)}/repos?per_page=${Math.min(Number(per_page), 100)}&sort=updated&page=${page}`,
      req.ghToken,
      { paginate: true }
    );
    const repos = (data || []).map(r => ({
      name: r.name,
      full_name: r.full_name,
      private: r.private,
      description: r.description,
      updated_at: r.updated_at,
      language: r.language,
      stargazers_count: r.stargazers_count,
    }));
    res.json(repos);
  } catch (err) {
    console.error('[GitHubProxy] /repos/:org failed:', err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

/**
 * GET /github/issues
 * Query: ?repos=quox,quoxflow&state=open&labels=bug&search=timeout&page=1&per_page=30
 * Fetches from each repo in parallel (max 3 concurrent), merges, sorts by updated_at.
 */
router.get('/issues', requireGitHubToken, async (req, res) => {
  const { repos, org, state = 'open', labels, search, page = 1, per_page = 30 } = req.query;
  if (!repos || !org) {
    return res.status(400).json({ error: 'repos and org query parameters are required' });
  }

  const repoList = repos.split(',').map(r => r.trim()).filter(Boolean);
  const params = new URLSearchParams({ state, page: String(page), per_page: String(Math.min(Number(per_page), 100)) });
  if (labels) params.set('labels', labels);

  try {
    const fetchers = repoList.map(repo => async () => {
      try {
        const { data } = await ghFetch(
          `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/issues?${params}`,
          req.ghToken
        );
        return (data || [])
          .filter(i => !i.pull_request) // exclude PRs
          .map(i => ({
            number: i.number,
            title: i.title,
            state: i.state,
            labels: (i.labels || []).map(l => typeof l === 'string' ? { name: l, color: 'cccccc' } : { name: l.name, color: l.color || 'cccccc' }),
            author: i.user?.login,
            assignees: (i.assignees || []).map(a => a.login),
            created_at: i.created_at,
            updated_at: i.updated_at,
            comments: i.comments,
            url: i.html_url,
            _repo: repo,
          }));
      } catch (err) {
        console.warn(`[GitHubProxy] Failed to fetch issues for ${repo}:`, err.message);
        return [];
      }
    });

    let issues = (await parallelLimit(fetchers, MAX_CONCURRENT_REPO_FETCHES)).flat();

    // Optional text search filter
    if (search) {
      const q = search.toLowerCase();
      issues = issues.filter(i =>
        i.title.toLowerCase().includes(q) ||
        (i.labels || []).some(l => (l.name || '').toLowerCase().includes(q))
      );
    }

    issues.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    res.json({
      issues,
      total: issues.length,
      page: Number(page),
      hasMore: issues.length >= Number(per_page),
    });
  } catch (err) {
    console.error('[GitHubProxy] /issues failed:', err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

/**
 * GET /github/issues/:owner/:repo/:number
 * Returns issue detail + comments.
 */
router.get('/issues/:owner/:repo/:number', requireGitHubToken, async (req, res) => {
  const { owner, repo, number } = req.params;
  try {
    const [issueResp, commentsResp] = await Promise.all([
      ghFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, req.ghToken),
      ghFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments?per_page=100`, req.ghToken),
    ]);
    res.json({
      issue: issueResp.data,
      comments: (commentsResp.data || []).map(c => ({
        id: c.id,
        author: c.user?.login,
        avatar_url: c.user?.avatar_url,
        body: c.body,
        created_at: c.created_at,
        updated_at: c.updated_at,
      })),
    });
  } catch (err) {
    console.error('[GitHubProxy] /issues/:owner/:repo/:number failed:', err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

/**
 * POST /github/issues
 * Body: { owner, repo, title, body, labels }
 *
 * QUOXTRUST MF-3: routed through executeConnectorTool('github', 'create_issue', ...)
 * — the governed choke (policy/entitlement/rate-limit/vault/approval-gate/
 * execution-ledger/AEE-WARD-receipt) — instead of calling ghFetch directly.
 */
router.post('/issues', async (req, res) => {
  const { owner, repo, title, body, labels, assignees } = req.body;
  if (!owner || !repo || !title) {
    return res.status(400).json({ error: 'owner, repo, and title are required' });
  }
  const orgId = resolveOrgId(req);
  try {
    const result = await executeConnectorTool(orgId, 'github', 'create_issue', {
      repo: `${owner}/${repo}`,
      title,
      body,
      labels,
      assignees,
    }, {
      agentId: 'github-proxy',
      orgId,
      corr: `GHPROXY_ISSUE_${req.user?.id || 'anon'}_${Date.now()}`,
    });
    if (result.success !== true) {
      return res.status(statusForGovernedResult(result)).json({ error: result.error || result.message || 'github_write_blocked', ...result });
    }
    res.json({ issue: result.result });
  } catch (err) {
    console.error('[GitHubProxy] POST /issues failed:', err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

/**
 * PATCH /github/issues/:owner/:repo/:number
 * Body: { state, labels, assignees, comment }
 *
 * QUOXTRUST MF-3: the actual mutation (field update and/or comment) is routed
 * through executeConnectorTool('github', 'update_issue', ...) — the governed
 * choke — in a SINGLE call (the connector tool itself does both the field
 * update and the comment post when both are given, same as this route always
 * did across two ghFetch calls). The requireLinkedPRForClosure pre-check
 * below stays a direct (read-only) ghFetch — it only reads the issue body to
 * decide whether to even attempt the write, so requireGitHubToken is kept on
 * this route for that read.
 */
router.patch('/issues/:owner/:repo/:number', requireGitHubToken, async (req, res) => {
  const { owner, repo, number } = req.params;
  const { state, labels, assignees, comment, override_reason } = req.body;
  const orgId = resolveOrgId(req);

  try {
    // R4: Policy enforcement — requireLinkedPRForClosure
    const policies = readPolicies();
    if (policies.requireLinkedPRForClosure && state === 'closed') {
      // Fetch the issue body to check for PR references
      const { data: issueData } = await ghFetch(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
        req.ghToken
      );
      const issueBody = issueData.body || '';
      const prRefPattern = /#\d+|pull\/\d+|github\.com\/[^/]+\/[^/]+\/pull\/\d+/g;
      const hasPRRef = prRefPattern.test(issueBody);

      logPolicyEvent({
        action: 'issue.close',
        policy: 'requireLinkedPRForClosure',
        owner, repo, issue: Number(number),
        hasPRRef,
        overrideProvided: !!override_reason,
        result: hasPRRef ? 'allowed' : (override_reason ? 'override' : 'blocked'),
      });

      if (!hasPRRef && !override_reason) {
        return res.json({
          status: 'policy_blocked',
          policy: 'requireLinkedPRForClosure',
          message: 'This issue has no linked PR. Provide an override_reason to close anyway.',
        });
      }

      if (!hasPRRef && override_reason) {
        logPolicyEvent({
          action: 'issue.close.override',
          policy: 'requireLinkedPRForClosure',
          owner, repo, issue: Number(number),
          override_reason,
        });
      }
    }

    // Nothing to do (no field update, no comment) — mirror prior behaviour
    // (an empty {} body) without crossing the governed choke for a no-op.
    if (state === undefined && labels === undefined && assignees === undefined && !comment) {
      return res.json({});
    }

    const result = await executeConnectorTool(orgId, 'github', 'update_issue', {
      repo: `${owner}/${repo}`,
      number: Number(number),
      state,
      labels,
      assignees,
      comment,
    }, {
      agentId: 'github-proxy',
      orgId,
      corr: `GHPROXY_ISSUE_UPDATE_${req.user?.id || 'anon'}_${Date.now()}`,
    });

    if (result.success !== true) {
      return res.status(statusForGovernedResult(result)).json({ error: result.error || result.message || 'github_write_blocked', ...result });
    }

    // update_issue's own execute() already returns { issue?, comment? } —
    // the exact shape this route always returned.
    res.json(result.result || {});
  } catch (err) {
    console.error('[GitHubProxy] PATCH /issues failed:', err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

/**
 * POST /github/issues/:owner/:repo/:number/comments
 * Body: { body }
 *
 * QUOXTRUST MF-3: routed through executeConnectorTool('github', 'update_issue', ...)
 * (the connector has no standalone create_comment tool; update_issue's own
 * `comment` field posts exactly this, same governed choke as the other writes).
 */
router.post('/issues/:owner/:repo/:number/comments', async (req, res) => {
  const { owner, repo, number } = req.params;
  const { body } = req.body;
  if (!body) {
    return res.status(400).json({ error: 'body is required' });
  }
  const orgId = resolveOrgId(req);
  try {
    const result = await executeConnectorTool(orgId, 'github', 'update_issue', {
      repo: `${owner}/${repo}`,
      number: Number(number),
      comment: body,
    }, {
      agentId: 'github-proxy',
      orgId,
      corr: `GHPROXY_COMMENT_${req.user?.id || 'anon'}_${Date.now()}`,
    });
    if (result.success !== true) {
      return res.status(statusForGovernedResult(result)).json({ error: result.error || result.message || 'github_write_blocked', ...result });
    }
    res.json({ comment: result.result?.comment });
  } catch (err) {
    console.error('[GitHubProxy] POST /comments failed:', err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

/**
 * GET /github/prs
 * Query: ?repos=quox,quoxflow&org=quoxai&state=open
 */
router.get('/prs', requireGitHubToken, async (req, res) => {
  const { repos, org, state = 'open' } = req.query;
  if (!repos || !org) {
    return res.status(400).json({ error: 'repos and org query parameters are required' });
  }

  const repoList = repos.split(',').map(r => r.trim()).filter(Boolean);

  try {
    const fetchers = repoList.map(repo => async () => {
      try {
        const { data } = await ghFetch(
          `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/pulls?state=${state}&per_page=100`,
          req.ghToken
        );
        return (data || []).map(pr => ({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          author: pr.user?.login,
          head: pr.head?.ref,
          base: pr.base?.ref,
          draft: pr.draft,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          url: pr.html_url,
          _repo: repo,
        }));
      } catch (err) {
        console.warn(`[GitHubProxy] Failed to fetch PRs for ${repo}:`, err.message);
        return [];
      }
    });

    const prs = (await parallelLimit(fetchers, MAX_CONCURRENT_REPO_FETCHES)).flat();
    prs.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    res.json({ prs });
  } catch (err) {
    console.error('[GitHubProxy] /prs failed:', err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

/**
 * GET /github/prs/:owner/:repo/:number/diff
 */
router.get('/prs/:owner/:repo/:number/diff', requireGitHubToken, async (req, res) => {
  const { owner, repo, number } = req.params;
  try {
    const { data } = await ghFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files?per_page=100`,
      req.ghToken
    );
    res.json({
      files: (data || []).map(f => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch?.slice(0, 2000),
      })),
    });
  } catch (err) {
    console.error('[GitHubProxy] /prs/diff failed:', err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

/**
 * GET /github/actions/:owner/:repo/runs
 * Query: ?status=failure&per_page=10
 */
router.get('/actions/:owner/:repo/runs', requireGitHubToken, async (req, res) => {
  const { owner, repo } = req.params;
  const { status, per_page = 10 } = req.query;
  const params = new URLSearchParams({ per_page: String(Math.min(Number(per_page), 100)) });
  if (status) params.set('status', status);

  try {
    const { data } = await ghFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?${params}`,
      req.ghToken
    );
    res.json({
      runs: (data.workflow_runs || []).map(run => ({
        id: run.id,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        branch: run.head_branch,
        event: run.event,
        created_at: run.created_at,
        updated_at: run.updated_at,
        url: run.html_url,
      })),
    });
  } catch (err) {
    console.error('[GitHubProxy] /actions/runs failed:', err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

/**
 * GET /github/releases
 * Query: ?repos=quox,quoxflow&org=quoxai&per_page=10
 */
router.get('/releases', requireGitHubToken, async (req, res) => {
  const { repos, org, per_page = 10 } = req.query;
  if (!repos || !org) {
    return res.status(400).json({ error: 'repos and org query parameters are required' });
  }

  const repoList = repos.split(',').map(r => r.trim()).filter(Boolean);

  try {
    const fetchers = repoList.map(repo => async () => {
      try {
        const { data } = await ghFetch(
          `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/releases?per_page=${Math.min(Number(per_page), 100)}`,
          req.ghToken
        );
        return (data || []).map(r => ({
          id: r.id,
          tag_name: r.tag_name,
          name: r.name,
          body: r.body?.slice(0, 2000),
          draft: r.draft,
          prerelease: r.prerelease,
          published_at: r.published_at,
          author: r.author?.login,
          url: r.html_url,
          _repo: repo,
        }));
      } catch (err) {
        console.warn(`[GitHubProxy] Failed to fetch releases for ${repo}:`, err.message);
        return [];
      }
    });

    const releases = (await parallelLimit(fetchers, MAX_CONCURRENT_REPO_FETCHES)).flat();
    releases.sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));

    res.json({ releases });
  } catch (err) {
    console.error('[GitHubProxy] /releases failed:', err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

/**
 * POST /github/releases
 * Body: { owner, repo, tag_name, name, body, draft, prerelease }
 *
 * QUOXTRUST MF-3: the actual GitHub write is routed through
 * executeConnectorTool('github', 'create_release', ...) — the governed choke
 * — AFTER the existing requireChecklistBeforeRelease pre-check (a local
 * config-file policy, unrelated to GOV-4/org governance, unchanged below).
 */
router.post('/releases', async (req, res) => {
  const { owner, repo, tag_name, name, body, draft, prerelease, checklist_confirmed } = req.body;
  if (!owner || !repo || !tag_name) {
    return res.status(400).json({ error: 'owner, repo, and tag_name are required' });
  }
  const orgId = resolveOrgId(req);
  try {
    // R4: Policy enforcement — requireChecklistBeforeRelease
    const policies = readPolicies();
    if (policies.requireChecklistBeforeRelease && !checklist_confirmed) {
      logPolicyEvent({
        action: 'release.create',
        policy: 'requireChecklistBeforeRelease',
        owner, repo, tag_name,
        checklistConfirmed: false,
        result: 'blocked',
      });
      return res.json({
        status: 'policy_blocked',
        policy: 'requireChecklistBeforeRelease',
        message: 'Deploy checklist not confirmed.',
      });
    }

    if (policies.requireChecklistBeforeRelease && checklist_confirmed) {
      logPolicyEvent({
        action: 'release.create',
        policy: 'requireChecklistBeforeRelease',
        owner, repo, tag_name,
        checklistConfirmed: true,
        result: 'allowed',
      });
    }

    const result = await executeConnectorTool(orgId, 'github', 'create_release', {
      repo: `${owner}/${repo}`,
      tag: tag_name,
      name: name || tag_name,
      body,
      draft: !!draft,
      prerelease: !!prerelease,
    }, {
      agentId: 'github-proxy',
      orgId,
      corr: `GHPROXY_RELEASE_${req.user?.id || 'anon'}_${Date.now()}`,
    });
    if (result.success !== true) {
      return res.status(statusForGovernedResult(result)).json({ error: result.error || result.message || 'github_write_blocked', ...result });
    }
    res.json({ release: result.result });
  } catch (err) {
    console.error('[GitHubProxy] POST /releases failed:', err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

/**
 * POST /github/releases/generate-notes
 * Body: { owner, repo, tag_name, previous_tag_name }
 *
 * QUOXTRUST MF-3 (FALLBACK B): the github connector has no equivalent tool
 * (this computes release-notes text from commit history — it creates no
 * GitHub resource, so there's nothing for a "generate_release_notes" tool to
 * wrap productively), so this route still calls ghFetch directly. It is now
 * gated by the SAME referenceMonitor.mediateGovernancePolicy() decision the
 * bridge choke runs, and emits the SAME _emitConnectorEvidence AEE/WARD
 * receipt on both the deny and the executed path — not a bespoke
 * reimplementation of either. `generate_release_notes` is the tool identity
 * used for policy matching/evidence (`github_generate_release_notes`), so an
 * org can write a policy against it exactly like any other connector tool.
 */
router.post('/releases/generate-notes', requireGitHubToken, async (req, res) => {
  const { owner, repo, tag_name, previous_tag_name } = req.body;
  if (!owner || !repo || !tag_name) {
    return res.status(400).json({ error: 'owner, repo, and tag_name are required' });
  }
  const orgId = resolveOrgId(req);
  const toolName = 'generate_release_notes';
  const govInput = { repo: `${owner}/${repo}`, tag_name, previous_tag_name };
  const govContext = { orgId, agentId: 'github-proxy', corr: `GHPROXY_RELNOTES_${req.user?.id || 'anon'}_${Date.now()}` };

  const gov = await referenceMonitor.mediateGovernancePolicy(
    `github_${toolName}`,
    govInput,
    govContext,
    { checkStorePolicies, isSafeUnderPolicyOutage, createApprovalRequest }
  );
  if (gov.outcome !== referenceMonitor.OUTCOME.ALLOW) {
    _emitConnectorEvidence({
      connectorId: 'github', toolName, input: govInput, context: govContext,
      durationMs: 0, success: false,
      error: gov.response?.error || gov.response?.message || `policy_${gov.outcome}`,
      disposition: 'denied',
    });
    return res.status(statusForGovernedResult(gov.response)).json({ error: gov.response?.error || gov.response?.message || 'github_write_blocked', ...gov.response });
  }

  const startTime = Date.now();
  try {
    const payload = { tag_name };
    if (previous_tag_name) payload.previous_tag_name = previous_tag_name;
    const { data } = await ghFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/generate-notes`,
      req.ghToken,
      { method: 'POST', body: JSON.stringify(payload) }
    );
    _emitConnectorEvidence({ connectorId: 'github', toolName, input: govInput, context: govContext, durationMs: Date.now() - startTime, success: true });
    res.json(data);
  } catch (err) {
    _emitConnectorEvidence({ connectorId: 'github', toolName, input: govInput, context: govContext, durationMs: Date.now() - startTime, success: false, error: err.message });
    console.error('[GitHubProxy] POST /releases/generate-notes failed:', err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

/**
 * GET /github/status
 * Returns whether a GitHub token is configured (without exposing the token).
 */
router.get('/status', async (req, res) => {
  const { token, source } = await getGitHubToken();
  res.json({
    configured: !!token,
    source: source || 'none',
  });
});

/**
 * POST /github/disconnect
 * Clears the stored token.
 */
router.post('/disconnect', async (req, res) => {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      fs.unlinkSync(CONFIG_PATH);
    }
    clearTokenCache();
    res.json({ success: true });
  } catch (err) {
    console.error('[GitHubProxy] disconnect failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// Exposed for reuse by other collector modules that need to file/read
// GitHub issues without duplicating the vault -> env token resolution chain
// (house rule: no env-only config — this chain already satisfies it, env is
// the last-resort fallback, not the only source).
// Used by lib/securityReportActions.js ("Raise as Gripe").
module.exports.getGitHubToken = getGitHubToken;
module.exports.ghFetch = ghFetch;
// Exposed for testing (VAULT-INTEG P3 — proving the plaintext-file fallback
// was actually removed, not just its read path).
module.exports.storeToken = storeToken;
module.exports.clearTokenCache = clearTokenCache;
