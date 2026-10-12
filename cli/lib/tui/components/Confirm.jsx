/**
 * Confirm — Confirmation dialog component
 *
 * Shows an inline confirmation prompt with y/n keybindings.
 *
 * Props:
 *   message   - question text (e.g. "Delete backup XYZ?")
 *   onConfirm - called when user presses y
 *   onCancel  - called when user presses n or Esc
 *   active    - whether dialog is shown/active (default true)
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { colors } from '../theme.js';

export function Confirm({ message, onConfirm, onCancel, active = true }) {
  useInput((input, key) => {
    if (!active) return;
    if (input === 'y' || input === 'Y') { onConfirm?.(); return; }
    if (input === 'n' || input === 'N' || key.escape) { onCancel?.(); return; }
  }, { isActive: active });

  if (!active) return null;

  return (
    <Box borderStyle="single" borderColor={colors.warning} paddingX={2} paddingY={1}>
      <Text color={colors.warning}>{message} </Text>
      <Text color={colors.dim}>(y/n)</Text>
    </Box>
  );
}
