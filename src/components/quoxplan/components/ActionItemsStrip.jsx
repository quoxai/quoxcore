import { Link, useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';

const PREVIEW_COUNT = 3;

/**
 * Focus view's roadmap-level open-action-items strip (QUOXPLAN-P7): one
 * calm row, not a wall — self-hides while loading/empty rather than
 * reserving space or showing a skeleton, since this is a secondary surface
 * above the real Focus sections. Uses the roadmap-level GET (cross-stream),
 * unlike ActionItemsCard which is per-stream.
 */
export default function ActionItemsStrip({ roadmapId }) {
  const location = useLocation();
  const { data } = useAsync(() => api.getRoadmapActionItems(roadmapId, 'OPEN'), [roadmapId]);
  const items = data?.action_items || [];
  if (items.length === 0) return null;

  const shown = items.slice(0, PREVIEW_COUNT);

  return (
    <div className="qx-card qx-card--compact qx-row qx-row--apart qx-row--wrap" style={{ marginBottom: 12 }}>
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <strong className="qx-hint qx-hint--sm" style={{ color: 'var(--m-text-primary)' }}>
          {items.length} open action item{items.length === 1 ? '' : 's'}
        </strong>
        {shown.map((item) => (
          <Link
            key={item.id}
            to={`/quoxplan/streams/${item.stream_id}`}
            state={{ from: location.pathname }}
            className="qx-chip qx-chip--xs"
            style={{ textDecoration: 'none' }}
            title={item.stream_name}
          >
            {item.title}
          </Link>
        ))}
      </div>
      <Link to={`/quoxplan/${roadmapId}/streams`} className="qx-btn qx-btn--sm qx-btn--ghost">
        View all
      </Link>
    </div>
  );
}
