// transcriptReader.mjs — P2b-3 (T3) filesystem corpus reader: Claude Code
// session transcripts (`*.jsonl`, one line per event) — the biggest
// untapped corpus (1.4GB+ across dozens of files at
// /opt/quoxcore/.claude/projects/-opt-quoxcore/*.jsonl).
//
// Ingests the SIGNAL — user intent + assistant reasoning/decisions/tool
// calls — and TRIMS the noise: megabyte tool-result dumps, system
// reminders, thinking-block internals, and tool_use `input` payloads are
// never held onto beyond the single line they arrived on.
//
// STREAMS every file line-by-line via readline (never readFileSync — a
// single session file can be 200MB+). Each parsed JSON line is transient;
// only the small extracted text fragments survive into the `turns` array
// that becomes the rendered markdown note.
//
// Pushed into a push-vault named VAULT_NAME via the P2b-1 API (idempotent
// content-hash skip on re-run), same as docsReader/gitReader/autoMemoryReader.

import { createReadStream, readdirSync, statSync, existsSync } from 'fs'
import { createInterface } from 'node:readline'
import { join, basename } from 'path'
import { fileURLToPath } from 'node:url'
import { cleanUserText } from './transcriptNoise.mjs'

export const DEFAULT_TRANSCRIPT_DIR = '/opt/quoxcore/.claude/projects/-opt-quoxcore'
export const VAULT_NAME = 'Dev Sessions'

// Per-turn cap — a single giant turn (e.g. a wall-of-text assistant reply)
// can't bloat the note past this many characters.
const MAX_TURN_CHARS = 4000

// Per-note cap (approx bytes) — sessions that would render past this get
// split into transcript/<sessionId>-partN.md at turn boundaries.
const MAX_NOTE_BYTES = 150 * 1024

// thinking blocks are internal reasoning scratch — keep only a short gist,
// never the full block (which can run to thousands of chars).
const THINKING_GIST_CHARS = 200

function truncate(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated]`
}

/**
 * Extracts genuine user prompt text from a `type:'user'` event's
 * `message.content`. Returns null when the line is noise: a
 * <system-reminder> string, a tool_result block, an attachment, or an
 * otherwise-empty message.
 */
function extractUserText(message) {
  const content = message?.content
  if (typeof content === 'string') {
    return cleanUserText(content)
  }
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') {
        const t = cleanUserText(block.text)
        if (t) parts.push(t)
      }
      // tool_result / image / attachment / other block types: bulk noise,
      // deliberately never read beyond `block.type`.
    }
    return parts.length ? parts.join('\n\n') : null
  }
  return null
}

/**
 * Extracts the visible signal from a `type:'assistant'` event's
 * `message.content` array: text blocks in full, thinking blocks as a short
 * gist, tool_use blocks as a one-line `[tool: <name>]` marker (never the
 * `input` payload). tool_result / other block types are skipped entirely.
 */
function extractAssistantText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return null
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      const t = block.text.trim()
      if (t) parts.push(t)
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      const t = block.thinking.trim()
      if (t) parts.push(`_thinking: ${truncate(t, THINKING_GIST_CHARS)}_`)
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      parts.push(`[tool: ${block.name}]`)
    }
    // tool_result and anything else: skipped — bulk noise.
  }
  return parts.length ? parts.join('\n\n') : null
}

/**
 * Streams a single transcript .jsonl file line-by-line and reduces it to
 * an ordered list of {role, text} turns plus the session title (last
 * `custom-title` event seen wins). Never loads the whole file into memory —
 * each line is parsed, its signal extracted, then discarded.
 *
 * Consecutive assistant events (a single logical assistant turn is often
 * split across several JSONL lines — one per content block) are merged
 * into a single assistant turn, flushed whenever a genuine user turn (or
 * end of file) follows.
 *
 * @param {string} filePath
 * @returns {Promise<{title: string|null, turns: Array<{role:'user'|'assistant', text:string}>, malformedLines: number}>}
 */
export async function parseTranscriptFile(filePath) {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })

  let title = null
  const turns = []
  let assistantBuffer = []
  let malformedLines = 0

  function flushAssistant() {
    if (assistantBuffer.length === 0) return
    const text = assistantBuffer.join('\n\n')
    assistantBuffer = []
    if (text.trim()) turns.push({ role: 'assistant', text: truncate(text, MAX_TURN_CHARS) })
  }

  for await (const rawLine of rl) {
    const line = rawLine.trim()
    if (!line) continue

    let event
    try {
      event = JSON.parse(line)
    } catch {
      malformedLines += 1
      continue
    }

    switch (event.type) {
      case 'custom-title':
        if (typeof event.customTitle === 'string' && event.customTitle.trim()) {
          title = event.customTitle.trim()
        }
        break

      case 'user': {
        if (event.message?.role !== 'user') break
        const text = extractUserText(event.message)
        if (text) {
          flushAssistant()
          turns.push({ role: 'user', text: truncate(text, MAX_TURN_CHARS) })
        }
        break
      }

      case 'assistant': {
        if (event.message?.role !== 'assistant') break
        const text = extractAssistantText(event.message)
        if (text) assistantBuffer.push(text)
        break
      }

      // system, attachment, file-history-snapshot, queue-operation,
      // bridge-session, agent-name, mode, permission-mode, last-prompt:
      // intentionally ignored — no signal.
      default:
        break
    }
  }

  flushAssistant()
  return { title, turns, malformedLines }
}

function renderTurn(turn) {
  const label = turn.role === 'user' ? '**You:**' : '**Assistant:**'
  return `${label} ${turn.text}`
}

/**
 * Renders an ordered turn list into one or more markdown note bodies,
 * splitting at turn boundaries whenever a part would exceed MAX_NOTE_BYTES.
 * Never splits inside a single turn.
 *
 * @param {string} title
 * @param {Array<{role:string,text:string}>} turns
 * @returns {string[]} one entry per note part
 */
export function buildNoteParts(title, turns) {
  const baseHeading = `# ${title}`
  const partTurns = []
  let current = []
  let currentBytes = Buffer.byteLength(baseHeading, 'utf8')

  for (const turn of turns) {
    const rendered = renderTurn(turn)
    const renderedBytes = Buffer.byteLength(rendered, 'utf8') + 2 // blank-line separator
    if (current.length > 0 && currentBytes + renderedBytes > MAX_NOTE_BYTES) {
      partTurns.push(current)
      current = []
      currentBytes = Buffer.byteLength(baseHeading, 'utf8')
    }
    current.push(rendered)
    currentBytes += renderedBytes
  }
  if (current.length > 0 || partTurns.length === 0) partTurns.push(current)

  const multiPart = partTurns.length > 1
  return partTurns.map((renderedTurns, i) => {
    const heading = multiPart ? `${baseHeading} (part ${i + 1})` : baseHeading
    return [heading, '', ...renderedTurns].join('\n\n')
  })
}

function listJsonlFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl'))
    .map((entry) => join(dir, entry.name))
    .sort()
}

/**
 * Streams + reduces one session transcript file into its push-ingest
 * document payload(s) (1 doc, or N parts if it exceeded MAX_NOTE_BYTES).
 * Sessions with zero extracted turns produce no documents.
 *
 * @param {string} filePath
 * @returns {Promise<{docs: Array<object>, sessionId: string, title: string, turnCount: number, partCount: number, malformedLines: number, chars: number}>}
 */
export async function collectSessionDocuments(filePath) {
  const sessionId = basename(filePath, '.jsonl')
  const stat = statSync(filePath)
  const { title, turns, malformedLines } = await parseTranscriptFile(filePath)
  const resolvedTitle = title || sessionId

  if (turns.length === 0) {
    return { docs: [], sessionId, title: resolvedTitle, turnCount: 0, partCount: 0, malformedLines, chars: 0 }
  }

  const noteParts = buildNoteParts(resolvedTitle, turns)
  const multiPart = noteParts.length > 1
  const occurredAt = stat.mtime.toISOString()

  const docs = noteParts.map((content, i) => ({
    relPath: multiPart ? `transcript/${sessionId}-part${i + 1}.md` : `transcript/${sessionId}.md`,
    content,
    title: multiPart ? `${resolvedTitle} (part ${i + 1})` : resolvedTitle,
    kind: 'transcript_session',
    sourceType: 'transcript',
    language: 'en',
    occurredAt
  }))

  const chars = docs.reduce((sum, d) => sum + d.content.length, 0)
  return { docs, sessionId, title: resolvedTitle, turnCount: turns.length, partCount: docs.length, malformedLines, chars }
}

/**
 * Collects the full transcript corpus (every `*.jsonl` file directly under
 * `dir`) as push-ingest document payloads, plus a per-session summary
 * array for logging. Pure w.r.t. the brain — streams the filesystem, never
 * calls the brain API.
 *
 * @param {{dir?:string, limitFiles?:number}} [opts]
 */
export async function collectDocuments({ dir = DEFAULT_TRANSCRIPT_DIR, limitFiles } = {}) {
  const files = listJsonlFiles(dir)
  const selected = typeof limitFiles === 'number' && !Number.isNaN(limitFiles)
    ? files.slice(0, limitFiles)
    : files

  const docs = []
  const sessions = []
  for (const filePath of selected) {
    const result = await collectSessionDocuments(filePath)
    docs.push(...result.docs)
    sessions.push(result)
  }

  return { docs, sessions, fileCount: selected.length }
}

function logSummary(sessions, docCount) {
  let totalChars = 0
  let totalTurns = 0
  for (const s of sessions) {
    totalChars += s.chars
    totalTurns += s.turnCount
    const malformedNote = s.malformedLines ? `, ${s.malformedLines} malformed line(s)` : ''
    console.log(`[transcriptReader] ${s.sessionId} "${s.title}": ${s.turnCount} turn(s), ${s.partCount} part(s), ${s.chars} chars${malformedNote}`)
  }
  const approxMb = (totalChars / (1024 * 1024)).toFixed(2)
  console.log(`[transcriptReader] totals: ${sessions.length} session(s), ${docCount} doc(s), ${totalTurns} turn(s), ~${totalChars} chars (~${approxMb}MB) extracted`)
}

/**
 * Runs the reader end to end: stream + collect the transcript corpus,
 * ensure the push vault exists, push documents. `dryRun` skips the network
 * calls entirely and just logs the per-session breakdown + totals.
 *
 * @param {{orgId:string, dir?:string, vaultName?:string, scope?:string, userId?:string, limitFiles?:number, dryRun?:boolean, deleteAbsent?:boolean}} opts
 */
export async function run({
  orgId,
  dir = DEFAULT_TRANSCRIPT_DIR,
  vaultName = VAULT_NAME,
  scope = 'org',
  userId,
  limitFiles,
  dryRun = false,
  deleteAbsent = false
} = {}) {
  const { docs, sessions } = await collectDocuments({ dir, limitFiles })
  logSummary(sessions, docs.length)

  if (dryRun) {
    return { vault: vaultName, vaultId: null, docCount: docs.length, added: 0, updated: 0, skipped: 0, chunks: 0 }
  }

  const { ensurePushVault, pushDocuments } = await import('./lib/brainClient.mjs')
  const vaultId = await ensurePushVault(orgId, vaultName, { scope, userId })
  // Codex cycle 5 F5: an unlimited read of an existing, readable dir with no
  // transcripts left is a real emptying; only then may an empty push delete.
  let emptyConfirmed = false
  if (docs.length === 0 && !limitFiles) {
    try { emptyConfirmed = existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).filter((n) => n.endsWith('.jsonl')).length === 0 } catch { emptyConfirmed = false }
  }
  const summary = await pushDocuments(orgId, vaultId, docs, { deleteAbsent, userId, emptyConfirmed })
  return { vault: vaultName, vaultId, docCount: docs.length, ...summary }
}

export default { collectDocuments, collectSessionDocuments, parseTranscriptFile, buildNoteParts, run, VAULT_NAME, DEFAULT_TRANSCRIPT_DIR }

// -----------------------------------------------------------------------------
// Standalone CLI (this reader ingests a large, host-specific corpus that
// doesn't fit run.mjs's generic --repo/--limit shape as cleanly as the
// other filesystem readers, so it's directly executable too):
//
//   node readers/transcriptReader.mjs --dir <path> --org <orgId>
//     [--vault "Dev Sessions"] [--scope org] [--user-id <id>]
//     [--limit-files N] [--dry-run] [--delete-absent]
// -----------------------------------------------------------------------------

function parseCliArgs(argv) {
  const args = {
    dir: DEFAULT_TRANSCRIPT_DIR,
    org: null,
    vault: VAULT_NAME,
    scope: 'org',
    userId: undefined,
    limitFiles: undefined,
    dryRun: false,
    deleteAbsent: false
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--dir':
        args.dir = argv[++i]
        break
      case '--org':
        args.org = argv[++i]
        break
      case '--vault':
        args.vault = argv[++i]
        break
      case '--scope':
        args.scope = argv[++i]
        break
      case '--user-id':
        args.userId = argv[++i]
        break
      case '--limit-files':
        args.limitFiles = Number(argv[++i])
        break
      case '--dry-run':
        args.dryRun = true
        break
      case '--delete-absent':
        args.deleteAbsent = true
        break
      default:
        console.error(`[transcriptReader] unrecognized argument: ${arg}`)
        process.exit(1)
    }
  }
  return args
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (isMainModule) {
  const args = parseCliArgs(process.argv.slice(2))
  if (!args.org) {
    console.error('Usage: node readers/transcriptReader.mjs --dir <path> --org <orgId> [--vault "Dev Sessions"] [--scope org] [--user-id <id>] [--limit-files N] [--dry-run] [--delete-absent]')
    process.exit(1)
  }

  run({
    orgId: args.org,
    dir: args.dir,
    vaultName: args.vault,
    scope: args.scope,
    userId: args.userId,
    limitFiles: args.limitFiles,
    dryRun: args.dryRun,
    deleteAbsent: args.deleteAbsent
  }).then((result) => {
    console.log('[transcriptReader] done:', result)
  }).catch((err) => {
    console.error('[transcriptReader] failed:', err)
    process.exit(1)
  })
}
