/**
 * Pure markdown editing transforms for the NotesQ toolbar and shortcuts.
 * Markdown stays canonical: every function maps (text, selection) to a new
 * text + selection and touches no DOM. The editor applies the result through
 * diffRange() so native undo survives.
 */

const lineStart = (t, i) => (i <= 0 ? 0 : t.lastIndexOf('\n', i - 1) + 1)
const lineEnd = (t, i) => { const n = t.indexOf('\n', i); return n === -1 ? t.length : n }
const isWord = (c) => !!c && /\w/.test(c)

/** Range of whole lines touched by [s, e]. A selection ending right after a newline excludes the next line. */
function blockRange(text, s, e) {
  const from = lineStart(text, s)
  const ref = e > s && text[e - 1] === '\n' ? e - 1 : e
  return { from, to: lineEnd(text, ref) }
}

const INLINE_MARKS = { bold: '**', italic: '*', strike: '~~', code: '`' }

function runLen(text, idx, ch, dir) {
  let n = 0
  while (dir < 0 ? text[idx - 1 - n] === ch : text[idx + n] === ch) n += 1
  return n
}
const markPresent = (run, m) => (m === '*' ? run % 2 === 1 : run >= m.length)

function toggleInline(text, s, e, m) {
  let a = s
  let b = e
  if (a === b) {
    while (isWord(text[a - 1])) a -= 1
    while (isWord(text[b])) b += 1
  }
  const L = m.length
  const sel = text.slice(a, b)
  const ch = m[0]
  const before = runLen(text, a, ch, -1)
  const after = runLen(text, b, ch, 1)
  if (before >= L && after >= L && markPresent(before, m) && markPresent(after, m)) {
    return { text: text.slice(0, a - L) + sel + text.slice(b + L), start: a - L, end: b - L }
  }
  const lead = runLen(sel, 0, ch, 1)
  const trail = runLen(sel, sel.length, ch, -1)
  if (sel.length >= 2 * L && lead >= L && trail >= L && lead < sel.length && markPresent(lead, m) && markPresent(trail, m)) {
    const inner = sel.slice(L, sel.length - L)
    return { text: text.slice(0, a) + inner + text.slice(b), start: a, end: a + inner.length }
  }
  return { text: text.slice(0, a) + m + sel + m + text.slice(b), start: a + L, end: b + L }
}

const LIST_PREFIX = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/
const HEAD_PREFIX = /^#{1,6}\s+/
const QUOTE_PREFIX = /^>\s?/

const LINE_KINDS = {
  ul: { has: (l) => /^\s*[-*+]\s+(?!\[[ xX]\]\s)/.test(l), strip: (l) => l.replace(LIST_PREFIX, '$1'), add: (l) => l.replace(LIST_PREFIX, '$1').replace(/^(\s*)/, '$1- ') },
  ol: { has: (l) => /^\s*\d+[.)]\s+/.test(l), strip: (l) => l.replace(LIST_PREFIX, '$1'), add: (l, n) => l.replace(LIST_PREFIX, '$1').replace(/^(\s*)/, `$1${n}. `), numbered: true },
  check: { has: (l) => /^\s*[-*+]\s+\[[ xX]\]\s+/.test(l), strip: (l) => l.replace(LIST_PREFIX, '$1'), add: (l) => l.replace(LIST_PREFIX, '$1').replace(/^(\s*)/, '$1- [ ] ') },
  quote: { has: (l) => QUOTE_PREFIX.test(l), strip: (l) => l.replace(QUOTE_PREFIX, ''), add: (l) => `> ${l}` },
}
;[1, 2, 3].forEach((n) => {
  const re = new RegExp(`^#{${n}}\\s`)
  LINE_KINDS[`h${n}`] = { has: (l) => re.test(l), strip: (l) => l.replace(HEAD_PREFIX, ''), add: (l) => `${'#'.repeat(n)} ${l.replace(HEAD_PREFIX, '')}` }
})

function toggleLines(text, s, e, kind) {
  const k = LINE_KINDS[kind]
  const { from, to } = blockRange(text, s, e)
  const lines = text.slice(from, to).split('\n')
  let targets = lines.map((l, i) => i).filter((i) => lines[i].trim() !== '')
  if (targets.length === 0) targets = lines.map((l, i) => i)
  const removing = targets.every((i) => k.has(lines[i]))
  let n = 1
  let caretDelta = 0
  let caretLine = 0
  const out = lines.map((l, i) => {
    if (!targets.includes(i)) return l
    const next = removing ? k.strip(l) : k.add(l, n)
    if (!removing) n += 1
    return next
  })
  if (s === e) {
    let off = from
    for (let i = 0; i < lines.length; i += 1) {
      if (s <= off + lines[i].length) { caretLine = i; break }
      off += lines[i].length + 1
    }
    caretDelta = out[caretLine].length - lines[caretLine].length
  }
  const block = out.join('\n')
  const next = text.slice(0, from) + block + text.slice(to)
  if (s === e) {
    let ls = from
    for (let i = 0; i < caretLine; i += 1) ls += out[i].length + 1
    const c = Math.max(ls, s + caretDelta)
    return { text: next, start: c, end: c }
  }
  return { text: next, start: from, end: from + block.length }
}

function toggleCodeBlock(text, s, e) {
  const { from, to } = blockRange(text, s, e)
  const lines = text.slice(from, to).split('\n')
  const isFence = (l) => /^```/.test(l)
  // Selection covers the fences themselves.
  if (lines.length >= 2 && isFence(lines[0]) && lines[lines.length - 1].trim() === '```') {
    const inner = lines.slice(1, -1).join('\n')
    return { text: text.slice(0, from) + inner + text.slice(to), start: from, end: from + inner.length }
  }
  // Fences sit on the lines just outside the selection.
  if (from > 0 && to < text.length) {
    const prevStart = lineStart(text, from - 1)
    const prev = text.slice(prevStart, from - 1)
    const nextEnd = lineEnd(text, to + 1)
    const next = text.slice(to + 1, nextEnd)
    if (isFence(prev) && next.trim() === '```') {
      const inner = text.slice(from, to)
      return { text: text.slice(0, prevStart) + inner + text.slice(nextEnd), start: prevStart, end: prevStart + inner.length }
    }
  }
  const inner = text.slice(from, to)
  return { text: `${text.slice(0, from)}\`\`\`\n${inner}\n\`\`\`${text.slice(to)}`, start: from + 4, end: from + 4 + inner.length }
}

function insertLink(text, s, e) {
  const sel = text.slice(s, e)
  if (/^https?:\/\/\S+$/.test(sel)) {
    return { text: `${text.slice(0, s)}[](${sel})${text.slice(e)}`, start: s + 1, end: s + 1 }
  }
  if (sel) {
    const us = s + 1 + sel.length + 2
    return { text: `${text.slice(0, s)}[${sel}](url)${text.slice(e)}`, start: us, end: us + 3 }
  }
  return { text: `${text.slice(0, s)}[text](url)${text.slice(e)}`, start: s + 1, end: s + 5 }
}

function insertNoteLink(text, s, e) {
  const sel = text.slice(s, e)
  const c = sel ? e + 2 : s + 2
  return { text: `${text.slice(0, s)}[[${sel}]]${text.slice(e)}`, start: c, end: c }
}

function insertRule(text, s, e) {
  const p = lineEnd(text, e)
  const curEmpty = text.slice(lineStart(text, e), p).trim() === ''
  const head = `${text.slice(0, p)}${curEmpty ? '' : '\n\n'}---\n\n`
  return { text: head + text.slice(p).replace(/^\n/, ''), start: head.length, end: head.length }
}

/** Run a toolbar/shortcut action. Returns { text, start, end } or null for an unknown id. */
export function formatAction(id, { text, start, end }) {
  if (INLINE_MARKS[id]) return toggleInline(text, start, end, INLINE_MARKS[id])
  if (LINE_KINDS[id]) return toggleLines(text, start, end, id)
  if (id === 'codeblock') return toggleCodeBlock(text, start, end)
  if (id === 'link') return insertLink(text, start, end)
  if (id === 'notelink') return insertNoteLink(text, start, end)
  if (id === 'hr') return insertRule(text, start, end)
  return null
}

const ITEM = /^(\s*)([-*+]|(\d+)([.)]))\s+(\[[ xX]\]\s+)?/

/** Enter inside a list item. Returns { text, caret } or null to let the browser handle it. */
export function continueList(text, caret) {
  const ls = lineStart(text, caret)
  const le = lineEnd(text, caret)
  const line = text.slice(ls, le)
  const m = ITEM.exec(line)
  if (!m || caret < ls + m[0].length) return null
  if (line.slice(m[0].length).trim() === '') {
    return { text: text.slice(0, ls) + text.slice(le), caret: ls }
  }
  const marker = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2]
  const next = `${m[1]}${marker} ${m[5] ? '[ ] ' : ''}`
  return { text: `${text.slice(0, caret)}\n${next}${text.slice(caret)}`, caret: caret + 1 + next.length }
}

/** Tab / Shift+Tab on list items. Returns { text, start, end } or null when not applicable. */
export function indentLines(text, s, e, outdent) {
  const { from, to } = blockRange(text, s, e)
  const lines = text.slice(from, to).split('\n')
  if (!ITEM.test(lines[0])) return null
  let changed = false
  let firstDelta = 0
  const out = lines.map((l, i) => {
    const m = ITEM.exec(l)
    if (!m) return l
    const unit = m[3] ? `${m[3]}${m[4]} `.length : 2
    let next = l
    if (!outdent) next = ' '.repeat(unit) + l
    else if (l.startsWith('\t')) next = l.slice(1)
    else { const lead = /^ */.exec(l)[0].length; next = l.slice(Math.min(lead, unit)) }
    if (next !== l) changed = true
    if (i === 0) firstDelta = next.length - l.length
    return next
  })
  if (!changed) return null
  const block = out.join('\n')
  const next = text.slice(0, from) + block + text.slice(to)
  if (s === e) { const c = Math.max(from, s + firstDelta); return { text: next, start: c, end: c } }
  return { text: next, start: from, end: from + block.length }
}

const TASK = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](?=\s)/

/** Flip the nth (document order) task checkbox, ignoring fenced code. Null if there is no such task. */
export function toggleTask(text, index) {
  const lines = text.split('\n')
  let n = 0
  let fence = false
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*```/.test(lines[i])) { fence = !fence; continue }
    if (fence) continue
    const m = TASK.exec(lines[i])
    if (!m) continue
    if (n === index) {
      lines[i] = `${m[1]}[${m[2] === ' ' ? 'x' : ' '}]${lines[i].slice(m[0].length)}`
      return lines.join('\n')
    }
    n += 1
  }
  return null
}

/** Minimal replaced span between two strings: { from, toOld, insert }. */
export function diffRange(a, b) {
  let p = 0
  const max = Math.min(a.length, b.length)
  while (p < max && a[p] === b[p]) p += 1
  let q = 0
  while (q < max - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q += 1
  return { from: p, toOld: a.length - q, insert: b.slice(p, b.length - q) }
}
