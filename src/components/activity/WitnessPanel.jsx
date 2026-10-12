/**
 * WitnessPanel — shows VOLT witness + WARD receipt for a conversation.
 *
 * AEE-CORE-6.1. Pulls /collector/aee/conversation/:corr/witnesses on mount,
 * renders a compact strip with copyable hashes and a "Download bundle"
 * action that hits the evidence-bundle endpoint.
 */
import { useEffect, useState } from 'react'

function short(h) {
  if (!h || typeof h !== 'string') return '—'
  return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export default function WitnessPanel({ corr }) {
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [copiedKey, setCopiedKey] = useState(null)

  useEffect(() => {
    let cancelled = false
    setState({ loading: true, error: null, data: null })
    fetch(`/collector/aee/conversation/${encodeURIComponent(corr)}/witnesses`, { signal: AbortSignal.timeout(10000) })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => { if (!cancelled) setState({ loading: false, error: null, data }) })
      .catch(err => { if (!cancelled) setState({ loading: false, error: err.message, data: null }) })
    return () => { cancelled = true }
  }, [corr])

  const handleCopy = async (key, value) => {
    if (!value) return
    const ok = await copyToClipboard(value)
    if (ok) {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(cur => cur === key ? null : cur), 1200)
    }
  }

  const handleDownloadBundle = () => {
    // Auth-gated endpoint — browser auth cookies will be sent with the click.
    window.location.href = `/collector/aee/conversation/${encodeURIComponent(corr)}/bundle`
  }

  if (state.loading) {
    return <div className="witness-panel witness-panel--loading">Loading witnesses…</div>
  }
  if (state.error) {
    return <div className="witness-panel witness-panel--error">Witness lookup failed: {state.error}</div>
  }

  const { volt, ward } = state.data || {}
  if (!volt) {
    return (
      <div className="witness-panel witness-panel--empty">
        <span className="witness-panel__label">Witnesses</span>
        <span className="witness-panel__none">No VOLT run recorded for this conversation.</span>
      </div>
    )
  }

  const headHash = volt.head_hash || state.data?.bundle?.head_hash
  const wardReceipt = ward?.receipt

  return (
    <div className="witness-panel">
      <div className="witness-panel__row">
        <span className={`witness-dot witness-dot--${volt.status === 'completed' ? 'ok' : 'pending'}`} />
        <span className="witness-panel__label">VOLT</span>
        <span className="witness-panel__value witness-panel__value--mono" title={headHash || ''}>
          {short(headHash) || '—'}
        </span>
        <button
          className="witness-panel__btn"
          type="button"
          disabled={!headHash}
          title="Copy VOLT head hash"
          onClick={() => handleCopy('volt', headHash)}
        >
          {copiedKey === 'volt' ? '✓' : 'copy'}
        </button>
        <span className="witness-panel__sep">·</span>
        <span className="witness-panel__meta">
          {volt.event_count || 0} events · run {short(volt.run_id)}
        </span>
      </div>

      <div className="witness-panel__row">
        <span className={`witness-dot witness-dot--${ward?.witnessed ? 'ok' : 'pending'}`} />
        <span className="witness-panel__label">WARD</span>
        <span className="witness-panel__value witness-panel__value--mono" title={wardReceipt || ''}>
          {ward?.witnessed ? short(wardReceipt) : 'not witnessed'}
        </span>
        {ward?.witnessed && (
          <button
            className="witness-panel__btn"
            type="button"
            title="Copy WARD receipt"
            onClick={() => handleCopy('ward', wardReceipt)}
          >
            {copiedKey === 'ward' ? '✓' : 'copy'}
          </button>
        )}
        <span className="witness-panel__sep">·</span>
        <button
          className="witness-panel__btn witness-panel__btn--primary"
          type="button"
          title="Download evidence bundle (JSON) with envelopes, policies, VOLT events, WARD receipt"
          onClick={handleDownloadBundle}
        >
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Evidence bundle
        </button>
      </div>
    </div>
  )
}
