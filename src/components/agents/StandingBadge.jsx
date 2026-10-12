import { useState, useRef, useEffect } from 'react';

// Fable design pass, 2026-08-10 — Standing concept (Evidence as Engine,
// first concrete application) from QuoxPlan stream DEVSUITE-DEVMODE's
// 2026-08-10 notes: agent_standing table, makeDecision() integration,
// Mission Control badge styled like the shipped AOCL/VOLT timelines.
const DROP_KINDS = new Set(['correction', 'override', 'rollback']);

function ringVariant(score) {
  if (score >= 80) return 'qx-percent--success';
  if (score >= 50) return 'qx-percent--warn';
  return 'qx-percent--crit';
}

// standing: { score, status: 'autonomous' | 'supervised',
//             history: number[],   // recent scores, oldest first, for the sparkline
//             events: [{ ts, kind, summary, delta }] }  // newest first
export default function StandingBadge({ standing }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const { score, status, history = [], events = [] } = standing;
  const auto = status === 'autonomous';

  // Sparkline points for .qx-spark (100x28 viewBox, y inverted)
  const pts = history
    .map((v, i) => `${(i / Math.max(1, history.length - 1)) * 100},${28 - (v / 100) * 26 - 1}`)
    .join(' ');

  return (
    <div className="qx-standing-wrap" ref={ref}>
      <button
        type="button"
        className="qx-standing"
        aria-expanded={open}
        aria-label={`Standing ${score} of 100, ${status}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`qx-percent qx-percent--sm ${ringVariant(score)}`} style={{ '--qx-pct': score }}>
          <span className="qx-percent__value">{score}</span>
        </span>
        <span className={`qx-pill qx-pill--sm ${auto ? 'qx-pill--online' : 'qx-pill--warn'}`}>
          {auto ? 'Autonomous' : 'Supervised'}
        </span>
      </button>

      {open && (
        <div className="qx-menu qx-standing-detail" role="dialog" aria-label="Standing history">
          <div className="qx-menu__header">Standing &middot; {score}/100</div>
          <div className="qx-standing-detail__spark">
            <span className={`qx-spark ${score >= 80 ? 'qx-spark--success' : score >= 50 ? 'qx-spark--warn' : 'qx-spark--crit'} qx-spark--lg`}>
              <svg viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
                <polyline className="qx-spark__line" points={pts} fill="none" />
              </svg>
            </span>
          </div>
          <div className="qx-evtl">
            {events.map((ev, i) => {
              const drop = DROP_KINDS.has(ev.kind) || ev.delta < 0;
              return (
                <div key={i} className={`qx-evtl__row${drop ? ' qx-evtl__row--drop' : ''}`}>
                  <span
                    className="qx-evtl__marker"
                    style={{ '--qx-evtl-tone': drop ? '#f87171' : ev.delta > 0 ? '#30ff90' : '#38bdf8' }}
                  />
                  <span className="qx-evtl__time">{ev.ts}</span>
                  <span className="qx-evtl__summary">{ev.summary}</span>
                  <span className={`qx-evtl__delta qx-trend qx-trend--${ev.delta < 0 ? 'down' : ev.delta > 0 ? 'up' : 'flat'}`}>
                    {ev.delta > 0 ? '+' : ''}{ev.delta}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
