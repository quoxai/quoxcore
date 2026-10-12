import { useState, useEffect, useCallback, useRef } from 'react'
import { getMemoryClient } from '../../services/memoryClient'
import './DecisionTimeline.css'

const svgProps = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
const UndoIcon = () => (<svg {...svgProps}><path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-15-6.7L3 13" /></svg>)
const CheckIcon = () => (<svg {...svgProps}><polyline points="20 6 9 17 4 12" /></svg>)
const CloseIcon = () => (<svg {...svgProps}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>)
const ChevronIcon = ({ open }) => (<svg {...svgProps} style={{ transform: open ? 'rotate(180deg)' : 'none' }}><polyline points="6 9 12 15 18 9" /></svg>)
const RefreshIcon = () => (<svg {...svgProps}><polyline points="23 4 23 10 17 10" /><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10" /></svg>)

export function reinstateErrorMessage(err) {
  if (err?.status === 403) return 'You cannot change this one. It belongs to someone else, or it is an organisation belief that needs an admin.'
  if (err?.status === 409) return 'This version is already current, so there is nothing to reinstate. Refresh to see the latest.'
  return `Could not reinstate this version${err?.message ? ` (${err.message})` : ''}. Try again.`
}

function fmtDate(v) {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function previousOf(history) {
  return Array.isArray(history) && history.length > 1 ? history[history.length - 2] : null
}

export default function DecisionTimeline({ client }) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [decisions, setDecisions] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState({})
  const [confirmId, setConfirmId] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [actionError, setActionError] = useState('')
  const seq = useRef(0)

  const getClient = useCallback(() => client || getMemoryClient(), [client])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300)
    return () => clearTimeout(t)
  }, [query])

  const load = useCallback(async () => {
    const my = ++seq.current
    setLoading(true)
    setError('')
    try {
      const data = await getClient().getDecisionTimeline({ q: debounced, limit: 20 })
      if (my !== seq.current) return
      setDecisions(Array.isArray(data?.decisions) ? data.decisions : [])
    } catch (e) {
      if (my !== seq.current) return
      setError(`Could not load decisions${e?.status ? ` (HTTP ${e.status})` : ''}. Try again.`)
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [debounced, getClient])

  useEffect(() => { load() }, [load])

  const reinstate = async (id) => {
    setBusyId(id)
    setActionError('')
    try {
      await getClient().reinstateMemory(id)
      setConfirmId(null)
      await load()
    } catch (e) {
      setActionError(reinstateErrorMessage(e))
    } finally {
      setBusyId(null)
    }
  }

  const sorted = (decisions || []).slice().sort((a, b) => new Date(b.last_change || 0) - new Date(a.last_change || 0))

  return (
    <div className="decision-timeline">
      <div className="decision-timeline__bar">
        <input
          className="decision-timeline__search"
          type="search"
          placeholder="Search decisions"
          aria-label="Search decisions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="glass-btn decision-timeline__btn" type="button" onClick={load} disabled={loading} aria-label="Refresh decisions">
          <RefreshIcon />
        </button>
      </div>

      {error && <div className="decision-timeline__error" role="alert">{error}</div>}
      {actionError && <div className="decision-timeline__error" role="alert">{actionError}</div>}
      {loading && !decisions && !error && <div className="decision-timeline__muted" role="status">Loading decisions...</div>}

      {!error && decisions && sorted.length === 0 && !loading && (
        <div className="decision-timeline__empty">
          No decisions have changed yet. When Qortex learns that something was replaced, it shows up here with the reason.
        </div>
      )}

      <ul className="decision-timeline__list">
        {sorted.map((d) => {
          const id = d.current?.id
          const isOpen = !!expanded[id]
          const prev = previousOf(d.history)
          const reason = prev?.superseded_reason || ''
          return (
            <li key={id} className="decision-timeline__item">
              <button
                className="glass-btn decision-timeline__head"
                type="button"
                aria-expanded={isOpen}
                onClick={() => setExpanded((m) => ({ ...m, [id]: !m[id] }))}
              >
                <span className="decision-timeline__current">{d.current?.content}</span>
                <ChevronIcon open={isOpen} />
              </button>
              {prev && <div className="decision-timeline__was">was: {prev.content}</div>}
              {reason && <div className="decision-timeline__reason">Replaced because: {reason}</div>}
              <div className="decision-timeline__meta">
                {d.changes} {d.changes === 1 ? 'change' : 'changes'}
                {d.last_change ? `, last changed ${fmtDate(d.last_change)}` : ''}
              </div>

              {isOpen && (
                <ol className="decision-timeline__chain">
                  {(d.history || []).map((h, i) => {
                    const isCurrent = i === d.history.length - 1
                    return (
                      <li key={h.id} className={`decision-timeline__step${isCurrent ? ' decision-timeline__step--current' : ''}`}>
                        <div className="decision-timeline__step-text">{h.content}</div>
                        <div className="decision-timeline__meta">
                          {isCurrent ? 'Current' : 'Replaced'}{h.created_at ? `, ${fmtDate(h.created_at)}` : ''}
                          {!isCurrent && h.superseded_reason ? `. Reason: ${h.superseded_reason}` : ''}
                        </div>
                        {!isCurrent && confirmId !== h.id && (
                          <button className="glass-btn decision-timeline__btn" type="button" onClick={() => { setActionError(''); setConfirmId(h.id) }}>
                            <UndoIcon /> Reinstate
                          </button>
                        )}
                        {!isCurrent && confirmId === h.id && (
                          <div className="decision-timeline__confirm" role="group" aria-label="Confirm reinstate">
                            <span>Make this current again? The newer version will be marked disputed.</span>
                            <button className="glass-btn decision-timeline__btn" type="button" disabled={busyId === h.id} onClick={() => reinstate(h.id)}>
                              <CheckIcon /> {busyId === h.id ? 'Working...' : 'Yes, reinstate'}
                            </button>
                            <button className="glass-btn decision-timeline__btn" type="button" disabled={busyId === h.id} onClick={() => setConfirmId(null)}>
                              <CloseIcon /> Cancel
                            </button>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ol>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
