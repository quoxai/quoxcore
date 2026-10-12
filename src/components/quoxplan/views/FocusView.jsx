import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';
import { useRoadmapCtx } from '../context/RoadmapContext.jsx';
import { flattenStreams } from '../lib/format.js';
import AsyncBoundary from '../components/AsyncBoundary.jsx';
import StreamMiniCard from '../components/StreamMiniCard.jsx';
import ActionItemsStrip from '../components/ActionItemsStrip.jsx';

const MAX_PER_SECTION = 5;

const SECTIONS = [
  { key: 'blockers', title: 'Blockers', hint: 'Tier 0 or blocked, the schedule waits on these.' },
  { key: 'decisions', title: 'Decisions needed', hint: 'Waiting on a call before work can continue.' },
  { key: 'in_flight', title: 'In flight', hint: 'Actively being worked right now.' },
  { key: 'stale', title: 'Gone quiet', hint: 'In progress, but no activity in 14+ days.' }
];

/** Assigns each focus-flagged stream to exactly one section (highest signal wins). */
function assignSection(stream) {
  const reasons = stream.focus_reasons || [];
  if (reasons.includes('tier0') || reasons.includes('blocked')) return 'blockers';
  if (reasons.includes('decision_needed')) return 'decisions';
  if (reasons.includes('stale')) return 'stale';
  if (reasons.includes('in_progress')) return 'in_flight';
  return null;
}

function Section({ title, hint, streams }) {
  const [expanded, setExpanded] = useState(false);
  if (streams.length === 0) return null;
  const shown = expanded ? streams : streams.slice(0, MAX_PER_SECTION);
  const remaining = streams.length - shown.length;

  return (
    <section className="qxp-focus-section">
      <div className="qxp-focus-section__head qx-stack qx-stack--tight">
        <h2 style={{ margin: 0 }}>{title}</h2>
        <span className="qx-hint qx-hint--sm">{hint}</span>
      </div>
      <div className="qxp-focus-grid">
        {shown.map((s) => (
          <StreamMiniCard key={s.id} stream={s} accent="status" />
        ))}
      </div>
      {remaining > 0 && (
        <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" style={{ marginTop: 10 }} onClick={() => setExpanded(true)}>
          Show {remaining} more
        </button>
      )}
    </section>
  );
}

export default function FocusView() {
  const { roadmapId } = useParams();
  const { activeScope } = useRoadmapCtx();

  const { loading, error, data, retry } = useAsync(
    () => api.listStreams(roadmapId, 'focus', activeScope),
    [roadmapId, activeScope]
  );

  const bySection = useMemo(() => {
    if (!data) return {};
    const flat = flattenStreams(data.streams);
    const grouped = { blockers: [], decisions: [], in_flight: [], stale: [] };
    for (const s of flat) {
      const key = assignSection(s);
      if (key) grouped[key].push(s);
    }
    grouped.blockers.sort((a, b) => a.tier - b.tier || a.priority - b.priority);
    for (const key of ['decisions', 'in_flight', 'stale']) {
      grouped[key].sort((a, b) => a.priority - b.priority);
    }
    return grouped;
  }, [data]);

  const totalFocused = Object.values(bySection).reduce((sum, list) => sum + list.length, 0);

  return (
    <div className="qx-view">
      <ActionItemsStrip roadmapId={roadmapId} />
      <AsyncBoundary loading={loading} error={error} onRetry={retry} skeletonLines={8}>
        {totalFocused === 0 ? (
          <div className="qx-empty">
            <div className="qx-empty__title">Nothing needs attention right now</div>
            <div className="qx-empty__body">No blockers, decisions, in-flight, or stale streams on this roadmap.</div>
          </div>
        ) : (
          SECTIONS.map((section) => (
            <Section key={section.key} title={section.title} hint={section.hint} streams={bySection[section.key] || []} />
          ))
        )}
      </AsyncBoundary>
    </div>
  );
}
