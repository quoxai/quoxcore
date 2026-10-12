/**
 * OrgView — Organization management view
 *
 * Left panel:  DataTable of orgs (name, slug, members count)
 * Right panel: DetailPanel with org detail (owner, plan, created)
 *
 * Features:
 *   - `s` key switches active org (updates config)
 *   - Shows current org with a marker in the table
 *
 * API:
 *   GET /api/orgs  (service: auth) -> data.orgs or data.organizations
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { Layout } from '../components/Layout.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { DetailPanel } from '../components/DetailPanel.jsx';
import { useApi } from '../hooks/useApi.js';
import { useTui } from '../app.jsx';
import { matchKey } from '../keys.js';
import { colors } from '../theme.js';
import { resolveEndpoint } from '../../api/endpoints.js';

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Safely extract the current org ID from TUI context.
 */
function getOrgId(ctx) {
  return ctx?.auth?.getUser?.()?.org_id
    || ctx?.config?.getActiveProfile?.()?.auth?.org_id
    || null;
}

// ── Column definitions ────────────────────────────────────────────────
const COLUMNS = [
  { key: 'marker',  label: ' ',       width: 3 },
  { key: 'name',    label: 'Name',    width: 22 },
  { key: 'slug',    label: 'Slug',    width: 16 },
  { key: 'members', label: 'Members', width: 10 },
];

/**
 * Format raw org data into table rows.
 * Marks the currently active org with a star.
 */
function formatRows(orgs, currentOrgId) {
  if (!Array.isArray(orgs)) return [];
  return orgs.map((o) => {
    const id = o.id || o.org_id;
    const isCurrent = id === currentOrgId;
    return {
      marker:  isCurrent ? '\u2605' : ' ',
      name:    o.name || o.display_name || id,
      slug:    o.slug || '--',
      members: o.member_count != null
        ? String(o.member_count)
        : (Array.isArray(o.members) ? String(o.members.length) : '--'),
      _raw: o,
      _isCurrent: isCurrent,
    };
  });
}

/**
 * Build a detail object for the right panel.
 */
function buildDetail(raw, isCurrent) {
  if (!raw) return null;
  return {
    'Name':         raw.name || raw.display_name,
    'ID':           raw.id || raw.org_id,
    'Slug':         raw.slug,
    'Owner':        raw.owner || raw.owner_email || raw.owner_id,
    'Plan':         raw.plan || raw.subscription || '--',
    'Members':      raw.member_count != null
      ? raw.member_count
      : (Array.isArray(raw.members) ? raw.members.length : '--'),
    'Active Org':   isCurrent,
    'Created':      raw.created_at,
    'Updated':      raw.updated_at,
    'Description':  raw.description,
  };
}

/**
 * Merge an `auth.switch-org` response into the stored auth blob — the shared
 * contract with `quox org switch`. The response carries the new org's info and
 * (critically) an org-scoped access_token; persisting only a local org_id
 * without this token leaves the OLD org's token in place. Exported for tests.
 */
export function mergeSwitchedOrgAuth(prevAuth, data, fallbackOrgId) {
  const authData = { ...(prevAuth || {}) };
  if (data?.org) {
    authData.org_id = data.org.id;
    authData.org_name = data.org.name;
    authData.org_slug = data.org.slug;
    authData.org_role = data.role;
  } else {
    authData.org_id = fallbackOrgId;
  }
  if (data?.access_token) authData.access_token = data.access_token;
  return authData;
}

// ── Component ─────────────────────────────────────────────────────────
export function OrgView() {
  const ctx = useTui();
  const { client, config, screen, onOrgChange } = ctx;
  const isActive = screen === 'orgs';
  const currentOrgId = getOrgId(ctx);

  const [selected, setSelected] = useState(0);
  const [actionMsg, setActionMsg] = useState(null);

  // ── Data fetching ───────────────────────────────────────────────────
  const { data, loading, error, refresh } = useApi(
    async () => {
      const res = await client.get(resolveEndpoint('orgs.list').path, { service: resolveEndpoint('orgs.list').service });
      return res?.orgs || res?.organizations || [];
    },
    [client]
  );

  const rows = formatRows(data, currentOrgId);
  const selectedRow = rows[selected];
  const detail = selectedRow
    ? buildDetail(selectedRow._raw, selectedRow._isCurrent)
    : null;

  // ── Switch active org ──────────────────────────────────────────────
  const switchOrg = useCallback(async () => {
    if (!selectedRow) return;
    const raw = selectedRow._raw;
    const newOrgId = raw.id || raw.org_id;

    if (newOrgId === currentOrgId) {
      setActionMsg('Already the active org');
      setTimeout(() => setActionMsg(null), 2000);
      return;
    }

    setActionMsg('Switching…');
    try {
      // Mirror `quox org switch`: POST switch-org to obtain the org-scoped
      // access_token + canonical org info, then persist BOTH. The old code
      // only poked a local org_id, leaving the previous org's token in place
      // so every subsequent refetch hit the new org with the wrong token.
      const ep = resolveEndpoint('auth.switch-org');
      const data = await client.post(ep.path, { service: ep.service, body: { org_id: newOrgId } });
      const nextAuth = mergeSwitchedOrgAuth(config?.getAuth?.(), data, newOrgId);
      config?.setAuth?.(nextAuth);

      setActionMsg(`Switched to ${data?.org?.name || raw.name || newOrgId}`);
      refresh();
      // Notify org-scoped views so they refetch against the new org.
      onOrgChange?.();
    } catch (err) {
      setActionMsg(`Failed to switch: ${err.message}`);
    }

    setTimeout(() => setActionMsg(null), 3000);
  }, [selectedRow, currentOrgId, client, config, refresh, onOrgChange]);

  // ── Keyboard handling ──────────────────────────────────────────────
  useInput((input, key) => {
    if (!isActive) return;

    // Switch org
    if (input === 's') {
      switchOrg();
      return;
    }

    // Manual refresh
    if (matchKey('refresh', input, key)) {
      refresh();
      return;
    }
  }, { isActive });

  // ── Footer hint ────────────────────────────────────────────────────
  const footer = [
    '\u2191/k \u2193/j Navigate',
    's Switch org',
    'r Refresh',
    'Esc Back',
  ].join('  ');

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <Layout
      title="Organizations"
      subtitle={currentOrgId ? `active: ${currentOrgId}` : '(none active)'}
      footer={footer}
      left={
        <Box flexDirection="column">
          {error && (
            <Box marginBottom={1}>
              <Text color={colors.error}>Error: {error.message}</Text>
            </Box>
          )}
          {actionMsg && (
            <Box marginBottom={1}>
              <Text color={colors.info}>{actionMsg}</Text>
            </Box>
          )}
          <DataTable
            columns={COLUMNS}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            loading={loading}
            emptyMessage="No organizations — create one via `quox org create`"
            active={isActive}
          />
        </Box>
      }
      right={
        <DetailPanel
          title={selectedRow ? (selectedRow._raw.name || 'Organization') : undefined}
          data={detail}
        />
      }
    />
  );
}
