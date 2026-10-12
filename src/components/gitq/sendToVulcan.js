/**
 * GITQ Stream A — Send-to-Vulcan shared link/seed builder.
 *
 * PURE and dependency-free by design. The GitQ Issues tab and the Gripe pad
 * both import this module; NEITHER imports the other. That is what keeps the
 * cockpit free of an import cycle (the issues surface and the gripe surface
 * are siblings, joined only through this leaf module and the chat handle).
 *
 * "Send to Vulcan" means: seed the persistent Vulcan chat with the context of
 * an issue or a gripe, so the human can review and let Vulcan triage. Vulcan's
 * only write path (github_create_pull_request) is human-approved, so seeding a
 * chat turn is never itself a destructive action.
 */

/** Trim a body to a sane length for a chat seed (full issue is one click away). */
function clip(text, max = 1500) {
  if (!text) return ''
  const s = String(text).trim()
  return s.length > max ? `${s.slice(0, max)}\n...(truncated, open the issue for the full body)` : s
}

/**
 * Best-effort repo slug from a merged-issues row. The collector proxy merges
 * issues across repos; different shapes have surfaced, so resolve defensively.
 */
export function issueRepoSlug(issue = {}) {
  if (issue.repo) return issue.repo
  if (issue.owner && issue.name) return `${issue.owner}/${issue.name}`
  if (issue.repository?.full_name) return issue.repository.full_name
  if (typeof issue.repository_url === 'string') {
    // .../repos/{owner}/{repo}
    const m = issue.repository_url.match(/repos\/([^/]+\/[^/]+)$/)
    if (m) return m[1]
  }
  return 'unknown/repo'
}

/** Human label for an issue row. */
export function issueLabel(issue = {}) {
  const slug = issueRepoSlug(issue)
  const num = issue.number != null ? `#${issue.number}` : ''
  return `${slug} ${num}`.trim()
}

/**
 * Build the chat seed for triaging a GitHub issue with Vulcan.
 * Returns a plain string suitable for chatHandle.send(seed).
 */
export function buildVulcanSeedFromIssue(issue = {}) {
  const slug = issueRepoSlug(issue)
  const num = issue.number != null ? `#${issue.number}` : ''
  const url = issue.html_url || issue.url || ''
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map(l => (typeof l === 'string' ? l : l?.name)).filter(Boolean).join(', ')
    : ''
  const lines = [
    `Please triage ${slug} ${num}: "${issue.title || '(no title)'}".`,
    url ? `Link: ${url}` : '',
    labels ? `Labels: ${labels}` : '',
    '',
    'Read the issue fully, use codebase_query to find the relevant code, and only if you are confident of the root cause, propose a fix as a pull request (github_create_pull_request is human-approved and never merges). If you are not confident, say what you found and what is unclear rather than guessing.',
    '',
    issue.body ? `Issue body:\n${clip(issue.body)}` : '',
  ]
  return lines.filter(l => l !== '').join('\n').trim()
}

/**
 * Build the chat seed for a one-line gripe. Vulcan decides whether it is a real
 * defect worth a fix; it never claims to have fixed anything on its own.
 */
export function buildVulcanSeedFromGripe(text = '') {
  const gripe = String(text).trim()
  return [
    'A one-line gripe just came in. If it is a real, actionable defect, triage it (find the relevant code with codebase_query) and, when confident, propose a fix as a human-approved pull request. If it is not actionable or you are unsure, say so plainly rather than guessing.',
    '',
    `Gripe: "${gripe}"`,
  ].join('\n').trim()
}
