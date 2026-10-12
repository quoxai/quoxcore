/**
 * One ItemCard. L0 headline; expand for L1 (Who/What/Why/When/Affected);
 * "What can I do" for L2 measures. Nothing ever auto-runs: `run` and
 * non-safe measures show "This files an approval" and wait for a click.
 */
import { useState } from 'react'
import { runMeasure, dur, fmtWhen } from '../../services/lucid'
import { Btn, Note, UrgencyPill, sub } from './lucidUi'
import LucidLessonButtons from './LucidLessonButtons'

function Line({ k, v }) {
  if (!v) return null
  return <div style={{ fontSize: 13, lineHeight: 1.45, overflowWrap: 'anywhere' }}><span style={{ fontWeight: 600 }}>{k}:</span> {v}</div>
}

function needsConfirm(m) {
  return m.kind === 'run' || m.risk === 'dangerous'
}

function MeasureResult({ result }) {
  if (!result) return null
  return (
    <div style={{ ...sub, marginTop: 4 }}>
      {result.status === 'filed' && <div>Approval filed{result.approval_id ? ` (${result.approval_id})` : ''}. Nothing runs until you approve it.</div>}
      {result.status === 'manual' && <div>Do this yourself:</div>}
      {result.status === 'opened' && <div>Opened.</div>}
      {result.say && <div>{result.say}</div>}
      {result.command && <code style={{ display: 'block', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{result.command}</code>}
      {result.url && <a href={result.url} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere' }}>{result.url}</a>}
    </div>
  )
}

function Measure({ item, m, authFetch }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState(null)
  const [err, setErr] = useState(null)

  async function go() {
    setBusy(true)
    setErr(null)
    const r = await runMeasure(item.ref, m.id, { authFetch })
    setBusy(false)
    setConfirming(false)
    if (!r.ok) { setErr(`Could not do that: ${r.status || r.error}`); return }
    setOut(r.result)
  }

  function click() {
    if (needsConfirm(m) && !confirming) { setConfirming(true); return }
    go()
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <Btn label={confirming ? `File approval: ${m.label}` : m.label} onClick={click} disabled={busy}>
          <polyline points="9 18 15 12 9 6" />
        </Btn>
        {m.risk !== 'safe' && <span className="qx-pill qx-pill--xs">{m.risk}</span>}
        {confirming && (
          <>
            <span style={sub}>This files an approval. It does not run until approved.</span>
            <Btn label="Cancel" withText onClick={() => setConfirming(false)}>
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </Btn>
          </>
        )}
      </div>
      {m.say && !out && <div style={sub}>{m.say}</div>}
      {err && <div role="alert" style={sub}>{err}</div>}
      <MeasureResult result={out} />
    </div>
  )
}

export default function LucidItemCard({ item, authFetch, now, compact, onChanged }) {
  const [open, setOpen] = useState(false)
  const [showDo, setShowDo] = useState(false)
  const l1 = item.L1 || {}
  const when = l1.when || {}
  const t = now || Date.now()
  const whenTxt = when.since
    ? `${dur(t - when.since)} ago (${fmtWhen(when.since)})${when.deadline ? `, due ${fmtWhen(when.deadline)}` : ''}`
    : ''
  const measures = (item.L2 && item.L2.measures) || []

  return (
    <div className="qx-card qx-card--compact" style={{ padding: compact ? '8px 10px' : undefined, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ fontSize: compact ? 13 : 14, lineHeight: 1.45, fontWeight: 600, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{item.L0}</span>
        <UrgencyPill urgency={item.urgency} />
        <Btn label={open ? 'Hide details' : 'Show details'} withText={false} onClick={() => setOpen(!open)} active={open}>
          {open ? <polyline points="18 15 12 9 6 15" /> : <polyline points="6 9 12 15 18 9" />}
        </Btn>
      </div>

      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          <Line k="Who" v={l1.who} />
          <Line k="What" v={l1.what} />
          <Line k="Why" v={l1.why} />
          <Line k="When" v={whenTxt} />
          {(l1.affected || []).length > 0 && (
            <div style={sub}>
              <span style={{ fontWeight: 600 }}>Affected:</span>{' '}
              {l1.affected.map((a) => `${a.label} (${a.how}${a.inferred ? ', inferred' : ''})`).join('; ')}
            </div>
          )}
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <Btn label={showDo ? 'Hide options' : 'What can I do'} onClick={() => setShowDo(!showDo)} active={showDo}>
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
            </Btn>
          </div>
          {showDo && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              {measures.length === 0 && <Note>Nothing I can offer for this one.</Note>}
              {measures.map((m) => <Measure key={m.id} item={item} m={m} authFetch={authFetch} />)}
            </div>
          )}
          <div style={{ marginTop: 6 }}>
            <LucidLessonButtons item={item} authFetch={authFetch} onTaught={onChanged} />
          </div>
        </div>
      )}
      {!open && (l1.who || when.since) ? (
        <div style={{ ...sub, marginTop: 4 }}>
          {[l1.who, when.since ? `${dur(t - when.since)} ago` : null].filter(Boolean).join(' · ')}
        </div>
      ) : null}
    </div>
  )
}

