/**
 * gripeRepoPolicy.js — QUOXON-PRIVACY. Single source for which repos a gripe
 * may be filed to, their visibility (STATIC; never ask GitHub), and the
 * pre-public-filing privacy scrub. Used by the fleet gripe handler and by the
 * shared connector choke (bridge.js executeConnectorTool github/create_issue),
 * so the GRIPE agent, the CLI proxy and fleet hosts all hit one gate.
 */
'use strict';

const REPO_ALLOWLIST = {
  'quoxai/quox': 'private',
  'quoxai/quoxwebsite': 'private',
  'quoxai/quoxflow': 'private',
  'quoxai/quoxterminal': 'private',
  'quoxai/quoxbastion': 'private',
  'quoxai/quoxagent': 'private',
  'quoxai/quoxmcp': 'public',
  'quoxai/quox-plugin-sdk': 'public',
};

// Same patterns as scripts/release/public-mirror/privacy-patterns.txt.
const PRIVACY_SCRUB_PATTERNS = [
  /pve0[0-9]/i, /bastion-01/i, /dev-host-01/i, /customer-01/i,
  /192\.168\./, /(^|[^0-9.])10\.0\.[0-9]+\.[0-9]/, /\/home\/[a-z0-9_-]+/i,
];

function scrubHits(text) {
  return PRIVACY_SCRUB_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
}

function normalizeRepo(raw) {
  const r = String(raw || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '');
  if (!r) return '';
  return r.includes('/') ? r : `quoxai/${r}`;
}

/**
 * Gate a filing. `strict` (fleet handler) refuses every repo not on the
 * allowlist; non-strict (the shared choke) only polices the quoxai org so
 * customers' own repos through the GitHub connector are untouched.
 * humanConfirmedPublic must come from a server-side human path, NEVER from
 * model-controlled tool input.
 * -> { ok:true, repo, visibility } | { ok:false, error, message, patterns? }
 */
function evaluateGripeFiling({ repo, title = '', body = '', humanConfirmedPublic = false, strict = false }) {
  const norm = normalizeRepo(repo);
  const visibility = REPO_ALLOWLIST[norm] || null;
  if (!visibility) {
    if (!strict && !/^quoxai\//i.test(norm)) return { ok: true, repo: norm, visibility: null };
    return { ok: false, error: 'repo_not_allowed', message: `repo "${norm}" is not on the gripe allowlist` };
  }
  if (visibility === 'public') {
    if (humanConfirmedPublic !== true) {
      return {
        ok: false,
        error: 'public_repo_requires_confirmation',
        message: `"${norm}" is PUBLIC; the issue would be world-readable. Only a human can confirm this (CLI: quox gripe --repo <name> --public). Do not retry.`,
      };
    }
    const hits = scrubHits(`${title}\n${body}`);
    if (hits.length) {
      return {
        ok: false,
        error: 'privacy_scrub_failed',
        message: 'refusing to file to a public repo: text matches internal-only patterns',
        patterns: hits,
      };
    }
  }
  return { ok: true, repo: norm, visibility };
}

module.exports = { REPO_ALLOWLIST, PRIVACY_SCRUB_PATTERNS, scrubHits, normalizeRepo, evaluateGripeFiling };
