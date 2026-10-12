// gitReader.mjs — P2b-2 filesystem corpus reader: a repo's own `git log`
// history, rendered as one document per commit (subject + body + author +
// date + changed-files list). Uses child_process.execFile (never a shell)
// so repo paths / revision ranges never risk shell injection.
//
// Pushed into a push-vault named VAULT_NAME via the P2b-1 API. relPath is
// `git/<repoBasename>/<shortsha>.md` — the SAME scheme the collector's
// feedGitSource.js uses, so the manual reader and the scheduled Feed source
// converge on one note per commit instead of forking into duplicates.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname, basename, resolve } from 'path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))

export const DEFAULT_REPO_PATH = join(__dirname, '..', '..', '..')
export const VAULT_NAME = 'Git History'
export const DEFAULT_COMMIT_LIMIT = 1000

// Unit/record separator control characters (ASCII 0x1e / 0x1f) — unlikely
// to appear in commit metadata — used to split `git log` output into
// per-commit records and per-field columns without depending on any single
// field never containing a comma/newline.
const RECORD_SEP = '' // record separator
const FIELD_SEP = '' // unit separator
const LOG_FORMAT = ['%H', '%h', '%s', '%b', '%an', '%aI'].join(FIELD_SEP)

function renderCommitNote({ shortSha, sha, subject, body, author, date, files }) {
  const lines = [
    `# ${subject}`,
    '',
    `- Commit: ${sha}`,
    `- Author: ${author}`,
    `- Date: ${date}`
  ]
  if (files.length > 0) {
    lines.push(`- Files changed: ${files.length}`)
  }
  if (body.trim()) {
    lines.push('', body.trim())
  }
  if (files.length > 0) {
    lines.push('', '## Changed files', ...files.map((f) => `- ${f}`))
  }
  return lines.join('\n') + '\n'
}

/**
 * Collects the git log as push-ingest document payloads (pure w.r.t. the
 * brain — it does shell out to `git`, but never calls the brain API).
 * Exported standalone so tests can point it at a small fixture repo.
 *
 * @param {{repoPath?:string, limit?:number}} [opts]
 * @returns {Promise<Array<{relPath:string, content:string, title:string, kind:string, sourceType:string, occurredAt:string}>>}
 */
export async function collectDocuments({ repoPath = DEFAULT_REPO_PATH, limit = DEFAULT_COMMIT_LIMIT } = {}) {
  let stdout
  try {
    ;({ stdout } = await execFileAsync('git', [
      '-C', repoPath,
      'log',
      `-n`, String(limit),
      `--format=${RECORD_SEP}${LOG_FORMAT}`,
      '--name-only'
    ], { maxBuffer: 64 * 1024 * 1024 }))
  } catch (err) {
    throw new Error(`gitReader: \`git log\` failed for ${repoPath}: ${err.message}`)
  }

  const repoBasename = basename(resolve(repoPath))
  const records = stdout.split(RECORD_SEP).map((r) => r.trim()).filter(Boolean)
  const docs = []

  for (const record of records) {
    // %b (body) can itself contain embedded newlines, so a newline can't be
    // used to separate the "header" from the trailing file list — but
    // FIELD_SEP never appears inside any of git's own field values, so
    // splitting the WHOLE record on it first is safe. The 6th (last) field,
    // %aI, is immediately followed by `--name-only`'s own blank line +
    // changed-file list in the same string — split that tail on '\n'.
    const parts = record.split(FIELD_SEP)
    if (parts.length < 6) continue
    const [sha, shortSha, subject, body = '', author, dateAndFiles] = parts
    if (!sha) continue

    const [date, ...fileLines] = dateAndFiles.split('\n')
    const files = fileLines.map((l) => l.trim()).filter(Boolean)

    docs.push({
      relPath: `git/${repoBasename}/${shortSha}.md`,
      content: renderCommitNote({ shortSha, sha, subject, body, author, date, files }),
      title: subject,
      kind: 'commit',
      sourceType: 'git',
      occurredAt: date
    })
  }

  return docs
}

/**
 * Runs the reader end to end: collect the commit corpus, ensure the push
 * vault exists, push documents.
 *
 * @param {{orgId:string, repoPath?:string, limit?:number, dryRun?:boolean, deleteAbsent?:boolean}} opts
 */
export async function run({ orgId, repoPath = DEFAULT_REPO_PATH, limit = DEFAULT_COMMIT_LIMIT, dryRun = false, deleteAbsent = false }) {
  const docs = await collectDocuments({ repoPath, limit })

  if (dryRun) {
    return { vault: VAULT_NAME, vaultId: null, docCount: docs.length, added: 0, updated: 0, skipped: 0, chunks: 0 }
  }

  const { ensurePushVault, pushDocuments } = await import('./lib/brainClient.mjs')
  const vaultId = await ensurePushVault(orgId, VAULT_NAME)
  const summary = await pushDocuments(orgId, vaultId, docs, { deleteAbsent })
  return { vault: VAULT_NAME, vaultId, docCount: docs.length, ...summary }
}

export default { collectDocuments, run, VAULT_NAME, DEFAULT_REPO_PATH, DEFAULT_COMMIT_LIMIT }
