/**
 * Monitoring Tool Executor
 *
 * Native executor for metrics_query and alerts_manage tools.
 * Replaces system-metrics.json and alerts-manage.json n8n workflows.
 * Direct HTTP to Prometheus and Alertmanager APIs (server-side, no CORS issues).
 */

const path = require('path');
const fs = require('fs');

const MONITORING_CONFIG_PATH = path.join(
  process.env.AEE_DB_PATH ? path.dirname(process.env.AEE_DB_PATH) : '/var/lib/quox',
  'monitoring-config.json'
);

function getPrometheusUrl() {
  const u = process.env.PROMETHEUS_URL || (() => {
    try { const c = JSON.parse(fs.readFileSync(MONITORING_CONFIG_PATH, 'utf8')); return c.prometheus?.url || ''; } catch { return ''; }
  })();
  // FND_...TX95 defence-in-depth: never fetch a denied SSRF target (loopback/link-local/metadata). A denied stored
  // URL reads as not-configured so callers refuse cleanly; normal LAN (RFC1918) stays allowed.
  if (u) { try { if (require('../monitoringEgressPolicy.js').orgMonitoringUrlRefusal(u)) return ''; } catch {} }
  return u;
}

// quox#1061: the Alertmanager URL is a platform setting resolved per call
// (org setting > instance setting > env > legacy monitoring-config.json).
const { resolveAlertmanagerTarget } = require('../alertmanagerConfig.js');

const METRIC_QUERIES = {
  summary: [
    { name: 'cpu_usage', query: 'avg(100 - (avg by(instance)(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100))' },
    { name: 'memory_usage', query: 'avg((1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) * 100)' },
    { name: 'disk_usage', query: 'avg((1 - (node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})) * 100)' }
  ],
  cpu: [
    { name: 'cpu_by_host', query: 'avg by(instance)(100 - (rate(node_cpu_seconds_total{mode="idle"}[5m]) * 100))' }
  ],
  memory: [
    { name: 'mem_used', query: 'node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes' },
    { name: 'mem_total', query: 'node_memory_MemTotal_bytes' }
  ],
  disk: [
    { name: 'disk_used', query: 'node_filesystem_size_bytes{mountpoint="/"} - node_filesystem_avail_bytes{mountpoint="/"}' },
    { name: 'disk_total', query: 'node_filesystem_size_bytes{mountpoint="/"}' }
  ],
  network: [
    { name: 'rx_bytes', query: 'rate(node_network_receive_bytes_total[5m])' },
    { name: 'tx_bytes', query: 'rate(node_network_transmit_bytes_total[5m])' }
  ]
};

/**
 * metrics_query — query Prometheus for system metrics
 */
async function metricsQuery(input) {
  const queryType = input.type || 'summary';
  const host = input.host || null;
  const range = input.range || '5m';
  const customQuery = input.custom_query || null;

  if (!getPrometheusUrl()) {
    return { success: false, error: 'Prometheus not configured. Set PROMETHEUS_URL environment variable.' };
  }

  // Custom PromQL query — execute directly
  if (customQuery) {
    return executePromQL(customQuery, { range, isRange: !!input.range_query, step: input.step });
  }

  const queries = METRIC_QUERIES[queryType];
  if (!queries) {
    return { success: false, error: `Invalid query type: ${queryType}. Valid: ${Object.keys(METRIC_QUERIES).join(', ')}` };
  }

  const results = {};
  const errors = [];

  for (const q of queries) {
    let query = q.query;
    // Filter by host if specified
    if (host) {
      query = query.replace(/\{/g, `{instance=~"${host}.*",`).replace(',}', '}');
    }
    // Apply custom range
    if (range !== '5m') {
      query = query.replace(/\[5m\]/g, `[${range}]`);
    }

    try {
      const resp = await fetch(`${getPrometheusUrl()}/api/v1/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `query=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(10000)
      });

      if (!resp.ok) {
        errors.push({ query: q.name, status: resp.status });
        continue;
      }

      const data = await resp.json();
      const result = data.data?.result || [];

      results[q.name] = result.map(r => ({
        instance: r.metric?.instance || 'unknown',
        job: r.metric?.job || 'unknown',
        value: parseFloat(r.value?.[1] || 0).toFixed(2)
      }));
    } catch (err) {
      errors.push({ query: q.name, error: err.message });
    }
  }

  // Compute aggregates across all metrics
  const allValues = Object.values(results).flat().map(m => parseFloat(m.value));
  const aggregate = allValues.length > 0
    ? {
      avg: (allValues.reduce((a, b) => a + b, 0) / allValues.length).toFixed(2),
      max: Math.max(...allValues).toFixed(2),
      min: Math.min(...allValues).toFixed(2),
      count: allValues.length
    }
    : null;

  return {
    success: errors.length === 0,
    queryType,
    range,
    metrics: results,
    aggregate,
    ...(errors.length > 0 ? { errors } : {})
  };
}

/**
 * Execute an arbitrary PromQL query (instant or range).
 */
async function executePromQL(query, opts = {}) {
  const { range, isRange = false, step = '1m' } = opts

  if (!getPrometheusUrl()) {
    return { success: false, error: 'Prometheus not configured. Set PROMETHEUS_URL environment variable.' }
  }

  try {
    let url, body
    if (isRange && range) {
      // Parse range string (e.g., "1h", "6h", "1d") to start/end timestamps
      const now = Math.floor(Date.now() / 1000)
      const seconds = parseRangeDuration(range)
      url = `${getPrometheusUrl()}/api/v1/query_range`
      body = `query=${encodeURIComponent(query)}&start=${now - seconds}&end=${now}&step=${encodeURIComponent(step)}`
    } else {
      url = `${getPrometheusUrl()}/api/v1/query`
      body = `query=${encodeURIComponent(query)}`
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15000),
    })

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      return { success: false, error: `Prometheus ${resp.status}: ${errBody.slice(0, 300)}` }
    }

    const data = await resp.json()
    if (data.status !== 'success') {
      return { success: false, error: data.error || 'Query failed', errorType: data.errorType }
    }

    const result = data.data?.result || []
    const MAX_SERIES = 50
    const MAX_POINTS_PER_SERIES = 200
    const truncatedResult = result.slice(0, MAX_SERIES)

    return {
      success: true,
      resultType: data.data?.resultType,
      query,
      results: truncatedResult.map(r => ({
        metric: r.metric || {},
        values: data.data?.resultType === 'matrix'
          ? r.values?.slice(0, MAX_POINTS_PER_SERIES).map(([ts, val]) => ({ timestamp: ts, value: parseFloat(val).toFixed(4) }))
          : undefined,
        value: data.data?.resultType !== 'matrix'
          ? parseFloat(r.value?.[1] || 0).toFixed(4)
          : undefined,
      })),
      count: result.length,
      truncated: result.length > MAX_SERIES,
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

/**
 * Parse a duration string (1m, 5m, 1h, 6h, 1d, 7d) to seconds.
 */
function parseRangeDuration(range) {
  const match = range.match(/^(\d+)(s|m|h|d|w)$/)
  if (!match) return 3600 // default 1h
  const [, num, unit] = match
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }
  return parseInt(num, 10) * (multipliers[unit] || 3600)
}

/**
 * alerts_manage — manage Alertmanager alerts and silences
 */
async function alertsManage(input, ctx = {}) {
  const operation = input.operation || 'active';
  const am = await resolveAlertmanagerTarget(ctx && ctx.orgId);
  const amUrl = am.url;
  // quox#1061: an org-set URL refused by the egress policy is reported as is,
  // never papered over by the Prometheus fallback below.
  if (am.refused) return { success: false, error: am.error };

  if (!amUrl) {
    // #889-adjacent: Prometheus evaluates the alerting rules and serves firing alerts at /api/v1/alerts,
    // so "are any alerts firing?" is answerable without Alertmanager. Fall back to it for a read of active
    // alerts; Alertmanager is only REQUIRED for silence create/delete and its own history.
    if (operation === 'active' && getPrometheusUrl()) return getActiveAlertsFromPrometheus();
    if (operation === 'history') {
      if (!getPrometheusUrl()) return { success: false, error: 'Prometheus not configured. Set PROMETHEUS_URL environment variable.' };
    } else {
      return { success: false, error: `${am.error} (silences need it; a read of firing alerts also works from PROMETHEUS_URL).` };
    }
  }

  switch (operation) {
    case 'active':
      return getActiveAlerts(amUrl);
    case 'silences':
      return getSilences(amUrl);
    case 'silence':
      return createSilence(input, amUrl);
    case 'unsilence':
      return deleteSilence(input, amUrl);
    case 'history':
      return getAlertHistory(input);
    default:
      return { success: false, error: `Invalid operation: ${operation}. Valid: active, silences, silence, unsilence, history` };
  }
}

async function getActiveAlertsFromPrometheus() {
  try {
    const resp = await fetch(`${getPrometheusUrl()}/api/v1/alerts`, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return { success: false, error: `Prometheus returned ${resp.status}` };
    const body = await resp.json();
    const all = (body && body.data && Array.isArray(body.data.alerts)) ? body.data.alerts : [];
    const firing = all.filter((a) => a.state === 'firing');
    const formatted = firing.map((a) => ({
      alertname: a.labels?.alertname,
      severity: a.labels?.severity,
      instance: a.labels?.instance,
      summary: a.annotations?.summary || a.annotations?.description,
      started_at: a.activeAt,
    }));
    return {
      success: true,
      operation: 'active',
      source: 'prometheus',
      note: 'Alertmanager is not configured; these are the firing alerts Prometheus has evaluated (no silence state).',
      alerts: formatted,
      summary: {
        total: formatted.length,
        critical: formatted.filter((a) => a.severity === 'critical').length,
        warning: formatted.filter((a) => a.severity === 'warning').length,
        pending_excluded: all.length - firing.length,
      },
    };
  } catch (err) {
    return { success: false, error: `Prometheus unreachable: ${err.message}` };
  }
}

async function getActiveAlerts(amUrl) {
  try {
    const resp = await fetch(`${amUrl}/api/v2/alerts?active=true`, { redirect: 'manual',
      signal: AbortSignal.timeout(10000)
    });

    if (!resp.ok) {
      return { success: false, error: `Alertmanager returned ${resp.status}` };
    }

    const alerts = await resp.json();
    const formatted = (Array.isArray(alerts) ? alerts : []).map(a => ({
      alertname: a.labels?.alertname,
      severity: a.labels?.severity,
      instance: a.labels?.instance,
      summary: a.annotations?.summary || a.annotations?.description,
      started_at: a.startsAt,
      fingerprint: a.fingerprint
    }));

    return {
      success: true,
      operation: 'active',
      alerts: formatted,
      summary: {
        total: formatted.length,
        critical: formatted.filter(a => a.severity === 'critical').length,
        warning: formatted.filter(a => a.severity === 'warning').length
      }
    };
  } catch (err) {
    return { success: false, error: `Alertmanager unreachable: ${err.message}` };
  }
}

async function getSilences(amUrl) {
  try {
    const resp = await fetch(`${amUrl}/api/v2/silences`, { redirect: 'manual',
      signal: AbortSignal.timeout(10000)
    });

    if (!resp.ok) {
      return { success: false, error: `Alertmanager returned ${resp.status}` };
    }

    const allSilences = await resp.json();
    const silences = (Array.isArray(allSilences) ? allSilences : [])
      .filter(s => s.status?.state === 'active')
      .map(s => ({
        id: s.id,
        matchers: s.matchers,
        created_by: s.createdBy,
        comment: s.comment,
        starts_at: s.startsAt,
        ends_at: s.endsAt
      }));

    return {
      success: true,
      operation: 'silences',
      silences,
      count: silences.length
    };
  } catch (err) {
    return { success: false, error: `Alertmanager unreachable: ${err.message}` };
  }
}

async function createSilence(input, amUrl) {
  if (!input.matchers || Object.keys(input.matchers).length === 0) {
    return { success: false, error: 'Missing required field: matchers (object of label name/value pairs)' };
  }

  const startsAt = new Date();
  const duration = input.duration || '2h';
  const hours = parseInt(duration) || 2;
  const endsAt = new Date(startsAt.getTime() + hours * 60 * 60 * 1000);

  const body = {
    matchers: Object.entries(input.matchers).map(([name, value]) => ({
      name,
      value: String(value),
      isRegex: false
    })),
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    createdBy: input.created_by || 'quox',
    comment: input.comment || 'Silenced via Quox'
  };

  try {
    const resp = await fetch(`${amUrl}/api/v2/silences`, { redirect: 'manual',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { success: false, error: `Failed to create silence: ${text}` };
    }

    const result = await resp.json();
    return {
      success: true,
      operation: 'silence',
      silence_id: result.silenceID || result.id,
      message: 'Silence created successfully',
      ends_at: endsAt.toISOString()
    };
  } catch (err) {
    return { success: false, error: `Alertmanager unreachable: ${err.message}` };
  }
}

async function deleteSilence(input, amUrl) {
  if (!input.silence_id) {
    return { success: false, error: 'Missing required field: silence_id' };
  }

  try {
    const resp = await fetch(`${amUrl}/api/v2/silence/${input.silence_id}`, { redirect: 'manual',
      method: 'DELETE',
      signal: AbortSignal.timeout(10000)
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { success: false, error: `Failed to remove silence: ${text}` };
    }

    return {
      success: true,
      operation: 'unsilence',
      silence_id: input.silence_id,
      message: 'Silence removed successfully'
    };
  } catch (err) {
    return { success: false, error: `Alertmanager unreachable: ${err.message}` };
  }
}

async function getAlertHistory(input) {
  const hours = Math.min(parseInt(input.hours) || 24, 168);
  const end = new Date();
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);

  try {
    const url = `${getPrometheusUrl()}/api/v1/query_range?query=ALERTS&start=${start.toISOString()}&end=${end.toISOString()}&step=60s`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });

    if (!resp.ok) {
      return { success: false, error: `Prometheus returned ${resp.status}` };
    }

    const data = await resp.json();
    const results = data.data?.result || [];

    const alertHistory = results.map(r => ({
      alertname: r.metric?.alertname,
      severity: r.metric?.severity,
      instance: r.metric?.instance,
      datapoints: r.values?.length || 0
    }));

    return {
      success: true,
      operation: 'history',
      hours,
      alerts: alertHistory,
      count: alertHistory.length
    };
  } catch (err) {
    return { success: false, error: `Prometheus unreachable: ${err.message}` };
  }
}

module.exports = { metricsQuery, alertsManage, executePromQL, parseRangeDuration };
