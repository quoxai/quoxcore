/**
 * BrainView — Quox Qortex search screen
 *
 * Left panel:  status header (note count + milestone) + search box +
 *              DataTable of search results
 * Right panel: DetailPanel for the selected result
 *
 * Features:
 *   - `/` key focuses the search input
 *   - Search posts to the brain semantic/keyword search API
 *   - Result detail shows title, kind, vault, snippet, score
 *
 * API:
 *   GET  /brain/status  (service: quoxbrain) -> { noteCount, sources, status, milestone }
 *   POST /brain/search  (service: quoxbrain, body: { query, limit }) -> { results, tookMs }
 */

import React, { useState, useCallback, useEffect } from 'react';
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

// ── Column definitions ────────────────────────────────────────────────
const RESULT_COLUMNS = [
  { key: 'title',   label: 'Title',   width: 26 },
  { key: 'kind',    label: 'Kind',    width: 12 },
  { key: 'snippet', label: 'Snippet', width: 32 },
];

// ── Row formatters ────────────────────────────────────────────────────

function formatResultRows(results) {
  if (!Array.isArray(results)) return [];
  return results.map((r) => ({
    title:   truncate(r.title || r.noteId || 'Untitled', 24),
    kind:    r.kind || '--',
    snippet: truncate(r.snippet || '', 30),
    _raw: r,
  }));
}

function buildResultDetail(raw) {
  if (!raw) return null;
  return {
    'Title':   raw.title,
    'Kind':    raw.kind,
    'Vault':   raw.vaultId,
    'Path':    raw.relPath,
    'Heading': raw.headingPath,
    'Score':   raw.score != null ? raw.score.toFixed(2) : undefined,
    'Snippet': raw.snippet,
    'Updated': raw.updatedAt,
    'Note ID': raw.noteId,
  };
}

// ── Utility ───────────────────────────────────────────────────────────

function truncate(str, max) {
  if (!str) return '';
  const s = String(str).replace(/\n/g, ' ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function formatMilestone(status) {
  if (!status) return '';
  const parts = [];
  if (status.noteCount != null) parts.push(`${status.noteCount} notes`);
  if (status.milestone) parts.push(status.milestone);
  return parts.join('  |  ');
}

// ── Component ─────────────────────────────────────────────────────────
export function BrainView() {
  const ctx = useTui();
  const { client, screen, setInputMode, orgVersion } = ctx;
  const isActive = screen === 'brain';

  const [selected, setSelected] = useState(0);
  const [search, setSearch] = useState('');
  const [searchActive, setSearchActive] = useState(false);

  // ── Input-mode registry: claim 'input' while the search box is
  // focused so global shortcuts (e.g. '?') don't steal keystrokes.
  useEffect(() => {
    if (searchActive) setInputMode?.('input');
    else if (isActive) setInputMode?.('nav');
  }, [searchActive, isActive, setInputMode]);

  // ── Fetch brain status (note count + milestone) ──────────────────────
  const { data: statusData, loading: statusLoading, refresh: refreshStatus } = useApi(
    async () => {
      const res = await client.get(resolveEndpoint('brain.status.list').path, {
        service: resolveEndpoint('brain.status.list').service,
      });
      return res || null;
    },
    [client, orgVersion]
  );

  // ── Fetch search results (only when a query has been submitted) ─────
  const { data: resultsData, loading: resultsLoading, error: resultsError, refresh: refreshResults } = useApi(
    async () => {
      if (!search) return [];
      const res = await client.post(resolveEndpoint('brain.search.list').path, {
        service: resolveEndpoint('brain.search.list').service,
        body: { query: search, limit: 20 },
      });
      return res?.results || [];
    },
    [client, search, orgVersion]
  );

  const rows = formatResultRows(resultsData);
  const detail = rows[selected] ? buildResultDetail(rows[selected]._raw) : null;

  // ── Reset selection when results change ─────────────────────────────
  useEffect(() => {
    setSelected(0);
  }, [resultsData]);

  // ── Search submit ───────────────────────────────────────────────────
  const handleSearchSubmit = useCallback(() => {
    setSearchActive(false);
    setSelected(0);
    refreshResults();
  }, [refreshResults]);

  // ── Refresh all ─────────────────────────────────────────────────────
  const refreshAll = useCallback(() => {
    refreshStatus();
    refreshResults();
  }, [refreshStatus, refreshResults]);

  // ── Keyboard handling ──────────────────────────────────────────────
  useInput((input, key) => {
    if (!isActive) return;

    // Focus search
    if (matchKey('search', input, key) && !searchActive) {
      setSearchActive(true);
      return;
    }

    // Escape from search
    if (searchActive && matchKey('back', input, key)) {
      setSearchActive(false);
      return;
    }

    // Let SearchInput handle keys when focused
    if (searchActive) return;

    // Manual refresh
    if (matchKey('refresh', input, key)) {
      refreshAll();
      return;
    }
  }, { isActive });

  // ── Footer hint ────────────────────────────────────────────────────
  const footer = searchActive
    ? 'Type to search  Enter Submit  Esc Cancel'
    : [
        '↑/k ↓/j Navigate',
        '/ Search',
        'r Refresh',
        'Esc Back',
      ].join('  ');

  const detailTitle = rows[selected] ? (rows[selected]._raw.title || 'Result') : undefined;

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <Layout
      title="Brain"
      subtitle={statusLoading ? 'loading...' : formatMilestone(statusData)}
      footer={footer}
      left={
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <SearchInput
              placeholder="Search the brain..."
              value={search}
              onChange={setSearch}
              onSubmit={handleSearchSubmit}
              active={searchActive}
            />
          </Box>

          {resultsError && (
            <Box marginBottom={1}>
              <Text color={colors.error}>Error: {resultsError.message}</Text>
            </Box>
          )}

          <DataTable
            columns={RESULT_COLUMNS}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            loading={resultsLoading}
            emptyMessage={search ? 'No results match your search' : 'Type a query and press Enter to search'}
            active={isActive && !searchActive}
          />
        </Box>
      }
      right={
        <DetailPanel
          title={detailTitle}
          data={detail}
        />
      }
    />
  );
}
