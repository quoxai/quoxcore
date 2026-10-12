/**
 * ChatInput — Presentational input line + agent picker overlay for ChatView
 *
 * Pure rendering component: ChatView owns all input state (draft text,
 * cursor position, history, agent selection) and passes it down as props.
 * Kept separate so the caret-rendering and agent-picker markup don't
 * clutter ChatView's streaming/keyboard logic.
 *
 * Props:
 *   input       - current draft text
 *   cursor      - caret index into `input` (0..input.length)
 *   disabled    - true while a response is streaming (dims the border)
 *   agents      - array of agent objects/strings for the picker list
 *   pickerOpen  - whether the agent picker overlay is visible
 *   pickerIndex - highlighted row in the picker
 */

import React from 'react';
import { Box, Text } from 'ink';
import { colors } from '../theme.js';

function agentLabel(a) {
  if (typeof a === 'string') return a;
  return a?.name || a?.display_name || a?.id || String(a);
}

export function ChatInput({
  input = '',
  cursor = 0,
  disabled = false,
  agents = [],
  pickerOpen = false,
  pickerIndex = 0,
}) {
  const safeCursor = Math.max(0, Math.min(cursor, input.length));
  const pre = input.slice(0, safeCursor);
  const rest = input.slice(safeCursor);

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" borderColor={disabled ? colors.subtle : colors.primary} paddingX={1}>
        <Text color={colors.cyberBlue}>{'> '}</Text>
        <Text>{pre}</Text>
        <Text color={colors.dim}>{'█'}</Text>
        <Text>{rest}</Text>
      </Box>

      {pickerOpen && (
        <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
          <Text color={colors.accent} bold>Select agent — Tab/↑↓ move, Enter confirm</Text>
          {agents.length === 0 ? (
            <Text color={colors.dim}>No agents found</Text>
          ) : (
            agents.map((a, i) => (
              <Text
                key={`${agentLabel(a)}-${i}`}
                color={i === pickerIndex ? colors.cyberBlue : colors.textMuted}
                bold={i === pickerIndex}
              >
                {i === pickerIndex ? '➤ ' : '  '}{agentLabel(a)}
              </Text>
            ))
          )}
        </Box>
      )}
    </Box>
  );
}
