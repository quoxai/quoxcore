/**
 * Status bar — bottom of the TUI
 *
 * Shows: user email, active org, profile name, current screen, a live
 * service-health dot (polled every 30s), a refresh/staleness indicator,
 * a clock, and key hints.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { colors } from '../theme.js';
import { useTui } from '../app.jsx';
import { useHealth } from '../hooks/useHealth.js';

// Display labels for each navigable screen id (see MainMenu.jsx MENU_ITEMS).
const SCREEN_LABELS = {
  menu: 'Menu',
  fleet: 'Fleet',
  agents: 'Agents',
  tools: 'Tools',
  orgs: 'Organizations',
  memory: 'Memory',
  brain: 'Brain',
  workflows: 'Workflows',
  chat: 'Chat',
  admin: 'Admin',
  files: 'Files',
  backups: 'Backups',
  objectives: 'Objectives',
  inbox: 'Inbox',
  vault: 'Vault',
  governance: 'Governance',
};

const HEALTH_DOT_COLORS = {
  green: colors.success,
  amber: colors.warning,
  red: colors.error,
  grey: colors.dim,
};

function formatClock(date) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatAge(lastFetched, isStale) {
  if (lastFetched == null) return '';
  if (isStale) return 'stale';
  const secs = Math.max(0, Math.floor((Date.now() - lastFetched) / 1000));
  return `${secs}s`;
}

export function StatusBar() {
  const ctx = useTui();
  const config = ctx?.config;
  const client = ctx?.client;
  const screen = ctx?.screen || '';

  // Try to extract user/org info from auth store
  let userEmail = '';
  let orgName = '';
  let profileName = '';

  try {
    const profile = config?.getActiveProfile?.();
    userEmail = profile?.auth?.email || profile?.auth?.user_email || '';
    orgName = profile?.auth?.org_name || profile?.auth?.org_slug || '';
    profileName = config?.getActiveProfileName?.() || '';
  } catch {
    // Config might not be loaded
  }

  const { color: healthColor, loading: healthLoading, lastFetched, isStale } = useHealth(client);

  // Clock — recomputed on a 30s tick (no 1s timer).
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);

  const screenLabel = SCREEN_LABELS[screen] ?? (screen || '');
  const ageText = formatAge(lastFetched, isStale);
  const dotColor = HEALTH_DOT_COLORS[healthColor] || HEALTH_DOT_COLORS.grey;

  return (
    <Box height={1} width="100%">
      <Box flexGrow={1}>
        <Text color={colors.primary} bold> QUOX</Text>
        {screenLabel && (
          <>
            <Text color={colors.dim}> | </Text>
            <Text color={colors.accent} bold>{screenLabel}</Text>
          </>
        )}
        <Text color={colors.dim}> | </Text>
        {userEmail ? (
          <>
            <Text color={colors.text}>{userEmail}</Text>
            <Text color={colors.dim}> | </Text>
          </>
        ) : (
          <>
            <Text color={colors.warning}>not logged in</Text>
            <Text color={colors.dim}> | </Text>
          </>
        )}
        {orgName && (
          <>
            <Text color={colors.accent}>{orgName}</Text>
            <Text color={colors.dim}> | </Text>
          </>
        )}
        {profileName && (
          <Text color={colors.dim}>{profileName}</Text>
        )}
      </Box>
      <Box>
        {healthLoading && <Text color={colors.dim}>{'⟳ '}</Text>}
        <Text color={dotColor}>{'●'}</Text>
        {ageText && (
          <Text color={isStale ? colors.warning : colors.dim}> {ageText}</Text>
        )}
        <Text color={colors.dim}>  {formatClock(now)}  </Text>
        <Text color={colors.dim}>
          {screen === 'menu' ? 'q:quit  ?:help' : 'Esc:back  ?:help  q:quit'}
        </Text>
      </Box>
    </Box>
  );
}
