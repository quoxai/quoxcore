import { useEffect, useMemo, useRef, useState } from 'react';

// LoopReplay — scrubbable time-travel replay over one loop's AEE envelope
// history. Fable design pass, 2026-08-10, fourth of the Objective Fabric
// set (ObjectiveStateVector / KnotBadge / StandingBadge). Origin:
// docs/RECURSIVE_OBJECTIVE_FABRIC_RESEARCH.md §M — the evidence store is
// already hash-chained and envelopes already carry ts/corr/reply_to, so
// "what did the loop believe, and why, at time T" is a reduction over
// data that exists as a byproduct of tamper-evidence.
//
// Layout call: this is a PANEL (.qx-card root), not a .qx-menu flyout like
// its three siblings. The siblings are glanceable atoms whose flyout holds
// one list; replay needs three simultaneous zones (temporal track,
// reconstructed belief, causal chain) and a flyout's ~340px cannot hold a
// track whose whole value is temporal resolution. Pass `flat` when
// embedding inside a parent that already provides glass (no glass-on-glass).
//
// envelopes: AEE-shaped, ordered by ts, one corr:
//   [{ id, ts, type, from, to, intent, corr, reply_to, payload }]

// ── Intent classification ─────────────────────────────────────────────
// One rule table drives tick tone, chain chips, and the belief reducer.
// Extend here when a new intent family joins the loop vocabulary.
const KIND_META = {
  snapshot:     { tone: '#38bdf8', chip: 'snapshot',  cls: 'qx-cap--read' },
  promote:      { tone: '#30ff90', chip: 'promote',   cls: 'qx-cap--write' },
  demote:       { tone: '#f59e0b', chip: 'demote',    cls: 'qx-cap--write' },
  usage:        { tone: null, chip: 'usage', cls: 'qx-cap--read' }, // null = theme-neutral via --qx-replay-neutral
  freeze:       { tone: '#f87171', chip: 'freeze',    cls: 'qx-cap--exec' },
  release:      { tone: '#c084fc', chip: 'release',   cls: 'qx-cap--exec' },
  intervention: { tone: '#c084fc', chip: 'knot',      cls: 'qx-cap--write' },
  error:        { tone: '#f87171', chip: 'error',     cls: 'qx-cap--exec' },
  other:        { tone: null, chip: 'event', cls: 'qx-cap--read' },
};

export function kindOf(env) {
  const intent = env.intent || '';
  if (env.type === 'error') return 'error';
  if (intent.includes('snapshot') || env.payload?.vector) return 'snapshot';
  if (intent.includes('promote')) return 'promote';
  if (intent.includes('demote')) return 'demote';
  if (intent.includes('freeze')) return 'freeze';
  if (intent.includes('release') || intent.includes('unfreeze')) return 'release';
  if (intent.includes('usage')) return 'usage';
  if (intent.startsWith('knot.') || intent.includes('.knot')) return 'intervention';
  return 'other';
}

// ── Belief reducer ────────────────────────────────────────────────────
// Fold envelopes[0..idx] into "what the loop believed at T". Latest
// snapshot wins for the vector; freeze/release toggle the frozen flag;
// promotions/demotions move the phase. Pure + exported so it can be
// unit-tested without rendering.
export function reconstructAt(envelopes, idx) {
  const s = {
    vector: null, vectorTs: null, phase: null, frozenBy: null,
    counts: { promote: 0, demote: 0, usage: 0, intervention: 0, error: 0 },
  };
  for (let i = 0; i <= idx && i < envelopes.length; i++) {
    const env = envelopes[i];
    const kind = kindOf(env);
    if (kind === 'snapshot' && env.payload?.vector) { s.vector = env.payload.vector; s.vectorTs = env.ts; }
    if (kind === 'promote') { s.counts.promote++; s.phase = env.payload?.to_state || s.phase; }
    if (kind === 'demote') { s.counts.demote++; s.phase = env.payload?.to_state || s.phase; }
    if (kind === 'usage') s.counts.usage++;
    if (kind === 'freeze') { s.counts.intervention++; s.frozenBy = env.from; }
    if (kind === 'release') { s.counts.intervention++; s.frozenBy = null; }
    if (kind === 'intervention') s.counts.intervention++;
    if (kind === 'error') s.counts.error++;
  }
  return s;
}

// ── Causal chain ──────────────────────────────────────────────────────
// Walk reply_to from the selected envelope back to its root. This is the
// differentiator: ancestry, not adjacency. Returns root-first, plus
// whether the walk fell off the edge of the provided window (reply_to
// pointing at an id we don't have — honest gap, not silently truncated).
export function causalChain(envelopes, id) {
  const byId = new Map(envelopes.map((e) => [e.id, e]));
  const chain = [];
  const seen = new Set();
  let cur = byId.get(id);
  let truncated = false;
  while (cur && !seen.has(cur.id)) {
    chain.unshift(cur);
    seen.add(cur.id);
    if (cur.reply_to && !byId.has(cur.reply_to)) truncated = true;
    cur = cur.reply_to ? byId.get(cur.reply_to) : null;
  }
  return { chain, truncated };
}

const DIMS = [
  { key: 'gap',        label: 'Gap',        hue: '#38bdf8' },
  { key: 'confidence', label: 'Confidence', hue: '#c084fc' },
  { key: 'stability',  label: 'Stability',  hue: '#30ff90' },
  { key: 'risk',       label: 'Risk',       hue: '#f59e0b' },
];

const fmtTime = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString().slice(11, 19);
};

const PLAY_MS = 900; // fixed per-event cadence — see playback note below

export default function LoopReplay({ envelopes = [], title = 'Loop replay', flat = false }) {
  const [rawIdx, setIdx] = useState(Math.max(0, envelopes.length - 1));
  const [playing, setPlaying] = useState(false);
  const timerRef = useRef(null);

  const n = envelopes.length;
  const idx = Math.min(rawIdx, Math.max(0, n - 1)); // clamp if the prop shrank
  const selected = envelopes[idx] || null;

  // Time-proportional tick positions. The range input steps by EVENT INDEX
  // (that is the useful scrub unit); the tick strip is honest about TIME,
  // so bursts of activity visibly cluster and dead hours visibly stretch.
  const t0 = n ? new Date(envelopes[0].ts).getTime() : 0;
  const tN = n ? new Date(envelopes[n - 1].ts).getTime() : 1;
  const span = Math.max(1, tN - t0);
  const fracOf = (env) => ((new Date(env.ts).getTime() - t0) / span) * 100;

  const { chain, truncated } = useMemo(
    () => (selected ? causalChain(envelopes, selected.id) : { chain: [], truncated: false }),
    [envelopes, selected],
  );
  const chainIds = useMemo(() => new Set(chain.map((e) => e.id)), [chain]);
  const belief = useMemo(() => reconstructAt(envelopes, idx), [envelopes, idx]);

  // Playback: step-play at a fixed per-event cadence. Wall-clock-
  // proportional replay is deliberately NOT offered — AEE gaps are hours,
  // and event-order is what an operator is actually watching for.
  useEffect(() => {
    if (!playing) return undefined;
    timerRef.current = setInterval(() => {
      setIdx((i) => {
        if (i >= n - 1) { setPlaying(false); return i; }
        return i + 1;
      });
    }, PLAY_MS);
    return () => clearInterval(timerRef.current);
  }, [playing, n]);

  if (!n) {
    return (
      <section className={`${flat ? '' : 'qx-card '}qx-replay`}>
        <div className="qx-empty">No envelope history for this loop yet.</div>
      </section>
    );
  }

  return (
    <section className={`${flat ? '' : 'qx-card '}qx-replay`} aria-label={title}>
      {/* Header: title, cursor time, transport */}
      <div className="qx-replay__head">
        <span className="qx-section-title">{title}</span>
        <span className="qx-replay__at">
          T = <strong>{fmtTime(selected.ts)}</strong>
          <span className="qx-replay__at-count">{idx + 1} / {n}</span>
        </span>
        <div className="qx-replay__controls" role="group" aria-label="Replay transport">
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" aria-label="Previous event"
            disabled={idx === 0} onClick={() => { setPlaying(false); setIdx((i) => Math.max(0, i - 1)); }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M9.5 2.5 4.5 7l5 4.5M4 2.5v9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" aria-label={playing ? 'Pause replay' : 'Play replay'}
            onClick={() => { if (idx >= n - 1 && !playing) setIdx(0); setPlaying((p) => !p); }}>
            {playing ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M4.5 2.5v9M9.5 2.5v9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M4 2.5v9l7-4.5-7-4.5Z" fill="currentColor" />
              </svg>
            )}
          </button>
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" aria-label="Next event"
            disabled={idx === n - 1} onClick={() => { setPlaying(false); setIdx((i) => Math.min(n - 1, i + 1)); }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="m4.5 2.5 5 4.5-5 4.5M10 2.5v9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Temporal track: time-proportional ticks. Causal ancestors of the
          selected envelope grow a stem + glow; everything else stays a dot.
          Adjacency is visible (position), ancestry is visible (stem) —
          two different visual channels for two different claims. */}
      <div className="qx-replay__track" aria-hidden="true">
        <div className="qx-replay__future" style={{ left: `${fracOf(selected)}%` }} />
        {envelopes.map((env, i) => {
          const causal = chainIds.has(env.id);
          const sel = i === idx;
          return (
            <button
              key={env.id}
              type="button"
              tabIndex={-1}
              className={`qx-replay__tick${causal ? ' qx-replay__tick--causal' : ''}${sel ? ' qx-replay__tick--selected' : ''}`}
              style={{ left: `${fracOf(env)}%`, '--qx-tick-tone': KIND_META[kindOf(env)].tone || undefined }}
              title={`${fmtTime(env.ts)} ${env.intent}`}
              onClick={() => { setPlaying(false); setIdx(i); }}
            />
          );
        })}
        <div className="qx-replay__cursor" style={{ left: `${fracOf(selected)}%` }} />
      </div>

      {/* The scrub control proper: native range, steps by event index.
          Keyboard arrows step events for free; the strip above carries
          the temporal truth. */}
      <input
        type="range"
        className="qx-replay__scrub"
        min={0}
        max={n - 1}
        step={1}
        value={idx}
        aria-label="Scrub loop history"
        aria-valuetext={`Event ${idx + 1} of ${n}, ${fmtTime(selected.ts)}, ${selected.intent}`}
        onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)); }}
      />

      <div className="qx-replay__cols">
        {/* Reconstructed belief at T — reuses the .qx-osv-detail row grammar
            so the vector here reads identically to the OSV flyout. */}
        <div className="qx-replay__state">
          <div className="qx-replay__subhead">Belief at T</div>
          {belief.vector ? (
            <>
              {DIMS.map((d) => (
                <div key={d.key} className="qx-osv-detail__row">
                  <span className="qx-osv-detail__label">{d.label}</span>
                  <span className="qx-osv-detail__track">
                    <span className="qx-osv-detail__fill" style={{ width: `${(belief.vector[d.key] ?? 0) * 100}%`, background: d.hue }} />
                  </span>
                  <span className="qx-osv-detail__num">{Math.round((belief.vector[d.key] ?? 0) * 100)}%</span>
                </div>
              ))}
              <div className="qx-replay__vector-ts">snapshot {fmtTime(belief.vectorTs)}</div>
            </>
          ) : (
            <div className="qx-replay__novector">No state snapshot yet at this point.</div>
          )}
          <div className="qx-replay__pills">
            {belief.phase && <span className="qx-pill qx-pill--sm">{belief.phase}</span>}
            {belief.frozenBy
              ? <span className="qx-pill qx-pill--sm qx-pill--critical">Frozen by {belief.frozenBy}</span>
              : <span className="qx-pill qx-pill--sm qx-pill--online">Running</span>}
            <span className="qx-pill qx-pill--sm">{belief.counts.promote}&uarr; {belief.counts.demote}&darr;</span>
            {belief.counts.error > 0 && <span className="qx-pill qx-pill--sm qx-pill--warn">{belief.counts.error} err</span>}
          </div>
        </div>

        {/* Causal chain: ONLY reply_to ancestors of the selected envelope,
            root-first, joined by a rail. Chronological neighbours that are
            not ancestors never appear here — that exclusion is the claim. */}
        <div className="qx-replay__chain">
          <div className="qx-replay__subhead">Why &mdash; causal chain ({chain.length})</div>
          <div className="qx-evtl">
            {truncated && (
              <div className="qx-evtl__row qx-evtl__row--gap">
                <span className="qx-evtl__marker" style={{ '--qx-evtl-tone': 'var(--qx-replay-neutral)' }} />
                <span className="qx-evtl__time">&hellip;</span>
                <span className="qx-evtl__summary">Chain continues before this window</span>
              </div>
            )}
            {chain.map((env, i) => {
              const kind = kindOf(env);
              const meta = KIND_META[kind];
              const isNow = env.id === selected.id;
              return (
                <div key={env.id} className={`qx-evtl__row qx-evtl__row--causal${isNow ? ' qx-evtl__row--now' : ''}`}>
                  <span className="qx-evtl__marker" style={{ '--qx-evtl-tone': meta.tone || 'var(--qx-replay-neutral)' }} />
                  <span className="qx-evtl__time">{fmtTime(env.ts)}</span>
                  <span className="qx-evtl__summary">
                    {env.payload?.summary || env.payload?.text || env.intent}
                    <span className="qx-replay__actors">{env.from} &rarr; {env.to}</span>
                  </span>
                  <span className={`qx-cap ${meta.cls}`}>{i === 0 && !truncated ? 'root' : meta.chip}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
