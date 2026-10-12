/**
 * ToolView — Tool catalog browser
 *
 * Left panel:  DataTable of tools (name, type, category)
 * Right panel: DetailPanel with tool description and parameters
 *
 * API (org-scoped):
 *   GET /api/orgs/:orgId/tools  (service: auth) -> data.tools
 *   Tool detail comes from the list data itself (no separate endpoint needed).
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Layout } from '../components/Layout.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { DetailPanel } from '../components/DetailPanel.jsx';
import { SearchInput } from '../components/SearchInput.jsx';
import { useApi } from '../hooks/useApi.js';
import { useTui } from '../app.jsx';
import { matchKey } from '../keys.js';
import { colors } from '../theme.js';
import { resolveEndpoint } from '../../api/endpoints.js';

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Safely extract the org ID from TUI context.
 */
function getOrgId(ctx) {
  return ctx?.auth?.getUser?.()?.org_id
    || ctx?.config?.getActiveProfile?.()?.auth?.org_id
    || null;
}

// ── Column definitions ────────────────────────────────────────────────
const COLUMNS = [
  { key: 'name',     label: 'Name',     width: 22 },
  { key: 'type',     label: 'Type',     width: 14 },
  { key: 'category', label: 'Category', width: 14 },
];

/**
 * Format raw tool data into table rows.
 */
function formatRows(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => ({
    name:     t.name || t.display_name || t.id,
    type:     t.type || '--',
    category: t.category || '--',
    _raw: t,
  }));
}

/**
 * Build a detail object for the right panel.
 */
function buildDetail(raw) {
  if (!raw) return null;
  const detail = {
    'Name':        raw.name || raw.display_name,
    'ID':          raw.id,
    'Type':        raw.type,
    'Category':    raw.category,
    'Description': raw.description,
    'Version':     raw.version,
    'Enabled':     raw.enabled != null ? raw.enabled : raw.active,
    'Created':     raw.created_at,
  };

  // Parameters
  if (raw.parameters || raw.input_schema) {
    const params = raw.parameters || raw.input_schema;
    if (typeof params === 'object') {
      detail['Parameters'] = params;
    }
  }

  // Tags
  if (Array.isArray(raw.tags) && raw.tags.length > 0) {
    detail['Tags'] = raw.tags;
  }

  return detail;
}

/**
 * Filter rows by search term (matches name, type, category).
 */
function filterRows(rows, search) {
  if (!search) return rows;
  const term = search.toLowerCase();
  return rows.filter((r) =>
    (r.name || '').toLowerCase().includes(term) ||
    (r.type || '').toLowerCase().includes(term) ||
    (r.category || '').toLowerCase().includes(term)
  );
}

// ── Component ─────────────────────────────────────────────────────────
export function ToolView() {
  const ctx = useTui();
  const { client, screen, setInputMode, orgVersion } = ctx;
  const isActive = screen === 'tools';
  const orgId = getOrgId(ctx);

  const [selected, setSelected] = useState(0);
  const [search, setSearch] = useState('');
  const [searchActive, setSearchActive] = useState(false);

  // ── Input-mode registry: claim 'input' while the search box is
  // focused so global shortcuts (e.g. '?') don't steal keystrokes.
  useEffect(() => {
    if (searchActive) setInputMode?.('input');
    else if (isActive) setInputMode?.('nav');
  }, [searchActive, isActive, setInputMode]);

  // ── Data fetching (refetches when the active org changes) ───────────
  const { data, loading, error, refresh } = useApi(
    async () => {
      if (!orgId) return [];
      const res = await client.get(resolveEndpoint('tools.list', { orgId }).path, { service: resolveEndpoint('tools.list', { orgId }).service });
      return res?.tools || [];
    },
    [client, orgId, orgVersion]
  );

  const allRows = formatRows(data);
  const rows = filterRows(allRows, search);
  const selectedRow = rows[selected];
  const detail = selectedRow ? buildDetail(selectedRow._raw) : null;

  // ── Keyboard handling ──────────────────────────────────────────────
  useInput((input, key) => {
    if (!isActive) return;

    // Toggle search focus
    if (matchKey('search', input, key) && !searchActive) {
      setSearchActive(true);
      return;
    }

    // Escape from search
    if (searchActive && matchKey('back', input, key)) {
      setSearchActive(false);
      return;
    }

    if (searchActive) return; // Let SearchInput handle keys

    // Manual refresh
    if (matchKey('refresh', input, key)) {
      refresh();
      return;
    }
  }, { isActive });

  // ── Reset selection when search changes ────────────────────────────
  const handleSearchChange = (val) => {
    setSearch(val);
    setSelected(0);
  };

  // ── Footer hint ────────────────────────────────────────────────────
  const footer = searchActive
    ? 'Type to filter  Esc Cancel search'
    : [
        '\u2191/k \u2193/j Navigate',
        '/ Search',
        'r Refresh',
        'Esc Back',
      ].join('  ');

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <Layout
      title="Tools"
      subtitle={orgId ? `${rows.length} tools` : '(no org)'}
      footer={footer}
      left={
        <Box flexDirection="column">
          {/* Search bar */}
          <Box marginBottom={1}>
            <SearchInput
              placeholder="Filter tools..."
              value={search}
              onChange={handleSearchChange}
              active={searchActive}
            />
          </Box>

          {error && (
            <Box marginBottom={1}>
              <Text color={colors.error}>Error: {error.message}</Text>
            </Box>
          )}
          {!orgId && !loading && (
            <Box marginBottom={1}>
              <Text color={colors.warning}>No organization selected.</Text>
            </Box>
          )}
          <DataTable
            columns={COLUMNS}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            loading={loading}
            emptyMessage={search ? `No tools match "${search}" — press Esc to clear the filter` : 'No tools installed — add one via `quox tool create` or `quox tool install`'}
            active={isActive && !searchActive}
          />
        </Box>
      }
      right={
        <DetailPanel
          title={selectedRow ? (selectedRow._raw.name || selectedRow._raw.id) : undefined}
          data={detail}
        />
      }
    />
  );
}
