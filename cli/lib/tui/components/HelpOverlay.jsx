/**
 * HelpOverlay — Keybinding reference overlay
 *
 * Renders on top of the current view when `?` is pressed.
 * Shows all keybindings organized in a clean layout.
 * Press `?` or `Esc` to dismiss.
 *
 * Props:
 *   visible  - whether the overlay is shown
 *   onClose  - called when user dismisses (? or Esc)
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { KEY_HELP } from '../keys.js';
import { colors } from '../theme.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

// Preferred overlay width; clamped down on narrow terminals.
const PREFERRED_WIDTH = 44;
const MIN_WIDTH = 20;

export function HelpOverlay({ visible = false, onClose }) {
  const { columns } = useTerminalSize();

  useInput((input, key) => {
    if (!visible) return;
    if (input === '?' || key.escape) {
      onClose?.();
    }
  }, { isActive: visible });

  if (!visible) return null;

  const width = Math.max(MIN_WIDTH, Math.min(PREFERRED_WIDTH, columns - 4));

  return (
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
        <Text color={colors.primary} bold>Keyboard Shortcuts</Text>
      </Box>

      {/* Key entries */}
      {KEY_HELP.map((entry, i) => (
        <Box key={i} marginBottom={0}>
          <Box width={14}>
            <Text color={colors.cyberBlue} bold>{entry.keys}</Text>
          </Box>
          <Text color={colors.textMuted}>{entry.desc}</Text>
        </Box>
      ))}

      {/* Dismiss hint */}
      <Box marginTop={1} justifyContent="center">
        <Text color={colors.dim}>Press ? or Esc to close</Text>
      </Box>
    </Box>
  );
}
