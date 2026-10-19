/**
 * BOB Agent Tools (DEVSUITE-HUB Phase 4)
 *
 * BOB is the Quox Dev Suite's own agent, bound to DevServersHub's right
 * sidebar (InfraView -> InfraChatSidebar, the same agent-switcher DAEDALUS/
 * WARDEN/CIPHER already use there). Per the plan doc
 * (docs/STREAM_DEVSUITE_HUB_PLAN.md, DEVSUITE-HUB phase 4): "Tools: build
 * status/history, log tail diagnosis, preflight, gripe filing, post-deploy
 * verification (container alive + HTTP probe) before calling any build
 * green. Actions are HITL-gated; failure alerts can fan out to Telegram.
 * Pull-only, no scheduled LLM loops."
 *
 * Deliberate reuse, not duplication:
 *  - build status/history wrap the EXISTING build_receipts store (DEVSUITE-
 *    BUILD Phase 1, GET /api/v1/build-status + /api/v1/build-receipts,
 *    lib/buildReceiptsStore.js) — no new store, self-fetch through the
 *    collector's own routes with X-Service-Key, same shape as
 *    qlarityTools.js's qlarityCall helper.
 *  - gripe filing is NOT wrapped here at all: BOB is granted the same
 *    connector family ('github') GRIPE already has, and calls the SAME
 *    github_create_issue connector tool with the same conversational
 *    confirm-before-file discipline (see bob.json's systemPromptAdditions).
 *    Wrapping it a second time here would be the "second issue-filing path"
 *    the plan explicitly says not to build.
 *  - post-deploy verification reuses two things that already exist rather
 *    than inventing a new probe: the local Docker socket (already mounted
 *    into this container at /var/run/docker.sock for scriptExecutor.js's
 *    sandbox runs, `dockerode` already a collector dependency) for
 *    container-alive, and the exact same internal service URLs server.js's
 *    own GET /api/v1/health/aggregate already uses (AUTH_SERVICE_URL,
 *    MEMORY_SERVICE_URL, QUOXFLOW_URL, etc.) for the HTTP probe half.
 *    src/config/serviceRegistry.js (the frontend's health-check metadata)
 *    was checked first — it is an ES module keyed off import.meta.env and
 *    is not requireable from this CommonJS backend, so its healthEndpoint
 *    values are mirrored narrowly into BOB_VERIFY_TARGETS below rather than
 *    imported. 'dashboard' and 'website' have no collector-reachable HTTP
 *    health endpoint today (nginx static / remote Hetzner host respectively)
 *    — verify_deploy is honest about that rather than guessing a URL.
 *
 * Honest gap (checked, not assumed): the build daemon's RAW stdout/stderr
 * log (/tmp/quox-build-log on the host, alongside /tmp/quox-build-history)
 * is real, substantial content — but it lives outside the one host path this
 * container has mounted (~:ro; docker-compose.yml has no /tmp
 * bind for the collector service). bob_log_tail therefore surfaces the
 * build_receipts row's own short `message` field, the only build-outcome
 * text actually reachable from this process today, and says so in its own
 * description and output rather than fabricating a full log tail.
 */

const { hostPath } = require('../utils/runtimePaths.js');
const fsp = require('fs/promises');
const path = require('path');
// dockerode (and its transitive docker-modem -> ssh2 chain, which runs an
// async WASM crypto probe at module load) is required LAZILY inside
// getDocker() below, not here. agentTools.js requires this module at its
// own top level to build BOB_TOOLS, so an eager require('dockerode') here
// meant every agentTools.js load (even a plain tool-definition/config read
// with no Docker use in sight) pulled in ssh2's module-load side effect.
// See quoxai/quox#597.

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://localhost:9848';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
const FETCH_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 4000;

// Repo root as mounted read-only into this container (docker-compose.yml:
// "- $HOME:$HOME:ro"). bob_preflight greps under here.
const HOST_REPO_ROOT = process.env.BOB_PREFLIGHT_REPO_ROOT || hostPath('quox-dashboard');

let _docker = null;
let _dockerOverride = null; // test-only injection, see __setDockerForTesting below
function getDocker() {
  if (_dockerOverride) return _dockerOverride;
  if (!_docker) {
    const Docker = require('dockerode'); // lazy — see note at top of file
    _docker = new Docker();
  }
  return _docker;
}

// MOCKING NOTE: same rationale as test/remoteSsh.test.js's
// __setSshClientForTesting — vitest's module runner does not intercept
// nested CJS require('dockerode') calls transitively in this repo's
// CJS/ESM hybrid setup, so tests inject a stub client directly instead.
function __setDockerForTesting(stub) {
  _dockerOverride = stub;
}

/** Shared self-fetch helper — every read goes through the collector's OWN
 * /api/v1/build-* routes (never a second store), authenticated the same way
 * qlarityTools.js's qlarityCall is (X-Service-Key). */
async function collectorGet(path, { orgId } = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const url = orgId ? `${COLLECTOR_URL}${path}${sep}org_id=${encodeURIComponent(orgId)}` : `${COLLECTOR_URL}${path}`;
  const headers = {};
  if (INTERNAL_SERVICE_KEY) headers['X-Service-Key'] = INTERNAL_SERVICE_KEY;
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`Collector unreachable at ${COLLECTOR_URL} (${err.message}).`);
  }
  let json = null;
  try { json = await res.json(); } catch { /* empty/non-JSON body */ }
  if (!res.ok) {
    const detail = json && json.error ? json.error : `${res.status} ${res.statusText}`;
    throw new Error(`Collector request failed (${res.status}): ${detail}`);
  }
  return json;
}

async function collectorPost(reqPath, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (INTERNAL_SERVICE_KEY) headers['X-Service-Key'] = INTERNAL_SERVICE_KEY;
  let res;
  try {
    res = await fetch(`${COLLECTOR_URL}${reqPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Collector unreachable at ${COLLECTOR_URL} (${err.message}).`);
  }
  let json = null;
  try { json = await res.json(); } catch { /* empty/non-JSON body */ }
  if (!res.ok) {
    const detail = json && json.error ? json.error : `${res.status} ${res.statusText}`;
    throw new Error(`Collector request failed (${res.status}): ${detail}`);
  }
  return json;
}

// ─── bob_verify_deploy target map ──────────────────────────────────────────
// Container names mirror docker-compose.yml's container_name: values
// exactly (checked directly, not guessed). URL builders mirror the exact
// env vars server.js already uses for /api/v1/health/aggregate and its
// /api/v1/<service>/* proxies — no new service-discovery mechanism.
const BOB_VERIFY_TARGETS = {
  collector: { container: 'quox-collector', url: () => 'http://localhost:9848/health' },
  auth: { container: 'quox-auth', url: () => `${process.env.AUTH_SERVICE_URL || 'http://auth:3101'}/health` },
  memory: { container: 'quox-memory', url: () => `${process.env.MEMORY_SERVICE_URL || 'http://memory:3103'}/health` },
  files: { container: 'quox-files', url: () => `${process.env.FILES_SERVICE_URL || 'http://files:3102'}/health` },
  quoxflow: { container: 'quox-quoxflow', url: () => `${process.env.QUOXFLOW_URL || 'http://quoxflow:3200'}/health` },
  repobrain: { container: 'quox-repobrain', url: () => `${process.env.REPOBRAIN_URL || 'http://repobrain:3105'}/healthz` },
  quoxbrain: { container: 'quox-brain', url: () => `${process.env.QUOXBRAIN_URL || 'http://quoxbrain:3106'}/health` },
  quoxplan: { container: 'quox-quoxplan', url: () => `${process.env.QUOXPLAN_URL || 'http://quoxplan:3107'}/health` },
  quoxsignal: { container: 'quox-quoxsignal', url: () => `${process.env.QUOXSIGNAL_URL || 'http://quoxsignal:3108'}/health` },
  qlarity: { container: 'quox-qlarity', url: () => `${process.env.QLARITY_URL || 'http://qlarity:3109'}/health` },
  tasks: { container: 'quox-tasks', url: () => `http://${process.env.TASKS_HOST || 'tasks'}:${process.env.TASKS_PORT || '3104'}/health` },
  'powers-host': { container: 'quox-powers-host', url: () => `${process.env.POWERS_HOST_URL || 'http://powers-host:9849'}/health` },
  // No collector-reachable HTTP health endpoint configured for these today
  // (dashboard is static nginx with no wired health URL; screencap has a
  // /health route but no env var wires it to the collector; website
  // deploys to a remote Hetzner host, not a local container at all).
  dashboard: { container: 'quox-dashboard', url: null },
  screencap: { container: 'quox-screencap', url: null },
  website: { container: null, url: null },
};

async function checkContainerAlive(containerName) {
  if (!containerName) return { checked: false, reason: 'no local container for this target' };
  try {
    const docker = getDocker();
    const containers = await docker.listContainers({ all: true });
    const match = containers.find((c) => (c.Names || []).some((n) => n.replace(/^\//, '') === containerName));
    if (!match) return { checked: true, found: false, alive: false };
    return {
      checked: true,
      found: true,
      alive: match.State === 'running',
      state: match.State,
      status: match.Status,
    };
  } catch (err) {
    return { checked: true, error: `Docker socket unreachable: ${err.message}` };
  }
}

async function probeHttp(url) {
  if (!url) return { checked: false, reason: 'no HTTP health endpoint known for this target' };
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const latency_ms = Date.now() - started;
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON is fine, still a real response */ }
    return { checked: true, ok: res.ok, status: res.status, latency_ms, body };
  } catch (err) {
    return { checked: true, ok: false, error: err.message };
  }
}

// ─── bob_preflight ──────────────────────────────────────────────────────────
// Narrow, deterministic mirror of the /preflight skill's step 2.1
// ("direct importers: grep for import.*from.*<filename> and
// require('<filename>') across the repo") plus a registry-membership check
// for the three hub registries most likely to matter for a dev-suite agent.
// No semantic analysis, no report synthesis (that is the calling agent's
// job once it has these facts) — just the grep facts.
const REGISTRY_FILES = [
  'src/config/agentRegistry.js',
  'src/services/entityRegistry.js',
  'src/config/plugins/index.js',
];

// SEC-AUDIT (2026-08-11) S3 — isPathSafe existed to validate `file`, but
// grepImporters is actually invoked with path.basename(file) (see its call
// site in bob_preflight's execute below), so this check never validated
// what was actually used — dead validation, not a real vulnerability
// (execFile below uses an array argv, so there is no shell-injection surface
// either way; grep only ever receives a bare, already-basenamed filename as
// one argv element). Removed rather than kept as a misleading no-op — a
// check that looks like it's guarding something it isn't is worse than no
// check, because the next person to touch this reads it as a real gate.

async function grepImporters(fileName) {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);
  // ES imports routinely drop the extension (`from './capabilityPanelRegistry'`,
  // not '...Registry.js') — search on the bare name with an OPTIONAL trailing
  // extension so a real import isn't missed just because it's extensionless.
  const bareName = fileName.replace(/\.(js|jsx|ts|tsx|json)$/i, '');
  const escaped = bareName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const extSuffix = `(\\.(js|jsx|ts|tsx))?`;
  // Match both `from '...bareName[.ext]'` and `require('...bareName[.ext]')`,
  // case-sensitive, across src/ and services/.
  const pattern = `(from ['"][^'"]*${escaped}${extSuffix}['"]|require\\(['"][^'"]*${escaped}${extSuffix}['"]\\))`;
  try {
    // SEC-AUDIT (2026-08-11) S3 — two real bugs fixed here:
    //  1. No --exclude-dir meant a grep for a common filename (e.g.
    //     'server.js') matched dozens of unrelated hits inside
    //     node_modules/dist/.git — all noise, zero real importers, so
    //     bob_preflight's answer was simply wrong for any name that happens
    //     to also exist in a vendored package.
    //  2. maxBuffer: 1MB was too small for a real repo-wide grep and threw
    //     "maxBuffer length exceeded" on common filenames (e.g. 'index.js'),
    //     turning a legitimate blast-radius check into a hard failure.
    const { stdout } = await execFileAsync('grep', [
      '-rnsE',
      '--exclude-dir=node_modules',
      '--exclude-dir=dist',
      '--exclude-dir=.git',
      pattern,
      path.join(HOST_REPO_ROOT, 'src'),
      path.join(HOST_REPO_ROOT, 'services'),
    ], { maxBuffer: 5 * 1024 * 1024 });
    return stdout.split('\n').filter(Boolean).map((line) => line.replace(HOST_REPO_ROOT + '/', ''));
  } catch (err) {
    // grep exits 1 with empty stdout when there are zero matches — not an error.
    if (err && err.code === 1 && !err.stdout) return [];
    // grep exits 2 when ANY file under the tree was unreadable or vanished mid-walk (the mounted repo is a
    // live working tree other sessions rewrite), even though it found matches. The matches are still the
    // answer; failing the whole blast-radius check over one unreadable file hid every real importer.
    if (err && err.code === 2 && err.stdout) return String(err.stdout).split('\n').filter(Boolean).map((line) => line.replace(HOST_REPO_ROOT + '/', ''));
    throw new Error(`grep failed: ${err.message}`);
  }
}

async function grepRegistryMembership(name) {
  const hits = [];
  for (const rel of REGISTRY_FILES) {
    const abs = path.join(HOST_REPO_ROOT, rel);
    try {
      const content = await fsp.readFile(abs, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (line.includes(name)) hits.push(`${rel}:${idx + 1}`);
      });
    } catch {
      // registry file unreadable/missing — skip, not a hard failure.
    }
  }
  return hits;
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

const BOB_TOOLS = {

  bob_build_status: {
    name: 'bob_build_status',
    description: 'Get the most recent build receipt per target from the durable build_receipts store (the same data GET /api/v1/build-status returns, and quox-build status shows). Reflects the last COMPLETED outcome per target only — does not show a currently-in-flight build.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Optional: filter to a single target (e.g. dashboard, collector).' },
      },
      required: [],
    },
    execute: async ({ target } = {}, ctx) => {
      try {
        const data = await collectorGet('/api/v1/build-status', { orgId: ctx && ctx.orgId });
        const targets = target ? (data.targets || []).filter((t) => t.target === target) : (data.targets || []);
        return { success: true, count: targets.length, targets, note: data.note };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  bob_build_history: {
    name: 'bob_build_history',
    description: 'List recent build receipts (newest first) from the durable build_receipts store, the same data GET /api/v1/build-receipts returns. Optionally filter by target and/or result.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Optional: filter to a single target.' },
        result: { type: 'string', description: "Optional: filter to a result value, e.g. 'ok', 'FAIL', 'UNVERIFIED'." },
        limit: { type: 'number', description: 'Max rows to return (default 50, max 500).' },
      },
      required: [],
    },
    execute: async ({ target, result, limit } = {}, ctx) => {
      try {
        const qs = new URLSearchParams();
        if (target) qs.set('target', target);
        if (result) qs.set('result', result);
        if (limit) qs.set('limit', String(limit));
        const q = qs.toString();
        const data = await collectorGet(`/api/v1/build-receipts${q ? `?${q}` : ''}`, { orgId: ctx && ctx.orgId });
        return { success: true, count: data.count, receipts: data.receipts };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  bob_log_tail: {
    name: 'bob_log_tail',
    description: "Surface the most recent build receipt(s)' own short `message` field for a target — the closest thing to a log tail actually reachable from this process. This is NOT the daemon's raw stdout/stderr build log: that file (/tmp/quox-build-log) lives on the host filesystem outside the collector container's mounts and cannot be read from here today. Always present this as a receipt summary, not a full log, and say so if the caller asked for a full log.",
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Build target to look up (e.g. dashboard, collector).' },
        count: { type: 'number', description: 'How many recent receipts to surface (default 3, max 20).' },
      },
      required: ['target'],
    },
    execute: async ({ target, count } = {}, ctx) => {
      if (!target) return { success: false, error: 'target is required' };
      const n = Math.max(1, Math.min(Number(count) || 3, 20));
      try {
        const data = await collectorGet(`/api/v1/build-receipts?target=${encodeURIComponent(target)}&limit=${n}`, { orgId: ctx && ctx.orgId });
        const receipts = data.receipts || [];
        return {
          success: true,
          target,
          full_log_available: false,
          reason: 'Raw build stdout/stderr lives at /tmp/quox-build-log on the host, not mounted into this container. Only each receipt\'s own short message is available.',
          entries: receipts.map((r) => ({
            created_at: r.created_at,
            result: r.result,
            message: r.message,
            duration_seconds: r.duration_seconds,
            terminal: r.terminal,
          })),
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  bob_preflight: {
    name: 'bob_preflight',
    description: "Narrow blast-radius check for a file: greps the mounted repo for direct importers (`import ... from` / `require(...)`) and checks whether a name appears in the three hub registries (agentRegistry.js, entityRegistry.js, plugins/index.js). Mirrors the /preflight skill's deterministic step (direct importers + registry references), not its full synthesised report.",
    input_schema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: "Relative path or bare filename to find importers of, e.g. 'capabilityPanelRegistry.js' or 'src/config/agentRegistry.js'." },
        registry_name: { type: 'string', description: 'Optional: also check whether this exact string (e.g. an agent id or plugin name) appears in the known registry files.' },
      },
      required: ['file'],
    },
    execute: async ({ file, registry_name } = {}) => {
      if (!file) return { success: false, error: 'file is required' };
      // grepImporters only ever receives this basename — a bare filename
      // passed as one execFile argv element, never a path, never
      // shell-interpreted. See grepImporters' own header comment (S3) for
      // why a separate path-containment check on `file` was dead code.
      const fileName = path.basename(file);
      try {
        const importers = await grepImporters(fileName);
        const result = { success: true, file: fileName, importers, importer_count: importers.length };
        if (registry_name) {
          result.registry_hits = await grepRegistryMembership(registry_name);
        }
        return result;
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  bob_verify_deploy: {
    name: 'bob_verify_deploy',
    description: "Independently verify a target actually came up: checks the local Docker socket for whether the container is running, and (where a health endpoint is known) makes a real HTTP GET against it. This is the check that turns a build daemon's 'ok' receipt into an actually-verified deploy — always run this before telling the user something is live. Honest about targets with no reachable local container (website, a remote Hetzner deploy) or no known HTTP health endpoint (dashboard, screencap).",
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: `Build target to verify. Known targets: ${Object.keys(BOB_VERIFY_TARGETS).join(', ')}.` },
      },
      required: ['target'],
    },
    execute: async ({ target } = {}) => {
      if (!target) return { success: false, error: 'target is required' };
      const cfg = BOB_VERIFY_TARGETS[target];
      if (!cfg) {
        return {
          success: true,
          target,
          verified: false,
          reason: `No verification mapping known for target "${target}". Known targets: ${Object.keys(BOB_VERIFY_TARGETS).join(', ')}.`,
        };
      }
      const container = await checkContainerAlive(cfg.container);
      const http = await probeHttp(cfg.url ? cfg.url() : null);
      const verified = !!(container.alive && (http.checked ? http.ok : true));
      // SEC-AUDIT (2026-08-11) S6 — the old summary always said "container
      // not running or not found" for ANY non-alive container, even a target
      // like website (BOB_VERIFY_TARGETS.website.container === null) whose
      // real reason is checkContainerAlive's own honest
      // { checked: false, reason: 'no local container for this target' } —
      // there is no container to be running or not-running in the first
      // place. Bob's own LLM quotes this summary verbatim, so the false
      // "not running" framing misled anyone asking "is the website up?".
      let containerReason = null;
      if (!container.alive) {
        if (!container.checked) {
          containerReason = container.reason || 'no local container known for this target';
        } else if (container.error) {
          containerReason = `container check failed: ${container.error}`;
        } else {
          containerReason = 'container not running or not found';
        }
      }
      return {
        success: true,
        target,
        container,
        http,
        verified,
        summary: verified
          ? `${target}: container alive${http.checked ? `, HTTP ${http.status}` : ' (no HTTP probe configured)'}.`
          : `${target}: NOT verified — ${containerReason || `HTTP probe failed (${http.error || http.status})`}.`,
      };
    },
  },

  bob_detect_repeated_failures: {
    name: 'bob_detect_repeated_failures',
    description: "Compute the CURRENT consecutive-failure streak for a target from the real build_receipts history (the same data bob_build_history reads): starting from the most recent receipt and walking backward, count how many receipts in a row are 'FAIL' (case-insensitive) before hitting a non-FAIL result or running out of history. Three-way classification, not a binary: 'ok' means healthy and stops the count; 'FAIL' extends the streak; anything else (e.g. 'UNVERIFIED' — a build that ran but whose post-deploy health check was merely inconclusive, not a build failure) also stops the count WITHOUT extending it and WITHOUT being treated as healthy either — it is neutral/inconclusive, not a failure. When the target has zero receipts at all, the response carries no_data:true (streak/exceeds_threshold still read 0/false for back-compat, but callers must not read that as 'this target is healthy' — there is simply no history to judge it by). Deterministic, no LLM judgment — real computed data, not an estimate. Use this whenever discussing a target's build status/history: if exceeds_threshold is true, that is a real repeated-failure pattern worth proactively surfacing and offering to file a gripe about (via github_create_issue, same confirm-before-file discipline as any other gripe).",
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Build target to check (e.g. dashboard, collector).' },
        threshold: { type: 'number', description: 'Consecutive-failure count that counts as a repeated-failure pattern worth flagging (default 3).' },
      },
      required: ['target'],
    },
    execute: async ({ target, threshold } = {}, ctx) => {
      if (!target) return { success: false, error: 'target is required' };
      const t = Math.max(1, Math.floor(Number(threshold) || 3));
      // Window large enough to find a real streak boundary without pulling
      // the entire history — mirrors bob_log_tail's own bounded-fetch style.
      const FETCH_LIMIT = 100;
      try {
        const data = await collectorGet(`/api/v1/build-receipts?target=${encodeURIComponent(target)}&limit=${FETCH_LIMIT}`, { orgId: ctx && ctx.orgId });
        const receipts = data.receipts || []; // newest first, per listBuildReceipts()

        // SEC-AUDIT (2026-08-11) S4(a) — zero receipts previously returned
        // streak:0, exceeds_threshold:false, identical to a genuinely
        // healthy target with real 'ok' history. no_data:true lets a caller
        // (bob's own prompt logic) say "no build history for X" instead of
        // implying health.
        if (receipts.length === 0) {
          return {
            success: true,
            target,
            streak: 0,
            threshold: t,
            exceeds_threshold: false,
            no_data: true,
            recent_results: [],
          };
        }

        // SEC-AUDIT (2026-08-11) S4(b) — only a real 'FAIL' extends the
        // streak. Previously ANY non-'ok' result (including 'UNVERIFIED' —
        // build fine, health probe merely inconclusive) extended it, so 3
        // consecutive UNVERIFIED results scored as a 3-failure streak and
        // could trigger a spurious "repeated build failure" gripe for
        // something that was never a build failure. 'ok' and any other
        // non-FAIL value both stop the walk (as before), but only 'FAIL'
        // ever increments the count.
        let streak = 0;
        for (const r of receipts) {
          if (String(r.result || '').toLowerCase() === 'fail') {
            streak += 1;
            continue;
          }
          break;
        }
        return {
          success: true,
          target,
          streak,
          threshold: t,
          exceeds_threshold: streak >= t,
          recent_results: receipts.map((r) => ({ created_at: r.created_at, result: r.result, message: r.message })),
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  bob_mark_build_outcome: {
    name: 'bob_mark_build_outcome',
    description: "Record BOB's own independently-verified outcome for a target as a new build receipt (terminal: 'bob'), after running bob_verify_deploy. This ALWAYS routes through the approval gate — it never resolves directly, it only ever proposes; a human must confirm before the receipt is actually written.",
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Build target this outcome is for.' },
        result: { type: 'string', description: "Outcome to record, e.g. 'ok', 'FAIL', 'UNVERIFIED'." },
        message: { type: 'string', description: "Short note explaining the verdict, e.g. 'container alive, health 200'." },
      },
      required: ['target', 'result'],
    },
    execute: async (input, ctx) => {
      const { target, result, message } = input || {};
      if (!target || !result) return { success: false, error: 'target and result are required' };
      const { withApprovalGate } = require('./approvalGate');
      return withApprovalGate('bob_mark_build_outcome', input, async () => {
        try {
          const data = await collectorPost('/api/v1/build-receipts', {
            target,
            result,
            terminal: 'bob',
            message: message || `BOB-verified outcome: ${result}`,
          });
          return { success: true, receipt: data.receipt };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }, ctx || {});
    },
  },
  // QUOXIFY pass 2 (DEVSUITE phase 15). BOB could READ everything about a
  // build and do nothing about it, which is the "backend richer than the
  // surface" pattern the audit found across the bundle. These two close it.
  //
  // Note the split the plan is explicit about: the QuoxBuild EXECUTOR stays a
  // deterministic feature with no LLM anywhere in the build path. BOB is its
  // agent LAYER. So this tool only ever NAMES a pre-registered target that
  // lives host-side, exactly as the dispatch envelope does; it can never
  // supply a command. If the envelope could carry the command, dev.build
  // would be a remote root shell with a queue in front of it.
  bob_build_targets: {
    name: 'bob_build_targets',
    description: 'List the build targets registered on a dev server. Targets are pre-registered host-side; a build can only ever name one of these, never supply its own command. Use this before dispatching so you name a target that exists, and to answer "what can I build here?" or "what can I build on my dev server?". host_id is optional: leave it out and the org\'s registered dev server with builds enabled is used; with several, the targets of each are listed. Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        host_id: { type: 'string', description: 'The registered dev server host id. Optional: omit it to use the org\'s registered dev server.' },
      },
    },
    execute: async (input, ctx) => {
      let host_id = input && input.host_id;
      try {
        // 4.2.4 t3-build-targets: "my registered dev server" names no host. Resolve it from the org's dev servers
        // with dev.build enabled; never guess between several.
        if (!host_id) {
          const list = await collectorGet('/api/v1/dev-servers', { orgId: ctx && ctx.orgId });
          const builders = (Array.isArray(list && list.servers) ? list.servers : [])
            .filter((s) => Array.isArray(s.enabled_capabilities) && s.enabled_capabilities.includes('dev.build'))
            .map((s) => ({ host_id: s.host_id, hostname: s.hostname || null }));
          if (builders.length === 0) {
            return { success: false, error: 'There is no registered dev server with builds (dev.build) enabled in this org, so there are no build targets to list.' };
          }
          // Live 2026-10-19 (ev_mvfky00t_52df33): three servers, and the turn stopped to ask which. Listing is a read,
          // so it needs no pick: read each server's targets (bounded). If none can be read, name them and ask.
          if (builders.length > 1 && builders.length <= 5) {
            const servers = await Promise.all(builders.map(async (b) => {
              try {
                const d = await collectorGet(`/api/v1/dev-build/${encodeURIComponent(b.host_id)}/targets`, { orgId: ctx && ctx.orgId });
                const targets = Array.isArray(d && d.targets) ? d.targets : [];
                return { ...b, count: targets.length, targets };
              } catch (err) {
                return { ...b, error: err.message };
              }
            }));
            if (servers.some((s) => !s.error)) {
              return {
                success: true,
                servers,
                note: `This org has ${builders.length} dev servers with builds enabled; the targets of each are listed. A build names one server and one of its targets.`,
              };
            }
          }
          if (builders.length > 1) {
            return {
              success: false,
              dev_servers: builders,
              error: `This org has ${builders.length} registered dev servers with builds enabled (${builders.map((b) => b.host_id).join(', ')}). Ask the user which one, then call again with its host_id.`,
            };
          }
          host_id = builders[0].host_id;
        }
        const data = await collectorGet(`/api/v1/dev-build/${encodeURIComponent(host_id)}/targets`, { orgId: ctx && ctx.orgId });
        const targets = Array.isArray(data && data.targets) ? data.targets : [];
        return {
          success: true,
          host_id,
          count: targets.length,
          targets,
          note: targets.length === 0
            ? 'No build targets are registered on this host. Registering one is a host-side action, so this is not something an agent can fix from here.'
            : undefined,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  bob_dispatch_build: {
    name: 'bob_dispatch_build',
    // QUOXTRUST C2/WP2: reaches outside the box — durable intent gated at the choke.
    externalEffect: true,
    // Approval gate runs INSIDE execute — the dispatch stamp lands at the real
    // effect boundary via ctx._markDispatched (approvalGate), not pre-execute.
    gatedInExecute: true,
    description: "Queue a build of a PRE-REGISTERED target on a registered dev server. The dispatch is oracle-signed and delivered over Bastion, and the host only accepts a target it already knows. ALWAYS goes through the approval gate: you propose the build, a human resolves it, so report it as requested and NOT as building or built. Remember the house rule that queued is not built and built is not verified: after a build actually runs, use bob_verify_deploy before calling anything green.",
    input_schema: {
      type: 'object',
      properties: {
        host_id: { type: 'string', description: 'The registered dev server host id.' },
        target: { type: 'string', description: 'A target from bob_build_targets. Must already be registered host-side.' },
        message: { type: 'string', description: 'Why this build is being requested. Recorded with the dispatch.' },
      },
      required: ['host_id', 'target'],
    },
    execute: async (input, ctx) => {
      const { host_id, target, message } = input || {};
      if (!host_id || !target) return { success: false, error: 'host_id and target are required' };
      // QUOXIFY pass 3: the READ half of the learning loop. Repeated build
      // failures were recorded as wisdom when they happened; this is where
      // that gets spent. Surfaced BEFORE the approval so the human deciding
      // whether to approve sees the pattern, not after they have said yes.
      // An empty advisory means "nothing known", never "safe".
      let advisory = [];
      try {
        advisory = await require('./buildLearning.js').getBuildAdvisory({ orgId: ctx && ctx.orgId, target });
      } catch { /* advisory is a bonus, never a blocker */ }

      const { withApprovalGate } = require('./approvalGate');
      return withApprovalGate('bob_dispatch_build', input, async () => {
        try {
          const data = await collectorPost(`/api/v1/dev-build/${encodeURIComponent(host_id)}/dispatch`, {
            target,
            message: message || 'dispatched by BOB',
          });
          return {
            success: true,
            host_id,
            target,
            dispatched: true,
            advisory: advisory.length ? advisory : undefined,
            advisory_note: advisory.length
              ? 'This target has a recorded repeated-failure pattern. Say so before reporting the dispatch as routine.'
              : undefined,
            queued_note: 'QUEUED, not built. Check bob_build_status for the receipt, then bob_verify_deploy before calling it green.',
            result: data || null,
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }, ctx || {});
    },
  },
};

function getBobToolDefinitions() {
  return Object.values(BOB_TOOLS).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

function executeBobTool(name, input, ctx) {
  const tool = BOB_TOOLS[name];
  if (!tool) throw new Error(`Unknown bob tool: ${name}`);
  return tool.execute(input || {}, ctx || {});
}

module.exports = {
  BOB_TOOLS,
  BOB_VERIFY_TARGETS,
  getBobToolDefinitions,
  executeBobTool,
  __setDockerForTesting,
};
