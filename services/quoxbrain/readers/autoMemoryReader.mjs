// autoMemoryReader.mjs — P2b-2 filesystem corpus reader: the orchestrator's
// own distilled cross-session knowledge — the auto-memory directory
// (MEMORY.md index + topic files + HANDOVER_*.md / NEXT_SESSION*.md), which
// already exist as flat `*.md` files directly in the directory (no HANDOVER/
// NEXT_SESSION-specific glob needed beyond the top-level `*.md` walk).
//
// Pushed into a push-vault named VAULT_NAME via the P2b-1 API.

import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'node:os'
import { join as pathJoin } from 'node:path'

// #1021: Claude project dir for the host user. Claude names a project dir by its
// path with separators turned into '-'. QUOX_HOST_HOME wins, else the running user.
const hostHome = process.env.QUOX_HOST_HOME || homedir()
const claudeProjectDir = pathJoin(hostHome, '.claude', 'projects', hostHome.replace(/[\\/]/g, '-'))

export const DEFAULT_MEMORY_DIR = join(claudeProjectDir, 'memory')
export const VAULT_NAME = 'Agent Memory'

function listMarkdownFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => join(dir, entry.name))
}

function toDocument(absPath, memoryDir) {
  const content = readFileSync(absPath, 'utf8')
  const stat = statSync(absPath)
  const name = absPath.slice(memoryDir.length + 1)
  const relPath = `memory/${name}`
  return {
    relPath,
    content,
    kind: 'note',
    sourceType: 'automemory',
    occurredAt: stat.mtime.toISOString(),
    // ONE-BRAIN A1 (QuoxPlan #493): a file-corpus reader has no canonical
    // DB row to point at, so origin_id falls back to the note's own stable
    // key (its relPath) rather than staying unstamped — origin_store='files'
    // still lets recall distinguish "known filesystem corpus" from "unknown
    // origin" even without a real foreign id.
    originStore: 'files',
    originId: relPath
  }
}

/**
 * Collects the auto-memory corpus as push-ingest document payloads (pure —
 * no network calls). Exported standalone so tests can point it at a small
 * fixture directory instead of the real memory dir.
 *
 * @param {{memoryDir?: string}} [opts]
 * @returns {Array<{relPath:string, content:string, kind:string, sourceType:string, occurredAt:string}>}
 */
export function collectDocuments({ memoryDir = DEFAULT_MEMORY_DIR } = {}) {
  return listMarkdownFiles(memoryDir).map((absPath) => toDocument(absPath, memoryDir))
}

/**
 * Runs the reader end to end: collect the memory corpus, ensure the push
 * vault exists, push documents.
 *
 * @param {{orgId:string, memoryDir?:string, dryRun?:boolean, deleteAbsent?:boolean}} opts
 */
/** Codex cycle 5 F5: the directory was read and holds no markdown, so an empty
 * snapshot really means "everything was deleted" (a missing mount does not). */
export function sourceConfirmedEmpty(memoryDir) {
  try { return existsSync(memoryDir) && statSync(memoryDir).isDirectory() && listMarkdownFiles(memoryDir).length === 0 } catch { return false }
}

export async function run({ orgId, memoryDir = DEFAULT_MEMORY_DIR, dryRun = false, deleteAbsent = false, scope = 'org', userId }) {
  const docs = collectDocuments({ memoryDir })

  if (dryRun) {
    return { vault: VAULT_NAME, vaultId: null, docCount: docs.length, added: 0, updated: 0, skipped: 0, chunks: 0 }
  }

  const { ensurePushVault, pushDocuments } = await import('./lib/brainClient.mjs')
  const vaultId = await ensurePushVault(orgId, VAULT_NAME, { scope, userId })
  const summary = await pushDocuments(orgId, vaultId, docs, { deleteAbsent, userId, emptyConfirmed: docs.length === 0 && sourceConfirmedEmpty(memoryDir) })
  return { vault: VAULT_NAME, vaultId, docCount: docs.length, ...summary }
}

export default { collectDocuments, run, VAULT_NAME, DEFAULT_MEMORY_DIR }
