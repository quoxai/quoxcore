/**
 * NotesQ AssistantQ wires (AQ-9D P4), pure helpers for the details rail.
 *
 * These MIRROR cli/lib/commands/notesBridges.js (extractTasks, promoteBody) and
 * must change together: the same note has to yield the same tasks, the same
 * hashes and the same stream note from the CLI and from the browser, or a task
 * sent from one surface would be sent again from the other.
 *
 * The only difference is the hash: the CLI uses node:crypto, the browser has
 * only crypto.subtle (async). Both are sha1(lowercased trimmed text).slice(0,12).
 */

/** sha1 hex of a string, first 12 chars; same value as the CLI's createHash('sha1'). */
export async function shortHash(s) {
  const buf = await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
}

/** Unchecked markdown tasks (`- [ ] x`, `* [ ]`, `1. [ ]`) outside code fences, with a stable short hash. */
export async function extractTasks(markdown) {
  const out = []
  let fence = false
  for (const line of String(markdown || '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue }
    if (fence) continue
    const m = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+(.+?)\s*$/.exec(line)
    if (m && m[1]) out.push({ text: m[1].slice(0, 200), hash: await shortHash(m[1].trim().toLowerCase()) })
  }
  return out
}

/** Deep link back to a note, as the CLI writes it. */
export const noteLink = (id) => `/notes?note=${id}`

/** The QuoxPlan stream note for a promoted note: title, link and an excerpt without the H1. */
export function promoteBody(note, link) {
  const body = String(note.markdown || '').replace(/^\s*#\s+.+\n+/, '').trim()
  const excerpt = body.length > 1500 ? `${body.slice(0, 1500).trimEnd()}...` : body
  return `NotesQ: "${note.title || 'Untitled'}" ${link}${excerpt ? `\n\n${excerpt}` : ''}`
}

/** Body for one Action-Q item, exactly as the CLI posts it. */
export function actionBody(task, note) {
  return { title: task.text, tags: ['notesq'], notes: `From note "${note.title || 'Untitled'}": ${noteLink(note.id)}` }
}

/** { fresh, sent } split of tasks against the note's recorded actions_extracted hashes. */
export function splitSent(tasks, properties) {
  const sent = new Set(Array.isArray(properties?.actions_extracted) ? properties.actions_extracted : [])
  const fresh = tasks.filter((t) => !sent.has(t.hash))
  return { fresh, sent: tasks.length - fresh.length }
}
