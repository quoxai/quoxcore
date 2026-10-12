import { useRef, useState } from 'react';
import { StatusPill, TierChip } from './Chips.jsx';
import { statusMeta, tierMeta } from '../lib/colors.js';
import PortalMenu from './PortalMenu.jsx';

const STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'DECISION_NEEDED', 'COMPLETE'];
const TIERS = [0, 1, 2, 3, 4, 5];

/**
 * Status pill that becomes a `.qx-menu` of the 5 statuses in edit mode.
 * Choosing COMPLETE does not mutate directly — it calls `onRequestComplete`
 * so the caller can show the owner-confirm dialog first.
 *
 * Popout positioned via the shared `PortalMenu` (owner's SECOND clipping
 * report — "edit has a popout but i can not see it" — this chip lives
 * inside a `.qx-card`-clipped context like every other converted popout in
 * the plugin; see PortalMenu.jsx for the root-cause writeup).
 */
export function StatusMenu({ status, onChange, onRequestComplete, disabled }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);

  return (
    <div className="qxp-menu-anchor" ref={anchorRef}>
      <button type="button" className="qxp-chip-trigger" onClick={() => setOpen((o) => !o)} disabled={disabled}>
        <StatusPill status={status} />
      </button>
      <PortalMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} minWidth={170}>
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            className={`qx-menu__item${s === status ? ' qx-menu__item--active' : ''}`}
            onClick={() => {
              setOpen(false);
              if (s === status) return;
              if (s === 'COMPLETE') onRequestComplete();
              else onChange(s);
            }}
          >
            {statusMeta(s).label}
          </button>
        ))}
      </PortalMenu>
    </div>
  );
}

/**
 * Assignee-scope chip that becomes a `.qx-menu` of the org's division/
 * department scopes (plus "None") in edit mode (QUOXPLAN-P5). Unlike
 * Tier/Status, `options` is dynamic (RoadmapContext's `scopeOptions`,
 * `{ id, name }[]`) and can be empty — callers should not render this
 * component at all in that case (mirrors the header scope selector's own
 * "hide when the org has zero scopes" rule). The mutation value sent is the
 * scope's `name` (a plain string — `assignee_scope` has no FK to the scopes
 * table), or `null` for "None".
 */
export function ScopeMenu({ scope, options, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);

  return (
    <div className="qxp-menu-anchor" ref={anchorRef}>
      <button type="button" className="qxp-chip-trigger" onClick={() => setOpen((o) => !o)} disabled={disabled}>
        <span className="qx-chip qx-chip--xs qxp-mono">{scope || 'no scope'}</span>
      </button>
      <PortalMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} minWidth={170}>
        <button
          type="button"
          className={`qx-menu__item${!scope ? ' qx-menu__item--active' : ''}`}
          onClick={() => {
            setOpen(false);
            if (scope) onChange(null);
          }}
        >
          None
        </button>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            className={`qx-menu__item${o.name === scope ? ' qx-menu__item--active' : ''}`}
            onClick={() => {
              setOpen(false);
              if (o.name !== scope) onChange(o.name);
            }}
          >
            {o.name}
          </button>
        ))}
      </PortalMenu>
    </div>
  );
}

/** Tier chip that becomes a 0-5 `.qx-menu` in edit mode. */
export function TierMenu({ tier, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);

  return (
    <div className="qxp-menu-anchor" ref={anchorRef}>
      <button type="button" className="qxp-chip-trigger" onClick={() => setOpen((o) => !o)} disabled={disabled}>
        <TierChip tier={tier} />
      </button>
      <PortalMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} minWidth={170}>
        {TIERS.map((t) => (
          <button
            key={t}
            type="button"
            className={`qx-menu__item${t === tier ? ' qx-menu__item--active' : ''}`}
            onClick={() => {
              setOpen(false);
              if (t !== tier) onChange(t);
            }}
          >
            {tierMeta(t).label}
          </button>
        ))}
      </PortalMenu>
    </div>
  );
}
