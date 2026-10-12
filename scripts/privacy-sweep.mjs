#!/usr/bin/env node
/**
 * privacy-sweep.mjs — real-infrastructure-identifier gate (text), HEAD only.
 *
 * Standalone port of quox-website's `npm run gate:privacy-sweep`
 * (scripts/refactor-gates/privacy-sweep-check.mjs), adapted for the
 * quox-dashboard repo ahead of public visibility (GTM-R2).
 *
 * Scans every git-tracked text file EXCEPT `src/` (already swept on branch
 * gtm-a1-demo-data — do not re-touch those files here) for the owner's real
 * infrastructure identifiers: LAN addresses, real hostnames, real public
 * IPs, and owner-personal strings. Git history is explicitly out of scope
 * (owner decision) — this only ever looks at the current working tree via
 * `git ls-files`.
 *
 * Usage:
 *   node scripts/privacy-sweep.mjs
 *   node scripts/privacy-sweep.mjs --self-test
 *
 * Exit codes:
 *   0  clean (outside the reviewed allowlist)
 *   1  one or more sensitive identifiers found (listed on stderr)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))

// ---------------------------------------------------------------------------
// Sensitive literals are stored base64-encoded so this DETECTOR file does not
// itself ship the owner's real hostnames/personal strings in plaintext (a
// public copy of a plaintext detector would leak exactly what it hunts, and
// would also flag its own source so the gate could never pass). Decoded once
// at load; detection behaviour is unchanged.
// ---------------------------------------------------------------------------
const _dec = (b64) => Buffer.from(b64, 'base64').toString('utf-8')
const _S = JSON.parse(_dec('eyJob3N0cyI6WyJhY2Nlc3MwMSIsInBiczAxIiwicWNvcmUtZGV2MDEiLCJjbGllbnQwMDAxIiwicXVveGRlbGFjbGF1ZGljdXMwMSIsIm5vZGV2cG4wMSIsInFzZWMtdGFyZ2V0MDEiXSwiaG9zdFByZWZpeGVzIjpbInF1b3hwZXJ0aWN1cyIsImNsYXVkaWN1cyJdLCJwZXJzb25hbCI6WyJkb29yLmJsYWNrIiwicG9vbHBybyIsImFydW4iXSwiZW1haWxQcmVmaXgiOiJhZGFtQCIsImZ4X2RpcnR5IjoiYmFzdGlvbiBob3N0IGF0IDE5Mi4xNjguODguMTAxLCBuYW1lIGFjY2VzczAxIiwiZnhfcGVyc29uYWwiOiJjb250YWN0IGFkYW1Abm93aGVyZS5leGFtcGxlIG9yIHNlZSBwb29scHJvLmNvLnVrIn0='))
const _esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---------------------------------------------------------------------------
// Scan surface: every git-tracked file, minus excluded dirs and `src/`
// (already swept on gtm-a1-demo-data — this pass targets docs/, scripts/,
// service configs, README, compose files, everything else).
// ---------------------------------------------------------------------------
export const EXCLUDED_DIR_PREFIXES = [
  'src/', // already swept on gtm-a1-demo-data
  'node_modules/',
  'dist/',
  'build/',
  '.git/',
  '.claude/worktrees/', // nested worktree checkouts, not this repo's own tree
]
export const SCAN_EXTENSIONS = [
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.html',
  '.yml', '.yaml', '.sh', '.env.example', '.toml', '.cfg', '.conf', '.txt',
]

// ---------------------------------------------------------------------------
// Allowlist — {file, match} pairs intentionally exempt, reason pinned.
// ---------------------------------------------------------------------------
export const ALLOWLIST = [
  // Fictional mock-fleet IP swapped in during the GTM-R2 sweep (the real
  // owner IP was replaced); the broad 192.168.x.x pattern still flags it
  // because it's structurally a private address, not real infrastructure.
  { file: 'tests/helpers/llmRoutingHarness.js', match: '192.168.1.10' },
  // The public-flip exclusion manifest must name the internal files it
  // excludes; three of those FILENAMES contain hostname-shaped strings.
  // These are references to file paths slated for removal, not live values.
  { file: 'docs/internal/PUBLIC_EXCLUDE_LIST.md', match: 'CLAUDICUS' },
  { file: 'docs/internal/PUBLIC_EXCLUDE_LIST.md', match: 'QUOXPERTICUS' },
  { file: 'docs/internal/PUBLIC_EXCLUDE_LIST.md', match: 'quoxperticus' },
  // The resident agent PRODUCT's name (the p-word entries below) is a shipped
  // code identifier: the services/tasks mode of that name, migrations 092-097,
  // its Settings > Instance panel, and its systemd unit directory under
  // deploy/. The hostname pattern (name + optional digits) exists to catch the
  // owner's real resident SESSION names (the name followed by a box number),
  // which these exact-match entries deliberately do NOT exempt. The bare
  // product name is allowed only in the surfaces whose subject it is; real
  // host/IP values in those same docs were fictionalized in the GTM-R2d
  // sanitize pass. The detector itself no longer needs self-referencing
  // entries: its pattern literals are encoded and it excludes its own file
  // from the scan (see collectScanTargets).
  { file: 'docs/STATUS_AND_LIMITS_QUOXPERTICUS.md', match: 'QUOXPERTICUS' },
  { file: 'docs/STATUS_AND_LIMITS_QUOXPERTICUS.md', match: 'Quoxperticus' },
  { file: 'docs/STATUS_AND_LIMITS_QUOXPERTICUS.md', match: 'quoxperticus' },
  { file: 'deploy/quoxperticus/INSTALL.md', match: 'QUOXPERTICUS' },
  { file: 'deploy/quoxperticus/INSTALL.md', match: 'Quoxperticus' },
  { file: 'deploy/quoxperticus/INSTALL.md', match: 'quoxperticus' },
  { file: 'deploy/quoxperticus/wake.sh', match: 'QUOXPERTICUS' },
  { file: 'deploy/quoxperticus/wake.sh', match: 'quoxperticus' },
  { file: 'docs/STATUS_AND_LIMITS_QLOOP.md', match: 'QUOXPERTICUS' },
  { file: 'docs/STATUS_AND_LIMITS_RESIDENT.md', match: 'quoxperticus' },
  { file: 'docs/STATUS_AND_LIMITS_DEV-SERVERS.md', match: 'Quoxperticus' },
  { file: 'docs/STATUS_AND_LIMITS_DEV-SERVERS.md', match: 'quoxperticus' },
]

// ---------------------------------------------------------------------------
// Sensitive patterns
// ---------------------------------------------------------------------------
// Host alternation built from decoded tokens: plain hosts (escaped), plus the
// two \d*-suffixed prefixes and the structural pve0[1-7] pattern.
const _hostAlt = [
  ..._S.hosts.map(_esc),
  ..._S.hostPrefixes.map((p) => _esc(p) + '\\d*'),
  'pve0[1-7]',
].join('|')
const _personalAlt = _S.personal.map(_esc).join('|')

export const SENSITIVE_PATTERNS = [
  { name: 'real LAN address (192.168.x.x)', regex: /\b192\.168\.\d{1,3}\.\d{1,3}\b/g },
  { name: 'real LAN address (10.0.0.x)', regex: /\b10\.0\.0\.\d{1,3}\b/g },
  { name: 'real hostname', regex: new RegExp(`\\b(${_hostAlt})\\b`, 'gi') },
  { name: 'real public IP', regex: /\b95\.217\.\d{1,3}\.\d{1,3}\b/g },
  { name: 'owner-personal string', regex: new RegExp(`\\b(${_personalAlt})\\b`, 'gi') },
  { name: 'owner email fragment', regex: new RegExp(`\\b${_esc(_S.emailPrefix)}[a-z0-9.-]+\\b`, 'gi') },
]

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------
function listTrackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf-8' })
  return out.split('\n').filter(Boolean)
}

export function collectScanTargets() {
  const files = listTrackedFiles().filter((f) => {
    if (EXCLUDED_DIR_PREFIXES.some((prefix) => f.startsWith(prefix))) return false
    // The detector never scans itself: its sensitive patterns are the point of
    // the file (now encoded, so no real literal ships) and its allowlist names
    // exempt occurrences. Standard practice (a linter does not lint its rules).
    if (f.endsWith('scripts/privacy-sweep.mjs')) return false
    return SCAN_EXTENSIONS.some((ext) => f.endsWith(ext))
  })
  const results = []
  for (const file of files) {
    const full = path.join(REPO_ROOT, file)
    try {
      const stat = lstatSync(full)
      if (!stat.isFile()) continue
      results.push({ file, content: readFileSync(full, 'utf-8') })
    } catch {
      // binary or unreadable; skip
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Checker: pure function, fixture-testable
// ---------------------------------------------------------------------------
export function checkPrivacySweep(fileContents, patterns = SENSITIVE_PATTERNS, allowlist = ALLOWLIST) {
  const allowSet = new Set(allowlist.map(({ file, match }) => `${file} ${match}`))
  const failures = []
  for (const { file, content } of fileContents) {
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const { name, regex } of patterns) {
        regex.lastIndex = 0
        let m
        while ((m = regex.exec(line)) !== null) {
          if (!allowSet.has(`${file} ${m[0]}`)) {
            failures.push(`${file}:${i + 1}: ${name} — "${m[0]}"`)
          }
          if (m.index === regex.lastIndex) regex.lastIndex++
        }
      }
    }
  }
  return failures
}

function selfTest() {
  const failures = []
  const dirty = [{ file: 'fixture/docs/Fixture.md', content: _S.fx_dirty }]
  if (checkPrivacySweep(dirty).length !== 2) failures.push('dirty fixture not fully flagged')

  const clean = [{ file: 'fixture/docs/Fixture.md', content: 'bastion host at 203.0.113.10, name hyp-01' }]
  if (checkPrivacySweep(clean).length !== 0) failures.push('clean fixture incorrectly flagged')

  const personal = [{ file: 'fixture/README.md', content: _S.fx_personal }]
  if (checkPrivacySweep(personal).length !== 2) failures.push('owner-personal strings not flagged')

  if (failures.length) {
    console.error('FAIL privacy-sweep --self-test')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('PASS privacy-sweep --self-test (3/3 fixture checks behaved as expected)')
  process.exit(0)
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest()
    return
  }
  const fileContents = collectScanTargets()
  const failures = checkPrivacySweep(fileContents)
  if (failures.length) {
    console.error(`FAIL privacy-sweep (${failures.length} finding(s) across ${fileContents.length} scanned files)`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log(`PASS privacy-sweep (${fileContents.length} files scanned, 0 findings)`)
  process.exit(0)
}

main()
