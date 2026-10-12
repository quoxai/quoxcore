/**
 * ContactsQChatSidebar: thin AgentChatSidebar wrapper for the ContactsQ agent.
 *
 * - Tells the agent which contact is open (id and display name only; never raw
 *   identifiers, the agent only ever sees masked cards through its own tools).
 * - A /contacts?contact=<id> link in a reply opens that contact in place.
 * - After every assistant turn the view is refreshed (onAgentActed), the same
 *   read-the-authoritative-store pattern as NotesQChatSidebar.
 */
import { useCallback } from 'react'
import { AgentChatSidebar } from '../chat/AgentChatSidebar'
import { XIcon } from './icons'

export const CONTACT_SUGGESTIONS = [
  'What is the best way to reach this person?',
  'Show our recent history with them',
  'Add a do-not-call for this contact',
  'Propose a fact about this contact',
]
export const NO_CONTACT_SUGGESTIONS = [
  'Find a contact by name',
  'Who is calling from this number?',
  'Who have we not spoken to lately?',
  'Which contacts asked not to be called?',
]

/** Contact id from an in-app contacts link, or null when the href is anything else. */
export function contactIdFromHref(href) {
  if (!href) return null
  try {
    const u = new URL(href, typeof window !== 'undefined' ? window.location.origin : 'http://localhost')
    if (u.pathname.replace(/\/+$/, '') !== '/contacts') return null
    const id = (u.searchParams.get('contact') || '').trim()
    return id && id.length <= 200 ? id : null
  } catch { return null }
}

export default function ContactsQChatSidebar({ orgId, openContact, onOpenContact, onAgentActed, onClose }) {
  const contextBuilder = useCallback(async () => {
    const name = openContact?.display_name || openContact?.name || 'Unnamed'
    return {
      surface: 'contactsq',
      page: '/contacts',
      panel: 'ContactsQ',
      focus: openContact
        ? { type: 'Contact', label: name, id: openContact.id }
        : { type: 'ContactsQ view', label: 'People list' },
      summary: [
        { label: 'Open contact', value: openContact ? `${name} (${openContact.id})` : 'none' },
      ],
      evidenceTitle: 'ContactsQ state',
      evidence: openContact ? [{ label: `Open contact: ${name}`, text: `id ${openContact.id}` }] : [],
      instructions: [
        'You are talking to the authenticated owner of these contacts. You only ever see masked cards: never ask for or repeat raw numbers or addresses.',
        openContact
          ? `The user has contact ${openContact.id} open. "This person" means that contact: use it as the contact id for your tools.`
          : 'No contact is open. Ask who they mean, or search by name.',
        'When you mention a person, link them as /contacts?contact=<id> so the user can open them in place.',
      ],
    }
  }, [openContact])

  const onClickCapture = useCallback((e) => {
    const a = e.target?.closest?.('a[href]')
    const id = a ? contactIdFromHref(a.getAttribute('href')) : null
    if (!id) return
    e.preventDefault()
    e.stopPropagation()
    onOpenContact?.(id)
  }, [onOpenContact])

  const handleAssistantMessage = useCallback(() => { onAgentActed?.() }, [onAgentActed])

  return (
    <div className="cq-agent" data-testid="cq-agent" onClickCapture={onClickCapture}>
      <AgentChatSidebar
        panel={false}
        agentId="contactsq"
        agentName="CONTACTSQ"
        agentColor="#38bdf8"
        agentRole="Contacts assistant"
        contextBuilder={contextBuilder}
        suggestions={openContact?.id ? CONTACT_SUGGESTIONS : NO_CONTACT_SUGGESTIONS}
        sessionPrefix={`CONTACTSQ_${orgId || 'NONE'}`}
        placeholder="Ask CONTACTSQ to find people or pick a channel..."
        emptyText="Ask CONTACTSQ about your contacts..."
        onAssistantMessage={handleAssistantMessage}
        headerExtra={onClose ? (
          // In the header row, beside New chat: never a separate strip the panel corner can clip.
          <button type="button" className="qx-btn qx-btn--sm cq-agent__close" onClick={onClose} aria-label="Close agent" title="Close agent"><XIcon /></button>
        ) : null}
      />
    </div>
  )
}
