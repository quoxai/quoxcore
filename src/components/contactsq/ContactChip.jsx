/**
 * ContactChip: a small glass chip that names a known contact and deep-links to
 * /contacts?contact=<id>. Shared by InboxQ (sender) and CalendarQ (attendees).
 * Takes a ContactsQ card subset ({id, display_name, relationship_primary}) or a
 * calendar attendee_contacts entry ({email_ref:'contact:<id>', display_name}).
 * Renders nothing when there is no resolvable id: callers stay unchanged for
 * unknown people. Global qx-* classes only.
 */
export function contactIdOf(c) {
  if (!c) return null
  if (c.id) return String(c.id)
  const m = typeof c.email_ref === 'string' ? /^contact:(.+)$/.exec(c.email_ref) : null
  return m ? m[1] : null
}

export default function ContactChip({ contact, testId = 'contact-chip' }) {
  const id = contactIdOf(contact)
  if (!id) return null
  const name = contact.display_name || 'Contact'
  const rel = contact.relationship_primary || null
  return (
    <a
      className="qx-chip qx-chip--xs"
      href={`/contacts?contact=${encodeURIComponent(id)}`}
      title={`Open ${name} in Contacts`}
      data-testid={testId}
    >
      {name}{rel ? ` · ${rel}` : ''}
    </a>
  )
}
