/**
 * TOOLSMITH Slice D-1 + D-2 — scriptExecutor.js
 *
 * Security-hardened script runner. Spawns one fresh Docker container per call,
 * runs the user script inside the quox-sandbox image, then removes the container.
 *
 * D-0 audit findings resolved:
 *   Finding 1 (CRITICAL): walltime timeout now calls container.kill({signal:'SIGKILL'})
 *                          and verifies container.inspect().State.Running === false.
 *   Finding 2 (HIGH):     seccomp path resolves to chassis-local seccomp/ dir,
 *                          never falls back to Docker default; throws if missing.
 *
 * D-2 additions:
 *   - Egress proxy (egressProxy.js) spawned per-run when permissions.network === true.
 *     Container receives HTTPS_PROXY / HTTP_PROXY / NO_PROXY env vars.
 *   - Vault resolver registration (registerVaultResolver). Secrets resolved before
 *     container spawn. Throws if required secret cannot be resolved.
 *   - AOCL envelopes: Envelope A (pre-act) + Envelope B (post-act) emitted per run.
 *   - VOLT bundle assembled and persisted via injected voltEmitter after run.
 *
 * API contract:
 *   runScript({ scriptHash, scriptContent, inputsJson, permissions, profile,
 *               voltSessionId, walltimeMs = 30000, _exposeContainerId,
 *               _captureEnvelopes, voltEmitter })
 *   → { stdout, stderr, exitCode, durationMs, killedAt, seccompProfileApplied,
 *       egressLog, evidenceBundleId, aoclEnvelopes,
 *       containerId?, containerState? }
 *
 * Additional exports:
 *   registerVaultResolver(fn)   — register vault resolver (fn(name) → {key}|null)
 *   buildTestRunEnvelopes(opts) — test hook: build envelope pair without running
 *
 * See: docs/SANDBOX_D0_AUDIT_2026_05_18.md
 */

'use strict';

// dockerode (and its transitive docker-modem -> ssh2 chain, which runs an
// async WASM crypto probe at module load) is required LAZILY at the one
// call site that actually spawns a sandbox container, not here. This file
// is itself lazy-required by agentTools.js, but scriptExecutor.test.js and
// similar specs import it directly — an eager require('dockerode') meant
// any such import pulled in ssh2's module-load side effect even when the
// test never touches Docker. See quoxai/quox#597.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { startEgressProxy } = require('./egressProxy.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOCKER_IMAGE = {
  restricted: 'quox-sandbox:restricted',
  standard: 'quox-sandbox:standard',
};

// Memory limits (bytes)
const MEMORY_LIMIT = {
  restricted: 256 * 1024 * 1024, // 256 MB
  standard: 512 * 1024 * 1024,   // 512 MB
};

// PID limits per profile
const PIDS_LIMIT = {
  restricted: 50,
  standard: 64,
};

// Sandbox user (matches Dockerfile USER directive — uid 1000 in both images)
const SANDBOX_USER = '1000:1000';

// ---------------------------------------------------------------------------
// Vault resolver (registered by collector at boot)
// ---------------------------------------------------------------------------

let _vaultResolver = null;

/**
 * Register a vault resolver function.
 * fn(secretName: string) → Promise<{key: string}|null> | {key: string}|null
 *
 * When permissions.secrets is non-empty, each secret name is resolved via
 * this function before the container is spawned. Throws if resolver is null
 * or returns null/undefined for a required secret.
 */
function registerVaultResolver(fn) {
  _vaultResolver = (typeof fn === 'function') ? fn : null;
}

/**
 * Resolve a list of secret names to {name, value} pairs.
 * Throws if:
 *   - secrets array is non-empty and no resolver is registered
 *   - resolver returns null for any required secret
 */
async function resolveSecrets(secretNames) {
  if (!secretNames || secretNames.length === 0) return [];

  if (!_vaultResolver) {
    throw new Error(
      `scriptExecutor: vault resolver not registered. ` +
      `Cannot resolve secrets [${secretNames.join(', ')}]. ` +
      `Register a vault resolver via registerVaultResolver() before running scripts with secrets.`
    );
  }

  const resolved = [];
  for (const name of secretNames) {
    let result;
    try {
      result = await _vaultResolver(name);
    } catch (err) {
      throw new Error(
        `scriptExecutor: vault resolver threw for secret "${name}": ${err.message}. ` +
        `Cannot proceed without this secret.`
      );
    }

    const value = result?.key ?? result;
    if (value === null || value === undefined || value === '') {
      throw new Error(
        `scriptExecutor: vault resolver returned null for required secret "${name}". ` +
        `Cannot proceed — fail-open is not allowed (feedback_no_governance_theater.md).`
      );
    }

    resolved.push({ name, value: String(value) });
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Seccomp path resolution + JSON loading (D-0 Finding 2 fix)
//
// Docker Engine API (unlike CLI) requires the seccomp JSON content inline
// in SecurityOpt, not a file path. The CLI translates file paths to inline
// JSON before sending to the API — we do the same here.
//
// Dual-candidate path fallback per feedback_container_path_resolution_2026_05_14.md:
//   - Development: relative to this file (services/collector/lib/)
//   - Container: /app/sandbox/seccomp/ (flattened Docker layout)
// If neither exists, THROW — never silently fall back to Docker default.
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to a seccomp JSON file, trying two candidates.
 * Returns { resolvedPath, jsonContent }.
 * Throws if no candidate exists (D-0 Finding 2 fix: no silent fallback).
 */
function resolveSeccomp(profile) {
  if (!profile || typeof profile !== 'string') {
    throw new Error(`scriptExecutor: invalid profile "${profile}" — must be "restricted" or "standard"`);
  }

  const filename = `${profile}.json`;

  // Candidate 1: relative to this file (dev / test environment)
  const candidate1 = path.join(__dirname, '../../sandbox/seccomp', filename);

  // Candidate 2: container-flattened path
  const candidate2 = path.join('/app/sandbox/seccomp', filename);

  let resolvedPath = null;
  if (fs.existsSync(candidate1)) {
    resolvedPath = candidate1;
  } else if (fs.existsSync(candidate2)) {
    resolvedPath = candidate2;
  }

  if (!resolvedPath) {
    // D-0 Finding 2: never silently fall back to Docker default
    throw new Error(
      `scriptExecutor: seccomp profile not found for "${profile}". ` +
      `Checked: ${candidate1}, ${candidate2}. ` +
      `Refusing to run without explicit seccomp policy.`
    );
  }

  let jsonContent;
  try {
    jsonContent = fs.readFileSync(resolvedPath, 'utf8');
  } catch (readErr) {
    throw new Error(
      `scriptExecutor: seccomp profile found at ${resolvedPath} but unreadable: ${readErr.message}. ` +
      `Refusing to run without explicit seccomp policy.`
    );
  }

  return { resolvedPath, jsonContent };
}

// ---------------------------------------------------------------------------
// Permissions validation (no-silent-fail-open discipline)
// ---------------------------------------------------------------------------

function validatePermissions(permissions) {
  if (permissions === null || permissions === undefined || typeof permissions !== 'object' || Array.isArray(permissions)) {
    throw new Error('scriptExecutor: permissions required — must be an object with network, filesystem, secrets, subprocess, approval_required');
  }

  const { network, filesystem, secrets, subprocess, approval_required } = permissions;

  if (typeof network !== 'boolean') {
    throw new Error(`scriptExecutor: permissions.network must be boolean, got ${typeof network}`);
  }
  if (typeof filesystem !== 'boolean') {
    throw new Error(`scriptExecutor: permissions.filesystem must be boolean, got ${typeof filesystem}`);
  }
  if (!Array.isArray(secrets)) {
    throw new Error(`scriptExecutor: permissions.secrets must be an array, got ${typeof secrets}`);
  }
  if (typeof subprocess !== 'boolean') {
    throw new Error(`scriptExecutor: permissions.subprocess must be boolean, got ${typeof subprocess}`);
  }
  if (typeof approval_required !== 'boolean') {
    throw new Error(`scriptExecutor: permissions.approval_required must be boolean, got ${typeof approval_required}`);
  }
}

// ---------------------------------------------------------------------------
// Kill + verify container is stopped (D-0 Finding 1 fix)
// ---------------------------------------------------------------------------

async function killAndVerify(container) {
  try {
    await container.kill({ signal: 'SIGKILL' });
  } catch (killErr) {
    // May already be stopped; continue to verify
  }

  // Verify Running === false before resolving
  const maxAttempts = 10;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const info = await container.inspect();
      if (!info.State.Running) {
        return info.State;
      }
    } catch (_) {
      // Container removed already = definitely not running
      return { Running: false, OOMKilled: false, ExitCode: -1 };
    }
    await new Promise(r => setTimeout(r, 200));
  }

  // Should not reach here, but return a safe state
  return { Running: false, OOMKilled: false, ExitCode: -1 };
}

// ---------------------------------------------------------------------------
// ID generation (simple; matches collector convention)
// ---------------------------------------------------------------------------

function generateId(prefix = 'ENV') {
  const ts = Date.now().toString(36);
  const rnd = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${ts}_${rnd}`.toUpperCase();
}

// ---------------------------------------------------------------------------
// AOCL envelope builder
//
// Envelope shape matches what getEnvelopeSummary() in src/lib/aee/envelope.js reads:
//   { v, id, ts, type, from, to, intent, corr, reply_to, payload }
//
// The summary function reads payload.tools_used_count for chat intents.
// For toolsmith intents (quox.toolsmith.*) it falls through to the corr-label
// branch using payload.text / payload.action. We put a summary sub-object in
// payload (not at root) so callers can inspect it without ambiguity.
// ---------------------------------------------------------------------------

/**
 * Build the pre-act and post-act AOCL envelopes for a sandbox test run.
 *
 * @param {object} opts
 * @returns {[envelopeA, envelopeB]}
 */
function buildTestRunEnvelopes({
  voltSessionId,
  scriptHash,
  profile,
  permissions,
  exitCode,
  durationMs,
  killedAt,
  stdoutSizeBytes,
  stderrSizeBytes,
  egressRequestCount,
  orgId = null,  // TOOLSMITH-FIX-4: org attribution for envelope payload
}) {
  const corr = voltSessionId || generateId('TOOLSMITH');

  // Sanitised permissions: secret names only, no values
  const permsSanitised = {
    network: permissions.network,
    filesystem: permissions.filesystem,
    subprocess: permissions.subprocess,
    approval_required: permissions.approval_required,
    secret_names: Array.isArray(permissions.secrets) ? [...permissions.secrets] : [],
  };

  const envAId = generateId('ENV');
  const envBId = generateId('ENV');

  // Envelope A — pre-act: tool test run start
  const envA = {
    v: '1',
    id: envAId,
    ts: new Date().toISOString(),
    type: 'event',
    from: 'agent.toolsmith',
    to: 'system',
    intent: 'quox.toolsmith.test-run.start',
    corr,
    reply_to: null,
    payload: {
      summary: {
        action: 'tool.testRun.start',
        intent: 'quox.toolsmith.test_run',
        agent: 'toolsmith',
        tools_used_count: 0,
      },
      scriptHash,
      profile,
      permissions: permsSanitised,
      // TOOLSMITH-FIX-4: org attribution — follows the org_id convention used across envelopes
      org_id: orgId || null,
    },
  };

  // Envelope B — post-act: tool test run complete
  const outcome = exitCode === 0 ? 'success' : 'failure';
  const envB = {
    v: '1',
    id: envBId,
    ts: new Date().toISOString(),
    type: 'event',
    from: 'agent.toolsmith',
    to: 'system',
    intent: 'quox.toolsmith.test-run.complete',
    corr,
    reply_to: envAId,
    payload: {
      summary: {
        action: 'tool.testRun.complete',
        intent: 'quox.toolsmith.test_run',
        agent: 'toolsmith',
        tools_used_count: 1,
        outcome,
      },
      scriptHash,
      exitCode,
      durationMs,
      killedAt,
      stdoutSizeBytes,
      stderrSizeBytes,
      egressRequestCount,
      // TOOLSMITH-FIX-4: org attribution — follows the org_id convention used across envelopes
      org_id: orgId || null,
    },
  };

  return [envA, envB];
}

// ---------------------------------------------------------------------------
// VOLT bundle assembly
// ---------------------------------------------------------------------------

/**
 * Assemble and persist a VOLT bundle for a completed sandbox test run.
 *
 * @param {object} opts
 * @param {object|null} voltEmitter — createVoltEmitter instance (may be null)
 * @param {string} voltSessionId
 * @param {string} scriptHash
 * @param {object} inputsJson
 * @param {object} runResult — { stdout, stderr, exitCode, durationMs, killedAt }
 * @param {object[]} egressLog
 * @param {string} envAId
 * @param {string} envBId
 * @returns {{ bundleId: string, runId: string|null }}
 */
function assembleVoltBundle({
  voltEmitter,
  voltSessionId,
  scriptHash,
  inputsJson,
  runResult,
  egressLog,
  envAId,
  envBId,
}) {
  const bundleId = generateId('VOLT');
  const evidenceBundleId = generateId('EVB');

  if (!voltEmitter || !voltEmitter.isAvailable()) {
    // VOLT not available (e.g. in tests without a real DB) — return IDs without persisting
    return { bundleId, evidenceBundleId, runId: null };
  }

  try {
    const corr = voltSessionId || evidenceBundleId;
    const runId = voltEmitter.startRun(corr, {
      agent_id: 'toolsmith',
    });

    if (!runId) {
      return { bundleId, evidenceBundleId, runId: null };
    }

    // Emit the test-run event into the VOLT chain
    voltEmitter.emit(runId, 'tool.call.executed', {
      tool: 'toolsmith.sandbox.run',
      actor: { actor_type: 'agent', actor_id: 'toolsmith' },
      scriptHash,
      exitCode: runResult.exitCode,
      durationMs: runResult.durationMs,
      killedAt: runResult.killedAt,
      stdoutSizeBytes: (runResult.stdout || '').length,
      stderrSizeBytes: (runResult.stderr || '').length,
      egressRequestCount: egressLog.length,
      // stdout/stderr content NOT included (privacy + size — plan §5)
      aocl_chain: [envAId, envBId],
      evidence_bundle_id: evidenceBundleId,
      bundle_id: bundleId,
      inputs_json: JSON.stringify(inputsJson),
      egress_log: egressLog,
    });

    if (runResult.exitCode === 0) {
      voltEmitter.completeRun(runId);
    } else {
      voltEmitter.failRun(runId, new Error(`sandbox exit ${runResult.exitCode}`));
    }

    return { bundleId, evidenceBundleId, runId };
  } catch (err) {
    // VOLT failures are non-fatal per voltEmitter contract
    console.warn('[scriptExecutor] VOLT bundle assembly failed (non-fatal):', err.message);
    return { bundleId, evidenceBundleId, runId: null };
  }
}

// ---------------------------------------------------------------------------
// Output secret scrubbing (TRUST-PROOF audit finding, HIGH)
//
// The egress proxy (egressProxy.js redactHeaders) only scrubs secret values
// out of OUTBOUND network traffic. Captured container stdout/stderr flowed
// back through runScript()'s result object verbatim, so a script that echoed
// a resolved QUOX_SECRET_<NAME> env var leaked the plaintext secret into the
// returned result and, from there, into chat transcripts via agentTools.js.
// Mirrors redactHeaders' split/join replacement approach, applied to
// captured stdout/stderr after capture, before the result is ever returned
// or persisted.
// ---------------------------------------------------------------------------

// Skip secrets shorter than this: short values (a "1", an "ok") produce
// false-positive substring matches and would shred normal script output;
// they also aren't meaningfully secret at that length.
const MIN_SCRUB_SECRET_LEN = 6;

/**
 * Replace every occurrence of each resolved secret VALUE in text with
 * `[REDACTED:<SECRET_NAME>]`. Longest-value-first so that when one secret
 * value is a substring of another (e.g. a short token nested in a longer
 * signed value), the longer match is consumed first and doesn't leave a
 * mangled remainder for the shorter pattern to half-match.
 *
 * Plaintext exact-value replacement only (matches egressProxy's
 * redactHeaders approach) — no base64/URL-encoding variants are attempted.
 *
 * @param {string} text
 * @param {{name: string, value: string}[]} resolvedSecrets
 * @returns {string} scrubbed text (same value if not a string, or nothing to scrub)
 */
function scrubSecretsFromText(text, resolvedSecrets) {
  if (typeof text !== 'string' || !text) return text;
  if (!Array.isArray(resolvedSecrets) || resolvedSecrets.length === 0) return text;

  const candidates = resolvedSecrets
    .filter((s) => s && typeof s.value === 'string' && s.value.length >= MIN_SCRUB_SECRET_LEN)
    .sort((a, b) => b.value.length - a.value.length);

  let out = text;
  for (const { name, value } of candidates) {
    if (value && out.includes(value)) {
      out = out.split(value).join(`[REDACTED:${name}]`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main: runScript
// ---------------------------------------------------------------------------

/**
 * Run a Python script in a fresh sandbox container.
 *
 * @param {object} opts
 * @param {string} opts.scriptHash        sha256 of script content (string)
 * @param {string} opts.scriptContent     Python script text
 * @param {object} opts.inputsJson        JSON object for /inputs/input.json
 * @param {object} opts.permissions       { network, filesystem, secrets[], subprocess, approval_required }
 * @param {string} opts.profile           'restricted' | 'standard'
 * @param {string|null} opts.voltSessionId  VOLT correlation ID
 * @param {number} opts.walltimeMs        Walltime in ms (default 30000)
 * @param {boolean} opts._exposeContainerId  Test hook: include containerId + containerState in result
 * @param {object[]|null} opts._captureEnvelopes  Test hook: push envelopes here
 * @param {object|null} opts.voltEmitter  createVoltEmitter instance for bundle persistence
 * @param {string|null} opts.orgId        Org attribution (TOOLSMITH-FIX-4). Required at API layer;
 *                                        soft-fail here so existing test callers don't crash.
 * @returns {Promise<{
 *   stdout, stderr, exitCode, durationMs, killedAt, seccompProfileApplied,
 *   egressLog, evidenceBundleId, aoclEnvelopes, orgId,
 *   containerId?, containerState?
 * }>}
 */
async function runScript({
  scriptHash,
  scriptContent,
  inputsJson = {},
  permissions,
  profile = 'restricted',
  voltSessionId = null,
  walltimeMs = 30000,
  _exposeContainerId = false,
  _captureEnvelopes = null,
  voltEmitter = null,
  orgId = null,
} = {}) {
  // Soft-fail when orgId is missing (API layer is the gate — see server.js TOOLSMITH-FIX-4)
  if (!orgId) {
    console.warn('[scriptExecutor] orgId missing — sandbox run will not be org-attributed');
  }
  // --- Validate inputs first (no container spawned on validation failure) ---
  validatePermissions(permissions);

  if (!['restricted', 'standard'].includes(profile)) {
    throw new Error(`scriptExecutor: seccomp profile not found for "${profile}" — must be "restricted" or "standard"`);
  }

  // Resolve secrets BEFORE container spawn (fail-open guard)
  const resolvedSecrets = await resolveSecrets(permissions.secrets || []);

  // Resolve seccomp — throws if file missing (D-0 Finding 2)
  const { resolvedPath: seccompPath, jsonContent: seccompJson } = resolveSeccomp(profile);

  const Docker = require('dockerode'); // lazy — see note at top of file
  const docker = new Docker();
  const image = DOCKER_IMAGE[profile];
  const memoryBytes = MEMORY_LIMIT[profile];
  const pidsLimit = PIDS_LIMIT[profile];

  // Network mode: isolated unless permissions.network explicitly true.
  // When network=true, join the same docker network as the collector so the egress proxy
  // (which binds on 0.0.0.0) is reachable via the collector's container name.
  const networkMode = permissions.network === true
    ? (process.env.QUOX_SANDBOX_NETWORK || 'quox_quox-network')
    : 'none';

  // Security options — verbatim from D-0 audit (non-negotiable, no fallback)
  const securityOpt = [
    'no-new-privileges',
    `seccomp=${seccompJson}`,
  ];

  // Build env vars for the container
  const containerEnv = [];

  // TOOLSMITH E-fix-4 (Error 2): inject inputsJson as QUOX_PARAMS env var.
  // tool-wrapper.py reads this via json.loads(os.environ['QUOX_PARAMS']).
  // ReadonlyRootfs=true means we cannot write /inputs/input.json; env var is
  // the correct v1 delivery path. Empty object is the safe default.
  containerEnv.push(`QUOX_PARAMS=${JSON.stringify(inputsJson || {})}`);

  // Inject resolved secrets as QUOX_SECRET_<NAME>=<value>
  for (const { name, value } of resolvedSecrets) {
    // Sanitize name: only allow [A-Z0-9_]
    const safeName = name.replace(/[^A-Z0-9_]/gi, '_').toUpperCase();
    containerEnv.push(`QUOX_SECRET_${safeName}=${value}`);
  }

  // Egress proxy setup
  let egressProxy = null;
  let egressLog = [];

  if (permissions.network === true) {
    // Start per-run egress proxy
    const secretValues = resolvedSecrets.map(s => s.value);
    const secretNames = resolvedSecrets.map(s => s.name);

    egressProxy = await startEgressProxy({
      secretValues,
      secretNames,
      allowedDomains: permissions.allowed_domains || null,
    });

    const proxyPort = egressProxy.port;

    // Inject proxy env vars into container.
    // Proxy is reachable via the collector container name since the sandbox joins the same
    // docker network (QUOX_SANDBOX_NETWORK). host.docker.internal ExtraHost kept for
    // back-compat with non-compose deployments; unused when routing via collector hostname.
    const collectorHost = process.env.QUOX_COLLECTOR_HOST || 'quox-collector';
    const proxyUrl = `http://${collectorHost}:${proxyPort}`;
    containerEnv.push(`HTTP_PROXY=${proxyUrl}`);
    containerEnv.push(`HTTPS_PROXY=${proxyUrl}`);
    containerEnv.push(`http_proxy=${proxyUrl}`);
    containerEnv.push(`https_proxy=${proxyUrl}`);
    // NO_PROXY: nothing — all traffic should go through the proxy when network=true
    containerEnv.push(`NO_PROXY=`);
    containerEnv.push(`no_proxy=`);
  }

  // Build container config
  const containerConfig = {
    Image: image,
    Cmd: ['python3', '-c', scriptContent],
    User: SANDBOX_USER,
    Env: containerEnv,
    NetworkingConfig: {},
    HostConfig: {
      CapDrop: ['ALL'],
      SecurityOpt: securityOpt,
      ReadonlyRootfs: true,
      PidsLimit: pidsLimit,
      Memory: memoryBytes,
      MemorySwap: memoryBytes, // No swap
      NanoCpus: 1e9,           // 1 CPU
      NetworkMode: networkMode,
      Tmpfs: {
        '/tmp': 'size=67108864,mode=1777', // 64MB writable scratch
      },
      AutoRemove: false, // We remove explicitly in finally for state capture
      // D-2: add host.docker.internal → host-gateway for proxy reachability when network=true
      // (kept as back-compat hedge for non-compose deployments — unused on QUOX_SANDBOX_NETWORK)
      ...(permissions.network === true ? { ExtraHosts: ['host.docker.internal:host-gateway'] } : {}),
      // FIX-3.2: dropped Dns: ['127.0.0.1'] override — that override broke quox-collector
      // hostname resolution from the sandbox netns (127.0.0.1 in sandbox is loopback, no
      // resolver listens). Letting docker provide its embedded resolver at 127.0.0.11 is
      // correct for user-defined networks; the proxy is the egress gatekeeper, not the
      // sandbox resolver.
    },
    // Labels for tracking (TOOLSMITH-FIX-4: orgId added for per-org attribution)
    Labels: {
      'quox.toolsmith.scriptHash': scriptHash || '',
      'quox.toolsmith.profile': profile,
      'quox.toolsmith.voltSessionId': voltSessionId || '',
      'quox.toolsmith.orgId': orgId || '',
    },
  };

  let container = null;
  let killedAt = null;
  let stdout = '';
  let stderr = '';
  let exitCode = -1;
  let containerState = null;
  const startTime = Date.now();

  try {
    container = await docker.createContainer(containerConfig);
    await container.start();

    // --- Collect output with walltime enforcement (D-0 Finding 1 fix) ---
    const outputResult = await collectOutputWithTimeout(container, walltimeMs);

    stdout = outputResult.stdout;
    stderr = outputResult.stderr;
    killedAt = outputResult.killedAt;

    if (killedAt === 'timeout') {
      containerState = await killAndVerify(container);
    } else {
      try {
        const waitResult = await container.wait();
        exitCode = waitResult.StatusCode;
      } catch (_) {
        exitCode = outputResult.exitCode !== undefined ? outputResult.exitCode : -1;
      }

      try {
        const info = await container.inspect();
        containerState = info.State;
        if (info.State.OOMKilled) {
          killedAt = 'oom';
          exitCode = info.State.ExitCode;
        } else {
          exitCode = info.State.ExitCode;
        }
      } catch (_) {
        // Container already gone
      }
    }
  } finally {
    // Stop egress proxy and collect log
    if (egressProxy) {
      try {
        egressLog = egressProxy.getRecordedRequests();
        await egressProxy.stop();
      } catch (err) {
        console.warn('[scriptExecutor] egressProxy stop failed (non-fatal):', err.message);
        egressLog = [];
      }
    }

    // Always remove the container (force=true handles already-stopped containers)
    if (container) {
      try {
        await container.remove({ force: true });
      } catch (_) {
        // Already removed — that's fine
      }
    }
  }

  const durationMs = Date.now() - startTime;

  // --- Emit AOCL envelopes ---
  const envelopePair = buildTestRunEnvelopes({
    voltSessionId,
    scriptHash,
    profile,
    permissions,
    exitCode,
    durationMs,
    killedAt,
    stdoutSizeBytes: (stdout || '').length,
    stderrSizeBytes: (stderr || '').length,
    egressRequestCount: egressLog.length,
    orgId,  // TOOLSMITH-FIX-4: propagate org attribution to envelopes
  });
  const [envA, envB] = envelopePair;

  // Test hook: capture envelopes
  if (Array.isArray(_captureEnvelopes)) {
    _captureEnvelopes.push(envA, envB);
  }

  // --- Assemble VOLT bundle ---
  const { evidenceBundleId } = assembleVoltBundle({
    voltEmitter,
    voltSessionId,
    scriptHash,
    inputsJson,
    runResult: { stdout, stderr, exitCode, durationMs, killedAt },
    egressLog,
    envAId: envA.id,
    envBId: envB.id,
  });

  // TRUST-PROOF audit finding (HIGH): scrub resolved secret values out of
  // captured stdout/stderr AFTER capture, BEFORE the result is returned or
  // persisted anywhere downstream (agentTools.js → chat transcript). Applied
  // after envelope/VOLT size accounting above so those sizes reflect the
  // actual raw byte counts from the run.
  stdout = scrubSecretsFromText(stdout, resolvedSecrets);
  stderr = scrubSecretsFromText(stderr, resolvedSecrets);

  const result = {
    stdout,
    stderr,
    exitCode,
    durationMs,
    killedAt,
    seccompProfileApplied: seccompPath,
    egressLog,
    evidenceBundleId,
    aoclEnvelopes: envelopePair,
    // TOOLSMITH-FIX-4: include orgId in result so callers can confirm attribution
    orgId: orgId || null,
  };

  // Test hook: expose internal state for R1/R2/T5/T6 assertions
  if (_exposeContainerId && container) {
    result.containerId = container.id;
    result.containerState = containerState || { Running: false, OOMKilled: killedAt === 'oom', ExitCode: exitCode };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Collect container output with walltime enforcement
// ---------------------------------------------------------------------------

/**
 * Attach to container logs and collect stdout/stderr until container exits
 * or walltime fires. On walltime: fires kill (D-0 Finding 1) and resolves
 * with killedAt='timeout'.
 */
async function collectOutputWithTimeout(container, walltimeMs) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let stdout = '';
    let stderr = '';
    let killTimer = null;

    function safeResolve(value) {
      if (!resolved) {
        resolved = true;
        if (killTimer) clearTimeout(killTimer);
        resolve(value);
      }
    }

    // Walltime timer — D-0 Finding 1 fix: we kill here, not just resolve
    killTimer = setTimeout(async () => {
      if (!resolved) {
        resolved = true;
        try {
          await container.kill({ signal: 'SIGKILL' });
        } catch (_) {
          // May already be dead
        }
        resolve({ stdout, stderr, exitCode: -1, killedAt: 'timeout' });
      }
    }, walltimeMs);

    // Attach to logs
    container.logs(
      {
        stdout: true,
        stderr: true,
        follow: true,
        timestamps: false,
      },
      (err, stream) => {
        if (err) {
          clearTimeout(killTimer);
          return reject(err);
        }

        if (stream && stream.on) {
          const chunks = [];

          stream.on('data', (chunk) => {
            chunks.push(chunk);
          });

          stream.on('end', () => {
            const parsed = demuxDockerStream(Buffer.concat(chunks));
            stdout = parsed.stdout;
            stderr = parsed.stderr;
            safeResolve({ stdout, stderr, exitCode: 0, killedAt: null });
          });

          stream.on('error', (streamErr) => {
            clearTimeout(killTimer);
            reject(streamErr);
          });
        } else {
          safeResolve({ stdout, stderr, exitCode: -1, killedAt: null });
        }
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Demux Docker multiplexed log stream
// Format: [stream_type:1byte][padding:3bytes][size:4bytes BE][payload]
// stream_type: 1=stdout, 2=stderr
// ---------------------------------------------------------------------------

function demuxDockerStream(buffer) {
  let stdout = '';
  let stderr = '';
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;

    const streamType = buffer[offset];
    const payloadSize = buffer.readUInt32BE(offset + 4);
    offset += 8;

    if (payloadSize === 0) continue;
    if (offset + payloadSize > buffer.length) break;

    const payload = buffer.slice(offset, offset + payloadSize).toString('utf8');
    offset += payloadSize;

    if (streamType === 1) {
      stdout += payload;
    } else if (streamType === 2) {
      stderr += payload;
    }
  }

  return { stdout, stderr };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  runScript,
  registerVaultResolver,
  buildTestRunEnvelopes,  // test hook (S6)
  scrubSecretsFromText,   // TRUST-PROOF: exported for direct unit testing (no Docker required)
};
