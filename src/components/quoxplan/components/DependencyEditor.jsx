import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useRoadmapCtx } from '../context/RoadmapContext.jsx';
import { fuzzyFilter } from '../lib/fuzzy.js';
import { StatusRead } from './Chips.jsx';
import PortalMenu from './PortalMenu.jsx';

/**
 * Edit-mode "Blocked by" list: each existing dependency gets a remove (x),
 * and an "Add dependency" combobox searches this roadmap's streams by
 * id/name and appends the chosen id to `depends_on`. The 422 cycle error
 * (if the parent's onAdd throws) is expected to be surfaced by the caller
 * via a toast — this component just triggers the mutation.
 */
export default function DependencyEditor({ roadmapId, streamId, items, onAdd, onRemove }) {
  const { getStreamIndex } = useRoadmapCtx();
  const [candidates, setCandidates] = useState([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    let cancelled = false;
    getStreamIndex(roadmapId)
      .then((list) => {
        if (!cancelled) setCandidates(list);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [roadmapId, getStreamIndex]);

  const existingIds = new Set(items.map((d) => d.id));
  const pool = candidates.filter((c) => c.id !== streamId && !existingIds.has(c.id));
  const options = query.trim() ? fuzzyFilter(query, pool, (c) => `${c.id} ${c.name}`) : pool;

  return (
    <div className="qx-stack qx-stack--tight">
      {items.length === 0 && <span className="qx-hint qx-hint--sm">No dependencies.</span>}
      {items.map((d) => (
        <div key={d.id} className="qx-row qx-row--apart">
          <Link to={`/quoxplan/streams/${d.id}`} className="qx-hint qx-hint--sm truncate" style={{ maxWidth: 150, textDecoration: 'none' }}>
            {d.name}
          </Link>
          <div className="qx-row qx-row--tight" style={{ gap: 4 }}>
            <StatusRead status={d.status} size={12} />
            <button type="button" className="qx-row-action" onClick={() => onRemove(d.id)} aria-label={`Remove dependency ${d.name}`}>
              ×
            </button>
          </div>
        </div>
      ))}

      <div className="qxp-menu-anchor" ref={ref}>
        <input
          className="qx-input qxp-input--sm"
          placeholder="Add dependency…"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
        />
        <PortalMenu
          open={open && options.length > 0}
          onClose={() => setOpen(false)}
          anchorRef={ref}
          className="qxp-dep-combobox"
          matchAnchorWidth
        >
          {options.slice(0, 8).map((c) => (
            <button
              key={c.id}
              type="button"
              className="qx-menu__item"
              onClick={() => {
                setQuery('');
                setOpen(false);
                onAdd(c.id);
              }}
            >
              <span style={{ flex: 1, textAlign: 'left' }}>{c.name}</span>
              <span className="qx-hint qx-hint--sm qxp-mono">{c.id}</span>
            </button>
          ))}
        </PortalMenu>
      </div>
    </div>
  );
}
