import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { StatusRead, TierNotch } from './Chips.jsx';
import { statusColorVar, tierColorVar } from '../lib/colors.js';
import { countAll } from '../lib/format.js';

function SubstreamRow({ stream, location }) {
  return (
    <Link
      to={`/quoxplan/streams/${stream.id}`}
      state={{ from: location.pathname }}
      className="qx-row qx-row--apart"
      style={{ padding: '4px 0', textDecoration: 'none' }}
    >
      <span className="qx-hint qx-hint--sm truncate" style={{ maxWidth: 170 }}>
        {stream.name}
      </span>
      <StatusRead status={stream.status} size={12} />
    </Link>
  );
}

/**
 * `editMode` + `onDragHandlePointerDown` are only used by BoardView's
 * pointer-based reorder (P2). The drag handle is a sibling of the Link, not
 * inside it, mirroring the existing "+N substreams" toggle button's
 * preventDefault/stopPropagation pattern below — so grabbing the handle
 * never triggers navigation.
 */
export default function BoardCard({ stream, accent = 'tier', editMode = false, isDragging = false, onDragHandlePointerDown }) {
  const [expanded, setExpanded] = useState(false);
  const location = useLocation();
  const accentColor = accent === 'tier' ? tierColorVar(stream.tier) : statusColorVar(stream.status);
  const substreamCount = countAll(stream.substreams || []);

  return (
    <div
      className={`qx-card qx-card--compact qxp-card-accent${isDragging ? ' qxp-board-card--dragging' : ''}${stream.scope_context ? ' qxp-scope-context' : ''}`}
      style={{ '--qxp-accent-color': accentColor }}
    >
      <TierNotch tier={stream.tier} />
      {editMode && (
        <button
          type="button"
          className="qxp-drag-handle"
          onPointerDown={onDragHandlePointerDown}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          aria-label={`Drag ${stream.name} to reorder`}
          title="Drag to reorder"
        >
          ⠿
        </button>
      )}
      <Link to={`/quoxplan/streams/${stream.id}`} state={{ from: location.pathname }} style={{ display: 'block', textDecoration: 'none' }}>
        <div className="qx-stack qx-stack--tight">
          <span className="qx-hint qx-hint--sm qxp-mono">{stream.id}</span>
          <strong style={{ fontSize: 'var(--m-text-sm)' }}>{stream.name}</strong>
          <StatusRead status={stream.status} size={12} />
        </div>
      </Link>
      {substreamCount > 0 && (
        <div className="qxp-board-card__substreams">
          <button
            type="button"
            className="qx-btn qx-btn--sm qx-btn--ghost"
            onClick={(e) => {
              e.preventDefault();
              setExpanded((v) => !v);
            }}
          >
            {expanded ? 'Hide' : `+${substreamCount} substream${substreamCount === 1 ? '' : 's'}`}
          </button>
          {expanded && (
            <div className="qx-stack qx-stack--tight" style={{ marginTop: 8, borderTop: '1px solid var(--m-border-subtle)', paddingTop: 6 }}>
              {stream.substreams.map((sub) => (
                <SubstreamRow key={sub.id} stream={sub} location={location} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
