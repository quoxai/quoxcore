import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';
import { formatDuration, relativeTime } from '../lib/format.js';
import AsyncBoundary from '../components/AsyncBoundary.jsx';
import EvidenceTrail from '../components/EvidenceTrail.jsx';
import ScoutChatSidebar from '../ScoutChatSidebar.jsx';

const stamp = (s) => {
  if (s === null || s === undefined) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

/** One item's full detail: transcript, triage verdict, and any drafted
 * proposal, with SCOUT grounded in exactly the evidence shown. Ported from
 * the standalone app's ItemDetailView.jsx, rebuilt on qx-* + the shared
 * ScoutChatSidebar. */
export default function ItemDetailView() {
  const { id } = useParams();
  const [scoutCollapsed, setScoutCollapsed] = useState(false);
  const fetchItem = () => api.getItem(id);
  const { loading, error, data: item, retry } = useAsync(fetchItem, [id]);

  const fetchProposal = () => api.getProposalForItem(id);
  const { data: proposal } = useAsync(fetchProposal, [id]);

  const fetchLenses = () => api.listLensResults(id);
  const { data: lensData } = useAsync(fetchLenses, [id]);

  return (
    <AsyncBoundary loading={loading} error={error} onRetry={retry} skeletonLines={6}>
      {!item ? (
        <div className="qx-empty">
          <div className="qx-empty__title">Item not found</div>
        </div>
      ) : (
        <div
          className="qx-stack"
          /* The view shell is height:100% with overflow:hidden, which is right: chrome
             stays put and content scrolls inside. The Feed tab already scrolls its own
             list, but this route did not, so a transcript taller than the viewport was
             clipped with no way to reach it. flex:1 with min-height:0 is what lets a flex
             child shrink below its content and scroll; without min-height:0 it defaults
             to auto and refuses. */
          style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
        >
          <Link to="/quoxsignal" className="qx-hint">&larr; Back to feed</Link>

          <div className="qx-row" style={{ alignItems: 'stretch', gap: 16 }}>
            <div className="qx-stack" style={{ flex: 1, minWidth: 0 }}>
              <div className="qx-card qx-stack qx-stack--tight">
                <strong>{item.title || item.id}</strong>
                <div className="qx-row qx-row--tight">
                  <span className="qx-chip qx-chip--xs">{item.source_label || item.platform}</span>
                  <span className="qx-hint qx-hint--sm">{relativeTime(item.published_at || item.discovered_at)}</span>
                  <span className="qx-hint qx-hint--sm">{formatDuration(item.duration_s)}</span>
                  <span className="qx-pill qx-pill--info qx-pill--xs">stage: {item.stage}</span>
                </div>
                {item.url && (
                  <a href={item.url} target="_blank" rel="noreferrer" className="qx-hint">
                    {item.url}
                  </a>
                )}
              </div>

              {item.segments?.length > 0 && (
                <div className="qx-card">
                  <div className="qx-section-title">Transcript</div>
                  <div className="qx-scroll-list qx-stack qx-stack--tight">
                    {item.segments.map((seg) => (
                      <div className="qx-row qx-row--tight" key={seg.seq}>
                        <span className="qx-chip qx-chip--xs qx-mono">{stamp(seg.start)}</span>
                        <span>{seg.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {proposal && (
                <div className="qx-card qx-stack">
                  <div className="qx-row qx-row--tight">
                    <span className="qx-chip qx-chip--xs">Proposal</span>
                    <span className="qx-hint qx-hint--sm">{proposal.status}</span>
                  </div>
                  <p>{proposal.summary}</p>
                  {proposal.proposals?.map((p, i) => (
                    <div key={i} className="qx-card qx-card--compact qx-stack qx-stack--tight">
                      <strong>{p.title}</strong>
                      <p className="qx-hint">{p.rationale}</p>
                      {p.evidence?.map((e, j) => (
                        <div key={j} className="qx-row qx-row--tight">
                          <span className="qx-chip qx-chip--xs qx-mono">{e.t}</span>
                          <span className="qx-hint">&ldquo;{e.quote}&rdquo;</span>
                        </div>
                      ))}
                    </div>
                  ))}
                  <EvidenceTrail proposal={proposal} />
                </div>
              )}
            </div>

            <div style={{ width: scoutCollapsed ? 48 : 320, flexShrink: 0 }}>
              <ScoutChatSidebar
                surface="item-detail"
                item={item}
                lensData={lensData}
                proposal={proposal}
                collapsed={scoutCollapsed}
                onToggle={() => setScoutCollapsed((v) => !v)}
              />
            </div>
          </div>
        </div>
      )}
    </AsyncBoundary>
  );
}
