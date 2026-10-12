/**
 * SearchInput — Text input for search/filter operations
 *
 * Uses @inkjs/ui TextInput when available, with a fallback
 * implementation using ink's useInput for basic text entry.
 *
 * Props:
 *   placeholder - placeholder text (default: 'Search...')
 *   value       - current search value
 *   onChange    - callback when value changes
 *   onSubmit   - callback when Enter is pressed
 *   active     - whether input accepts keyboard input (default: true)
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { colors } from '../theme.js';

// ── Try to load @inkjs/ui TextInput ────────────────────────────────────
let InkTextInput = null;
try {
  const mod = await import('@inkjs/ui');
  InkTextInput = mod.TextInput;
} catch {
  // Fallback to custom implementation below
}

/**
 * Fallback text input using useInput.
 * Handles printable characters, backspace, and Enter.
 */
function FallbackTextInput({ placeholder, value, onChange, onSubmit, active }) {
  useInput((input, key) => {
    if (!active) return;

    // Enter submits
    if (key.return) {
      if (onSubmit) onSubmit(value);
      return;
    }

    // Backspace / delete
    if (key.backspace || key.delete) {
      if (onChange && value.length > 0) {
        onChange(value.slice(0, -1));
      }
      return;
    }

    // Escape is handled by parent, not here

    // Printable characters
    if (input && !key.ctrl && !key.meta && !key.escape && !key.tab) {
      if (onChange) {
        onChange(value + input);
      }
    }
  });

  const showPlaceholder = !value || value.length === 0;

  return (
    <Box>
      <Text color={colors.cyberBlue} bold>/ </Text>
      {showPlaceholder ? (
        <Text color={colors.dim}>{placeholder}</Text>
      ) : (
        <Text color={colors.text}>{value}</Text>
      )}
      {active && <Text color={colors.cyberBlue}>{'\u2588'}</Text>}
    </Box>
  );
}

/**
 * Wrapper that uses @inkjs/ui TextInput if available.
 */
function InkUITextInput({ placeholder, value, onChange, onSubmit, active }) {
  // @inkjs/ui TextInput uses defaultValue + onChange, not controlled value.
  // We track the internal value and sync via onChange.
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    setInitialized(true);
  }, []);

  return (
    <Box>
      <Text color={colors.cyberBlue} bold>/ </Text>
      <InkTextInput
        placeholder={placeholder}
        defaultValue={value || ''}
        isDisabled={!active}
        onChange={(newVal) => {
          if (onChange) onChange(newVal);
        }}
        onSubmit={(val) => {
          if (onSubmit) onSubmit(val);
        }}
      />
    </Box>
  );
}

export function SearchInput({
  placeholder = 'Search...',
  value = '',
  onChange,
  onSubmit,
  active = true,
}) {
  const InputComponent = InkTextInput ? InkUITextInput : FallbackTextInput;

  return (
    <Box borderStyle="single" borderColor={active ? colors.cyberBlue : colors.subtle} paddingX={1}>
      <InputComponent
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        active={active}
      />
    </Box>
  );
}
