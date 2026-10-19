#!/usr/bin/env node
/**
 * QLOOP-ENGINE P3 step (b): the dark manual learning pass.
 *
 * Runs the learning pipeline on demand: completed+witnessed objectives ->
 * observer -> detector -> proposer, queuing DRAFT skills (human review required)
 * through the existing chokepoint. PREVIEW BY DEFAULT: it only reports what it
 * WOULD propose unless you pass --commit. Even with --commit it can only queue
 * human-review drafts; nothing is ever promoted.
 *
 * Run it where the tasks service's env is available (DB_PATH, and for --commit
 * also QUOXFLOW_URL + INTERNAL_SERVICE_KEY):
 *
 *   node services/tasks/scripts/learning-pass.mjs --org <id> [--since <ts>]
 *       [--threshold N] [--limit N] [--commit]
 *
 * A bare run (no --commit) is always safe. --commit is a human choosing to queue
 * the drafts for review; that choice is the authorization.
 */
import { initDatabase, getDatabase, closeDatabase } from '../db/index.js'
import { runLearningPass } from '../lib/learningPass.js'

function arg(name, def = null) {
  const i = process.argv.indexOf(name)
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def
}
const has = (name) => process.argv.includes(name)

async function main() {
  const dbPath = process.env.DB_PATH
  if (!dbPath) { console.error('Ⓠ QUOX │ learning pass │ DB_PATH not set ✖ (run where the tasks service env is available)'); process.exit(2) }

  const orgId = arg('--org')
  const sinceTs = arg('--since')
  const threshold = arg('--threshold') ? Number(arg('--threshold')) : undefined
  const limit = arg('--limit') ? Number(arg('--limit')) : undefined
  const commit = has('--commit')

  initDatabase(dbPath)
  try {
    const out = await runLearningPass(getDatabase(), { orgId, sinceTs, threshold, limit, dryRun: !commit })
    const mode = commit ? 'commit' : 'preview'
    console.log(`Ⓠ QUOX │ learning pass (${mode})${orgId ? ' org ' + orgId : ' all orgs'} │ scanned ${out.scanned} · candidates ${out.candidates} · patterns ${out.patterns} ${commit ? '· drafts queued ' + out.submitted + ' ✔' : '◐'}`)
    if (!commit && out.would_propose.length) {
      console.log('would propose DRAFTS (run again with --commit to queue them for human review):')
      for (const d of out.would_propose) console.log(`  · ${d.kind} shape ${d.shape} · ${d.occurrences}x · org ${d.org_id}`)
    }
    if (commit && out.skipped.length) {
      console.log('skipped:')
      for (const s of out.skipped) console.log(`  · ${s.shape || '(no shape)'} · ${s.reason}`)
    }
  } finally {
    closeDatabase()
  }
}

main().catch((err) => { console.error('Ⓠ QUOX │ learning pass │ failed ✖', err && err.message ? err.message : err); process.exit(1) })
