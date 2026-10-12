/**
 * Breadcrumb — Navigation trail showing current position
 *
 * Renders a breadcrumb path like: Main > Fleet > Agent Details
 * where the last segment is highlighted in the primary color
 * and preceding segments are dimmed.
 *
 * Props:
 *   path - array of strings, e.g. ['Main', 'Fleet', 'Agent Details']
 */

import React from 'react';
import { Box, Text } from 'ink';
import { colors } from '../theme.js';

export function Breadcrumb({ path = [] }) {
  if (path.length === 0) return null;

  return (
    <Box>
      {path.map((segment, i) => {
        const isLast = i === path.length - 1;
        return (
          <React.Fragment key={i}>
            {/* Separator */}
            {i > 0 && (
              <Text color={colors.dim}> {'>'} </Text>
            )}

            {/* Segment */}
            <Text
              color={isLast ? colors.primary : colors.dim}
              bold={isLast}
            >
              {segment}
            </Text>
          </React.Fragment>
        );
      })}
    </Box>
  );
}
