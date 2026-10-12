#!/usr/bin/env node
// run.mjs — CLI runner for the P2b-2 filesystem corpus readers.
//
//   node readers/run.mjs --reader <docs|git|automemory|transcript|all> --org <orgId> [--repo <path>] [--limit <n>] [--dry-run]
//
// Each reader is idempotent (P2b-1's content-hash skip) — safe to re-run on
// a cron/schedule once this graduates from a host-runnable script to a
// scheduled job (out of scope for P2b-2).

import * as docsReader from './docsReader.mjs'
import * as gitReader from './gitReader.mjs'
import * as autoMemoryReader from './autoMemoryReader.mjs'
import * as transcriptReader from './transcriptReader.mjs'

const READERS = {
  docs: docsReader,
  git: gitReader,
  automemory: autoMemoryReader,
  transcript: transcriptReader
}

function parseArgs(argv) {
  const args = { reader: null, org: null, repo: undefined, limit: undefined, dryRun: false, deleteAbsent: false, scope: 'org', userId: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--reader':
        args.reader = argv[++i]
        break
      case '--org':
        args.org = argv[++i]
        break
      case '--scope':
        args.scope = argv[++i]
        break
      case '--user-id':
        args.userId = argv[++i]
        break
      case '--repo':
        args.repo = argv[++i]
        break
      case '--limit':
        args.limit = Number(argv[++i])
        break
      case '--dry-run':
        args.dryRun = true
        break
      case '--delete-absent':
        args.deleteAbsent = true
        break
      default:
        console.error(`[run] unrecognized argument: ${arg}`)
        process.exit(1)
    }
  }
  return args
}

function printSummaryTable(rows) {
  const headers = ['vault', 'added', 'updated', 'skipped', 'chunks']
  const widths = headers.map((h, i) => Math.max(
    h.length,
    ...rows.map((r) => String(r[i] ?? '').length)
  ))

  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  |  ')

  console.log(line(headers))
  console.log(widths.map((w) => '-'.repeat(w)).join('--+--'))
  for (const row of rows) {
    console.log(line(row))
  }
}

async function runOne(name, mod, { org, repo, limit, dryRun, deleteAbsent, scope, userId }) {
  const opts = { orgId: org, dryRun, deleteAbsent, scope, userId }
  if (repo !== undefined) {
    // docsReader takes `repoRoot`, gitReader takes `repoPath` — both accept
    // the same CLI --repo flag for convenience.
    opts.repoRoot = repo
    opts.repoPath = repo
  }
  if (limit !== undefined && !Number.isNaN(limit)) {
    opts.limit = limit
  }

  console.log(`\n[run] starting reader "${name}"...`)
  const result = await mod.run(opts)
  console.log(`[run] reader "${name}" done: ${result.docCount} document(s) collected.`)
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!args.reader) {
    console.error('Usage: node readers/run.mjs --reader <docs|git|automemory|transcript|all> --org <orgId> [--repo <path>] [--limit <n>] [--dry-run] [--delete-absent]')
    process.exit(1)
  }
  if (!args.org) {
    console.error('[run] --org <orgId> is required')
    process.exit(1)
  }

  const names = args.reader === 'all' ? Object.keys(READERS) : [args.reader]
  const unknown = names.filter((n) => !READERS[n])
  if (unknown.length > 0) {
    console.error(`[run] unknown reader(s): ${unknown.join(', ')}. Known readers: ${Object.keys(READERS).join(', ')}, all`)
    process.exit(1)
  }

  const rows = []
  let failed = 0
  for (const name of names) {
    try {
      const result = await runOne(name, READERS[name], args)
      rows.push([result.vault, result.added, result.updated, result.skipped, result.chunks])
    } catch (err) {
      console.error(`[run] reader "${name}" FAILED: ${err.message}`)
      rows.push([`${name} (ERROR)`, '-', '-', '-', '-'])
      failed += 1
    }
  }

  console.log('\n=== Summary ===')
  printSummaryTable(rows)
  // BRAIN2-W7 C 144: cron/automation must see a failed reader as a failure.
  if (failed > 0) {
    console.error(`[run] ${failed} of ${names.length} reader(s) failed`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('[run] fatal error:', err)
  process.exit(1)
})
