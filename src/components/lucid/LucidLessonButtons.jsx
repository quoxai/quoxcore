/** Teach LUCID: owner corrections that stay. */
import { useState } from 'react'
import { teach } from '../../services/lucid'
import { Btn, Note } from './lucidUi'

export default function LucidLessonButtons({ item, authFetch, onTaught }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  async function send(label, lesson) {
    setBusy(true)
    setMsg(null)
    const r = await teach({ ...lesson, reason: 'owner via panel' }, { authFetch })
    setBusy(false)
    if (!r.ok) { setMsg(`Could not save lesson: ${r.status || r.error}`); return }
    setMsg(`Learned: ${label}`)
    if (onTaught) onTaught()
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <Btn label="Not useful" disabled={busy}
          onClick={() => send('not useful', { scope: 'kind', target: item.kind, field: 'urgency', value: 'whenever' })}>
          <circle cx="12" cy="12" r="10" /><line x1="8" y1="12" x2="16" y2="12" />
        </Btn>
        <Btn label="I care about this" disabled={busy}
          onClick={() => send('you care about this', { scope: 'subject', target: item.ref, field: 'watched', value: true })}>
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
        </Btn>
        <Btn label="Mute" disabled={busy}
          onClick={() => send('muted', { scope: 'subject', target: item.ref, field: 'mute', value: true })}>
          <path d="M11 5L6 9H2v6h4l5 4V5z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
        </Btn>
      </div>
      {msg && <Note>{msg}</Note>}
    </div>
  )
}
