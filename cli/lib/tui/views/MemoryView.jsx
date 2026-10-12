/**
 * MemoryView — Memory browser with 3 sub-tabs
 *
 * Tabs: Memories | Entities | Conversations
 *
 * Left panel:  DataTable of the active tab's data
 * Right panel: DetailPanel for the selected item
 *
 * Features:
 *   - Tab key switches between Memories / Entities / Conversations
 *   - `/` key focuses the search input
 *   - Search queries the memory search API
 *   - Memory detail shows type, content, tags
 *
 * API:
 *   GET /api/memory         (service: memory) -> data.memories
 *   GET /api/memory/search  (service: memory, query: { query }) -> results
 *   GET /api/entity         (service: memory) -> data.entities
 *   GET /api/conversations  (service: memory) -> data.conversations
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

// ── Tab definitions ───────────────────────────────────────────────────
const TABS = ['Memories', 'Entities', 'Conversations'];

// ── Column definitions per tab ────────────────────────────────────────
const MEMORY_COLUMNS = [
  { key: 'type',    label: 'Type',    width: 14 },
  { key: 'content', label: 'Content', width: 36 },
  { key: 'tags',    label: 'Tags',    width: 16 },
];

const ENTITY_COLUMNS = [
  { key: 'name',  label: 'Name',  width: 20 },
  { key: 'type',  label: 'Type',  width: 14 },
  { key: 'count', label: 'Refs',  width: 8 },
];

const CONVERSATION_COLUMNS = [
  { key: 'title',   label: 'Title',   width: 28 },
  { key: 'date',    label: 'Date',    width: 14 },
  { key: 'turns',   label: 'Turns',   width: 8 },
];

// ── Row formatters ────────────────────────────────────────────────────

function formatMemoryRows(memories) {
  if (!Array.isArray(memories)) return [];
  return memories.map((m) => ({
    type:    m.type || '--',
    content: truncate(m.content || m.text || m.value || '', 34),
    tags:    Array.isArray(m.tags) ? m.tags.join(', ') : '--',
    _raw: m,
  }));
}

function formatEntityRows(entities) {
  if (!Array.isArray(entities)) return [];
  return entities.map((e) => ({
    name:  e.name || e.display_name || e.id,
    type:  e.type || e.entity_type || '--',
    count: e.reference_count != null ? String(e.reference_count) : (e.count != null ? String(e.count) : '--'),
    _raw: e,
  }));
}

function formatConversationRows(conversations) {
  if (!Array.isArray(conversations)) return [];
  return conversations.map((c) => ({
    title: truncate(c.title || c.summary || c.id || 'Untitled', 26),
    date:  c.created_at ? formatDate(c.created_at) : '--',
    turns: c.turn_count != null ? String(c.turn_count) : (c.message_count != null ? String(c.message_count) : '--'),
    _raw: c,
  }));
}

// ── Detail builders ───────────────────────────────────────────────────

function buildMemoryDetail(raw) {
  if (!raw) return null;
  return {
    'Type':       raw.type,
    'Content':    raw.content || raw.text || raw.value,
    'Tags':       Array.isArray(raw.tags) ? raw.tags : undefined,
    'Source':     raw.source,
    'Confidence': raw.confidence,
    'Created':    raw.created_at,
    'Updated':    raw.updated_at,
    'ID':         raw.id,
  };
}

function buildEntityDetail(raw) {
  if (!raw) return null;
  return {
    'Name':            raw.name || raw.display_name,
    'Type':            raw.type || raw.entity_type,
    'ID':              raw.id,
    'References':      raw.reference_count || raw.count,
    'Properties':      raw.properties || raw.metadata,
    'First Seen':      raw.first_seen || raw.created_at,
    'Last Seen':       raw.last_seen || raw.updated_at,
    'Related Entities':raw.related || raw.relationships,
  };
}

function buildConversationDetail(raw) {
  if (!raw) return null;
  return {
    'Title':     raw.title || raw.summary,
    'ID':        raw.id,
    'Turns':     raw.turn_count || raw.message_count,
    'Started':   raw.created_at || raw.started_at,
    'Last Active':raw.updated_at || raw.last_message_at,
    'Participants':raw.participants,
    'Tags':      raw.tags,
    'Summary':   raw.summary || raw.description,
  };
}

// ── Utility ───────────────────────────────────────────────────────────

function truncate(str, max) {
  if (!str) return '';
  const s = String(str).replace(/\n/g, ' ');
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

function formatDate(iso) {
  if (!iso) return '--';
  try {
    const d = new Date(iso);
    return d.toISOString().slice(0, 10);
  } catch {
    return String(iso).slice(0, 10);
  }
}

// ── Component ─────────────────────────────────────────────────────────
export function MemoryView() {
  const ctx = useTui();
  const { client, screen, setInputMode, orgVersion } = ctx;
  const isActive = screen === 'memory';

  const [activeTab, setActiveTab] = useState(0);
  const [selected, setSelected] = useState(0);
  const [search, setSearch] = useState('');
  const [searchActive, setSearchActive] = useState(false);

  // ── Input-mode registry: claim 'input' while the search box is
  // focused so global shortcuts (e.g. '?') don't steal keystrokes.
  useEffect(() => {
    if (searchActive) setInputMode?.('input');
    else if (isActive) setInputMode?.('nav');
  }, [searchActive, isActive, setInputMode]);

  // ── Fetch memories (refetches when the active org changes) ──────────
  const { data: memoriesData, loading: memoriesLoading, error: memoriesError, refresh: refreshMemories } = useApi(
    async () => {
      if (search) {
        const res = await client.get(resolveEndpoint('memory.search.list').path, {
          service: resolveEndpoint('memory.search.list').service,
          query: { query: search },
        });
        return res?.results || res?.memories || [];
      }
      const res = await client.get(resolveEndpoint('memory.list').path, { service: resolveEndpoint('memory.list').service });
      return res?.memories || [];
    },
    [client, search, orgVersion]
  );

  // ── Fetch entities (refetches when the active org changes) ──────────
  const { data: entitiesData, loading: entitiesLoading, error: entitiesError, refresh: refreshEntities } = useApi(
    async () => {
      const res = await client.get(resolveEndpoint('entity.list').path, { service: resolveEndpoint('entity.list').service });
      return res?.entities || [];
    },
    [client, orgVersion]
  );

  // ── Fetch conversations (refetches when the active org changes) ─────
  const { data: convoData, loading: convoLoading, error: convoError, refresh: refreshConvos } = useApi(
    async () => {
      const res = await client.get(resolveEndpoint('conversations.list').path, { service: resolveEndpoint('conversations.list').service });
      return res?.conversations || [];
    },
    [client, orgVersion]
  );

  // ── Active tab data ─────────────────────────────────────────────────
  let columns, rows, detail, loading, error;

  switch (activeTab) {
    case 0: // Memories
      columns = MEMORY_COLUMNS;
      rows = formatMemoryRows(memoriesData);
      detail = rows[selected] ? buildMemoryDetail(rows[selected]._raw) : null;
      loading = memoriesLoading;
      error = memoriesError;
      break;
    case 1: // Entities
      columns = ENTITY_COLUMNS;
      rows = formatEntityRows(entitiesData);
      detail = rows[selected] ? buildEntityDetail(rows[selected]._raw) : null;
      loading = entitiesLoading;
      error = entitiesError;
      break;
    case 2: // Conversations
      columns = CONVERSATION_COLUMNS;
      rows = formatConversationRows(convoData);
      detail = rows[selected] ? buildConversationDetail(rows[selected]._raw) : null;
      loading = convoLoading;
      error = convoError;
      break;
  }

  // ── Reset selection on tab change ───────────────────────────────────
  useEffect(() => {
    setSelected(0);
  }, [activeTab]);

  // ── Refresh all ─────────────────────────────────────────────────────
  const refreshAll = useCallback(() => {
    refreshMemories();
    refreshEntities();
    refreshConvos();
  }, [refreshMemories, refreshEntities, refreshConvos]);

  // ── Search submit ───────────────────────────────────────────────────
  const handleSearchSubmit = useCallback(() => {
    setSearchActive(false);
    setActiveTab(0); // Search always applies to memories tab
    setSelected(0);
    refreshMemories();
  }, [refreshMemories]);

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

    // Tab to switch sub-tabs
    if (matchKey('tab', input, key)) {
      setActiveTab((t) => (t + 1) % TABS.length);
      return;
    }

    // Manual refresh
    if (matchKey('refresh', input, key)) {
      refreshAll();
      return;
    }
  }, { isActive });

  // ── Tab bar rendering ──────────────────────────────────────────────
  const tabBar = (
    <Box marginBottom={1}>
      {TABS.map((tab, i) => {
        const isSel = i === activeTab;
        return (
          <React.Fragment key={tab}>
            {i > 0 && <Text color={colors.subtle}> | </Text>}
            <Text
              color={isSel ? colors.cyberBlue : colors.dim}
              bold={isSel}
              underline={isSel}
            >
              {tab}
            </Text>
          </React.Fragment>
        );
      })}
      <Text color={colors.dim}>  (Tab to switch)</Text>
    </Box>
  );

  // ── Footer hint ────────────────────────────────────────────────────
  const footer = searchActive
    ? 'Type to search  Enter Submit  Esc Cancel'
    : [
        '\u2191/k \u2193/j Navigate',
        'Tab Switch tab',
        '/ Search',
        'r Refresh',
        'Esc Back',
      ].join('  ');

  // ── Detail title ───────────────────────────────────────────────────
  let detailTitle;
  if (rows[selected]) {
    switch (activeTab) {
      case 0: detailTitle = `Memory: ${rows[selected]._raw.type || 'item'}`; break;
      case 1: detailTitle = rows[selected]._raw.name || 'Entity'; break;
      case 2: detailTitle = rows[selected]._raw.title || 'Conversation'; break;
    }
  }

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <Layout
      title="Memory"
      subtitle={TABS[activeTab]}
      footer={footer}
      left={
        <Box flexDirection="column">
          {/* Tab bar */}
          {tabBar}

          {/* Search (visible on Memories tab) */}
          {activeTab === 0 && (
            <Box marginBottom={1}>
              <SearchInput
                placeholder="Search memories..."
                value={search}
                onChange={setSearch}
                onSubmit={handleSearchSubmit}
                active={searchActive}
              />
            </Box>
          )}

          {error && (
            <Box marginBottom={1}>
              <Text color={colors.error}>Error: {error.message}</Text>
            </Box>
          )}

          <DataTable
            columns={columns}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            loading={loading}
            emptyMessage={
              activeTab === 0 && search
                ? 'No memories match your search'
                : ['No memories yet', 'No entities yet', 'No conversations yet'][activeTab]
            }
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
