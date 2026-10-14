/**
 * QuoxAgent Executor
 *
 * Inline executor for quoxagent entity tools.
 * Routes to collector's own fleet/agent endpoints.
 */

function getCollectorUrl() {
  return process.env.COLLECTOR_URL || 'http://localhost:9848';
}

// The install bootstrap runs ON the remote host via Bastion SSH, so it needs
// a LAN-reachable collector address, not the container-internal COLLECTOR_URL
// (localhost from a managed host's perspective resolves to itself, not here).
//
// FLEET #431: this used to default to one specific dev box's LAN IP, which sent
// every other instance's hosts to curl the WRONG collector's /install. There is
// no safe default, so it is required and resolved LAZILY at the install call
// site — module load must stay side-effect-free (the executor is required for
// all quoxagent.* tools, most of which never need this URL).
const { resolveCollectorEventUrl } = require('./collectorUrls.js');

function getCollectorLanUrl() {
  return resolveCollectorEventUrl({
    required: true,
    purpose: 'the quoxagent install bootstrap (the target host curls this URL for /install)',
  });
}

const BASTION_URL = process.env.BASTION_URL || '';
const BASTION_TOKEN = process.env.BASTION_API_TOKEN || '';

// BASTION-CRED Phase 2 — bootstrap-credential escalation fallback for hosts
// whose day-2 user has no NOPASSWD sudo yet.
const { grantNopasswdViaBootstrap, isSudoPasswordFailure } = require('./bootstrapCredential');
// QUOXTRUST FND_..SK5C: validate hostId before it is interpolated into the install shell command.
const { isSafeShellArg } = require('./shellSafe.js');

async function callBastion(hostId, command) {
  if (!BASTION_URL || !BASTION_TOKEN) {
    return { success: false, error: require('./bastionUnavailable').BASTION_UNAVAILABLE_MESSAGE };
  }
  try {
    const resp = await fetch(`${BASTION_URL}/api/v1/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BASTION_TOKEN}` },
      body: JSON.stringify({ targets: [hostId], command }),
      signal: AbortSignal.timeout(60000)
    });
    if (!resp.ok) {
      const text = await resp.text();
      return require("./bastionRefusal.js").bastionHttpErrorResult(resp.status, text); // #815: a 403 is a refusal, never an approval card
    }
    const data = await resp.json();
    const r = data.results && data.results[0];
    if (r) {
      return {
        success: r.exit_code === 0,
        exit_code: r.exit_code,
        stdout: r.stdout,
        stderr: r.stderr,
        error: r.error || (r.exit_code !== 0 ? r.stderr : undefined)
      };
    }
    return data;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// AGENT-OVERHAUL phase 7: /api/v1/agents|jobs are behind the collector's
// default-deny gate, so these self-fetches must present the service key or
// they 401 ("Agent API 401: authentication_required"). This is the same
// missing-auth class as the KEEPER tools; see collector-default-deny-gate.
function authHeaders(extra = {}) {
  return {
    ...(process.env.INTERNAL_SERVICE_KEY ? { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY } : {}),
    ...extra,
  };
}

module.exports = {
  async execute(toolId, input, ctx) {
    const base = getCollectorUrl();

    try {
      switch (toolId) {
        case 'quoxagent.status': {
          const resp = await fetch(`${base}/api/v1/agents`, {
            headers: authHeaders(),
            signal: AbortSignal.timeout(10000)
          });
          if (!resp.ok) {
            const text = await resp.text();
            return { success: false, error: `Agent API ${resp.status}: ${text.substring(0, 200)}` };
          }
          return { success: true, ...(await resp.json()) };
        }
        case 'quoxagent.execute': {
          const resp = await fetch(`${base}/api/v1/jobs`, {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
              host_id: input.hostId,
              command: input.command,
              timeout: input.timeout || 30
            }),
            signal: AbortSignal.timeout((input.timeout || 30) * 1000 + 5000)
          });
          if (!resp.ok) {
            const text = await resp.text();
            return { success: false, error: `Job API ${resp.status}: ${text.substring(0, 200)}` };
          }
          return { success: true, ...(await resp.json()) };
        }
        case 'quoxagent.logs': {
          const resp = await fetch(`${base}/api/v1/agents/${encodeURIComponent(input.hostId)}/logs?lines=${input.lines || 100}`, {
            headers: authHeaders(),
            signal: AbortSignal.timeout(10000)
          });
          if (!resp.ok) {
            const text = await resp.text();
            return { success: false, error: `Logs API ${resp.status}: ${text.substring(0, 200)}` };
          }
          return { success: true, ...(await resp.json()) };
        }
        case 'quoxagent.install': {
          const hostId = input.hostId;
          if (!hostId) return { success: false, error: 'Missing required field: hostId' };
          // QUOXTRUST FND_..SK5C: hostId is interpolated into the install shell command
          // (`--host-id ${hostId}`); validate it (host charset, no shell metachars) and refuse.
          if (!isSafeShellArg('host', hostId)) {
            return { success: false, error: 'invalid_hostId', detail: 'hostId must be a valid host name (injection guard)' };
          }
          const lanUrl = getCollectorLanUrl();
          const cmd = `curl -sSL ${lanUrl}/install -o /tmp/quoxagent-install.sh && sudo bash /tmp/quoxagent-install.sh --host-id ${hostId}`;
          let result = await callBastion(hostId, cmd);

          // BASTION-CRED Phase 2: `sudo bash` fails on hosts whose day-2 user
          // has no NOPASSWD sudo. If the host has a linked bootstrap
          // credential, grant NOPASSWD through it (verified + auto-revoked
          // inside grantNopasswdViaBootstrap), then retry the install ONCE
          // through the normal day-2 path.
          let fallbackReport = null;
          if (!result.success && isSudoPasswordFailure(result)) {
            const orgId = (ctx && ctx.orgId) || input.org_id || null;
            if (!orgId) {
              return {
                success: false,
                error: `${result.error || 'Install failed'} (bootstrap fallback unavailable: no org context)`,
                stdout: result.stdout, stderr: result.stderr,
              };
            }
            console.log(`[QuoxAgent] install hit a sudo-password wall on ${hostId}, trying bootstrap-credential fallback`);
            const fb = await grantNopasswdViaBootstrap({ hostId, orgId });
            if (!fb.success) {
              return {
                success: false,
                error: `Install needs sudo, and bootstrap fallback failed (${fb.code}): ${fb.detail}`,
                steps: fb.steps, stdout: result.stdout, stderr: result.stderr,
              };
            }
            fallbackReport = fb;
            result = await callBastion(hostId, cmd);
          }

          if (!result.success) {
            return { success: false, error: result.error || 'Install script failed', stdout: result.stdout, stderr: result.stderr, ...(fallbackReport ? { fallback_used: 'bootstrap_credential', steps: fallbackReport.steps } : {}) };
          }
          return { success: true, message: `QuoxAgent installed on ${hostId}`, output: result.stdout, ...(fallbackReport ? { fallback_used: 'bootstrap_credential', steps: fallbackReport.steps } : {}) };
        }
        default:
          return { success: false, error: `Unknown quoxagent tool: ${toolId}` };
      }
    } catch (err) {
      return { success: false, error: `QuoxAgent request failed: ${err.message}` };
    }
  }
};
