import { useState, useRef, useEffect } from 'react';

// Fixed order + fixed hue per dimension, identical across every objective card,
// so a column of objectives reads like small multiples: same dimension, same
// x-position, every row. Fable design pass, 2026-08-10 — see
// docs/RECURSIVE_OBJECTIVE_FABRIC_RESEARCH.md for the state-vector origin
// and QuoxPlan stream QG's notes for the build context.
const DIMS = [
  { key: 'gap',        label: 'Gap',        hue: '#38bdf8' },
  { key: 'confidence', label: 'Confidence', hue: '#c084fc' },
  { key: 'stability',  label: 'Stability',  hue: '#30ff90' },
  { key: 'risk',       label: 'Risk',       hue: '#f59e0b' },
];

// Derived headline flag: the preattentive "spot the odd one out" channel —
// cross-dimension rules a single-dimension encoding can't surface on its own.
export function deriveFlag(v) {
  if (v.gap < 0.15 && v.confidence < 0.5) return { label: 'Apparently done, low confidence', tone: 'warn' };
  if (v.velocity > 0.3 && v.risk > 0.6) return { label: 'Closing fast, risk rising', tone: 'warn' };
  if (v.risk > 0.75 || v.stability < 0.25) return { label: 'At risk', tone: 'crit' };
  if (v.velocity < -0.2) return { label: 'Regressing', tone: 'crit' };
  if (v.costUsedPct > 90) return { label: 'Budget near cap', tone: 'warn' };
  if (v.gap < 0.1 && v.confidence > 0.8) return { label: 'Done, high confidence', tone: 'ok' };
  return { label: 'On track', tone: 'ok' };
}

const TONE_DOT = { ok: 'online', warn: 'degraded', crit: 'offline' };

// vector: { gap, confidence, stability, risk } each 0-1,
//         velocity -1..1 (bipolar, diverging bar), costUsedPct 0-100
export default function ObjectiveStateVector({ vector }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const flag = deriveFlag(vector);
  const velUp = vector.velocity >= 0;

  return (
    <div className="qx-osv-wrap" ref={ref}>
      <button
        type="button"
        className="qx-osv"
        aria-expanded={open}
        aria-label={`Objective state: ${flag.label}`}
        title={flag.label}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`qx-dot qx-dot--sm qx-dot--${TONE_DOT[flag.tone]}`} />
        <span className="qx-osv__bars" aria-hidden="true">
          {DIMS.map((d) => (
            <span
              key={d.key}
              className="qx-osv__bar"
              style={{ height: `${Math.max(8, vector[d.key] * 100)}%`, background: d.hue }}
            />
          ))}
          <span className="qx-osv__vel">
            <span
              className={`qx-osv__vel-fill${velUp ? '' : ' qx-osv__vel-fill--down'}`}
              style={{ height: `${Math.abs(vector.velocity) * 50}%` }}
            />
          </span>
          <span
            className="qx-osv__bar qx-osv__bar--cost"
            style={{ height: `${Math.max(8, vector.costUsedPct)}%` }}
          />
        </span>
        <span className="qx-osv__headline">
          {Math.round((1 - vector.gap) * 100)}<i>%</i>
        </span>
      </button>

      {open && (
        <div className="qx-menu qx-osv-detail" role="dialog" aria-label="Objective state detail">
          <div className="qx-menu__header">Objective state</div>
          {DIMS.map((d) => (
            <div key={d.key} className="qx-osv-detail__row">
              <span className="qx-osv-detail__label">{d.label}</span>
              <span className="qx-osv-detail__track">
                <span
                  className="qx-osv-detail__fill"
                  style={{ width: `${vector[d.key] * 100}%`, background: d.hue }}
                />
              </span>
              <span className="qx-osv-detail__num">{vector[d.key].toFixed(2)}</span>
            </div>
          ))}
          <div className="qx-osv-detail__row">
            <span className="qx-osv-detail__label">Velocity</span>
            <span className={`qx-trend qx-trend--${vector.velocity > 0.05 ? 'up' : vector.velocity < -0.05 ? 'down' : 'flat'}`}>
              {vector.velocity > 0 ? '+' : ''}{vector.velocity.toFixed(2)}
            </span>
            <span className="qx-osv-detail__num" />
          </div>
          <div className="qx-osv-detail__row">
            <span className="qx-osv-detail__label">Budget</span>
            <span className="qx-osv-detail__track">
              <span
                className="qx-osv-detail__fill"
                style={{
                  width: `${vector.costUsedPct}%`,
                  background: vector.costUsedPct > 90 ? '#f87171' : 'rgba(255,255,255,0.7)',
                }}
              />
            </span>
            <span className="qx-osv-detail__num">{Math.round(vector.costUsedPct)}%</span>
          </div>
          <div className="qx-osv-detail__row">
            <span className="qx-osv-detail__label">Read</span>
            <span className={`qx-pill qx-pill--xs qx-pill--${flag.tone === 'ok' ? 'success' : flag.tone === 'warn' ? 'warn' : 'critical'}`}>
              {flag.label}
            </span>
            <span className="qx-osv-detail__num" />
          </div>
        </div>
      )}
    </div>
  );
}
