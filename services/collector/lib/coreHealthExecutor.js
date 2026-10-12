/**
 * Core Health Executor
 *
 * Inline executor for core.health entity tool.
 * Checks health of all core QuoxCORE services and returns aggregate status.
 */

const SERVICES = [
  { name: 'auth', port: 3101, path: '/health' },
  { name: 'files', port: 3102, path: '/health' },
  { name: 'memory', port: 3103, path: '/health' },
  { name: 'tasks', port: 3104, path: '/health' },
  { name: 'collector', port: 9848, path: '/health' },
  { name: 'quoxflow', port: 3200, path: '/health' }
];

async function checkService(svc) {
  const url = `http://${svc.name}:${svc.port}${svc.path}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      return { name: svc.name, status: 'healthy', port: svc.port };
    }
    return { name: svc.name, status: 'degraded', port: svc.port, error: `HTTP ${resp.status}` };
  } catch (err) {
    return { name: svc.name, status: 'down', port: svc.port, error: err.message };
  }
}

module.exports = {
  async execute(toolId, input, ctx) {
    const results = await Promise.all(SERVICES.map(checkService));

    const healthy = results.filter(r => r.status === 'healthy').length;
    const degraded = results.filter(r => r.status === 'degraded').length;
    const down = results.filter(r => r.status === 'down').length;

    let status = 'healthy';
    if (down > 0) status = 'critical';
    else if (degraded > 0) status = 'degraded';

    return {
      success: true,
      status,
      summary: { total: results.length, healthy, degraded, down },
      services: results
    };
  }
};
