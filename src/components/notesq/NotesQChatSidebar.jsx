/**
 * NotesQChatSidebar: thin AgentChatSidebar wrapper for the NotesQ agent.
 *
 * - Tells the agent which note is open (id, title, collection, tags; never the
 *   body, it can read it with its own tools) and the active filters.
 * - A /notes?note=<id> link in a reply opens that note in place (no navigation).
 * - After every assistant turn the view is refreshed (list, facets, open note),
 *   same read-the-authoritative-store pattern as InboxQChatSidebar.
 */
import { useCallback } from 'react'
import { AgentChatSidebar } from '../chat/AgentChatSidebar'
import { XIcon } from './icons'

// Suggestions depend on whether a note is open: "Summarise this note" with
// nothing open was a dead end (seen in the 2026-10-07 dock screenshot).
export const NOTE_SUGGESTIONS = [
  'Summarise this note',
  'Find notes related to this one',
  'Tidy this note into sections',
  'Turn the to-dos here into a list',
]
export const NO_NOTE_SUGGESTIONS = [
  'Jot this down: ',
  'What did I write about last week?',
  'Find my notes on a topic',
  'What does the knowledge brain say about this?',
]

/** Note id from an in-app notes link, or null when the href is anything else. */
export function noteIdFromHref(href) {
  if (!href) return null
  try {
    const u = new URL(href, typeof window !== 'undefined' ? window.location.origin : 'http://localhost')
    if (u.pathname.replace(/\/+$/, '') !== '/notes') return null
    const id = (u.searchParams.get('note') || '').trim()
    return id && id.length <= 200 ? id : null
  } catch { return null }
}

export function describeFilters(f = {}) {
  const parts = [`scope ${f.scope || 'all'}`]
  if (f.q) parts.push(`search "${f.q}"`)
  if (f.collection) parts.push(`collection ${f.collection}`)
  if (f.tag) parts.push(`tag #${f.tag}`)
  if (f.pinned) parts.push('pinned only')
  if (f.archived && f.archived !== 'exclude') parts.push(`archived ${f.archived}`)
  return parts.join(', ')
}

export default function NotesQChatSidebar({ orgId, openNote, filters, onOpenNote, onAgentWrote, onClose }) {
  const contextBuilder = useCallback(async () => {
    const tags = openNote?.tags || []
    const collection = openNote?.properties?.collection || ''
    return {
      surface: 'notesq',
      page: '/notes',
      panel: 'NotesQ',
      focus: openNote
        ? { type: 'Note', label: openNote.title || 'Untitled', id: openNote.id, detail: collection || undefined }
        : { type: 'NotesQ view', label: 'Notes list' },
      summary: [
        { label: 'Open note', value: openNote ? `${openNote.title || 'Untitled'} (${openNote.id})` : 'none' },
        { label: 'Filters', value: describeFilters(filters) },
      ],
      evidenceTitle: 'NotesQ state',
      evidence: openNote ? [{
        label: `Open note: ${openNote.title || 'Untitled'}`,
        text: `id ${openNote.id} • collection ${collection || 'none'} • tags ${tags.length ? tags.join(', ') : 'none'} • scope ${openNote.scope || 'unknown'}`,
      }] : [],
      instructions: [
        'You are talking to the authenticated owner of these notes. Their direct command IS the authorization.',
        openNote
          ? `The user has note ${openNote.id} open. "This note" means that note: read it with your note tools by id when asked to summarise or edit it.`
          : 'No note is open. Ask which note they mean, or search for it.',
        'When you mention a note, link it as /notes?note=<id> so the user can open it in place.',
      ],
    }
  }, [openNote, filters])

  const onClickCapture = useCallback((e) => {
    const a = e.target?.closest?.('a[href]')
    const id = a ? noteIdFromHref(a.getAttribute('href')) : null
    if (!id) return
    e.preventDefault()
    e.stopPropagation()
    onOpenNote?.(id)
  }, [onOpenNote])

  const handleAssistantMessage = useCallback(() => { onAgentWrote?.() }, [onAgentWrote])

  return (
    <div className="nq-agent" data-testid="nq-agent" onClickCapture={onClickCapture}>
      {onClose ? (
        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm nq-agent__close" onClick={onClose}
          aria-label="Close agent" title="Close agent"><XIcon /></button>
      ) : null}
      <AgentChatSidebar
        panel={false}
        agentId="notesq"
        agentName="NOTESQ"
        agentColor="#a78bfa"
        agentRole="Notes assistant"
        contextBuilder={contextBuilder}
        suggestions={openNote?.id ? NOTE_SUGGESTIONS : NO_NOTE_SUGGESTIONS}
        sessionPrefix={`NOTESQ_${orgId || 'NONE'}`}
        placeholder="Ask NOTESQ to find, summarise or write notes..."
        emptyText="Ask NOTESQ about your notes..."
        onAssistantMessage={handleAssistantMessage}
      />
    </div>
  )
}
