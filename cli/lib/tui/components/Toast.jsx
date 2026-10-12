/**
 * Toast — Auto-dismissing notification component
 *
 * Shows a message at the top of the view that auto-dismisses after a timeout.
 * Supports success, error, warning, and info variants.
 *
 * Props:
 *   message  - notification text
 *   type     - 'success' | 'error' | 'warning' | 'info' (default: 'info')
 *   duration - auto-dismiss ms (default: 3000, 0 = no auto-dismiss)
 *   onDismiss- called when the toast is dismissed
 *   visible  - whether the toast is shown (default: true when message is truthy)
 */

import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import { colors } from '../theme.js';

const TYPE_CONFIG = {
  success: { color: colors.success, icon: '\u2714' },  // ✔
  error:   { color: colors.error,   icon: '\u2718' },  // ✘
  warning: { color: colors.warning, icon: '\u26A0' },  // ⚠
  info:    { color: colors.cyberBlue, icon: '\u2139' }, // ℹ
};

export function Toast({ message, type = 'info', duration = 3000, onDismiss, visible }) {
  const show = visible !== undefined ? visible : !!message;

  useEffect(() => {
    if (!show || duration <= 0) return;
    const timer = setTimeout(() => {
      onDismiss?.();
    }, duration);
    return () => clearTimeout(timer);
  }, [show, duration, onDismiss]);

  if (!show || !message) return null;

  const config = TYPE_CONFIG[type] || TYPE_CONFIG.info;

  return (
    <Box
      borderStyle="single"
      borderColor={config.color}
      paddingX={1}
      marginBottom={1}
    >
      <Text color={config.color} bold>{config.icon} </Text>
      <Text color={config.color}>{message}</Text>
    </Box>
  );
}
