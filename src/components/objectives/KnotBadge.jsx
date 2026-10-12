import { useState, useRef, useEffect } from 'react';

// Capabilities mapped onto the read/write/exec severity ladder the dashboard
// already teaches via .qx-cap: observation reads, evidence demands write
// to the record, interrupt/freeze execute against the objective. Fable
// design pass, 2026-08-10 — Knot concept from
// docs/RECURSIVE_OBJECTIVE_FABRIC_RESEARCH.md §G, capability-bounding
// resolution from QuoxPlan stream QG's 2026-08-10 notes (per-Knot-type
// bounding, not one blanket capability set).
const CAP_META = {
  observe: { cls: 'qx-cap--read', label: 'observe' },
  question: { cls: 'qx-cap--read', label: 'question' },
  challenge: { cls: 'qx-cap--write', label: 'challenge' },
  request_evidence: { cls: 'qx-cap--write', label: 'evidence' },
  escalate: { cls: 'qx-cap--write', label: 'escalate' },
  interrupt: { cls: 'qx-cap--exec', label: 'interrupt' },
  freeze: { cls: 'qx-cap--exec', label: 'freeze' },
};

const EVT_TONE = {
  observe: '#38bdf8',
  question: '#38bdf8',
  challenge: '#f59e0b',
  request_evidence: '#f59e0b',
  escalate: '#c084fc',
  interrupt: '#f87171',
  freeze: '#f87171',
};

function tierOf(caps) {
  if (caps.includes('freeze') || caps.includes('interrupt')) return 'authoritative';
  if (caps.some((c) => ['challenge', 'request_evidence', 'escalate'].includes(c))) return 'evidential';
  return 'passive';
}

// knot: { name, capabilities: string[], intervening: boolean,
//         interventions: [{ ts, action, summary }] }  (newest first)
export default function KnotBadge({ knot }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const tier = tierOf(knot.capabilities);
  const mod = knot.intervening
    ? 'qx-knot--intervening'
    : tier === 'authoritative'
      ? 'qx-knot--authoritative'
      : tier === 'evidential'
        ? 'qx-knot--evidential'
        : '';

  return (
    <div className="qx-knot-wrap" ref={ref}>
      <button
        type="button"
        className={`qx-knot ${mod}`}
        aria-expanded={open}
        aria-label={`Knot ${knot.name}, ${tier}${knot.intervening ? ', intervening now' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <svg className="qx-knot__glyph" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path
            d="M6 1.2c2.6 0 4.8 2.2 4.8 4.8S8.6 10.8 6 10.8 1.2 8.6 1.2 6 3.4 1.2 6 1.2Zm0 2.1c-1.5 0-2.7 1.2-2.7 2.7S4.5 8.7 6 8.7 8.7 7.5 8.7 6 7.5 3.3 6 3.3Z"
            fill="currentColor"
            opacity="0.5"
          />
          <path d="M2.3 2.3 9.7 9.7M9.7 2.3 2.3 9.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        {knot.name}
        {knot.intervening && <span className="qx-dot qx-dot--sm qx-dot--offline" />}
      </button>

      {open && (
        <div className="qx-menu qx-knot-detail" role="dialog" aria-label={`Knot ${knot.name} detail`}>
          <div className="qx-menu__header">Knot &middot; {tier}</div>
          <div className="qx-knot-detail__caps">
            {knot.capabilities.map((c) => (
              <span key={c} className={`qx-cap ${CAP_META[c]?.cls || ''}`}>
                <span className="qx-cap__dot" />
                {CAP_META[c]?.label || c}
              </span>
            ))}
          </div>
          <div className="qx-evtl">
            {knot.interventions.length === 0 && (
              <div className="qx-evtl__row">
                <span className="qx-evtl__marker" style={{ '--qx-evtl-tone': 'rgba(255,255,255,0.35)' }} />
                <span className="qx-evtl__time">&mdash;</span>
                <span className="qx-evtl__summary">No interventions yet</span>
              </div>
            )}
            {knot.interventions.map((ev, i) => (
              <div
                key={i}
                className={`qx-evtl__row${ev.action === 'freeze' || ev.action === 'interrupt' ? ' qx-evtl__row--drop' : ''}`}
              >
                <span className="qx-evtl__marker" style={{ '--qx-evtl-tone': EVT_TONE[ev.action] || '#38bdf8' }} />
                <span className="qx-evtl__time">{ev.ts}</span>
                <span className="qx-evtl__summary">{ev.summary}</span>
                <span className={`qx-cap ${CAP_META[ev.action]?.cls || ''}`}>{CAP_META[ev.action]?.label || ev.action}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
