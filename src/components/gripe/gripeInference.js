/**
 * Gripe inference: the deterministic repo + label keyword tables and the
 * title/body templates, as a PURE, dependency-free module (the Gripe page
 * imports it; nothing here touches the DOM, the network or React).
 *
 * The tables MIRROR the GRIPE agent's own parsing rules in
 * src/config/entities/assistants/gripe.json ("Step 1: Parse"). The CLI
 * (`quox gripe`) delegates inference to that agent, so the agent prompt is the
 * original source of truth; src/test/gripeInference.test.js pins this module
 * to the prompt so the two cannot drift silently.
 */

export const DEFAULT_REPO = 'quoxai/quox'
export const DEFAULT_LABEL = 'fleet/idea'
export const DEFAULT_OWNER = 'quoxai'

/** Fleet labels, in the order the chips render. */
export const FLEET_LABELS = ['fleet/qa', 'fleet/idea', 'fleet/docs', 'fleet/plan', 'fleet/research']

/** Repo keyword table, in the agent prompt's order. */
export const REPO_RULES = [
  { repo: 'quoxai/quoxwebsite', keywords: ['website', 'pricing', 'landing', 'blog', 'seo'] },
  { repo: 'quoxai/quox', keywords: ['dashboard', 'sidebar', 'panel', 'plugin', 'agent', 'memory', 'glass', 'cogcore', 'wiremap', 'opsdeck', 'mission control', 'quox tui', 'tui', 'quoxon', 'slash command', 'quox window', 'status line'] },
  { repo: 'quoxai/quoxflow', keywords: ['flow', 'workflow', 'cron', 'executor', 'schedule', 'quoxflow'] },
  { repo: 'quoxai/quoxmcp', keywords: ['mcp', 'oauth', 'tool-call'] },
  { repo: 'quoxai/quoxterminal', keywords: ['quoxterminal', 'tauri', 'desktop app'] },
  // QUOXON-PRIVACY (d2683d4b5): no PUBLIC repo is ever picked by keyword. quoxai/quox-plugin-sdk is
  // public, so it is reachable only by an explicit repo: override (the collector's allowlist then asks
  // a human to confirm a public filing).
  { repo: 'quoxai/quoxbastion', keywords: ['bastion', 'ssh', 'fleet', 'vm'] },
]

/** Label keyword table, in the agent prompt's order (first matching rule wins). */
export const LABEL_RULES = [
  { label: 'fleet/qa', keywords: ['bug', 'broken', 'error', 'crash', 'fail'] },
  { label: 'fleet/idea', keywords: ['could be better', 'ux', 'nit', 'improvement', 'should', 'ugly'] },
  { label: 'fleet/docs', keywords: ['docs', 'documentation', 'readme', 'outdated'] },
  { label: 'fleet/plan', keywords: ['architecture', 'refactor', 'tech debt'] },
  { label: 'fleet/research', keywords: ['investigate', 'investigation', 'research', 'unclear'] },
]

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whole-token match with an optional plural/verb suffix ("fails", "crashed", "panels"). */
function matchesKeyword(text, kw) {
  const re = new RegExp(`(^|[^a-z0-9])${escapeRe(kw)}(?:s|es|ed|ing)?(?![a-z0-9])`, 'i')
  return re.test(text)
}

/** Pull `repo:`/`reponame:`/`label:` overrides out of the text. */
export function parseOverrides(text = '') {
  const s = String(text)
  const repoM = s.match(/(?:^|\s)(?:repo|reponame):(\S+)/i)
  const labelM = s.match(/(?:^|\s)label:(\S+)/i)
  const cleaned = s
    .replace(/(?:^|\s)(?:repo|reponame):\S+/gi, ' ')
    .replace(/(?:^|\s)label:\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { repo: repoM ? repoM[1] : null, label: labelM ? labelM[1] : null, cleaned }
}

/** Normalise "name" or "owner/name" to "owner/name". */
export function normaliseRepo(repo) {
  const r = String(repo || '').trim()
  if (!r) return ''
  return r.includes('/') ? r : `${DEFAULT_OWNER}/${r}`
}

export function splitRepo(repo) {
  const [owner, name] = normaliseRepo(repo).split('/', 2)
  return { owner, name }
}

/**
 * Infer repo + label from a one-liner.
 * Repo: the rule whose LONGEST matched keyword is longest wins (so "plugin-sdk"
 * beats "plugin"); ties go to the earlier rule. Label: first matching rule.
 * Returns { repo, label, repoDefaulted, labelDefaulted, text } where `text`
 * is the gripe with any overrides stripped.
 */
export function inferGripe(input = '') {
  const { repo: repoOverride, label: labelOverride, cleaned } = parseOverrides(input)

  let repo = DEFAULT_REPO
  let repoDefaulted = true
  if (repoOverride) {
    repo = normaliseRepo(repoOverride)
    repoDefaulted = false
  } else {
    let best = null
    for (const rule of REPO_RULES) {
      for (const kw of rule.keywords) {
        if (matchesKeyword(cleaned, kw) && (!best || kw.length > best.len)) {
          best = { repo: rule.repo, len: kw.length }
        }
      }
    }
    if (best) { repo = best.repo; repoDefaulted = false }
  }

  let label = DEFAULT_LABEL
  let labelDefaulted = true
  if (labelOverride) {
    label = labelOverride
    labelDefaulted = false
  } else {
    const rule = LABEL_RULES.find((r) => r.keywords.some((kw) => matchesKeyword(cleaned, kw)))
    if (rule) { label = rule.label; labelDefaulted = false }
  }

  return { repo, label, repoDefaulted, labelDefaulted, text: cleaned }
}

/** Title: first line, 80 chars max (77 + "..."), same cut as `quox gripe --yes`. */
export function buildTitle(text = '') {
  const firstLine = String(text).trim().split('\n')[0]
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine
}

/** Issue body: the GRIPE agent/CLI template with Source: dashboard. */
export function buildBody(text = '', { repoDefaulted = false } = {}) {
  const gripe = String(text).trim()
  return [
    '## Gripe',
    gripe,
    '',
    '## Context',
    '- Filed from Gripe (dashboard)',
    '- Priority: minor / off-task observation',
    '- Source: dashboard',
    ...(repoDefaulted ? [`- Repo defaulted to ${DEFAULT_REPO} (no keyword matched)`] : []),
    '',
    '## Suggested Action',
    'Investigate and fix if confirmed.',
  ].join('\n')
}
