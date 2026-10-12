// docsReader.mjs — P2b-2 filesystem corpus reader: the dashboard's own
// `docs/**/*.md` tree plus the repo-root knowledge files (CLAUDE.md,
// ARCHITECTURE.md, NEXT_SESSION.md, CODEBASE_MAP.md). The highest-value
// reader — this is the project's own hand-written documentation corpus.
//
// Pushed into a single push-vault named VAULT_NAME via the P2b-1 API
// (lib/ingest.js ingestDocuments — idempotent per-relPath content-hash
// skip), so re-running this reader on an unchanged tree is a no-op.

import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, relative, dirname } from 'path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// readers/ -> services/quoxbrain/ -> services/ -> quox-dashboard/ (repo root)
export const DEFAULT_REPO_ROOT = join(__dirname, '..', '..', '..')

export const VAULT_NAME = 'Quox Docs'

// Extra knowledge files living at the repo root, outside docs/. Each is
// optional — CODEBASE_MAP.md / ARCHITECTURE.md may not exist in every
// checkout state, so missing files are silently skipped rather than thrown.
const ROOT_KNOWLEDGE_FILES = ['CLAUDE.md', 'ARCHITECTURE.md', 'NEXT_SESSION.md', 'CODEBASE_MAP.md']

// Never walk into these — mirrors lib/ingest.js's own SKIP_DIR_NAMES/dotdir
// convention for consistency, even though docs/ itself has none of these
// today.
const SKIP_DIR_NAMES = new Set(['.obsidian', '.trash', 'node_modules'])

function walkMarkdownFiles(root) {
  const files = []
  if (!existsSync(root)) return files

  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIR_NAMES.has(entry.name)) continue
        walk(join(dir, entry.name))
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(join(dir, entry.name))
      }
    }
  }

  walk(root)
  return files
}

function toDocument(absPath, repoRoot) {
  const content = readFileSync(absPath, 'utf8')
  const stat = statSync(absPath)
  return {
    // Normalize to forward-slash relPaths regardless of host path.sep, so
    // the same fixture-relative paths are produced on posix and (in
    // principle) Windows dev boxes.
    relPath: relative(repoRoot, absPath).split('\\').join('/'),
    content,
    kind: 'note',
    sourceType: 'docs',
    occurredAt: stat.mtime.toISOString()
  }
}

/**
 * Collects the docs corpus as push-ingest document payloads (pure — no
 * network calls). Exported standalone so tests can point it at a small
 * fixture directory instead of the real repo.
 *
 * @param {{repoRoot?: string}} [opts]
 * @returns {Array<{relPath:string, content:string, kind:string, sourceType:string, occurredAt:string}>}
 */
export function collectDocuments({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const docs = []

  const docsDir = join(repoRoot, 'docs')
  for (const absPath of walkMarkdownFiles(docsDir)) {
    docs.push(toDocument(absPath, repoRoot))
  }

  for (const name of ROOT_KNOWLEDGE_FILES) {
    const absPath = join(repoRoot, name)
    if (existsSync(absPath) && statSync(absPath).isFile()) {
      docs.push(toDocument(absPath, repoRoot))
    }
  }

  return docs
}

/**
 * Runs the reader end to end: collect the corpus, ensure the push vault
 * exists, push documents. `dryRun` skips both network calls and just
 * returns the collected doc count — useful for `run.mjs --dry-run`.
 *
 * @param {{orgId:string, repoRoot?:string, dryRun?:boolean, deleteAbsent?:boolean}} opts
 */
export async function run({ orgId, repoRoot = DEFAULT_REPO_ROOT, dryRun = false, deleteAbsent = false }) {
  const docs = collectDocuments({ repoRoot })

  if (dryRun) {
    return { vault: VAULT_NAME, vaultId: null, docCount: docs.length, added: 0, updated: 0, skipped: 0, chunks: 0 }
  }

  const { ensurePushVault, pushDocuments } = await import('./lib/brainClient.mjs')
  const vaultId = await ensurePushVault(orgId, VAULT_NAME)
  // Codex cycle 5 F5: the repo is there and simply has no docs left.
  let emptyConfirmed = false
  if (docs.length === 0) { try { emptyConfirmed = existsSync(repoRoot) && statSync(repoRoot).isDirectory() } catch { emptyConfirmed = false } }
  const summary = await pushDocuments(orgId, vaultId, docs, { deleteAbsent, emptyConfirmed })
  return { vault: VAULT_NAME, vaultId, docCount: docs.length, ...summary }
}

export default { collectDocuments, run, VAULT_NAME, DEFAULT_REPO_ROOT }
