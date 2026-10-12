import { useRef, useState } from 'react';
import InlineEdit from './InlineEdit.jsx';
import { relativeTime } from '../lib/format.js';
import PortalMenu from './PortalMenu.jsx';

const PHASE_STATUSES = ['TODO', 'IN_PROGRESS', 'DONE'];
const STATUS_LABEL = { TODO: 'To do', IN_PROGRESS: 'In progress', DONE: 'Done' };

/** Per-phase "..." row menu, positioned via the shared PortalMenu (owner's
 * SECOND clipping report — see PortalMenu.jsx for the root-cause writeup). */
function PhaseRowMenu({ status, onSetStatus, onDelete }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);

  return (
    <div className="qxp-menu-anchor" ref={anchorRef}>
      <button type="button" className="qx-row-action" onClick={() => setOpen((o) => !o)} aria-label="Phase options">
        ⋯
      </button>
      <PortalMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} minWidth={170}>
        {PHASE_STATUSES.filter((s) => s !== status).map((s) => (
          <button
            key={s}
            type="button"
            className="qx-menu__item"
            onClick={() => {
              setOpen(false);
              onSetStatus(s);
            }}
          >
            Mark {STATUS_LABEL[s].toLowerCase()}
          </button>
        ))}
        <div className="qx-menu__sep" />
        <button
          type="button"
          className="qx-menu__item qx-menu__item--danger"
          onClick={() => {
            setOpen(false);
            onDelete();
          }}
        >
          Delete phase
        </button>
      </PortalMenu>
    </div>
  );
}

/**
 * Edit-mode phase checklist: checkbox toggles DONE/TODO, a per-phase menu
 * covers the full TODO/IN_PROGRESS/DONE/rename/delete surface, and an
 * "Add phase" input sits at the end. All calls go through the parent's
 * mutate-then-refetch handlers.
 */
export default function PhaseEditor({ phases, onToggleDone, onSetStatus, onRename, onDelete, onAdd }) {
  const [newTitle, setNewTitle] = useState('');

  function submitAdd() {
    const title = newTitle.trim();
    if (!title) return;
    setNewTitle('');
    onAdd(title);
  }

  return (
    <ul className="qxp-phase-list">
      {(phases || []).map((p) => (
        <li key={p.id} className="qxp-phase-list__item">
          <label className="qx-checkbox" style={{ flex: 0 }}>
            <input type="checkbox" checked={p.status === 'DONE'} onChange={() => onToggleDone(p)} />
            <span className="qx-checkbox__box" />
          </label>
          <div style={{ flex: 1, minWidth: 0 }}>
            <InlineEdit value={p.title} onSave={(title) => onRename(p, title)} placeholder="Phase title" />
          </div>
          {p.status === 'DONE' && p.done_at && <span className="qx-hint qx-hint--sm">done {relativeTime(p.done_at)}</span>}
          {p.status === 'IN_PROGRESS' && <span className="qx-pill qx-pill--xs qx-pill--warn">In progress</span>}
          <PhaseRowMenu status={p.status} onSetStatus={(s) => onSetStatus(p, s)} onDelete={() => onDelete(p)} />
        </li>
      ))}
      <li className="qxp-phase-list__item qxp-phase-list__add">
        <input
          className="qx-input qxp-input--sm"
          placeholder="Add phase…"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submitAdd();
            }
          }}
          onBlur={submitAdd}
        />
      </li>
    </ul>
  );
}
