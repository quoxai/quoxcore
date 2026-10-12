'use strict';

/**
 * repobrainGitCredential.js — credential broker for RepoBrain private repos
 * (owner chose "fix the product", 2026-10-05: github.com/quoxai/chatgpt-uploads
 * could not be indexed; the dashboard's Connect GitHub sent a plain clone URL
 * and the engine never used any credential).
 *
 * The engine calls POST /api/internal/nucleus/git-credential (service key)
 * right before cloning/fetching a target marked auth:'org_github'. This hands
 * back ONLY the target org's own mapped GitHub credential (source 'vault-org'),
 * never github-proxy's shared '_global' fallback or the instance GITHUB_TOKEN,
 * and only for https://github.com/<owner>/<repo>. The engine keeps nothing.
 */

const GITHUB_REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(\.git)?\/?$/;

async function brokerGitCredential({ orgId, repoUrl } = {}, { resolveOrgToken } = {}) {
  if (!orgId) return { ok: false, code: 'org_required' };
  if (typeof repoUrl !== 'string' || !GITHUB_REPO.test(repoUrl)) return { ok: false, code: 'unsupported_repo_url' };
  let entry = null;
  try { entry = await resolveOrgToken(orgId); } catch { entry = null; }
  if (!entry || entry.source !== 'vault-org' || !entry.token) {
    return { ok: false, code: 'no_org_github_credential' };
  }
  return { ok: true, username: 'x-access-token', password: entry.token };
}

module.exports = { brokerGitCredential, GITHUB_REPO };
