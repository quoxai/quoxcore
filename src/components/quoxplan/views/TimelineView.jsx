import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';
import { useEditMode } from '../context/EditModeContext.jsx';
import { useRoadmapCtx } from '../context/RoadmapContext.jsx';
import { toastApiError } from '../lib/toastBus.js';
import { flattenStreams } from '../lib/format.js';
import { ganttBarClass, statusColorVar, statusMeta } from '../lib/colors.js';
import { effortDaysFromDrag } from '../lib/timelineEdit.js';
import { usePersistedNumber } from '../lib/viewPrefs.js';
import {
  ZOOM_PRESETS,
  DEFAULT_ROW_HEIGHT,
  MIN_PX_PER_DAY,
  MAX_PX_PER_DAY,
  computeFitPxPerDay,
  shouldShowBarLabel,
  computeRowOrder,
  weekGridlines,
  barRect,
  rowMidY,
  connectorElbowPath
} from '../lib/timelineLayout.js';
import AsyncBoundary from '../components/AsyncBoundary.jsx';
import OctaGlyph from '../components/OctaGlyph.jsx';

const ZOOM_PREF_KEY = 'quoxplan.timeline.pxPerDay';
const DEFAULT_PX_PER_DAY = ZOOM_PRESETS.normal.pxPerDay;
const AXIS_HEIGHT = 28;
const LEFT_MARGIN = 12;

/**
 * Appends a fixed, pointer-events:none SVG overlay spanning the viewport so
 * the drag-a-dependency-edge line can be drawn in raw client coordinates
 * (no need to account for the chart's own scroll offset or <g> transform).
 * Removed on drop.
 */
function createLinkOverlay(x1, y1) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'qxp-link-drag-overlay');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', x1);
  line.setAttribute('y1', y1);
  line.setAttribute('x2', x1);
  line.setAttribute('y2', y1);
  line.setAttribute('class', 'qxp-link-drag-line');
  svg.appendChild(line);
  document.body.appendChild(svg);
  return { svg, line };
}

export default function TimelineView() {
  const { roadmapId } = useParams();
  const navigate = useNavigate();
  const { editMode } = useEditMode();
  const { activeScope } = useRoadmapCtx();
  const [pxPerDay, setPxPerDay] = usePersistedNumber(ZOOM_PREF_KEY, DEFAULT_PX_PER_DAY);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [activeRowId, setActiveRowId] = useState(null);
  const [tooltip, setTooltip] = useState(null);
  const [resizeDrag, setResizeDrag] = useState(null); // { rowId, deltaPx }
  const [containerWidth, setContainerWidth] = useState(0);
  const chartWrapRef = useRef(null);

  // Tracks the chart viewport's own width (excluding the row-label column) so
  // Fit-to-width can compute pxPerDay from it and so the chart can stretch to
  // fill the panel even when the content itself is narrower (owner feedback
  // 2026-07-25 wave 2, item 8: full panel width, no fixed max).
  useEffect(() => {
    const el = chartWrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { loading, error, data, retry } = useAsync(async () => {
    const [tl, streams] = await Promise.all([
      api.getTimeline(roadmapId, activeScope),
      api.listStreams(roadmapId, 'all', activeScope)
    ]);
    const effortById = new Map(flattenStreams(streams.streams).map((s) => [s.id, s.effort]));
    return tl.timeline.map((item) => ({ ...item, effort: effortById.get(item.id) }));
  }, [roadmapId, activeScope]);

  const rows = useMemo(() => (data ? computeRowOrder(data, collapsed) : []), [data, collapsed]);
  const rowIndexById = useMemo(() => new Map(rows.map((r, i) => [r.id, i])), [rows]);
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const maxDay = useMemo(() => (data ? Math.max(0, ...data.map((s) => s.end_offset_days ?? 0)) : 0), [data]);
  const gridlines = useMemo(() => weekGridlines(maxDay, pxPerDay), [maxDay, pxPerDay]);
  const chartWidth = Math.max(320, containerWidth, gridlines.length ? gridlines[gridlines.length - 1].x + 120 : 320);
  const chartHeight = rows.length * DEFAULT_ROW_HEIGHT + AXIS_HEIGHT + 8;

  function handleFit() {
    const width = chartWrapRef.current?.clientWidth || containerWidth;
    setPxPerDay(computeFitPxPerDay(width, maxDay));
  }

  function toggleCollapse(id) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function patchStream(id, fields, errorTitle) {
    try {
      await api.patchStream(id, fields);
      await retry();
    } catch (err) {
      toastApiError(err, errorTitle);
    }
  }

  function startResize(e, row) {
    if (!editMode) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const originalDays = row.effort_days ?? Math.max(1, (row.end_offset_days ?? 0) - (row.start_offset_days ?? 0));
    setResizeDrag({ rowId: row.id, deltaPx: 0 });

    function onMove(ev) {
      setResizeDrag({ rowId: row.id, deltaPx: ev.clientX - startX });
    }
    function onUp(ev) {
      window.removeEventListener('pointermove', onMove);
      const deltaPx = ev.clientX - startX;
      setResizeDrag(null);
      const newDays = effortDaysFromDrag(originalDays, deltaPx, pxPerDay);
      if (newDays === originalDays) return;
      patchStream(row.id, { effort_days: newDays }, 'Effort update failed');
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  function startLinkDrag(e, sourceRow) {
    if (!editMode) return;
    e.preventDefault();
    e.stopPropagation();
    const { svg, line } = createLinkOverlay(e.clientX, e.clientY);
    let hoverEl = null;

    function onMove(ev) {
      line.setAttribute('x2', ev.clientX);
      line.setAttribute('y2', ev.clientY);
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const rowEl = el?.closest('[data-row-id]') || null;
      if (rowEl !== hoverEl) {
        hoverEl?.classList.remove('qxp-bar--drop-target');
        hoverEl = rowEl && rowEl.getAttribute('data-row-id') !== sourceRow.id ? rowEl : null;
        hoverEl?.classList.add('qxp-bar--drop-target');
      }
    }
    function onUp(ev) {
      window.removeEventListener('pointermove', onMove);
      hoverEl?.classList.remove('qxp-bar--drop-target');
      svg.remove();
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const rowEl = el?.closest('[data-row-id]');
      const targetId = rowEl?.getAttribute('data-row-id');
      if (!targetId || targetId === sourceRow.id) return;
      const targetRow = rowById.get(targetId);
      const nextDeps = Array.from(new Set([...(targetRow?.blocked_by || []), sourceRow.id]));
      patchStream(targetId, { depends_on: nextDeps }, 'Could not create dependency');
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  function removeDependency(targetId, depId) {
    const targetRow = rowById.get(targetId);
    const nextDeps = (targetRow?.blocked_by || []).filter((id) => id !== depId);
    patchStream(targetId, { depends_on: nextDeps }, 'Could not remove dependency');
  }

  const activeRow = activeRowId != null ? rows[rowIndexById.get(activeRowId)] : null;

  return (
    <div className="qx-view qx-stack">
      <div className="qx-row qx-row--apart qxp-gantt-toolbar qx-card qx-card--bar">
        <span className="qxp-gantt-legend">
          {rows.length} streams · hover or click a row to trace its dependencies
          {editMode && ' · drag a bar’s edge to re-estimate, drag its end circle onto another bar to link'}
        </span>
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          <div className="qx-seg">
            <button type="button" className="qx-seg__btn" onClick={handleFit} title="Fit the whole roadmap into the panel width">
              Fit
            </button>
            <button
              type="button"
              className={`qx-seg__btn${pxPerDay === DEFAULT_PX_PER_DAY ? ' qx-seg__btn--active' : ''}`}
              onClick={() => setPxPerDay(DEFAULT_PX_PER_DAY)}
            >
              Normal
            </button>
          </div>
          <input
            type="range"
            className="qxp-zoom-range"
            min={MIN_PX_PER_DAY}
            max={MAX_PX_PER_DAY}
            step={0.5}
            value={pxPerDay}
            onChange={(e) => setPxPerDay(Number(e.target.value))}
            aria-label="Timeline zoom, pixels per day"
          />
          <span className="qx-hint qx-hint--sm qxp-mono">{pxPerDay.toFixed(1)}px/d</span>
        </div>
      </div>

      <AsyncBoundary loading={loading} error={error} onRetry={retry} skeletonLines={10}>
        <div className="qxp-gantt" style={{ height: Math.min(chartHeight + 2, 640) }}>
          <div className="qxp-gantt__rows" style={{ paddingTop: AXIS_HEIGHT }}>
            {rows.map((row, i) => (
              <div
                key={row.id}
                className={`qxp-gantt__row-label${activeRowId === row.id ? ' qxp-gantt__row-label--active' : ''}${row.error ? ' qxp-gantt__row-label--error' : ''}${row.scope_context ? ' qxp-scope-context' : ''}`}
                style={{ paddingLeft: 10 + row.depth * 16 }}
                onMouseEnter={() => setActiveRowId(row.id)}
                onClick={() => navigate(`/quoxplan/streams/${row.id}`)}
              >
                <OctaGlyph status={row.status} size={12} />
                {row.hasChildren ? (
                  <button
                    type="button"
                    className={`qxp-gantt__caret${!row.collapsed ? ' qxp-gantt__caret--open' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapse(row.id);
                    }}
                  >
                    ▸
                  </button>
                ) : (
                  <span style={{ width: 14, display: 'inline-block' }} />
                )}
                <span className="qxp-gantt__row-name">{row.name}</span>
                {row.hasChildren && <span className="qx-hint qx-hint--sm qxp-mono">+{row.childCount}</span>}
                {row.error && <span title={row.error}>⚠</span>}
              </div>
            ))}
          </div>

          <div className="qxp-gantt__chart" ref={chartWrapRef} onMouseLeave={() => setTooltip(null)}>
            <svg width={chartWidth + LEFT_MARGIN} height={chartHeight}>
              <g transform={`translate(${LEFT_MARGIN}, 0)`}>
                {gridlines.map((g) => (
                  <g key={g.day}>
                    <line
                      className="qxp-gantt__gridline"
                      x1={g.x}
                      x2={g.x}
                      y1={AXIS_HEIGHT}
                      y2={chartHeight}
                    />
                    {g.label && (
                      <text className="qxp-gantt__weeklabel" x={g.x + 3} y={16}>
                        {g.label} · d{g.day}
                      </text>
                    )}
                  </g>
                ))}

                {rows.map((row, i) => {
                  const rect = barRect(row, { pxPerDay, rowIndex: i, rowHeight: DEFAULT_ROW_HEIGHT });
                  const y = rect.y + AXIS_HEIGHT;
                  const fill = statusColorVar(row.status);
                  const isActive = activeRowId === row.id;
                  const showLabel = shouldShowBarLabel(pxPerDay, isActive);
                  const labelInside = rect.width > row.name.length * 6.2 + 12;
                  const isResizing = resizeDrag?.rowId === row.id;
                  const ghostWidth = isResizing ? Math.max(2, rect.width + resizeDrag.deltaPx) : null;

                  return (
                    <g
                      key={row.id}
                      data-row-id={row.id}
                      className={row.scope_context ? 'qxp-scope-context' : undefined}
                      onMouseEnter={() => setActiveRowId(row.id)}
                      onMouseMove={(e) => setTooltip({ row, x: e.clientX, y: e.clientY })}
                      onMouseLeave={() => setTooltip(null)}
                      onClick={() => navigate(`/quoxplan/streams/${row.id}`)}
                      style={{ cursor: 'pointer' }}
                    >
                      <rect
                        x={0}
                        y={y}
                        width={chartWidth}
                        height={DEFAULT_ROW_HEIGHT}
                        className={`qxp-gantt__row-bg${isActive ? ' qxp-gantt__row-bg--hover' : ''}`}
                      />
                      <rect
                        x={rect.x}
                        y={y}
                        width={rect.width}
                        height={rect.height}
                        rx={6}
                        className={`${ganttBarClass(row.status)}${row.status === 'COMPLETE' ? ' qxp-bar--complete' : ''}`}
                        style={{
                          fill,
                          fillOpacity: isResizing ? 0.35 : 0.65,
                          stroke: row.error ? 'var(--m-warning)' : fill,
                          strokeWidth: row.error ? 2 : 2,
                          strokeDasharray: row.error ? '4 2' : undefined
                        }}
                      />
                      {row.on_critical_path && (
                        <rect
                          x={rect.x - 1}
                          y={y - 1}
                          width={rect.width + 2}
                          height={rect.height + 2}
                          rx={7}
                          fill="none"
                          stroke="var(--m-quox-primary)"
                          strokeWidth={1}
                          pointerEvents="none"
                          className="qxp-bar--critical-path"
                        />
                      )}
                      {isResizing && (
                        <rect
                          x={rect.x}
                          y={y}
                          width={ghostWidth}
                          height={rect.height}
                          rx={6}
                          className="qxp-bar--ghost"
                          style={{ stroke: fill }}
                        />
                      )}
                      {showLabel && (
                        <text
                          className={`qxp-bar-label${labelInside ? '' : ' qxp-bar-label--outside'}`}
                          x={labelInside ? rect.x + 8 : rect.x + rect.width + 6}
                          y={y + rect.height / 2 + 4}
                        >
                          {row.name}
                        </text>
                      )}
                      {editMode && (
                        <>
                          <rect
                            x={rect.x + rect.width - 4}
                            y={y}
                            width={8}
                            height={rect.height}
                            className="qxp-resize-handle"
                            onPointerDown={(e) => startResize(e, row)}
                          />
                          <circle
                            cx={rect.x + rect.width + 10}
                            cy={y + rect.height / 2}
                            r={5}
                            className="qxp-link-handle"
                            onPointerDown={(e) => startLinkDrag(e, row)}
                          />
                        </>
                      )}
                    </g>
                  );
                })}

                {activeRow &&
                  (activeRow.blocked_by || []).map((depId) => {
                    const depIndex = rowIndexById.get(depId);
                    if (depIndex == null) return null;
                    const dep = rows[depIndex];
                    const from = {
                      x: barRect(dep, { pxPerDay, rowIndex: depIndex }).x + barRect(dep, { pxPerDay, rowIndex: depIndex }).width,
                      y: rowMidY(depIndex, DEFAULT_ROW_HEIGHT) + AXIS_HEIGHT
                    };
                    const to = {
                      x: barRect(activeRow, { pxPerDay, rowIndex: rowIndexById.get(activeRow.id) }).x,
                      y: rowMidY(rowIndexById.get(activeRow.id), DEFAULT_ROW_HEIGHT) + AXIS_HEIGHT
                    };
                    const danger = activeRow.status === 'BLOCKED';
                    const midX = (from.x + to.x) / 2;
                    const midY = (from.y + to.y) / 2;
                    return (
                      <g key={`${activeRow.id}-${depId}`}>
                        <path
                          d={connectorElbowPath(from, to)}
                          className={`qxp-connector${danger ? ' qxp-connector--blocked' : ''}`}
                          style={{ stroke: danger ? 'var(--m-error)' : 'var(--m-text-tertiary)' }}
                        />
                        {danger && (
                          <text x={to.x - 14} y={to.y + 4} fontSize={11}>
                            ⛔
                          </text>
                        )}
                        {editMode && (
                          <g
                            className="qxp-edge-remove"
                            transform={`translate(${midX}, ${midY})`}
                            onClick={(e) => {
                              e.stopPropagation();
                              removeDependency(activeRow.id, depId);
                            }}
                          >
                            <circle r={8} />
                            <text x={0} y={4} textAnchor="middle">
                              ×
                            </text>
                          </g>
                        )}
                      </g>
                    );
                  })}
              </g>
            </svg>
          </div>
        </div>

        {tooltip && (
          <div
            className="qx-card qx-card--compact qxp-gantt-tooltip"
            style={{ left: tooltip.x + 16, top: tooltip.y + 16 }}
          >
            <div className="qx-stack qx-stack--tight">
              <strong>{tooltip.row.name}</strong>
              <span className="qx-hint qx-hint--sm">{statusMeta(tooltip.row.status).label}</span>
              <span className="qx-hint qx-hint--sm qxp-mono">
                {tooltip.row.effort || `${tooltip.row.effort_days ?? '?'}d`} · days {tooltip.row.start_offset_days}–{tooltip.row.end_offset_days}
              </span>
              {tooltip.row.blocked_by?.length > 0 && (
                <span className="qx-hint qx-hint--sm">
                  depends on <span className="qxp-mono">{tooltip.row.blocked_by.join(', ')}</span>
                </span>
              )}
              {tooltip.row.on_critical_path && <span className="qx-hint qx-hint--sm">on critical path</span>}
              {tooltip.row.error && <span className="qx-hint qx-hint--danger">{tooltip.row.error}</span>}
            </div>
          </div>
        )}
      </AsyncBoundary>
    </div>
  );
}
