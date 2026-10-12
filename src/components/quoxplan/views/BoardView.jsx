import { useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';
import { useEditMode } from '../context/EditModeContext.jsx';
import { useRoadmapCtx } from '../context/RoadmapContext.jsx';
import { toastApiError } from '../lib/toastBus.js';
import { computeBoardReorder } from '../lib/dragOrder.js';
import AsyncBoundary from '../components/AsyncBoundary.jsx';
import BoardCard from '../components/BoardCard.jsx';
import ConfirmCompleteDialog from '../components/ConfirmCompleteDialog.jsx';
import { TierRead, StatusRead } from '../components/Chips.jsx';

const STATUS_ORDER = ['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'DECISION_NEEDED', 'COMPLETE'];

function buildColumns(streams, mode, overrides) {
  const { statusOverride, priorityRank } = overrides;
  const withOverrides = streams.map((s) => ({
    ...s,
    status: statusOverride.has(s.id) ? statusOverride.get(s.id) : s.status,
    priority: priorityRank ? priorityRank.get(s.id) ?? s.priority : s.priority
  }));

  if (mode === 'tier') {
    const byTier = new Map();
    for (const s of withOverrides) {
      if (!byTier.has(s.tier)) byTier.set(s.tier, []);
      byTier.get(s.tier).push(s);
    }
    return [...byTier.keys()]
      .sort((a, b) => a - b)
      .map((tier) => ({
        key: `tier-${tier}`,
        statusKey: null,
        streams: byTier.get(tier).sort((a, b) => a.priority - b.priority),
        header: <TierRead tier={tier} />
      }));
  }
  const byStatus = new Map();
  for (const s of withOverrides) {
    if (!byStatus.has(s.status)) byStatus.set(s.status, []);
    byStatus.get(s.status).push(s);
  }
  return STATUS_ORDER.filter((s) => byStatus.has(s)).map((status) => ({
    key: `status-${status}`,
    statusKey: status,
    streams: byStatus.get(status).sort((a, b) => a.priority - b.priority),
    header: <StatusRead status={status} size={14} />
  }));
}

function makeGhost(text) {
  const el = document.createElement('div');
  el.className = 'qxp-drag-ghost';
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

export default function BoardView() {
  const { roadmapId } = useParams();
  const { editMode } = useEditMode();
  const { activeScope } = useRoadmapCtx();
  const [mode, setMode] = useState('tier');

  const { loading, error, data, retry } = useAsync(
    () => api.listStreams(roadmapId, 'all', activeScope),
    [roadmapId, activeScope]
  );

  // Optimistic overlays applied on top of server data while a reprioritise/
  // status PATCH is in flight (or awaiting the owner-confirm dialog).
  // Cleared once the refetch after a successful mutation lands, or
  // immediately on error/cancel to snap the board back to server truth.
  const [statusOverride, setStatusOverride] = useState(() => new Map());
  const [priorityRank, setPriorityRank] = useState(null);
  const [draggingId, setDraggingId] = useState(null);
  const [pendingComplete, setPendingComplete] = useState(null); // { streamId, flatOrder }
  const [completeBusy, setCompleteBusy] = useState(false);

  const columns = useMemo(() => {
    if (!data) return [];
    return buildColumns(data.streams, mode, { statusOverride, priorityRank });
  }, [data, mode, statusOverride, priorityRank]);

  const columnRefs = useRef(new Map());
  const cardRefs = useRef(new Map());

  function clearOverrides() {
    setStatusOverride(new Map());
    setPriorityRank(null);
  }

  function colIndexAt(clientX) {
    let best = 0;
    let bestDist = Infinity;
    columns.forEach((col, i) => {
      const el = columnRefs.current.get(col.key);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const dist = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    return best;
  }

  function itemIndexAt(colIndex, clientY, excludeId) {
    const col = columns[colIndex];
    if (!col) return 0;
    const ids = col.streams.map((s) => s.id).filter((id) => id !== excludeId);
    for (let i = 0; i < ids.length; i++) {
      const el = cardRefs.current.get(ids[i]);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return ids.length;
  }

  function applyMove(fromColIndex, fromItemIndex, toColIndex, toItemIndex) {
    const columnsIds = columns.map((c) => c.streams.map((s) => s.id));
    const flatOrder = computeBoardReorder(columnsIds, {
      fromColumnIndex: fromColIndex,
      fromItemIndex,
      toColumnIndex: toColIndex,
      toItemIndex
    });
    const streamId = columnsIds[fromColIndex][fromItemIndex];
    const rank = new Map(flatOrder.map((id, i) => [id, i]));
    const crossColumn = fromColIndex !== toColIndex;
    const targetStatus = mode === 'status' ? columns[toColIndex].statusKey : null;

    setPriorityRank(rank);
    if (crossColumn && targetStatus) {
      setStatusOverride((m) => new Map(m).set(streamId, targetStatus));
    }

    if (!crossColumn) {
      api
        .reprioritise(roadmapId, flatOrder)
        .then(() => retry())
        .then(clearOverrides)
        .catch((err) => {
          clearOverrides();
          toastApiError(err, 'Reorder failed');
        });
      return;
    }

    if (targetStatus === 'COMPLETE') {
      setPendingComplete({ streamId });
      return;
    }

    api
      .patchStream(streamId, { status: targetStatus })
      .then(() => retry())
      .then(clearOverrides)
      .catch((err) => {
        clearOverrides();
        toastApiError(err, 'Status update failed');
      });
  }

  function handlePointerDown(e, streamId, streamName, colIndex, itemIndex) {
    if (!editMode) return;
    e.preventDefault();
    setDraggingId(streamId);
    const ghost = makeGhost(streamName);
    ghost.style.left = `${e.clientX + 12}px`;
    ghost.style.top = `${e.clientY + 12}px`;

    function onMove(ev) {
      ghost.style.left = `${ev.clientX + 12}px`;
      ghost.style.top = `${ev.clientY + 12}px`;
    }

    function onUp(ev) {
      window.removeEventListener('pointermove', onMove);
      ghost.remove();
      setDraggingId(null);
      const toColIndex = mode === 'tier' ? colIndex : colIndexAt(ev.clientX);
      const toItemIndex = itemIndexAt(toColIndex, ev.clientY, streamId);
      if (toColIndex === colIndex && toItemIndex === itemIndex) return;
      applyMove(colIndex, itemIndex, toColIndex, toItemIndex);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  function confirmPendingComplete() {
    if (!pendingComplete) return;
    setCompleteBusy(true);
    api
      .patchStream(pendingComplete.streamId, { status: 'COMPLETE', confirm_owner: true })
      .then(() => retry())
      .then(() => {
        clearOverrides();
        setPendingComplete(null);
      })
      .catch((err) => {
        clearOverrides();
        toastApiError(err, 'Could not mark complete');
      })
      .finally(() => setCompleteBusy(false));
  }

  function cancelPendingComplete() {
    clearOverrides();
    setPendingComplete(null);
  }

  const pendingStream = pendingComplete && data ? data.streams.find((s) => s.id === pendingComplete.streamId) : null;

  return (
    <div className="qx-view qx-stack">
      <div className="qx-tabs qxp-lens-tabs">
        <button type="button" className={`qx-tab${mode === 'tier' ? ' qx-tab--active' : ''}`} onClick={() => setMode('tier')}>
          By tier
        </button>
        <button type="button" className={`qx-tab${mode === 'status' ? ' qx-tab--active' : ''}`} onClick={() => setMode('status')}>
          By status
        </button>
      </div>

      <AsyncBoundary loading={loading} error={error} onRetry={retry} skeletonLines={8}>
        <div className="qxp-board-columns">
          {columns.map((col, colIndex) => (
            <div
              key={col.key}
              className="qxp-board-column"
              ref={(el) => {
                if (el) columnRefs.current.set(col.key, el);
                else columnRefs.current.delete(col.key);
              }}
            >
              <div className="qxp-board-column__head qx-row qx-row--apart">
                {col.header}
                <span className="qx-hint qx-hint--sm qxp-mono">{col.streams.length}</span>
              </div>
              {col.streams.map((s, itemIndex) => (
                <div
                  key={s.id}
                  ref={(el) => {
                    if (el) cardRefs.current.set(s.id, el);
                    else cardRefs.current.delete(s.id);
                  }}
                >
                  <BoardCard
                    stream={s}
                    accent={mode}
                    editMode={editMode}
                    isDragging={draggingId === s.id}
                    onDragHandlePointerDown={(e) => handlePointerDown(e, s.id, s.name, colIndex, itemIndex)}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      </AsyncBoundary>

      {pendingComplete && (
        <ConfirmCompleteDialog
          streamName={pendingStream?.name || pendingComplete.streamId}
          busy={completeBusy}
          onConfirm={confirmPendingComplete}
          onCancel={cancelPendingComplete}
        />
      )}
    </div>
  );
}
