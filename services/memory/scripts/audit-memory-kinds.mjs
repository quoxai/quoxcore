// QSKL-13 slice 4: audit-memory-kinds
// One-shot, report-only audit of memory rows by memory_role.
// NO writes to the memories table — read-only.
//
// Usage:
//   node scripts/audit-memory-kinds.mjs
//
// Exports:
//   runAudit({ db, outputDir }) — testable function for unit tests

import Database from 'better-sqlite3'
import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ─── Exported audit function ──────────────────────────────────────────────────

/**
 * runAudit({ db, outputDir })
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db       - An open better-sqlite3 database instance
 * @param {string}                            opts.outputDir - Directory to write the JSON report to
 * @returns {object} The audit report object
 */
export async function runAudit({ db, outputDir }) {
  const generatedAt = new Date().toISOString()

  // ── 1. By-kind counts ──────────────────────────────────────────────────────
  const kindRows = db.prepare(`
    SELECT memory_role, COUNT(*) AS count
    FROM memories
    GROUP BY memory_role
    ORDER BY count DESC
  `).all()

  const byKind = { fact: 0, procedure: 0, session_history: 0 }
  for (const row of kindRows) {
    if (row.memory_role in byKind) {
      byKind[row.memory_role] = row.count
    }
  }

  // ── 2. Procedure candidates (capped at 50) ─────────────────────────────────
  const candidates = db.prepare(`
    SELECT id, substr(content, 1, 140) AS content_preview, created_at
    FROM memories
    WHERE memory_role = 'procedure'
    ORDER BY created_at DESC
    LIMIT 50
  `).all()

  // ── 3. Total procedure row count (uncapped) ────────────────────────────────
  const { total } = db.prepare(`
    SELECT COUNT(*) AS total
    FROM memories
    WHERE memory_role = 'procedure'
  `).get()

  // ── 4. Resolve db_path from the DB's filename property ────────────────────
  // better-sqlite3 exposes .name for the file path; use that or fallback.
  const dbPath = db.name || 'unknown'

  // ── 5. Build report ────────────────────────────────────────────────────────
  const report = {
    generated_at: generatedAt,
    db_path: dbPath,
    by_kind: byKind,
    procedure_candidates_total: total,
    procedure_candidates: candidates
  }

  // ── 6. Write to outputDir ─────────────────────────────────────────────────
  mkdirSync(outputDir, { recursive: true })
  const dateStr = generatedAt.slice(0, 10) // YYYY-MM-DD
  const outFile = join(outputDir, `memory-kinds-${dateStr}.json`)
  writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf-8')

  return report
}

// ─── CLI entry point ──────────────────────────────────────────────────────────
// Only runs when executed directly: node scripts/audit-memory-kinds.mjs

if (process.argv[1] === __filename) {
  const dbPath = process.env.DB_PATH
    ? resolve(process.env.DB_PATH)
    : resolve(__dirname, '..', 'data', 'memory.db')

  const outputDir = resolve(__dirname, '..', 'audit-output')

  const db = new Database(dbPath, { readonly: true })

  // Enable WAL so a readonly open doesn't block the live service
  try {
    db.pragma('journal_mode = WAL')
  } catch (_) {
    // WAL pragma on readonly connections is silently ignored in some versions
  }

  try {
    const report = await runAudit({ db, outputDir })

    // Stdout: pretty-printed JSON
    console.log(JSON.stringify(report, null, 2))

    const dateStr = report.generated_at.slice(0, 10)
    const outFile = `${outputDir}/memory-kinds-${dateStr}.json`
    console.error(`[audit] Written to ${outFile}`)
  } finally {
    db.close()
  }
}
