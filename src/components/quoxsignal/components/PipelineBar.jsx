import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

/**
 * SIGNAL-PIPELINE: the product IS a pipeline — Feed > Transcribe > Analyse >
 * Proposals > Deepen > Discuss & update > QuoxPlan — but the UI presented
 * three flat tabs and made the stages implicit (owner: "I'm just not getting
 * that pipeline feel... it's hard to get between those at each stage").
 *
 * This bar is the pipeline made navigable: one station per stage, a live
 * count of what is SITTING at that station, click to jump straight to the
 * matching surface (feed filtered to the stage, or the proposals lane).
 * Counts come from GET /stats (one aggregate call); the bar refetches
 * whenever the tab or lane changes so acting on a station moves its number.
 *
 * The last station leaves the plugin on purpose: handed-off proposals LIVE
 * in QuoxPlan, and pretending the pipeline ends inside Signal would hide
 * where the work actually lands.
 */
const I = (d) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 13, height: 13 }} aria-hidden="true">
    {d}
  </svg>
);
const ICONS = {
  feed: I(<><path d="M4 11a9 9 0 0 1 9 9" /><path d="M4 4a16 16 0 0 1 16 16" /><circle cx="5" cy="19" r="1" /></>),
  transcribed: I(<><rect x="9" y="2" width="6" height="11" rx="3" /><path d="M5 10a7 7 0 0 0 14 0" /><path d="M12 17v4" /></>),
  analysed: I(<><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" /></>),
  proposals: I(<><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5 5h14l3 7v7H2v-7z" /></>),
  quoxplan: I(<><path d="M4 22V4a2 2 0 0 1 2-2h9l5 5v15" /><path d="M9 12l2 2 4-4" /></>),
};

/* SIGNAL-RETHINK (owner, 2026-09-18): five stations, not seven. Deepen and
   Discuss & Improve are OPTIONAL verbs on a queued proposal, not stations
   everything must pass through — as stations they made the pipeline read as
   longer and more mandatory than it is. Proposals counts everything still
   awaiting the terminal act (pending + approved-but-not-on-the-roadmap). */
const STATIONS = [
  { key: 'feed', label: 'Feed', sub: 'discovered, pick what to transcribe', count: (s) => s.items.discovered, to: { tab: 'feed', stage: 'discovered' } },
  { key: 'transcribed', label: 'Transcribed', sub: 'ready to analyse', count: (s) => s.items.transcribed, to: { tab: 'feed', stage: 'transcribed' } },
  { key: 'analysed', label: 'Analysed', sub: 'triage done, proposals drawn', count: (s) => s.items.analysed, to: { tab: 'feed', stage: 'analysed' } },
  { key: 'proposals', label: 'Proposals', sub: 'queued for your call — approve to QuoxPlan, optionally deepen or discuss first', count: (s) => s.proposals.pending + s.proposals.awaiting_deepen + s.proposals.awaiting_discussion, to: { tab: 'proposals', lane: 'queue' } },
  { key: 'quoxplan', label: 'QuoxPlan', sub: 'approved onto the roadmap', count: (s) => s.proposals.handed_off, external: '/quoxplan' },
];

export default function PipelineBar({ tab, stage, lane, onNavigate }) {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.getStats({ force: true })
      .then((s) => { if (!cancelled) setStats(s); })
      .catch(() => { /* bar degrades to count-less labels, never blocks the view */ });
    return () => { cancelled = true; };
  }, [tab, stage, lane]);

  const activeKey = (() => {
    if (tab === 'proposals') return 'proposals';
    if (tab === 'feed' && stage === 'transcribed') return 'transcribed';
    if (tab === 'feed' && stage === 'analysed') return 'analysed';
    if (tab === 'feed') return 'feed';
    return null;
  })();

  return (
    <div className="qx-card qx-card--compact" data-testid="signal-pipeline-bar" style={{ overflowX: 'auto', padding: '10px 20px' }}>
      <div className="qx-row qx-row--tight" style={{ flexWrap: 'nowrap', alignItems: 'center', minWidth: 'max-content' }}>
        {STATIONS.map((st, i) => {
          // Shape drift in the stats payload degrades this station to a
          // count-less label, same as a failed fetch — never the whole view.
          let n = null;
          if (stats) { try { n = st.count(stats); } catch { n = null; } }
          if (Number.isNaN(n)) n = null;
          const active = st.key === activeKey;
          const inner = (
            <span className="qx-row" style={{ alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
              {ICONS[st.key]}
              <span>{st.label}</span>
              <span className="qx-chip qx-chip--xs" style={n ? undefined : { opacity: 0.55 }}>{n ?? '·'}</span>
            </span>
          );
          return (
            <span key={st.key} className="qx-row" style={{ alignItems: 'center', gap: 4, flexShrink: 0 }}>
              {i > 0 && <span className="qx-trail__sep" aria-hidden="true">&rsaquo;</span>}
              {st.external ? (
                <Link
                  to={st.external}
                  className="qx-btn qx-btn--sm qx-btn--ghost"
                  title={`${st.sub} — opens QuoxPlan`}
                  data-testid={`signal-station-${st.key}`}
                >
                  {inner}
                </Link>
              ) : (
                <button
                  type="button"
                  className={`qx-btn qx-btn--sm ${active ? 'qx-btn--primary' : 'qx-btn--ghost'}`}
                  title={st.sub}
                  aria-current={active ? 'step' : undefined}
                  onClick={() => onNavigate(st.to)}
                  data-testid={`signal-station-${st.key}`}
                >
                  {inner}
                </button>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
