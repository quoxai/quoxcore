/**
 * Layout component — header + dual-panel + status bar
 *
 * Provides the two-panel layout (35% left / 65% right) used by most views.
 * Mirrors the QuoxBastion BubbleTea TUI layout pattern.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { colors } from '../theme.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useTui } from '../app.jsx';
import { Breadcrumb } from './Breadcrumb.jsx';
import { SCREEN_TITLES } from '../registry.js';

/** Separator width: fills the terminal, with a small margin, floor of 20. */
function separatorWidth(columns) {
  return Math.max(20, columns - 2);
}

/**
 * Build the breadcrumb trail from nav history + the current screen, e.g.
 * ['Main', 'Fleet']. Renders nothing (via Breadcrumb's own empty-path
 * guard) when the trail is trivial — i.e. we're still on the menu.
 */
function useBreadcrumbPath() {
  const ctx = useTui();
  const screen = ctx?.screen;
  const history = ctx?.history || [];

  if (!screen || screen === 'menu') return [];

  return [...history, screen].map((id) => SCREEN_TITLES[id] || id);
}

export function Layout({ title, subtitle, left, right, footer, children }) {
  const { columns } = useTerminalSize();
  const breadcrumbPath = useBreadcrumbPath();

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* Header */}
      <Box height={1} width="100%">
        <Text color={colors.primary} bold> {title || 'QuoxCLI'}</Text>
        {subtitle && (
          <Text color={colors.dim}> {subtitle}</Text>
        )}
        {breadcrumbPath.length > 0 && (
          <Box marginLeft={2}>
            <Breadcrumb path={breadcrumbPath} />
          </Box>
        )}
      </Box>

      {/* Separator */}
      <Box height={1} width="100%">
        <Text color={colors.subtle}>{' ' + '\u2500'.repeat(separatorWidth(columns))}</Text>
      </Box>

      {/* Content area */}
      <Box flexGrow={1} width="100%">
        {children ? (
          children
        ) : (
          <>
            {/* Left panel (35%) */}
            <Box width="35%" flexDirection="column" borderStyle="single" borderColor={colors.primary} paddingX={1}>
              {left}
            </Box>

            {/* Right panel (65%) */}
            <Box width="65%" flexDirection="column" borderStyle="single" borderColor={colors.subtle} paddingX={1}>
              {right}
            </Box>
          </>
        )}
      </Box>

      {/* Footer hint bar */}
      {footer && (
        <Box height={1} width="100%">
          <Text color={colors.dim}> {footer}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Single-panel layout for views like Chat that need full width.
 */
export function FullLayout({ title, subtitle, footer, children }) {
  const { columns } = useTerminalSize();
  const breadcrumbPath = useBreadcrumbPath();

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* Header */}
      <Box height={1} width="100%">
        <Text color={colors.primary} bold> {title || 'QuoxCLI'}</Text>
        {subtitle && (
          <Text color={colors.dim}> {subtitle}</Text>
        )}
        {breadcrumbPath.length > 0 && (
          <Box marginLeft={2}>
            <Breadcrumb path={breadcrumbPath} />
          </Box>
        )}
      </Box>

      {/* Separator */}
      <Box height={1} width="100%">
        <Text color={colors.subtle}>{' ' + '\u2500'.repeat(separatorWidth(columns))}</Text>
      </Box>

      {/* Content */}
      <Box flexGrow={1} flexDirection="column" paddingX={1}>
        {children}
      </Box>

      {/* Footer */}
      {footer && (
        <Box height={1} width="100%">
          <Text color={colors.dim}> {footer}</Text>
        </Box>
      )}
    </Box>
  );
}
