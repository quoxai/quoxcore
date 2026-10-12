/**
 * NotesQ-local wrapper around the shared MarkdownContent that makes task-list
 * checkboxes clickable. The shared component renders GFM task lists as
 * disabled inputs and takes no callback, so we enable them after render and
 * map a click to the nth task in the markdown (document order, code fences
 * skipped, see lib/mdFormat toggleTask).
 */
import { useLayoutEffect, useRef } from 'react'
import { isAttachmentHref } from './lib/attachments'
import MarkdownContent from '../ui/MarkdownContent'

export default function NotesQMarkdown({ markdown, onToggleTask }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const boxes = ref.current?.querySelectorAll('input[type="checkbox"]') || []
    boxes.forEach((b) => { b.disabled = false; b.style.cursor = 'pointer' })
    // Attachment links (written by NotesQ) become file chips; images are styled by .nq-md img.
    ref.current?.querySelectorAll('a[href^="/api/orgs/"]').forEach((a) => {
      if (isAttachmentHref(a.getAttribute('href'))) { a.classList.add('qx-chip', 'nq-file'); a.setAttribute('download', '') }
    })
  })
  const onChange = (e) => {
    const t = e.target
    if (!(t instanceof HTMLInputElement) || t.type !== 'checkbox') return
    const all = Array.from(ref.current.querySelectorAll('input[type="checkbox"]'))
    onToggleTask?.(all.indexOf(t))
  }
  return <div ref={ref} className="nq-md" onChange={onChange}><MarkdownContent>{markdown}</MarkdownContent></div>
}
