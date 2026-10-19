// multilingualReader — ingest a base knowledge vault + its per-language
// translation dirs into ONE push-vault, stamping each note with its `language`
// so the brain exposes a LANGUAGE FACET instead of 18 duplicate vaults.
//
// Layout assumed (NodeBrain-style):
//   <base>/<enSubdir>/**/*.md          -> language 'en'
//   <base>/translations_<lang>/**/*.md -> language '<lang>'
//
// Usage:
//   node readers/multilingualReader.mjs --base ~/obsidian \
//     --en-subdir NodeBrain --org <orgId> --vault "ExampleVPN KB" [--scope org] [--dry-run]
//
// Idempotent (content-hash skip in the push API). Re-runnable.

import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, relative, basename } from 'node:path'
import { ensurePushVault, pushDocuments } from './lib/brainClient.mjs'

function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k.startsWith('--')) {
      const key = k.slice(2)
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
      a[key] = val
    }
  }
  return a
}

function walkMd(dir) {
  const out = []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...walkMd(full))
    else if (e.isFile() && e.name.endsWith('.md')) out.push(full)
  }
  return out
}

// Collect {relPath, content, language, occurredAt} for every md file under a
// language root. relPath is prefixed with the language so the same document in
// two languages gets distinct stable ids (e.g. `de/support/foo.md`).
function collectLang(langRootAbs, language) {
  const files = walkMd(langRootAbs)
  return files.map((abs) => {
    const rel = relative(langRootAbs, abs)
    let content = ''
    let mtime = null
    try {
      content = readFileSync(abs, 'utf8')
      mtime = statSync(abs).mtime.toISOString()
    } catch { /* skip unreadable */ }
    return {
      relPath: `${language}/${rel}`,
      content,
      title: basename(rel, '.md'),
      kind: 'note',
      sourceType: 'kb',
      language,
      occurredAt: mtime
    }
  }).filter((d) => d.content)
}

async function run() {
  const args = parseArgs(process.argv.slice(2))
  const base = args.base
  const enSubdir = args['en-subdir'] || null
  const orgId = args.org
  const vaultName = args.vault || 'Knowledge Base'
  const scope = args.scope || 'org'
  const userId = args['user-id'] || undefined
  const dryRun = !!args['dry-run']
  if (!base || !orgId) {
    console.error('usage: --base <dir> --org <orgId> [--en-subdir NodeBrain] [--vault name] [--scope org|user|shared] [--dry-run]')
    process.exit(1)
  }

  // Discover language roots: the en subdir (language 'en') + every translations_* dir.
  const roots = []
  if (enSubdir) roots.push({ abs: join(base, enSubdir), language: 'en' })
  let entries = []
  try { entries = readdirSync(base, { withFileTypes: true }) } catch {}
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith('translations_')) {
      roots.push({ abs: join(base, e.name), language: e.name.replace('translations_', '') })
    }
  }

  let allDocs = []
  const perLang = {}
  for (const r of roots) {
    const docs = collectLang(r.abs, r.language)
    perLang[r.language] = docs.length
    allDocs = allDocs.concat(docs)
  }

  console.log(`[multilingual] base=${base} vault="${vaultName}" scope=${scope} org=${orgId}`)
  console.log(`[multilingual] languages: ${Object.entries(perLang).map(([l, n]) => `${l}:${n}`).join('  ')}`)
  console.log(`[multilingual] total docs: ${allDocs.length}`)
  if (dryRun) { console.log('[multilingual] --dry-run, not pushing'); return }

  const vaultId = await ensurePushVault(orgId, vaultName, { scope, userId })
  const res = await pushDocuments(orgId, vaultId, allDocs, { userId })
  console.log(`[multilingual] pushed -> added:${res.added} updated:${res.updated} skipped:${res.skipped} chunks:${res.chunks}`)
}

run().catch((e) => { console.error('[multilingual] failed:', e.message); process.exit(1) })
