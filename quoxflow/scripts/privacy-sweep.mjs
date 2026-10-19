#!/usr/bin/env node
/**
 * privacy-sweep.mjs — real-infrastructure-identifier gate (text), HEAD only.
 *
 * Standalone port of quox-dashboard's scripts/privacy-sweep.mjs (itself a
 * port of quox-website's `npm run gate:privacy-sweep`), adapted for the
 * quoxflow repo ahead of public visibility (GTM-R2).
 *
 * Scans every git-tracked text file for the owner's real infrastructure
 * identifiers: LAN addresses, real hostnames, real public IPs, and
 * owner-personal strings. Git history is explicitly out of scope (owner
 * decision) — this only ever looks at the current working tree via
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
// Scan surface: every git-tracked file, minus excluded dirs.
// ---------------------------------------------------------------------------
export const EXCLUDED_DIR_PREFIXES = [
  'node_modules/',
  'dist/',
  'build/',
  '.git/',
  '.claude/worktrees/', // nested worktree checkouts, not this repo's own tree
]
export const SCAN_EXTENSIONS = [
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.html',
  '.yml', '.yaml', '.sh', '.env.example', '.toml', '.cfg', '.conf', '.txt',
  '.sql', '.mts',
]

// ---------------------------------------------------------------------------
// Allowlist — {file, match} pairs intentionally exempt, reason pinned.
// ---------------------------------------------------------------------------
export const ALLOWLIST = [
  // RFC1918 network-boundary constants inside isPrivateIP() itself — the
  // literal definitions of the 10.0.0.0/8 and 192.168.0.0/16 ranges, not
  // real infrastructure addresses.
  { file: 'src/executors/call.executor.ts', match: '10.0.0.0' },
  { file: 'src/executors/call.executor.ts', match: '192.168.0.0' },
  // Generic RFC1918 example addresses used purely to exercise
  // private-IP/SSRF/rate-limit/firewall detection logic (any private IP
  // would do — value chosen has no relationship to real infra).
  { file: 'src/api/middleware/rate-limit.test.ts', match: '192.168.1.1' },
  { file: 'src/executors/agent-invoke.executor.test.ts', match: '192.168.1.50' },
  { file: 'src/objective/objective.test.ts', match: '192.168.1.1' },
  { file: 'src/integration/reliability-batch-1.test.ts', match: '192.168.1.5' },
  { file: 'src/security/__tests__/skill_firewall.test.ts', match: '192.168.1.100' },
  { file: 'src/executors/call.executor.test.ts', match: '192.168.0.5' },
  // Generic example private CIDR (192.168.1.0/24) chosen to exercise the
  // QUOXFLOW_ALLOWED_PRIVATE allowlist logic — deliberately NOT the real
  // owner subnet it replaced during this sweep.
  { file: 'src/executors/call.executor.test.ts', match: '192.168.1.177' },
  { file: 'src/executors/call.executor.test.ts', match: '192.168.1.0' },
  { file: 'src/executors/call.executor.test.ts', match: '10.0.0.0' },
  { file: 'src/executors/call.executor.ts', match: '192.168.1.0' },
  // Project codename ("QUOXPERTICUS P5") in a version-history comment —
  // not a reachable hostname or access disclosure.
  { file: 'src/store/core-dev-pack-seed.ts', match: 'QUOXPERTICUS' },
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
// Public-mirror parity. quoxflow ships inside the public QuoxCORE mirror, whose
// privacy gate (quox scripts/release/public-mirror/privacy-allow.txt) accepts
// 192.168 example addresses ONLY in the 192.168.0.x and 192.168.1.x blocks. A
// reviewed example here in any other block passes this sweep but fails the
// mirror at release time (it did: a fictional /24 from GTM-R2 blocked a clean
// install of main). So: allowlist entries and this file's own text may only use
// those two blocks. This file is not scanned by the sweep above, so this is
// also what stops it shipping an off-block address itself.
// ---------------------------------------------------------------------------
// Same shape as the mirror gate: every occurrence of the dotted 192.168 prefix must continue as
// 192.168.0.x, 192.168.1.x, 192.168.x or 192.168.*, so a split or computed literal is caught too.
const MIRROR_OK = /^192\.168\.((0|1)\.[0-9x]|x|\*)/i
function offBlockHits(text) {
  const out = []
  const re = /192\.168\./gi
  let m
  while ((m = re.exec(text)) !== null) if (!MIRROR_OK.test(text.slice(m.index))) out.push(m.index)
  return out
}
export function mirrorParityFailures(allowlist = ALLOWLIST, selfSource = readFileSync(fileURLToPath(import.meta.url), 'utf-8')) {
  const bad = []
  for (const { file, match } of allowlist) {
    if (offBlockHits(match).length) bad.push(`ALLOWLIST ${file}: "${match}" is outside the mirror's 192.168.0.x/1.x example blocks`)
  }
  selfSource.split('\n').forEach((ln, i) => {
    if (offBlockHits(ln).length) bad.push(`scripts/privacy-sweep.mjs:${i + 1}: 192.168 text outside the mirror's 192.168.0.x/1.x example blocks`)
  })
  return bad
}

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
    // The detector never scans itself: it documents fictional example IPs and
    // codenames in its allowlist, and its sensitive patterns are the point of
    // the file. Its own real-literal exposure is prevented by encoding (above),
    // not by scanning. Standard practice (a linter does not lint its own rules).
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

  const offBlock = ['192', '168', '77', '5'].join('.') // built from octets so this file keeps no off-block literal
  if (mirrorParityFailures([{ file: 'fixture/x.test.ts', match: offBlock }], '').length !== 1) failures.push('off-block allowlist entry not flagged for mirror parity')
  if (mirrorParityFailures([{ file: 'fixture/x.test.ts', match: '192.168.1.5' }], `// ${offBlock}`).length !== 1) failures.push('off-block address in detector source not flagged for mirror parity')
  if (mirrorParityFailures([{ file: 'fixture/x.test.ts', match: '192.168.1.5' }], '// 192.168.0.0/16').length !== 0) failures.push('in-block addresses incorrectly flagged for mirror parity')
  if (mirrorParityFailures([], `const ip = '${['192', '168', ''].join('.')}' + n`).length !== 1) failures.push('split 192.168 literal not flagged for mirror parity')

  if (failures.length) {
    console.error('FAIL privacy-sweep --self-test')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('PASS privacy-sweep --self-test (7/7 fixture checks behaved as expected)')
  process.exit(0)
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest()
    return
  }
  const fileContents = collectScanTargets()
  const failures = [...checkPrivacySweep(fileContents), ...mirrorParityFailures()]
  if (failures.length) {
    console.error(`FAIL privacy-sweep (${failures.length} finding(s) across ${fileContents.length} scanned files)`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log(`PASS privacy-sweep (${fileContents.length} files scanned, 0 findings)`)
  process.exit(0)
}

// Run only as a script, so tests can import the checkers.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
