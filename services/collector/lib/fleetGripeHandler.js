/**
 * fleetGripeHandler.js — DEVSUITE-GRIPE fleet-host capability.
 *
 * POST /api/v1/fleet/gripe/file-issue
 *
 * quoxagent's `dev.gripe` capability (fleet hosts) has zero GitHub
 * integration and must NEVER be handed a raw GitHub token — a fleet host
 * has no user session and no reason to hold org-scoped credentials
 * directly. The host POSTs a request authenticated via requireFleetHostAuth()
 * (lib/fleetHostCredentialsStore.js) — a per-host token issued once at
 * enrollment and bound to a specific org_id server-side — to this
 * collector-side endpoint, and the collector does the deterministic parsing
 * + files the issue itself, reusing the EXACT same vault-credential-resolving
 * path the chat "GRIPE" agent already proves works: lib/connectors/bridge.js's
 * executeConnectorTool(orgId, 'github', 'create_issue', input, context) —
 * see lib/agentTools.js's connector-tool routing (github_create_issue ->
 * executeConnectorTool) for the chat-agent call site this mirrors. No LLM
 * round-trip: this is a deterministic path, so the repo-detection keyword
 * table, label-selection keyword table, and title/body templating that
 * live in src/config/entities/assistants/gripe.json's system prompt (the
 * chat agent's instructions to itself) are ported here as real JS logic
 * rather than re-run through a model. No shared/extractable module backed
 * that prompt text (confirmed by grep before writing this file) — the
 * tables below are hand-ported from gripe.json verbatim, ordered exactly
 * as gripe.json lists them, so a keyword's category here matches what the
 * chat agent would infer for the same input.
 */

'use strict';

// ── Repo detection (verbatim from gripe.json's systemPromptAdditions "Step 1: Parse", item 1) ──
const REPO_KEYWORD_TABLE = [
  { repo: 'quoxai/quoxwebsite', keywords: ['website', 'pricing', 'landing', 'blog', 'seo'] },
  { repo: 'quoxai/quox', keywords: ['dashboard', 'sidebar', 'panel', 'plugin', 'agent', 'memory', 'glass', 'cogcore', 'wiremap', 'opsdeck', 'mission control'] },
  { repo: 'quoxai/quoxflow', keywords: ['flow', 'workflow', 'cron', 'executor', 'schedule', 'quoxflow'] },
  { repo: 'quoxai/quoxmcp', keywords: ['mcp', 'oauth', 'tool-call'] },
  { repo: 'quoxai/quoxterminal', keywords: ['terminal', 'tauri', 'desktop'] },
  { repo: 'quoxai/quox-plugin-sdk', keywords: ['sdk', 'plugin-sdk', 'marketplace'] },
  { repo: 'quoxai/quoxbastion', keywords: ['bastion', 'ssh', 'fleet', 'vm'] },
];
const DEFAULT_REPO = 'quoxai/quox';

// ── Label detection (verbatim from gripe.json's "Step 1: Parse", item 2) ──
// Order matters: earlier entries win on overlap (e.g. "bug" beats "should"),
// matching the order gripe.json itself lists the categories in.
const LABEL_KEYWORD_TABLE = [
  { label: 'fleet/qa', keywords: ['bug', 'broken', 'error', 'crash', 'fails', 'fail'] },
  { label: 'fleet/idea', keywords: ['could be better', 'ux nit', 'improvement', 'should', 'ugly'] },
  { label: 'fleet/docs', keywords: ['missing docs', 'wrong docs', 'outdated readme', 'docs', 'documentation', 'readme'] },
  { label: 'fleet/plan', keywords: ['architecture concern', 'refactor needed', 'tech debt', 'refactor', 'architecture'] },
  { label: 'fleet/research', keywords: ['needs investigation', 'investigate', 'research', 'unclear'] },
];
const DEFAULT_LABEL = 'fleet/idea';

const TITLE_MAX_LEN = 80;

// Matches an explicit `repo:<value>` / `reponame:<value>` or `label:<value>`
// override embedded in the complaint text itself — same override
// convention gripe.json documents for the chat agent ("If the user
// explicitly prefixes with `repo:` or `reponame:`, use that verbatim" /
// "Respect an explicit `label:<x>` override from the user").
const INLINE_REPO_RE = /\b(?:repo|reponame):(\S+)/i;
const INLINE_LABEL_RE = /\blabel:(\S+)/i;

function detectRepo(lowerText) {
  for (const entry of REPO_KEYWORD_TABLE) {
    if (entry.keywords.some((kw) => lowerText.includes(kw))) {
      return { repo: entry.repo, defaulted: false };
    }
  }
  return { repo: DEFAULT_REPO, defaulted: true };
}

function detectLabel(lowerText) {
  for (const entry of LABEL_KEYWORD_TABLE) {
    if (entry.keywords.some((kw) => lowerText.includes(kw))) {
      return { label: entry.label, defaulted: false };
    }
  }
  return { label: DEFAULT_LABEL, defaulted: true };
}

function stripInlineOverrides(text) {
  return text.replace(INLINE_REPO_RE, '').replace(INLINE_LABEL_RE, '').replace(/\s{2,}/g, ' ').trim();
}

function buildTitle(cleanText) {
  const collapsed = cleanText.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= TITLE_MAX_LEN) return collapsed;
  return `${collapsed.slice(0, TITLE_MAX_LEN - 3).trimEnd()}...`;
}

function buildBody(originalText, hostId, repoDefaulted) {
  const defaultNote = repoDefaulted ? '\n- Repo defaulted to quoxai/quox (no matching keyword found)' : '';
  return `## Gripe\n${originalText}\n\n## Context\n- Filed from Gripe (fleet host capability, no LLM in the loop)\n- Priority: minor / off-task observation\n- Source: fleet:${hostId}${defaultNote}\n\n## Suggested Action\nInvestigate and fix if confirmed.`;
}

/**
 * Deterministic parse: complaint text (+ optional explicit overrides) ->
 * { repo, label, title, body, repoDefaulted, labelDefaulted }.
 * Pure function — no network, no LLM — exported directly for unit testing
 * of the keyword tables in isolation from the HTTP handler.
 */
function parseFleetGripe(complaintText, { hostId = 'unknown', repoOverride, labelOverride } = {}) {
  const cleanText = stripInlineOverrides(complaintText);
  const lowerClean = cleanText.toLowerCase();

  const inlineRepoMatch = complaintText.match(INLINE_REPO_RE);
  const inlineLabelMatch = complaintText.match(INLINE_LABEL_RE);

  let repo, repoDefaulted;
  if (repoOverride) {
    repo = repoOverride;
    repoDefaulted = false;
  } else if (inlineRepoMatch) {
    repo = inlineRepoMatch[1];
    repoDefaulted = false;
  } else {
    ({ repo, defaulted: repoDefaulted } = detectRepo(lowerClean));
  }

  let label, labelDefaulted;
  if (labelOverride) {
    label = labelOverride;
    labelDefaulted = false;
  } else if (inlineLabelMatch) {
    label = inlineLabelMatch[1];
    labelDefaulted = false;
  } else {
    ({ label, defaulted: labelDefaulted } = detectLabel(lowerClean));
  }

  return {
    repo,
    label,
    title: buildTitle(cleanText),
    body: buildBody(complaintText.trim(), hostId, repoDefaulted),
    repoDefaulted,
    labelDefaulted,
  };
}

/**
 * POST /api/v1/fleet/gripe/file-issue handler factory.
 * deps.executeConnectorTool must be lib/connectors/bridge.js's
 * executeConnectorTool (injected so this file never requires server.js
 * and stays unit-testable with a mock).
 *
 * Auth: route registration (server.js) puts requireFleetHostAuth()
 * (lib/fleetHostCredentialsStore.js) in front of this handler, which sets
 * req.fleetHost = { hostId, orgId } resolved server-side from the presented
 * X-Fleet-Host-Token. That resolved orgId is THE authoritative org for this
 * request — SEC-FLEET-CRED fixed exactly this: a request body could
 * previously claim any org_id and have it trusted outright, letting one
 * shared INTERNAL_SERVICE_KEY holder impersonate any org's vault-stored
 * GitHub credentials. Any body.org_id is now informational only, logged if
 * it disagrees with the resolved credential, and never used.
 *
 * Request body:  { host_id, complaint_text, repo?, label?, org_id? (ignored,
 *                  see above) }
 * Success (200): { success: true, issue: { number, title, url, state },
 *                  repo, label, repo_defaulted, label_defaulted }
 * Failure:       { success: false, error }  (400 bad input, 502 connector
 *                  bridge failure — e.g. no GitHub credentials in vault
 *                  for this org)
 */
function createFleetGripeFileIssueHandler(deps = {}) {
  const { executeConnectorTool } = deps;
  // QDIS-NEXT #439: gripe-feed real completion hook (see gripeFeedLog.js
  // header). Injectable so tests never touch the real /var/lib/quox path.
  const { logGripeIssueFiled } = deps.gripeFeedLog || require('./gripeFeedLog');

  return async function fleetGripeFileIssueHandler(req, res) {
    const body = req.body || {};

    if (!req.fleetHost || !req.fleetHost.orgId) {
      // Should be unreachable in production (requireFleetHostAuth() 401s
      // first), but fail closed rather than falling back to body.org_id.
      return res.status(401).json({ success: false, error: 'fleet_host_not_authenticated' });
    }
    // Authoritative org — resolved server-side from the credential binding,
    // NEVER from the request body (that was the exact vulnerability). See
    // JSDoc above.
    const orgId = req.fleetHost.orgId;
    const claimedOrgId = typeof body.org_id === 'string' ? body.org_id.trim() : '';
    if (claimedOrgId && claimedOrgId !== orgId) {
      console.warn(
        `[fleetGripeHandler] request from host "${req.fleetHost.hostId}" claimed org_id="${claimedOrgId}" ` +
        `but its credential resolves to org_id="${orgId}" — using the resolved org, ignoring the claim.`
      );
    }

    const hostId = typeof body.host_id === 'string' ? body.host_id.trim() : req.fleetHost.hostId;
    const complaintText = typeof body.complaint_text === 'string' ? body.complaint_text.trim() : '';

    if (!hostId) {
      return res.status(400).json({ success: false, error: 'bad_request', message: 'host_id is required' });
    }
    if (!complaintText) {
      return res.status(400).json({ success: false, error: 'bad_request', message: 'complaint_text is required' });
    }
    if (typeof executeConnectorTool !== 'function') {
      return res.status(500).json({ success: false, error: 'server_misconfigured', message: 'connector bridge not wired' });
    }

    const parsed = parseFleetGripe(complaintText, {
      hostId,
      repoOverride: typeof body.repo === 'string' ? body.repo.trim() : undefined,
      labelOverride: typeof body.label === 'string' ? body.label.trim() : undefined,
    });

    const input = {
      repo: parsed.repo,
      title: parsed.title,
      body: parsed.body,
      labels: [parsed.label],
    };

    // orgId here is the ONLY org identifier passed to the connector bridge
    // — it comes from req.fleetHost.orgId (resolved server-side from this
    // request's own credential via requireFleetHostAuth()), never from the
    // request body or any cached/ambient value, so one org's fleet host can
    // never resolve another org's vault credentials by simply claiming a
    // different org_id in its payload (see the org-impersonation test below).
    const context = {
      agentId: 'gripe-fleet',
      orgId,
      corr: `FLEETGRIPE_${hostId}_${Date.now()}`,
    };

    let result;
    try {
      result = await executeConnectorTool(orgId, 'github', 'create_issue', input, context);
    } catch (err) {
      console.error('[fleetGripeHandler] create_issue call threw:', err.message);
      return res.status(502).json({ success: false, error: err.message || 'connector_call_failed' });
    }

    if (!result || result.success !== true) {
      const errMsg = (result && result.error) || 'create_issue_failed';
      console.warn('[fleetGripeHandler] create_issue failed:', errMsg);
      return res.status(502).json({ success: false, error: errMsg });
    }

    // Real completion only — issue actually filed, never on a failed/
    // 502'd attempt above.
    logGripeIssueFiled({
      source: `fleet:${hostId}`,
      repo: parsed.repo,
      number: result.result && result.result.number,
      title: result.result && result.result.title,
      url: result.result && result.result.url,
    });

    return res.json({
      success: true,
      issue: result.result,
      repo: parsed.repo,
      label: parsed.label,
      repo_defaulted: parsed.repoDefaulted,
      label_defaulted: parsed.labelDefaulted,
    });
  };
}

module.exports = {
  REPO_KEYWORD_TABLE,
  LABEL_KEYWORD_TABLE,
  DEFAULT_REPO,
  DEFAULT_LABEL,
  parseFleetGripe,
  createFleetGripeFileIssueHandler,
};
