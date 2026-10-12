/**
 * DataTable — Paginated, selectable data table for list views
 *
 * Designed for the left panel of dual-panel layouts.
 * Supports vim-style navigation, pagination, and keyboard selection.
 *
 * Props:
 *   columns          - array of { key, label, width? } — a column with no
 *                       `width` (or explicit `flex: true`) absorbs a share
 *                       of the remaining terminal width alongside other
 *                       flex columns. Columns with a numeric `width` are
 *                       fixed and unaffected by flex distribution.
 *   rows             - array of data objects
 *   selected         - controlled selected row index
 *   onSelect         - callback on Enter (receives row object)
 *   onSelectionChange- callback on cursor move (receives index)
 *   pageSize         - rows per page (default: derived from terminal rows)
 *   loading          - show spinner overlay
 *   emptyMessage     - text when rows is empty
 *   active           - accept keyboard input (default: true)
 */

import React, { useState, useMemo, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
import { matchKey } from '../keys.js';
import { colors } from '../theme.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

// Minimum rows per page when deriving from a short terminal.
const MIN_PAGE_SIZE = 5;
// Rows reserved for header/footer/borders/etc. when deriving page size.
const CHROME_ROWS = 8;
// Width reserved for the selection marker ("▶ " / "  ") before columns start.
const MARKER_WIDTH = 2;
// Floor width for a flex column so it never collapses to unreadable size.
const MIN_FLEX_WIDTH = 6;

export function DataTable({
  columns,
  rows = [],
  selected: controlledSelected,
  onSelect,
  onSelectionChange,
  pageSize: pageSizeProp,
  loading = false,
  emptyMessage = 'No items',
  active = true,
}) {
  // ── Responsive page size (only when caller doesn't pass one) ────────
  const { rows: termRows, columns: termColumns } = useTerminalSize();
  const pageSize = pageSizeProp != null
    ? pageSizeProp
    : Math.max(MIN_PAGE_SIZE, termRows - CHROME_ROWS);

  // ── Internal cursor state ───────────────────────────────────────────
  const [internalSelected, setInternalSelected] = useState(0);

  // Use controlled selection if provided, otherwise internal
  const isControlled = controlledSelected !== undefined;
  const selected = isControlled ? controlledSelected : internalSelected;

  const setSelected = (valOrFn) => {
    const nextVal = typeof valOrFn === 'function' ? valOrFn(selected) : valOrFn;
    if (!isControlled) {
      setInternalSelected(nextVal);
    }
    if (onSelectionChange) {
      onSelectionChange(nextVal);
    }
  };

  // ── Pagination ──────────────────────────────────────────────────────
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));

  const currentPage = useMemo(() => {
    return Math.floor(selected / pageSize);
  }, [selected, pageSize]);

  const pageRows = useMemo(() => {
    const start = currentPage * pageSize;
    return rows.slice(start, start + pageSize);
  }, [rows, currentPage, pageSize]);

  const pageOffset = currentPage * pageSize;

  // ── Reset selection when rows change ────────────────────────────────
  useEffect(() => {
    if (rows.length > 0 && selected >= rows.length) {
      setSelected(Math.max(0, rows.length - 1));
    }
  }, [rows.length]);

  // ── Keyboard handling ───────────────────────────────────────────────
  useInput((input, key) => {
    if (!active || rows.length === 0) return;

    // Cursor movement: j/down, k/up
    if (matchKey('down', input, key)) {
      setSelected((s) => (s < rows.length - 1 ? s + 1 : 0));
      return;
    }
    if (matchKey('up', input, key)) {
      setSelected((s) => (s > 0 ? s - 1 : rows.length - 1));
      return;
    }

    // Page navigation: n = next page, p = prev page
    if (matchKey('nextPage', input, key)) {
      const nextPageStart = Math.min((currentPage + 1) * pageSize, rows.length - 1);
      if (currentPage < totalPages - 1) {
        setSelected(nextPageStart);
      }
      return;
    }
    if (matchKey('prevPage', input, key)) {
      const prevPageStart = Math.max((currentPage - 1) * pageSize, 0);
      if (currentPage > 0) {
        setSelected(prevPageStart);
      }
      return;
    }

    // Select with Enter
    if (matchKey('select', input, key)) {
      if (onSelect && rows[selected]) {
        onSelect(rows[selected]);
      }
      return;
    }
  });

  // ── Column widths ───────────────────────────────────────────────────
  // A column with an explicit numeric `width` is fixed (unchanged from
  // legacy behavior). A column with `flex: true` or no `width` at all is a
  // flex column: it absorbs an equal share of whatever terminal width is
  // left over after fixed columns and the selection marker are accounted
  // for, so long values (titles, URLs) expand on wide terminals instead of
  // always being clipped at the old hard-coded 40-char cap.
  const colWidths = useMemo(() => {
    if (columns.length === 0) return [];

    const isFlex = (col) => col.flex === true || col.width == null;

    // Content-based width (legacy auto-calc): used as the fallback when no
    // usable terminal width is available.
    const contentWidth = (col) => {
      const headerLen = col.label.length;
      const maxDataLen = rows.reduce((max, row) => {
        const val = String(row[col.key] ?? '');
        return Math.max(max, val.length);
      }, 0);
      return Math.min(Math.max(headerLen, maxDataLen) + 2, 40);
    };

    const flexIndices = columns
      .map((col, i) => (isFlex(col) ? i : -1))
      .filter((i) => i !== -1);

    // No flex columns — every width is explicit, behavior is unchanged.
    if (flexIndices.length === 0) {
      return columns.map((col) => col.width);
    }

    const fixedTotal = columns.reduce(
      (sum, col) => sum + (isFlex(col) ? 0 : col.width),
      0
    );

    // No terminal width info at all — fall back to legacy content-based sizing.
    if (!termColumns) {
      return columns.map((col) => (isFlex(col) ? contentWidth(col) : col.width));
    }

    const available = termColumns - MARKER_WIDTH - fixedTotal;
    const perFlex = Math.floor(available / flexIndices.length);
    const flexWidth = Math.max(MIN_FLEX_WIDTH, perFlex);

    return columns.map((col) => (isFlex(col) ? flexWidth : col.width));
  }, [columns, rows, termColumns]);

  // ── Render: Loading state ───────────────────────────────────────────
  if (loading) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Spinner label="Loading..." />
      </Box>
    );
  }

  // ── Render: Empty state ─────────────────────────────────────────────
  if (rows.length === 0) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color={colors.dim}>{emptyMessage}</Text>
      </Box>
    );
  }

  // ── Render: Table ───────────────────────────────────────────────────
  return (
    <Box flexDirection="column">
      {/* Column headers */}
      <Box>
        <Text color={colors.dim}>  </Text>
        {columns.map((col, ci) => (
          <Box key={col.key} width={colWidths[ci]}>
            <Text bold dimColor>
              {col.label}
            </Text>
          </Box>
        ))}
      </Box>

      {/* Header separator */}
      <Box>
        <Text color={colors.subtle}>
          {'  '}{columns.map((_, ci) => '\u2500'.repeat(Math.max(1, colWidths[ci] - 1))).join(' ')}
        </Text>
      </Box>

      {/* Data rows */}
      {pageRows.map((row, ri) => {
        const absoluteIndex = pageOffset + ri;
        const isSelected = absoluteIndex === selected;
        return (
          <Box key={absoluteIndex}>
            {/* Selection marker */}
            <Text color={isSelected ? colors.cyberBlue : colors.subtle}>
              {isSelected ? '\u25B6 ' : '  '}
            </Text>

            {/* Cell values */}
            {columns.map((col, ci) => {
              const rawVal = row[col.key];
              const val = rawVal === null || rawVal === undefined ? '' : String(rawVal);
              return (
                <Box key={col.key} width={colWidths[ci]}>
                  <Text
                    color={isSelected ? colors.text : colors.textMuted}
                    bold={isSelected}
                  >
                    {val.length > colWidths[ci] - 1
                      ? val.slice(0, colWidths[ci] - 2) + '\u2026'
                      : val}
                  </Text>
                </Box>
              );
            })}
          </Box>
        );
      })}

      {/* Page indicator */}
      {totalPages > 1 && (
        <Box marginTop={1}>
          <Text color={colors.dim}>
            Page {currentPage + 1} of {totalPages}
            {'  '}({rows.length} items)
            {'  '}
          </Text>
          <Text color={colors.cyberBlue}>n</Text>
          <Text color={colors.dim}>/</Text>
          <Text color={colors.cyberBlue}>p</Text>
          <Text color={colors.dim}> next/prev</Text>
        </Box>
      )}
    </Box>
  );
}
