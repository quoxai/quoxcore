/**
 * Prometheus Executor
 *
 * Inline executor for prometheus entity tools.
 * Routes each tool ID to the correct Prometheus API endpoint with GET.
 */

const fs = require('fs');
const path = require('path');

const MONITORING_CONFIG_PATH = path.join(__dirname, '..', 'monitoring-config.json');

function getPrometheusUrl() {
  if (process.env.PROMETHEUS_URL) return process.env.PROMETHEUS_URL;
  try {
    const config = JSON.parse(fs.readFileSync(MONITORING_CONFIG_PATH, 'utf8'));
    if (config.prometheus?.url) return config.prometheus.url;
  } catch {}
  return '';
}

module.exports = {
  async execute(toolId, input, ctx) {
    const base = getPrometheusUrl();
    if (!base) {
      return { success: false, error: 'Prometheus not configured. Set PROMETHEUS_URL environment variable.' };
    }

    try {
      let url;
      switch (toolId) {
        case 'prometheus.query': {
          const params = new URLSearchParams({ query: input.query });
          if (input.time) params.set('time', input.time);
          if (input.timeout) params.set('timeout', input.timeout);
          url = `${base}/api/v1/query?${params}`;
          break;
        }
        case 'prometheus.range': {
          const params = new URLSearchParams({
            query: input.query,
            start: input.start,
            end: input.end,
            step: input.step || '15s'
          });
          url = `${base}/api/v1/query_range?${params}`;
          break;
        }
        case 'prometheus.alerts':
          url = `${base}/api/v1/alerts`;
          break;
        case 'prometheus.targets':
          url = `${base}/api/v1/targets`;
          break;
        default:
          return { success: false, error: `Unknown prometheus tool: ${toolId}` };
      }

      const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) {
        const text = await resp.text();
        return { success: false, error: `Prometheus ${resp.status}: ${text.substring(0, 200)}` };
      }
      const data = await resp.json();
      return { success: true, ...data };
    } catch (err) {
      return { success: false, error: `Prometheus request failed: ${err.message}` };
    }
  }
};
