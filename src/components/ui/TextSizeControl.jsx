/**
 * A- | 100% | A+ text size control (born in NotesQ). Remembers the size per
 * device under storageKey. Apply the returned zoom as --qx-text-zoom on a
 * .qx-slate (or any container whose font size reads that variable).
 *
 *   const [zoom, control] = useTextSize('quox.inboxq.textZoom')
 *   <header>{control}</header>
 *   <div className="qx-card qx-slate" style={{ '--qx-text-zoom': zoom }}>...</div>
 */
import { useState } from 'react'
import { ZOOM_STEPS, DEFAULT_ZOOM, loadZoom, saveZoom, stepZoom } from '../../lib/textZoom'

const svg = (d) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
)
const SmallerIcon = () => svg(<><path d="M3 19l5-13 5 13M5 15h6" /><path d="M16 12h6" /></>)
const LargerIcon = () => svg(<><path d="M3 19l5-13 5 13M5 15h6" /><path d="M16 12h6M19 9v6" /></>)

export function TextSizeControl({ zoom, onChange }) {
  const pct = Math.round(zoom * 100)
  return (
    <span className="qx-seg qx-textsize" role="group" aria-label="Text size">
      <button type="button" className="qx-seg__btn" onClick={() => onChange(-1)} disabled={zoom <= ZOOM_STEPS[0]}
        aria-label="Smaller text" title="Smaller text"><SmallerIcon /></button>
      <button type="button" className="qx-seg__btn qx-textsize__pct" onClick={() => onChange(0)} disabled={zoom === DEFAULT_ZOOM}
        aria-label={`Text size ${pct}%, reset`} title="Reset text size">{pct}%</button>
      <button type="button" className="qx-seg__btn" onClick={() => onChange(1)} disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
        aria-label="Larger text" title="Larger text"><LargerIcon /></button>
    </span>
  )
}

/** [zoom, <TextSizeControl/>]: state + persistence + the control, in one line. */
export function useTextSize(storageKey) {
  const [zoom, setZoom] = useState(() => loadZoom(storageKey))
  const change = (dir) => setZoom((z) => { const next = dir === 0 ? DEFAULT_ZOOM : stepZoom(z, dir); saveZoom(storageKey, next); return next })
  return [zoom, <TextSizeControl key="textsize" zoom={zoom} onChange={change} />]
}

export default TextSizeControl
