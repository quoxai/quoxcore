/**
 * Attachment helpers for NotesQ (pure, no DOM). Markdown stays canonical: an
 * attachment is just a same-origin link into the org file_objects store.
 *
 * NOTE: deleting text that references an attachment never deletes the stored
 * file. Revisions may still reference it, so files are only ever added here.
 */

export const NAMESPACE = 'notesq'
export const SOURCE_PLUGIN = 'notesq'
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024 // mirrors the auth route cap

// Only these are ever embedded as images. SVG and HTML are uploaded as plain
// files (chips) and never rendered inline.
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'])

const extOf = (name) => { const m = /\.([A-Za-z0-9]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : '' }

/** 'image' | 'file'. Declared mime wins; extension is the fallback when the browser gives none. */
export function classifyFile({ name, type } = {}) {
  const mime = String(type || '').split(';')[0].trim().toLowerCase()
  if (mime) return IMAGE_MIMES.has(mime) ? 'image' : 'file'
  return IMAGE_EXTS.has(extOf(name)) ? 'image' : 'file'
}

export function formatBytes(n) {
  const b = Number(n)
  if (!Number.isFinite(b) || b < 0) return '0 B'
  if (b < 1024) return `${Math.round(b)} B`
  const units = ['KB', 'MB', 'GB']
  let v = b / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  const s = v >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1)
  return `${s} ${units[i]}`
}

/** Clear message when a file is unusable, else null. */
export function validateFile(file) {
  if (!file) return 'No file selected.'
  if (file.size === 0) return `${file.name || 'File'} is empty.`
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `${file.name || 'File'} is ${formatBytes(file.size)}, over the ${formatBytes(MAX_ATTACHMENT_BYTES)} attachment limit.`
  }
  return null
}

/** Pasted screenshots arrive as a generic "image.png"; give them a datestamped name. */
export function nameForPaste(file, now = new Date()) {
  const name = file?.name || ''
  if (name && !/^image\.\w+$/i.test(name)) return name
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}`
  const ext = extOf(name) || ((file?.type || '').split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png'
  return `Screenshot ${stamp}.${ext}`
}

export const attachmentUrl = (orgId, fileId) => `/api/orgs/${encodeURIComponent(orgId)}/files/${encodeURIComponent(fileId)}`

/** True for links this module wrote (same-origin org file URLs). */
export const isAttachmentHref = (href) => /^\/api\/orgs\/[^/]+\/files\/[^/?#]+$/.test(String(href || ''))

// Link text must not break out of [...]; keep it readable.
const label = (s) => String(s || 'file').replace(/[[\]\\]/g, '_').replace(/[\r\n]+/g, ' ').trim() || 'file'

/** { kind, label, url, markdown } for one uploaded file. Rich mode uses kind/label/url, markdown mode uses markdown. */
export function describeAttachment({ name, size, type, url }) {
  const l = label(name)
  if (classifyFile({ name, type }) === 'image') return { kind: 'image', label: l, url, markdown: `![${l}](${url})` }
  const text = `${l} (${formatBytes(size)})`
  return { kind: 'file', label: text, url, markdown: `[${text}](${url})` }
}

export const buildAttachmentMarkdown = (f) => describeAttachment(f).markdown

export const placeholderText = (name) => `![Uploading ${label(name)}…]()`

/** Replace the first placeholder for `name` (or remove it when replacement is ''). Unchanged text if absent. */
export function replacePlaceholder(markdown, name, replacement) {
  const ph = placeholderText(name)
  const i = markdown.indexOf(ph)
  if (i < 0) return markdown
  return markdown.slice(0, i) + replacement + markdown.slice(i + ph.length)
}
