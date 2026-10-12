/**
 * HealthView — btop-style live health dashboard
 *
 * Single full-width panel showing:
 *   - Overall status dot (derived from per-service statuses)
 *   - A live Sparkline trend of "healthy service count" across recent polls
 *   - A dense list of services with status dot + status + latency
 *   - Recent governance incidents (best-effort, defensive)
 *
 * Auto-refreshes every 5 seconds via usePolledApi (only while active).
 * `r` manually refreshes; Esc is handled by the parent app shell.
 *
 * API:
 *   GET /api/v1/health/aggregate  (service: collector) -> { services: [...] } | { checks: [...] }
 *     each entry: { name, status, latency_ms }
 *   GET /governance/incidents     (service: collector) -> { incidents: [...] } (best-effort, defensive)
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { FullLayout } from '../components/Layout.jsx';
import { Sparkline } from '../components/Sparkline.jsx';
import { usePolledApi } from '../hooks/usePolledApi.js';
import { useTui } from '../app.jsx';
import { matchKey } from '../keys.js';
import { colors, styles } from '../theme.js';
import { resolveEndpoint } from '../../api/endpoints.js';

// ── Auto-refresh interval (ms) ───────────────────────────────────────
const REFRESH_INTERVAL = 5_000;

// ── History cap for the trend sparkline ──────────────────────────────
const MAX_HISTORY = 40;

// ── Statuses considered "healthy" for the overall roll-up ───────────
const HEALTHY_STATUSES = new Set(['healthy', 'online', 'active', 'up', 'ok']);

function isHealthy(status) {
  return HEALTHY_STATUSES.has(status);
}

/**
 * Defensively unwrap the aggregate response into a services array —
 * accepts { services: [...] }, { checks: [...] }, or a bare array.
 */
function unwrapServices(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.services)) return data.services;
  if (Array.isArray(data.checks)) return data.checks;
  return [];
}

/**
 * Defensively unwrap an incidents response into an array.
 */
function unwrapIncidents(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.incidents)) return data.incidents;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

function formatServiceRow(s) {
  const status = s.status || s.state || 'unknown';
  const latency = s.latency_ms ?? s.latencyMs ?? s.latency;
  return {
    name: s.name || s.service || s.id || 'unknown',
    status,
    latency: latency != null ? `${Number(latency).toFixed(0)}ms` : '--',
    _raw: s,
  };
}

function formatIncidentRows(incidents) {
  return unwrapIncidents(incidents)
    .slice(0, 8)
    .map((i, idx) => ({
      id: i.id != null ? String(i.id) : `incident-${idx}`,
      title: i.title || i.summary || i.description || 'incident',
      severity: i.severity || i.level || '--',
    }));
}

// ── Component ─────────────────────────────────────────────────────────
export function HealthView() {
  const ctx = useTui();
  const { client, screen } = ctx;
  const isActive = screen === 'health';

  // ── Health trend history (accumulated across polls) ──────────────────
  const historyRef = useRef([]);
  const [history, setHistory] = useState([]);

  // ── Fetch aggregate health, polled every 5s while active ─────────────
  const { data, loading, error, refresh } = usePolledApi(
    async () => {
      const res = await client.get(resolveEndpoint('v1.health.aggregate.list').path, { service: resolveEndpoint('v1.health.aggregate.list').service });
      return res || {};
    },
    [client],
    { intervalMs: REFRESH_INTERVAL, active: isActive }
  );

  // ── Fetch recent governance incidents, best-effort ────────────────────
  const { data: incidentsData } = usePolledApi(
    async () => {
      try {
        const res = await client.get(resolveEndpoint('governance.incidents.list').path, { service: resolveEndpoint('governance.incidents.list').service });
        return res;
      } catch {
        // Endpoint may not exist / may 404 — skip silently, view still works.
        return [];
      }
    },
    [client],
    { intervalMs: REFRESH_INTERVAL, active: isActive }
  );

  const services = unwrapServices(data);
  const rows = services.map(formatServiceRow);
  const incidents = formatIncidentRows(incidentsData);

  // ── Accumulate a healthy-service-count trend for the sparkline ───────
  useEffect(() => {
    if (!data) return;
    const healthyCount = services.filter((s) => isHealthy(s.status || s.state)).length;

    historyRef.current = [...historyRef.current, healthyCount].slice(-MAX_HISTORY);
    setHistory(historyRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // ── Keyboard handling ──────────────────────────────────────────────
  useInput((input, key) => {
    if (!isActive) return;

    // Manual refresh
    if (matchKey('refresh', input, key)) {
      refresh();
      return;
    }
  }, { isActive });

  // ── Overall roll-up status ────────────────────────────────────────
  const overallStatus = rows.length === 0
    ? 'unknown'
    : rows.every((r) => isHealthy(r.status))
      ? 'healthy'
      : 'degraded';

  // ── Footer hint ────────────────────────────────────────────────────
  const footer = 'r: refresh  Esc: back';

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <FullLayout
      title="Health"
      subtitle={loading ? '(refreshing...)' : `${rows.length} services`}
      footer={footer}
    >
      <Box flexDirection="column">
        {error && (
          <Box marginBottom={1}>
            <Text color={colors.error}>Error: {error.message}</Text>
          </Box>
        )}

        <Box marginBottom={1}>
          <Text color={colors.textMuted}>Overall: </Text>
          <Text>{styles.statusDot(overallStatus)} </Text>
          <Text color={colors.text}>{overallStatus}</Text>
        </Box>

        {history.length > 0 && (
          <Box marginBottom={1}>
            <Text color={colors.textMuted}>Trend: </Text>
            <Sparkline data={history} width={40} color={colors.cyberBlue} />
            <Text color={colors.dim}>  ({history[history.length - 1]}/{rows.length} healthy)</Text>
          </Box>
        )}

        <Box flexDirection="column" marginBottom={1}>
          {loading && rows.length === 0 && (
            <Text color={colors.dim}>Loading...</Text>
          )}
          {!loading && rows.length === 0 && (
            <Text color={colors.dim}>No service health data available</Text>
          )}
          {rows.map((r) => (
            <Box key={r.name}>
              <Text>{styles.statusDot(r.status)} </Text>
              <Text color={colors.text} bold>{r.name.padEnd(16)}</Text>
              <Text color={colors.dim}>{String(r.status).padEnd(12)}</Text>
              <Text color={colors.textMuted}>{r.latency}</Text>
            </Box>
          ))}
        </Box>

        {incidents.length > 0 && (
          <Box flexDirection="column">
            <Text color={colors.accent} bold>Recent Incidents</Text>
            {incidents.map((i, idx) => (
              <Box key={`${i.id}-${idx}`}>
                <Text color={colors.warning}>{String(i.severity).padEnd(10)}</Text>
                <Text color={colors.text}>{i.title}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    </FullLayout>
  );
}
