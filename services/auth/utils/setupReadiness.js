const CACHE_TTL_MS = 5000;
// 2500ms was too tight: the collector's own /health handler can stall a few
// seconds under normal event-loop load (same root cause already documented
// and fixed at 12000ms client-side in healthCheck.js, and independently
// found 2026-08-10 tripping getFleetStatusLocal()'s self-referential fleet
// calls). A single stall exceeding both probe attempts here produces a
// sticky false "Platform degraded: core services unreachable" banner for
// the rest of that page view (AppShell.jsx fetches /setup/status once per
// navigation, no retry), even though the service is genuinely healthy.
const REQUEST_TIMEOUT_MS = 5000;
const PROBE_ATTEMPTS = 2;

let readinessCache = null;
let readinessCacheTime = 0;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function withPath(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}${path}`;
}

function isConfiguredTruthy(value) {
  return typeof value === 'string'
    ? value.trim().length > 0 && value !== 'false' && value !== '0'
    : Boolean(value);
}

function getOptionalCapabilityManifest() {
  const bastionInstalled = isConfiguredTruthy(process.env.BASTION_ENABLED) || isConfiguredTruthy(process.env.BASTION_URL);

  return {
    bastion: {
      key: 'bastion',
      label: 'QuoxBastion',
      installed: bastionInstalled,
      mode: bastionInstalled ? 'configured' : 'absent',
    },
  };
}

async function probeUrl(fetchImpl, url, timeoutMs = REQUEST_TIMEOUT_MS, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(headers || {}),
      },
    });

    let payload = null;
    try {
      payload = await res.clone().json();
    } catch {
      payload = null;
    }

    return {
      ok: res.ok,
      status: res.status,
      payload,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeService(fetchImpl, {
  key,
  label,
  candidates,
  path = '/health',
  headers,
  severityWhenDown = 'fail',
}) {
  const urls = unique(candidates).map((baseUrl) => withPath(baseUrl, path));
  let lastFailure = null;

  // Two passes: a cold DNS lookup inside the container can eat the entire
  // first attempt's budget; the retry hits a warm resolver and answers in ms.
  // A genuinely down service fails both passes (usually fast, via refusal).
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    for (const url of urls) {
      const result = await probeUrl(fetchImpl, url, REQUEST_TIMEOUT_MS, headers);
      if (result.ok) {
        return {
          key,
          label,
          status: 'pass',
          detail: 'Healthy',
          url,
        };
      }

      lastFailure = {
        status: severityWhenDown,
        detail: result.status ? `HTTP ${result.status}` : 'Unreachable',
        url,
      };
    }
  }

  return {
    key,
    label,
    status: severityWhenDown,
    detail: lastFailure?.detail || 'Unavailable',
    url: lastFailure?.url || urls[0] || null,
  };
}

function buildDegradedFeatures(services) {
  const degraded = [];

  if (services.collector?.status !== 'pass') {
    degraded.push('AI chat, streaming, and terminal tooling');
  }
  if (services.files?.status !== 'pass') {
    degraded.push('Uploads, attachments, and artifact-backed workflows');
  }
  if (services.qdrant?.status !== 'pass') {
    degraded.push('Semantic memory and vector search');
  }
  if (services.tasks?.status !== 'pass') {
    degraded.push('Objectives, Mission Control, and Agentic Teams');
  }
  if (services.quoxflow?.status !== 'pass') {
    degraded.push('Workflow Builder, approvals, policies, and automation');
  }

  return degraded;
}

function buildOptionalFeatureIssues(services, capabilities) {
  const issues = [];

  if (capabilities.bastion?.installed && services.bastion?.status !== 'pass') {
    issues.push('Bastion-backed SSH access and fleet operations');
  }

  return issues;
}

export async function getSetupReadiness({
  fetchImpl = fetch,
  forceRefresh = false,
  now = Date.now(),
} = {}) {
  if (!forceRefresh && readinessCache && (now - readinessCacheTime) < CACHE_TTL_MS) {
    return readinessCache;
  }

  const services = {};
  services.auth = {
    key: 'auth',
    label: 'Auth Service',
    status: 'pass',
    detail: 'This service is responding',
    url: null,
  };

  const [
    collector,
    files,
    qdrant,
    tasks,
    quoxflow,
    bastion,
  ] = await Promise.all([
    probeService(fetchImpl, {
      key: 'collector',
      label: 'Collector',
      candidates: [process.env.COLLECTOR_URL, 'http://collector:9848', 'http://127.0.0.1:9848'],
      severityWhenDown: 'fail',
    }),
    probeService(fetchImpl, {
      key: 'files',
      label: 'Files Service',
      candidates: [process.env.FILES_SERVICE_URL, 'http://files:3102', 'http://127.0.0.1:3102'],
      severityWhenDown: 'fail',
    }),
    probeService(fetchImpl, {
      key: 'qdrant',
      label: 'Qdrant',
      candidates: [process.env.QDRANT_URL, 'http://qdrant:6333', 'http://127.0.0.1:6333'],
      path: '/healthz',
      headers: process.env.QDRANT_API_KEY ? { 'api-key': process.env.QDRANT_API_KEY } : undefined,
      severityWhenDown: 'fail',
    }),
    probeService(fetchImpl, {
      key: 'tasks',
      label: 'Objectives Engine',
      candidates: [process.env.TASKS_SERVICE_URL, 'http://tasks:3104', 'http://127.0.0.1:3104'],
      severityWhenDown: 'warn',
    }),
    probeService(fetchImpl, {
      key: 'quoxflow',
      label: 'Workflow Engine',
      candidates: [process.env.QUOXFLOW_URL, 'http://quoxflow:3200', 'http://127.0.0.1:3200'],
      severityWhenDown: 'warn',
    }),
    probeService(fetchImpl, {
      key: 'bastion',
      label: 'QuoxBastion',
      candidates: [process.env.BASTION_URL, 'http://127.0.0.1:9850'],
      path: '/api/v1/health',
      severityWhenDown: 'warn',
    }),
  ]);

  services.collector = collector;
  services.files = files;
  services.qdrant = qdrant;
  services.tasks = tasks;
  services.quoxflow = quoxflow;
  const optionalCapabilities = getOptionalCapabilityManifest();
  services.bastion = optionalCapabilities.bastion?.installed
    ? bastion
    : {
        key: 'bastion',
        label: 'QuoxBastion',
        status: 'absent',
        detail: 'Not installed for this deployment',
        url: null,
      };

  const coreShellReady = ['auth', 'collector'].every((key) => services[key]?.status === 'pass');
  const fullPlatformReady = coreShellReady && ['files', 'qdrant', 'tasks', 'quoxflow'].every((key) => services[key]?.status === 'pass');
  const degradedFeatures = buildDegradedFeatures(services);
  const optionalFeatureIssues = buildOptionalFeatureIssues(services, optionalCapabilities);

  const readiness = {
    checkedAt: new Date(now).toISOString(),
    coreShellReady,
    fullPlatformReady,
    platformState: fullPlatformReady ? 'full' : coreShellReady ? 'core_only' : 'degraded',
    degradedFeatures,
    optionalFeatureIssues,
    optionalCapabilities,
    serviceClasses: {
      coreShell: ['auth', 'collector'],
      fullPlatform: ['files', 'qdrant', 'tasks', 'quoxflow'],
      optional: ['bastion'],
    },
    services,
  };

  readinessCache = readiness;
  readinessCacheTime = now;
  return readiness;
}

export function clearSetupReadinessCache() {
  readinessCache = null;
  readinessCacheTime = 0;
}
