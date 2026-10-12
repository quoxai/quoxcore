import { useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';
import { toastApiError } from '../lib/toastBus.js';
import { relativeTime } from '../lib/format.js';
import { actionItemKindColorVar, actionItemKindMeta } from '../lib/colors.js';
import AsyncBoundary from './AsyncBoundary.jsx';
import PortalMenu from './PortalMenu.jsx';

/** Small filled octahedron, colored by action-item kind rather than stream
 * status — same wireframe-diamond language as OctaGlyph.jsx, kept separate
 * since kind (blocked/decision/manual) is a different axis than status. */
function ActionItemGlyph({ kind, size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="qxp-octa-glyph">
      <path d="M8 1 L15 8 L8 15 L1 8 Z" fill={actionItemKindColorVar(kind)} opacity={0.85} />
    </svg>
  );
}

function ActionItemRow({ item, editMode, onToggleDone, onCancel }) {
  const meta = actionItemKindMeta(item.kind);
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef(null);
  const done = item.status === 'DONE';
  const cancelled = item.status === 'CANCELLED';

  return (
    <li className="qxp-phase-list__item">
      <ActionItemGlyph kind={item.kind} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ opacity: done || cancelled ? 0.6 : 1, textDecoration: cancelled ? 'line-through' : 'none' }}>
          {item.title}
        </span>
        <div className="qx-hint qx-hint--sm qxp-mono">
          {meta.label} &middot; created {relativeTime(item.created_at)}
          {item.due_at && <> &middot; due {relativeTime(item.due_at)}</>}
        </div>
      </div>
      {editMode && !cancelled && (
        <>
          <label className="qx-checkbox" style={{ flex: 0 }} title={done ? 'Reopen' : 'Mark done'}>
            <input type="checkbox" checked={done} onChange={() => onToggleDone(item)} />
            <span className="qx-checkbox__box" />
          </label>
          <div className="qxp-menu-anchor" ref={anchorRef}>
            <button type="button" className="qx-row-action" onClick={() => setMenuOpen((o) => !o)} aria-label="Action item options">
              &#8942;
            </button>
            <PortalMenu open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={anchorRef} minWidth={140}>
              <button
                type="button"
                className="qx-menu__item qx-menu__item--danger"
                onClick={() => {
                  setMenuOpen(false);
                  onCancel(item);
                }}
              >
                Cancel
              </button>
            </PortalMenu>
          </div>
        </>
      )}
    </li>
  );
}

/**
 * Stream page "Action items" card (QUOXPLAN-P7), sits between Phases and the
 * Plan/dependencies layout. Self-fetches — action items aren't part of
 * getStreamDetail(), only the `open_action_items` count is. Open items sort
 * first; DONE/CANCELLED follow, most recent first within each group.
 */
export default function ActionItemsCard({ streamId, editMode }) {
  const { loading, error, data, retry } = useAsync(() => api.getActionItems(streamId), [streamId]);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const items = data?.action_items || [];
  const ordered = [...items].sort((a, b) => {
    const aOpen = a.status === 'OPEN';
    const bOpen = b.status === 'OPEN';
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  async function submitAdd() {
    const title = newTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await api.addActionItem(streamId, { title });
      setNewTitle('');
      await retry();
    } catch (err) {
      toastApiError(err, 'Could not add action item');
    } finally {
      setBusy(false);
    }
  }

  async function toggleDone(item) {
    try {
      await api.patchActionItem(streamId, item.id, { status: item.status === 'DONE' ? 'OPEN' : 'DONE' });
      await retry();
    } catch (err) {
      toastApiError(err, 'Could not update action item');
    }
  }

  async function cancelItem(item) {
    try {
      await api.patchActionItem(streamId, item.id, { status: 'CANCELLED' });
      await retry();
    } catch (err) {
      toastApiError(err, 'Could not cancel action item');
    }
  }

  return (
    <div className="qx-card">
      <h3 style={{ marginTop: 0 }}>Action items</h3>
      <AsyncBoundary loading={loading} error={error} onRetry={retry} skeletonLines={2}>
        {ordered.length === 0 && !editMode && <span className="qx-hint">No action items for this stream.</span>}
        {ordered.length > 0 && (
          <ul className="qxp-phase-list">
            {ordered.map((item) => (
              <ActionItemRow key={item.id} item={item} editMode={editMode} onToggleDone={toggleDone} onCancel={cancelItem} />
            ))}
          </ul>
        )}
        {editMode && (
          <div className="qxp-phase-list__add" style={{ marginTop: ordered.length > 0 ? 10 : 0 }}>
            <input
              className="qx-input qxp-input--sm"
              placeholder="Add action item…"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submitAdd();
                }
              }}
              onBlur={submitAdd}
              disabled={busy}
            />
          </div>
        )}
      </AsyncBoundary>
    </div>
  );
}
