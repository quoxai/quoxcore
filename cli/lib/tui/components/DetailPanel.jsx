/**
 * DetailPanel — Scrollable key-value display for the right panel
 *
 * Shows properties of a selected item as labeled key-value pairs.
 * Handles nested objects (JSON.stringify) and arrays (join with ', ').
 *
 * When content exceeds the available vertical space (derived from
 * useTerminalSize().rows, or the `maxHeight` prop), the panel renders a
 * windowed slice of its content lines instead of silently overflowing, and
 * shows a scroll indicator (`▲ N more` / `▼ N more`) for whatever is
 * hidden off-screen.
 *
 * Props:
 *   data      - object to display (keys become labels, values become text)
 *   title     - optional heading string
 *   loading   - show spinner when true
 *   focused   - when true, the panel handles Up/Down/k/j/PgUp/PgDn itself
 *               to move the scroll offset (default: false — content is
 *               top-anchored, clamped, with an overflow hint if needed)
 *   maxHeight - override the auto-derived (terminal-size-based) viewport
 *               height used for windowing
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
import { matchKey } from '../keys.js';
import { colors } from '../theme.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

// Rows reserved for title/borders/scroll-indicator when deriving viewport height.
const CHROME_ROWS = 6;
// Minimum viewport height when deriving from a short terminal.
const MIN_HEIGHT = 5;

/**
 * Format a key string into a readable label.
 * Converts camelCase and snake_case to Title Case.
 */
function formatLabel(key) {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Format a value for display.
 * - null/undefined => dim dash
 * - arrays => comma-separated
 * - objects => JSON string
 * - booleans => Yes/No with color
 * - everything else => string
 */
function formatValue(value) {
  if (value === null || value === undefined) {
    return { text: '—', color: colors.dim };
  }

  if (typeof value === 'boolean') {
    return {
      text: value ? 'Yes' : 'No',
      color: value ? colors.success : colors.dim,
    };
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return { text: '(empty)', color: colors.dim };
    return { text: value.join(', '), color: colors.text };
  }

  if (typeof value === 'object') {
    try {
      return { text: JSON.stringify(value, null, 2), color: colors.textMuted };
    } catch {
      return { text: String(value), color: colors.textMuted };
    }
  }

  return { text: String(value), color: colors.text };
}

/**
 * Flatten data entries into a linear list of renderable "lines" so the
 * panel can window/scroll through them regardless of whether an entry is a
 * single inline row or a multi-line JSON block.
 */
function buildLines(entries) {
  const lines = [];

  for (const [key, value] of entries) {
    const { text, color } = formatValue(value);
    const label = formatLabel(key);
    const isBlock = typeof value === 'object' && value !== null && !Array.isArray(value);

    if (isBlock) {
      lines.push({ id: `${key}:label`, kind: 'label', label: `${label}:` });
      text.split('\n').forEach((jsonLine, i) => {
        lines.push({ id: `${key}:${i}`, kind: 'block', text: jsonLine, color });
      });
    } else {
      lines.push({ id: key, kind: 'inline', label: `${label}: `, text, color });
    }
  }

  return lines;
}

export function DetailPanel({ data, title, loading = false, focused = false, maxHeight }) {
  const { rows: termRows } = useTerminalSize();
  const viewportHeight = maxHeight != null
    ? maxHeight
    : Math.max(MIN_HEIGHT, termRows - CHROME_ROWS);

  const entries = useMemo(() => (data ? Object.entries(data) : []), [data]);
  const lines = useMemo(() => buildLines(entries), [entries]);

  const total = lines.length;
  const needsScroll = total > viewportHeight;
  const maxOffset = needsScroll ? total - viewportHeight : 0;

  const [offset, setOffset] = useState(0);

  // Reset scroll position whenever the underlying data changes.
  useEffect(() => {
    setOffset(0);
  }, [data]);

  // Clamp if the viewport grew (e.g. terminal resize) past the current offset.
  useEffect(() => {
    setOffset((o) => Math.min(o, maxOffset));
  }, [maxOffset]);

  useInput((input, key) => {
    if (!focused || !needsScroll) return;

    if (matchKey('down', input, key)) {
      setOffset((o) => Math.min(maxOffset, o + 1));
      return;
    }
    if (matchKey('up', input, key)) {
      setOffset((o) => Math.max(0, o - 1));
      return;
    }
    if (key.pageDown) {
      setOffset((o) => Math.min(maxOffset, o + viewportHeight));
      return;
    }
    if (key.pageUp) {
      setOffset((o) => Math.max(0, o - viewportHeight));
      return;
    }
  });

  // ── Loading state ───────────────────────────────────────────────────
  if (loading) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Spinner label="Loading details..." />
      </Box>
    );
  }

  // ── Empty state ─────────────────────────────────────────────────────
  if (!data) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color={colors.dim}>No item selected</Text>
      </Box>
    );
  }

  const visibleLines = needsScroll ? lines.slice(offset, offset + viewportHeight) : lines;
  // Gate on needsScroll, not just offset>0: `offset` state can be briefly
  // stale for one render after `data` changes (before the reset effect
  // runs), and without this guard that stale offset would flash a false
  // "more above" hint even though the new content fits without scrolling.
  const hiddenAbove = needsScroll ? offset : 0;
  const hiddenBelow = needsScroll ? total - (offset + visibleLines.length) : 0;

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column">
      {/* Title */}
      {title && (
        <Box marginBottom={1}>
          <Text color={colors.accent} bold>
            {title}
          </Text>
        </Box>
      )}

      {/* Scroll-up indicator */}
      {hiddenAbove > 0 && (
        <Box>
          <Text color={colors.dim}>{'▲'} {hiddenAbove} more</Text>
        </Box>
      )}

      {/* Windowed key-value lines */}
      {visibleLines.map((line, _i) => {
        if (line.kind === 'label') {
          return (
            <Box key={`${line.id}-${_i}`}>
              <Text color={colors.textMuted} bold>
                {line.label}
              </Text>
            </Box>
          );
        }
        if (line.kind === 'block') {
          return (
            <Box key={`${line.id}-${_i}`} marginLeft={2}>
              <Text color={line.color}>{line.text}</Text>
            </Box>
          );
        }
        return (
          <Box key={`${line.id}-${_i}`}>
            <Text color={colors.textMuted} bold>
              {line.label}
            </Text>
            <Text color={line.color}>{line.text}</Text>
          </Box>
        );
      })}

      {/* Scroll-down indicator */}
      {hiddenBelow > 0 && (
        <Box>
          <Text color={colors.dim}>{'▼'} {hiddenBelow} more</Text>
        </Box>
      )}

      {/* Empty data object */}
      {entries.length === 0 && (
        <Text color={colors.dim}>No properties to display</Text>
      )}
    </Box>
  );
}
