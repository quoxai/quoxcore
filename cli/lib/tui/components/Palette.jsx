/**
 * Palette — command palette overlay
 *
 * Opened from app.jsx on Ctrl+K or ':' (nav mode only). Renders in place
 * of the current screen — mirrors HelpOverlay's content-swap pattern, no
 * layout shift. Owns its own keystrokes via its own useInput while open.
 *
 * A text query filters SCREEN_REGISTRY (case-insensitive substring match
 * on title + keywords). Up/Down or Ctrl+P/Ctrl+N move the selection,
 * Enter calls onSelect(id), Esc calls onClose().
 *
 * Props:
 *   onSelect(id) - called with the chosen screen id
 *   onClose()    - called when the user dismisses the palette
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { SCREEN_REGISTRY } from '../registry.js';
import { colors } from '../theme.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

const PREFERRED_WIDTH = 56;
const MIN_WIDTH = 24;
const MAX_VISIBLE = 8;

/** Case-insensitive substring match against title + keywords. */
function filterEntries(query) {
  const q = query.trim().toLowerCase();
  if (!q) return SCREEN_REGISTRY;
  return SCREEN_REGISTRY.filter((entry) => {
    if (entry.title.toLowerCase().includes(q)) return true;
    return entry.keywords.some((kw) => kw.toLowerCase().includes(q));
  });
}

export function Palette({ onSelect, onClose }) {
  const { columns } = useTerminalSize();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);

  const results = useMemo(() => filterEntries(query), [query]);

  useInput((input, key) => {
    if (key.escape) {
      onClose?.();
      return;
    }

    if (key.return) {
      const entry = results[selected];
      if (entry) onSelect?.(entry.id);
      return;
    }

    if (key.upArrow || (key.ctrl && input === 'p')) {
      setSelected((s) => (results.length === 0 ? 0 : (s > 0 ? s - 1 : results.length - 1)));
      return;
    }

    if (key.downArrow || (key.ctrl && input === 'n')) {
      setSelected((s) => (results.length === 0 ? 0 : (s < results.length - 1 ? s + 1 : 0)));
      return;
    }

    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setSelected(0);
      return;
    }

    // Printable characters only — ignore other ctrl/meta/tab combos.
    if (input && !key.ctrl && !key.meta && !key.tab) {
      setQuery((q) => q + input);
      setSelected(0);
    }
  });

  const width = Math.max(MIN_WIDTH, Math.min(PREFERRED_WIDTH, columns - 4));

  // Keep the selected row inside the visible window as the list scrolls.
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(MAX_VISIBLE / 2), Math.max(0, results.length - MAX_VISIBLE))
  );
  const visible = results.slice(start, start + MAX_VISIBLE);

  return (
    <Box flexDirection="column" alignItems="center" width="100%" paddingTop={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={colors.primary}
        paddingX={2}
        paddingY={1}
        width={width}
      >
        {/* Header */}
        <Box justifyContent="center" marginBottom={1}>
          <Text color={colors.primary} bold>Jump to Screen</Text>
        </Box>

        {/* Query input */}
        <Box borderStyle="single" borderColor={colors.cyberBlue} paddingX={1} marginBottom={1}>
          <Text color={colors.cyberBlue} bold>{'> '}</Text>
          {query ? (
            <Text color={colors.text}>{query}</Text>
          ) : (
            <Text color={colors.dim}>Type to filter...</Text>
          )}
          <Text color={colors.cyberBlue}>{'█'}</Text>
        </Box>

        {/* Results */}
        {visible.length === 0 ? (
          <Text color={colors.dim}>No matching screens</Text>
        ) : (
          visible.map((entry, i) => {
            const isSelected = start + i === selected;
            return (
              <Box key={entry.id} height={1}>
                <Text color={isSelected ? colors.primary : colors.subtle}>
                  {isSelected ? ' ▶ ' : '   '}
                </Text>
                <Text color={colors.cyberBlue} bold>[{entry.hotkey}] </Text>
                <Text color={isSelected ? colors.text : colors.textMuted} bold={isSelected}>
                  {entry.title}
                </Text>
              </Box>
            );
          })
        )}

        {/* Footer hint */}
        <Box marginTop={1}>
          <Text color={colors.dim}>{'↑/↓'} Navigate  Enter Jump  Esc Close</Text>
        </Box>
      </Box>
    </Box>
  );
}
