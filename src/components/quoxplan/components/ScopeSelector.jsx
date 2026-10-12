import { useRef, useState } from 'react';
import { useRoadmapCtx } from '../context/RoadmapContext.jsx';
import PortalMenu from './PortalMenu.jsx';

/**
 * Header-row division/department scope filter (QUOXPLAN-P5, owner mandate:
 * "one roadmap per org, divisions/departments are FILTERS" — the active
 * scope is ALWAYS visible, never a silently-applied default, so this always
 * renders a label even when unfiltered ("All scopes")). Filters every view
 * (Focus, Board, Timeline, Streams) in place via RoadmapContext's
 * `activeScope`, persisted per roadmap.
 *
 * Positioned via the shared `PortalMenu` (see that component's doc comment
 * for why the menu must portal to `document.body` — the same "`.qx-card`
 * clips absolutely positioned popovers" root cause as the roadmap switcher
 * in QuoxPlanView.jsx).
 *
 * Renders nothing when the org has zero scopes configured (owner
 * requirement: "hide the selector entirely" rather than showing an
 * always-empty menu).
 */
export default function ScopeSelector() {
  const { scopeOptions, activeScope, setActiveScope } = useRoadmapCtx();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);

  if (scopeOptions.length === 0) return null;

  return (
    <div ref={anchorRef} style={{ position: 'relative' }}>
      <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => setOpen((v) => !v)}>
        {activeScope || 'All scopes'} <span aria-hidden="true">&#9662;</span>
      </button>
      <PortalMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} className="qxp-scope-menu" minWidth={200}>
        <button
          type="button"
          className={`qx-menu__item${!activeScope ? ' qx-menu__item--active' : ''}`}
          onClick={() => {
            setOpen(false);
            setActiveScope(null);
          }}
        >
          All scopes
        </button>
        {scopeOptions.map((o) => (
          <button
            key={o.id}
            type="button"
            className={`qx-menu__item${o.name === activeScope ? ' qx-menu__item--active' : ''}`}
            onClick={() => {
              setOpen(false);
              setActiveScope(o.name);
            }}
          >
            {o.name}
          </button>
        ))}
      </PortalMenu>
    </div>
  );
}
