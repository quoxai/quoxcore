/**
 * Main Menu — top-level navigation for the TUI
 *
 * 10 sections covering all CLI capabilities.
 * Supports vim-style navigation (j/k), number keys, and Enter to select.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { colors } from '../theme.js';
import { matchKey } from '../keys.js';
import { useTui } from '../app.jsx';
import { IntroHeader } from '../intro/Intro.jsx';

const MENU_ITEMS = [
  { key: '1', id: 'fleet',     label: 'Fleet',         desc: 'Fleet status, agent health, tool execution', icon: '\u25C8' },
  { key: '2', id: 'agents',    label: 'Agents',        desc: 'Agent management, activate/deactivate, tools', icon: '\u2726' },
  { key: '3', id: 'tools',     label: 'Tools',         desc: 'Tool catalog, install, manage',               icon: '\u2692' },
  { key: '4', id: 'orgs',      label: 'Organizations', desc: 'Org management, members, divisions, switch',  icon: '\u2616' },
  { key: '5', id: 'memory',    label: 'Memory',        desc: 'Memory, entities, conversations, search',     icon: '\u29BE' },
  { key: 'b', id: 'brain',     label: 'Brain',         desc: 'Quox Qortex: search notes, vaults, growth',   icon: '\u2B22' },
  { key: '6', id: 'workflows', label: 'Workflows',     desc: 'Workflow CRUD, run, steps, versions',         icon: '\u2B82' },
  { key: '7', id: 'chat',      label: 'Chat',          desc: 'Interactive CommanderQ chat',                  icon: '\u276F' },
  { key: '8', id: 'admin',     label: 'Admin',         desc: 'Config, API keys, services, logs, retention', icon: '\u2699' },
  { key: '9', id: 'files',     label: 'Files',         desc: 'File upload, download, list, delete',         icon: '\u2630' },
  { key: '0', id: 'backups',   label: 'Backups',       desc: 'Backup/restore, verify, schedules',           icon: '\u29C9' },
  { key: 'o', id: 'objectives', label: 'Objectives',   desc: 'Autonomous goals: plan, approve, start, track', icon: '\u25CE' },
  { key: 'i', id: 'inbox',      label: 'Inbox',        desc: 'HITL approvals: review, approve, deny',        icon: '\u2709' },
  { key: 'v', id: 'vault',      label: 'Vault',        desc: 'Credentials: list, test, expiry, activity',    icon: '\u26BF' },
  { key: 'g', id: 'governance', label: 'Governance',   desc: 'WARD chain, VOLT evidence, policies, approvals', icon: '\u2696' },
  { key: 'h', id: 'health',     label: 'Health',       desc: 'Live service health, incidents, sparklines',   icon: '\u271a' },
];

export function MainMenu() {
  const { navigate, screen } = useTui();
  const [selected, setSelected] = useState(0);

  // MainMenu is kept alive (mounted permanently) once the app starts, so
  // it must gate its own input on isActive — otherwise its number-key /
  // vim-nav / Enter handling would also fire while a sub-view is active
  // and hidden (e.g. pressing Enter to send a chat message would also
  // "select" whatever menu item was last highlighted).
  const isActive = (screen ?? 'menu') === 'menu';

  useInput((input, key) => {
    // Number keys for quick navigation
    const byKey = MENU_ITEMS.find((item) => item.key === input);
    if (byKey) {
      navigate(byKey.id);
      return;
    }

    // Vim / arrow navigation
    if (matchKey('up', input, key)) {
      setSelected((s) => (s > 0 ? s - 1 : MENU_ITEMS.length - 1));
      return;
    }
    if (matchKey('down', input, key)) {
      setSelected((s) => (s < MENU_ITEMS.length - 1 ? s + 1 : 0));
      return;
    }

    // Enter to select
    if (matchKey('select', input, key)) {
      navigate(MENU_ITEMS[selected].id);
      return;
    }
  }, { isActive });

  return (
    <Box flexDirection="column" paddingX={2} paddingY={0}>
      {/* Animated intro header: orb + block title + subtitle */}
      <IntroHeader />

      {/* Menu items */}
      <Box flexDirection="column" marginTop={1}>
        {MENU_ITEMS.map((item, i) => {
          const isSelected = i === selected;
          return (
            <Box key={item.id} height={1}>
              {/* Selection indicator */}
              <Text color={isSelected ? colors.primary : colors.subtle}>
                {isSelected ? ' \u25B6 ' : '   '}
              </Text>

              {/* Number key */}
              <Text color={colors.cyberBlue} bold>
                [{item.key}]
              </Text>

              {/* Icon */}
              <Text color={isSelected ? colors.accent : colors.dim}>
                {' '}{item.icon}{' '}
              </Text>

              {/* Label */}
              <Text color={isSelected ? colors.text : colors.textMuted} bold={isSelected}>
                {item.label.padEnd(16)}
              </Text>

              {/* Description */}
              <Text color={colors.dim}>
                {item.desc}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Footer hints */}
      <Box marginTop={1}>
        <Text color={colors.dim}>
          {' \u2191/k \u2193/j'} Navigate  {'  '}
          {'Enter'} Select  {'  '}
          {'1-0 / o i v g'} Quick access  {'  '}
          {'q'} Quit
        </Text>
      </Box>
    </Box>
  );
}

export { MENU_ITEMS };
