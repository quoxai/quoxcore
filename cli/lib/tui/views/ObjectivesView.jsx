/**
 * ObjectivesView — Objectives (autonomous multi-step goals) management view
 *
 * Left panel:  DataTable of objectives (title, status, progress)
 * Right panel: DetailPanel with objective detail
 *
 * Features:
 *   - `a` key approves a decomposed objective's plan (starts execution)
 *   - `s` key starts an objective (decomposes into tasks)
 *   - Auto-refreshes every 10 seconds via usePolledApi (only while active —
 *     never polls in the background when another screen is showing)
 *   - After `a`/`s`, an immediate refresh() is fired (decomposition/start
 *     happens async server-side — see services/tasks/lib/objectiveDispatch.js
 *     — so the list often hasn't caught up yet) and the acted-on row shows a
 *     transient "starting…"/"decomposing…" hint until a subsequent fetch
 *     (immediate refresh or the next 10s poll) reflects the new status.
 *
 * API (NOT org-scoped in the path — org/user scoping comes from the JWT):
 *   GET  /api/objectives           (service: tasks) -> data.objectives
 *   GET  /api/objectives/:id       (service: tasks) -> objective detail
 *   POST /api/objectives/:id/approve-plan  (service: tasks)
 *   POST /api/objectives/:id/start         (service: tasks)
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Layout } from '../components/Layout.jsx';
import { DataTable } from '../components/DataTable.jsx';
import { DetailPanel } from '../components/DetailPanel.jsx';
import { usePolledApi } from '../hooks/usePolledApi.js';
import { useTui } from '../app.jsx';
import { matchKey } from '../keys.js';
import { colors, styles } from '../theme.js';
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
  { key: 'title',     label: 'Title',    width: 24 },
  { key: 'status',    label: 'Status',   width: 14 },
  { key: 'progress',  label: 'Progress', width: 10 },
];

/**
 * Format raw objective data into table rows.
 * `pendingAction` (if present) is `{ id, hint }` for an in-flight
 * start/approve action whose effect hasn't shown up in `objectives` yet.
 */
function formatRows(objectives, pendingAction) {
  if (!Array.isArray(objectives)) return [];
  return objectives.map((o) => {
    const isPending = pendingAction && pendingAction.id === o.id;
    const statusText = `${styles.statusDot(o.status || 'unknown')} ${o.status || 'unknown'}`;
    return {
      ...o,
      title:    o.title || o.name || o.id,
      status:   isPending ? `${statusText} (${pendingAction.hint})` : statusText,
      progress: (o.tasks_done != null || o.tasks_total != null)
        ? `${o.tasks_done || 0}/${o.tasks_total || 0}`
        : '--',
      _raw: o,
    };
  });
}

/**
 * Build a detail object for the right panel.
 * `pendingAction` (if present and matching this objective) appends the
 * transient "starting…"/"decomposing…" hint to the full-width Status line
 * (the DataTable row's Status column is too narrow to show it in full).
 */
function buildDetail(raw, pendingAction) {
  if (!raw) return null;
  const isPending = pendingAction && pendingAction.id === raw.id;
  return {
    'Title':       raw.title || raw.name,
    'ID':          raw.id,
    'Status':      isPending ? `${raw.status} (${pendingAction.hint})` : raw.status,
    'Description': raw.description,
    'Team':        raw.team_id,
    'Progress':    (raw.tasks_done != null || raw.tasks_total != null)
      ? `${raw.tasks_done || 0}/${raw.tasks_total || 0}`
      : '--',
    'Created':     raw.created_at,
    'Updated':     raw.updated_at,
  };
}

// ── Component ─────────────────────────────────────────────────────────
export function ObjectivesView() {
  const ctx = useTui();
  const { client, screen, showToast, orgVersion } = ctx;
  const isActive = screen === 'objectives';
  const orgId = getOrgId(ctx);

  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState(undefined);
  // In-flight start/approve action: { id, previousStatus, hint }. Cleared
  // once a fetch shows the objective's status has actually moved on, or
  // after a safety timeout if it hasn't.
  const [pendingAction, setPendingAction] = useState(null);

  // ── Data fetching (auto-refreshes every 10s, only while active) ─────
  const { data, loading, error, refresh } = usePolledApi(
    async () => {
      const res = await client.get(resolveEndpoint('objectives.list').path, { service: resolveEndpoint('objectives.list').service, query: { status: filter } });
      return res?.objectives || res?.items || (Array.isArray(res) ? res : []);
    },
    [client, orgVersion, filter],
    { intervalMs: 10000, active: isActive }
  );

  const rows = formatRows(data, pendingAction);
  const selectedRow = rows[selected];
  const detail = selectedRow ? buildDetail(selectedRow._raw, pendingAction) : null;

  // ── Clear the pending hint once the objective's status has moved on ──
  useEffect(() => {
    if (!pendingAction || !Array.isArray(data)) return;
    const current = data.find((o) => o.id === pendingAction.id);
    if (current && current.status !== pendingAction.previousStatus) {
      setPendingAction(null);
    }
  }, [data, pendingAction]);

  // Safety timeout: never leave the hint stuck if status genuinely hasn't
  // changed by the time it fires (e.g. decomposition takes longer than this).
  useEffect(() => {
    if (!pendingAction) return;
    const t = setTimeout(() => setPendingAction(null), 15000);
    return () => clearTimeout(t);
  }, [pendingAction]);

  // ── Approve plan ──────────────────────────────────────────────────
  const approvePlan = useCallback(async () => {
    if (!selectedRow) return;
    const id = selectedRow._raw.id;
    try {
      await client.post(resolveEndpoint('objectives.approve-plan', { id }).path, { service: resolveEndpoint('objectives.approve-plan', { id }).service });
      showToast('Objective started', 'success');
      setPendingAction({ id, previousStatus: selectedRow._raw.status, hint: 'starting…' });
      refresh();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [selectedRow, client, refresh, showToast]);

  // ── Start objective ───────────────────────────────────────────────
  const startObjective = useCallback(async () => {
    if (!selectedRow) return;
    const id = selectedRow._raw.id;
    try {
      await client.post(resolveEndpoint('objectives.start', { id }).path, { service: resolveEndpoint('objectives.start', { id }).service, body: {} });
      showToast('Objective started', 'success');
      setPendingAction({ id, previousStatus: selectedRow._raw.status, hint: 'decomposing…' });
      refresh();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, [selectedRow, client, refresh, showToast]);

  // ── Keyboard handling ──────────────────────────────────────────────
  useInput((input, key) => {
    if (!isActive) return;

    // Manual refresh
    if (matchKey('refresh', input, key)) {
      refresh();
      return;
    }

    // Approve plan
    if (input === 'a') {
      approvePlan();
      return;
    }

    // Start objective
    if (input === 's') {
      startObjective();
      return;
    }
  }, { isActive });

  // ── Footer hint ────────────────────────────────────────────────────
  const footer = 'a: approve  s: start  r: refresh  Esc: back';

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <Layout
      title="Objectives"
      subtitle={orgId ? `org: ${orgId}` : '(no org)'}
      footer={footer}
      left={
        <Box flexDirection="column">
          {error && (
            <Box marginBottom={1}>
              <Text color={colors.error}>Error: {error.message}</Text>
            </Box>
          )}
          <DataTable
            columns={COLUMNS}
            rows={rows}
            selected={selected}
            onSelectionChange={setSelected}
            loading={loading}
            emptyMessage="No objectives yet — press s to start one, or create via `quox objective create`"
            active={isActive}
          />
        </Box>
      }
      right={
        <DetailPanel
          title={selectedRow ? (selectedRow._raw.title || selectedRow._raw.id) : undefined}
          data={detail}
        />
      }
    />
  );
}
