/**
 * QUOXON E1: GET /api/v1/capabilities, the honest answer to "what can this
 * Quox do here, for me, right now?".
 *
 * Availability comes ONLY from real signals passed in as probes; nothing here
 * ever defaults to "installed". A probe that throws, times out, or answers
 * something unreadable makes the capability `unavailable` with a reason that
 * says we could not check, never a guess in either direction.
 *
 * Reasons are built from fixed templates. Probe error text is never copied
 * into a response, so a URL, header or key in an upstream error cannot leak.
 *
 * Cache: 30 s per org (the org-level facts). permissions_ok and the setup
 * hint's "ask an org admin" are per caller, applied after the cache, so one
 * member's view never leaks into another's.
 *
 * Probes (all async unless noted; injected by server.js, stubbed in tests):
 *   serviceHealth(key) -> { status: 'ok'|'degraded'|'down' }
 *   licence(orgId, pluginId) -> { licensed, failClosed? }
 *   installs(orgId, ctx) -> { ok, rows: [{ plugin_id, is_enabled }] }
 *   providers(orgId) -> { ok, openai, anthropic, claude_subscription, claude_cli (false = no claude binary), ...B5 presets (openrouter, groq, ...) }
 *   mailAccounts(orgId) / calendarConnections(orgId) / devServers(orgId) -> number
 *   collectorEvidence() / lucidReady() / collectorCore() -> boolean (sync)
 */

const { CAPABILITY_CATALOG, SERVICES } = require('./catalog.js');

const TTL_MS = 30_000;
const MAX_ORGS = 500; // bounded cache; oldest org evicted first

const ADMIN_ROLES = new Set(['owner', 'admin']);
const PROVIDER_NAMES = {
  openai: 'OpenAI', anthropic: 'Claude API', claude_subscription: 'Claude subscription',
  // CLI-QUOX B5 presets
  openrouter: 'OpenRouter', huggingface: 'Hugging Face', groq: 'Groq', together: 'Together AI',
  lmstudio: 'LM Studio', vllm: 'vLLM', custom: 'Custom endpoint',
  // QUOXON-PROOF (quox#822): self-hosted Ollama.
  ollama: 'Ollama',
};

const RANK = { installed: 0, requires_setup: 1, unavailable: 2 };

function verdict(availability, reason = null, setup = null, setupNeeds = null) {
  return { availability, reason, setup, setupNeeds };
}

/** Memoise each probe call for one evaluation so 20 capabilities on quoxflow ask once. */
function memo(fn) {
  const m = new Map();
  return (key, ...args) => {
    if (!m.has(key)) m.set(key, Promise.resolve().then(() => fn(...args)));
    return m.get(key);
  };
}

async function checkRequirement(req, orgId, p, ctx) {
  if (req.licence) {
    let r;
    try { r = await p.licence(`lic:${req.licence}`, orgId, req.licence); } catch { r = { failClosed: true }; }
    if (r && r.licensed === true) return verdict('installed');
    if (r && r.failClosed) return verdict('unavailable', `Could not run the licence check for ${req.name} right now; try again shortly`);
    return verdict('unavailable', `${req.name} is not in your plan`, `quox plugin licence ${req.licence}`);
  }
  if (req.service) {
    const svc = SERVICES[req.service] || { label: req.service };
    let h;
    try { h = await p.serviceHealth(`svc:${req.service}`, req.service); } catch { h = { status: 'down' }; }
    if (h && h.status === 'ok') return verdict('installed');
    if (h && h.status === 'degraded') return verdict('unavailable', `${svc.label} is running but not healthy`);
    return verdict('unavailable', `${svc.label} not running or not reachable from this QuoxCORE`);
  }
  if (req.install) {
    let r;
    try { r = await p.installs('installs', orgId, ctx); } catch { r = null; }
    // Unreadable install list: say nothing about install state (licence and
    // service checks above still decide). Never invent "installed" or "missing".
    if (!r || !r.ok || !Array.isArray(r.rows)) return verdict('installed');
    const row = r.rows.find((x) => x && x.plugin_id === req.install);
    if (!row) return verdict('requires_setup', `The ${req.name} plugin is not installed for your org`, 'Dashboard: Plugins (an org admin installs it)', 'admin');
    if (!row.is_enabled) return verdict('requires_setup', `${req.name} is turned off for your org`, `quox plugin update ${req.install} --enable`, 'admin');
    return verdict('installed');
  }
  if (req.provider) {
    let r;
    try { r = await p.providers('providers', orgId); } catch { r = null; }
    if (!r || r.ok !== true) return verdict('unavailable', 'Could not read AI provider status right now');
    if (req.provider === 'any') {
      if (Object.keys(PROVIDER_NAMES).some((k) => r[k] === true)) return verdict('installed');
      return verdict('requires_setup', 'No AI provider connected');
    }
    // Z2H-425: public prebuilt images ship without the Claude CLI; a Claude sign-in cannot work there.
    if (req.provider === 'claude_subscription' && r.claude_cli === false) {
      return verdict('unavailable', 'needs a local build (Claude CLI not in prebuilt images)');
    }
    if (r[req.provider]) return verdict('installed');
    // null = this provider's status could not be read (B5 presets on a vault error).
    if (r[req.provider] === null) return verdict('unavailable', `Could not read ${PROVIDER_NAMES[req.provider] || req.provider} status right now`);
    return verdict('requires_setup', `${PROVIDER_NAMES[req.provider] || req.provider} not connected`);
  }
  if (req.count) {
    let n;
    try { n = await p[req.count](`count:${req.count}`, orgId); } catch { n = null; }
    if (typeof n !== 'number' || Number.isNaN(n)) return verdict('unavailable', `Could not check: ${req.none.replace(/ yet$/, '').toLowerCase()}`);
    if (n > 0) return verdict('installed');
    return verdict('requires_setup', req.none, req.setup || null, req.setupNeeds || null);
  }
  if (req.check) {
    let ok = false;
    try { ok = (await p[req.check](`check:${req.check}`)) === true; } catch { ok = false; }
    return ok ? verdict('installed') : verdict('unavailable', req.fail);
  }
  return verdict('unavailable', 'Unknown requirement');
}

async function evaluateOne(cap, orgId, p, ctx) {
  const base = {
    id: cap.id,
    name: cap.name,
    intent: cap.intent,
    evidence: cap.evidence,
    interfaces: cap.interfaces,
  };
  if (cap.planned) {
    return { ...base, availability: 'planned', reason: 'Planned, not built yet', setup: null, _setupNeeds: null };
  }
  const results = [];
  for (const req of cap.requires || []) {
    // Sequential on purpose: a licence refusal should not fan out to the
    // service health of a plugin the org cannot use.
    const v = await checkRequirement(req, orgId, p, ctx);
    results.push(v);
    if (v.availability === 'unavailable') break;
  }
  if (!results.length) {
    return { ...base, availability: 'unavailable', reason: 'No signal to check', setup: null, _setupNeeds: null };
  }
  let worst = results[0];
  for (const v of results) if (RANK[v.availability] > RANK[worst.availability]) worst = v;
  const setup = worst.availability === 'requires_setup' ? (worst.setup || cap.setup || null) : (worst.setup || null);
  const setupNeeds = worst.availability === 'requires_setup' ? (worst.setupNeeds || cap.setupNeeds || null) : null;
  return { ...base, availability: worst.availability, reason: worst.reason, setup, _setupNeeds: setupNeeds };
}

function createCapabilitiesService({ probes, ttlMs = TTL_MS, now = () => Date.now(), catalog = CAPABILITY_CATALOG } = {}) {
  if (!probes) throw new TypeError('probes are required');
  const cache = new Map(); // orgId -> { at, value }
  const inflight = new Map();

  async function compute(orgId, ctx) {
    // Each p.<probe>(memoKey, ...args) calls probes.<probe>(...args) once per evaluation.
    const missing = async () => { throw new Error('probe not wired'); };
    const p = {};
    for (const name of ['serviceHealth', 'licence', 'installs', 'providers', 'mailAccounts', 'calendarConnections', 'devServers']) {
      p[name] = memo(typeof probes[name] === 'function' ? (...args) => probes[name](...args) : missing);
    }
    for (const name of ['collectorEvidence', 'lucidReady', 'collectorCore']) {
      p[name] = async () => (typeof probes[name] === 'function' ? probes[name]() : false);
    }
    const capabilities = await Promise.all(catalog.map((cap) => evaluateOne(cap, orgId, p, ctx)));
    return { capabilities, computed_at: new Date(now()).toISOString() };
  }

  async function evaluate(orgId, ctx = {}) {
    if (!orgId) throw new TypeError('orgId is required');
    const hit = cache.get(orgId);
    if (hit && now() - hit.at < ttlMs) return { ...hit.value, cached: true };
    if (inflight.has(orgId)) return inflight.get(orgId);
    const job = compute(orgId, ctx).then((value) => {
      cache.delete(orgId);
      cache.set(orgId, { at: now(), value });
      while (cache.size > MAX_ORGS) cache.delete(cache.keys().next().value);
      return { ...value, cached: false };
    }).finally(() => inflight.delete(orgId));
    inflight.set(orgId, job);
    return job;
  }

  return { evaluate, invalidate: (orgId) => (orgId ? cache.delete(orgId) : cache.clear()) };
}

/** Per-caller view: permissions_ok and the setup hint, never cached across callers. */
function forCaller(capabilities, caller) {
  const isAdmin = caller.isService || ADMIN_ROLES.has(String(caller.role || '').toLowerCase());
  const isMember = caller.isService || Boolean(caller.role) && String(caller.role).toLowerCase() !== 'viewer';
  return capabilities.map(({ _setupNeeds, ...c }) => {
    let permissionsOk = isMember || c.availability === 'planned';
    let setup = c.setup;
    if (c.availability === 'requires_setup' && _setupNeeds === 'admin') {
      permissionsOk = isAdmin;
      if (!isAdmin && setup) setup = `${setup} (ask an org admin)`;
    }
    return { ...c, setup, permissions_ok: permissionsOk };
  });
}

/**
 * The org comes ONLY from the verified token for a user. A service-key caller
 * names the org with X-Org-Id (same convention as the other service+org reads
 * in server.js). Query/body org params are ignored for users.
 */
function resolveCallerOrg(req) {
  if (req.user && req.user.org_id) return req.user.org_id;
  if (req.service) return (req.headers && req.headers['x-org-id']) || null;
  return null;
}

function createCapabilitiesHandler({ service }) {
  return async function capabilitiesHandler(req, res) {
    const orgId = resolveCallerOrg(req);
    if (!orgId) return res.status(401).json({ error: 'Organisation context required for capabilities' });
    try {
      // A user's own credentials, forwarded only to read their org's plugin
      // install rows (member-readable in auth). Service callers forward nothing.
      const ctx = req.user ? { authHeader: req.headers?.authorization, cookie: req.headers?.cookie } : {};
      const out = await service.evaluate(orgId, ctx);
      const caller = { role: req.user ? req.user.dashboardRole : null, isService: !req.user && Boolean(req.service) };
      res.set('Cache-Control', 'private, max-age=30');
      return res.json({
        org_id: orgId,
        computed_at: out.computed_at,
        cached: out.cached,
        ttl_seconds: TTL_MS / 1000,
        capabilities: forCaller(out.capabilities, caller),
      });
    } catch {
      return res.status(500).json({ error: 'Could not compute capabilities' });
    }
  };
}

module.exports = {
  CAPABILITY_CATALOG,
  SERVICES,
  createCapabilitiesService,
  createCapabilitiesHandler,
  forCaller,
  resolveCallerOrg,
};
