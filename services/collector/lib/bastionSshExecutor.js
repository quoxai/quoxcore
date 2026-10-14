/**
 * Bastion SSH Executor
 *
 * Inline executor for entity tools that run commands on remote hosts via
 * the SSH bastion. Maps entity tool IDs to the correct shell commands,
 * reusing the same command patterns as the native tool executors.
 *
 * Registered as internal executor "bastion_ssh" — entity JSON files use:
 *   "endpoints": { "base": "internal", "api": "bastion_ssh" }
 */

const BASTION_URL = process.env.BASTION_URL || '';
const BASTION_TOKEN = process.env.BASTION_API_TOKEN || '';
const { BASTION_UNAVAILABLE_MESSAGE } = require('./bastionUnavailable');

// TRUST-PROOF slice 4 — QuoxBastion's (config-gated, rolling out) approval
// gate verifies an X-Bastion-Approval-Grant header: a short-lived Ed25519-
// signed envelope minted by auth (services/auth/routes/internal-approval-
// grants.js) binding the EXACT command/tool+params and targets to a HITL
// inbox item that a human just approved. See mintApprovalGrant() below.
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`;
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
const APPROVAL_GRANT_HEADER = 'X-Bastion-Approval-Grant';

/**
 * Mint a short-lived signed approval grant for an already-HITL-approved
 * bastion call. Binds the EXACT command (action:'exec') or tool id + params
 * (action:'tool') and the exact targets, so QuoxBastion's grant verifier
 * can refuse a replay against a different command/target.
 *
 * TODO(TRUST-PROOF soft-fail removal): this is a SOFT FAIL by design while
 * the bastion approval-grant gate is a config-gated rollout — a mint
 * failure (auth unreachable, item not found/stale, etc.) must NEVER block
 * fleet ops, so this NEVER throws; it logs loudly and returns null, and the
 * caller proceeds WITHOUT the header. Once the gate is mandatory on every
 * bastion instance, this soft-fail should be reconsidered (a missing grant
 * would then just get refused bastion-side anyway, so the soft-fail may
 * become redundant rather than dangerous — re-audit at that point).
 *
 * @param {object} opts
 * @param {string} opts.itemId - approved HITL inbox item id (ctx.hitlApprovedItemId)
 * @param {'exec'|'tool'} opts.action
 * @param {string} [opts.command] - exact command string (action:'exec')
 * @param {string} [opts.toolId] - bastion tool id (action:'tool')
 * @param {object} [opts.params] - tool params, string values (action:'tool')
 * @param {string[]} opts.targets - exact target host ids/aliases (or "group:<name>")
 * @returns {Promise<string|null>} grant_base64, or null on any failure
 */
async function mintApprovalGrant({ itemId, action, command, toolId, params, targets }) {
  if (!itemId || !AUTH_SERVICE_URL) return null;
  try {
    const resp = await fetch(`${AUTH_SERVICE_URL}/api/internal/approval-grants/mint`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_SERVICE_KEY ? { 'X-Service-Key': INTERNAL_SERVICE_KEY } : {}),
      },
      body: JSON.stringify({
        item_id: itemId,
        action,
        ...(command ? { command } : {}),
        ...(toolId ? { tool_id: toolId } : {}),
        ...(params ? { params } : {}),
        targets: Array.isArray(targets) ? targets : [targets].filter(Boolean),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error(`[BastionSSH] approval-grant mint failed (${resp.status}) for item ${itemId}: ${text.slice(0, 300)}`);
      return null;
    }
    const data = await resp.json();
    if (!data || typeof data.grant_base64 !== 'string' || !data.grant_base64) {
      console.error(`[BastionSSH] approval-grant mint returned no grant_base64 for item ${itemId}`);
      return null;
    }
    return data.grant_base64;
  } catch (err) {
    console.error(`[BastionSSH] approval-grant mint error for item ${itemId}: ${err.message}`);
    return null;
  }
}

/**
 * Mint a grant for the current call when ctx carries an approved HITL item
 * id (set by toolResume.js's resume handler after a human approved the
 * gated tool call — see lib/approvalGate.js's withApprovalGate).
 *
 * FAIL CLOSED (TRUST-PROOF, soft-fail removed after the live HITL E2E):
 * with the bastion gate deployed, a grantless risky call is a guaranteed
 * bastion-side 403 with a worse error — and on a gate-misconfigured
 * bastion it would silently run an approved-but-unprovable command. A mint
 * failure on an approved item now THROWS code 'grant_mint_failed'; call
 * sites surface it as an executor error naming the mint step. Calls with
 * no approved item (ungated/legacy paths) still return null unchanged.
 */
async function mintGrantForCtx(ctx, { action, command, toolId, params, targets }) {
  const itemId = ctx && ctx.hitlApprovedItemId;
  if (!itemId) return null;
  const grant = await mintApprovalGrant({ itemId, action, command, toolId, params, targets });
  if (!grant) {
    const err = new Error(
      `approval grant mint failed for approved inbox item ${itemId} (targets: ${JSON.stringify(targets)}) — refusing to execute without the X-Bastion-Approval-Grant the human's approval is supposed to carry. Check the auth service and retry the approval.`
    );
    err.code = 'grant_mint_failed';
    throw err;
  }
  return grant;
}

/**
 * QUOXTRUST #626 (A) — mint an engagement-anchored grant for a governed
 * security scan. Unlike mintApprovalGrant (anchored to a HITL inbox item),
 * this is anchored to an ACTIVE security engagement: the auth mint-engagement
 * route re-validates the engagement authorization (verified target, risk within
 * ceiling, within time-window) via its own keyed callback to the collector's
 * check-policy endpoint BEFORE signing. Returns the base64 grant, or null when
 * auth is unconfigured/unreachable — the caller (makeEngagementMintFn) turns a
 * null/failure into a FAIL-CLOSED grant_mint_failed so no ungranted scan runs.
 *
 * @param {object} o
 * @param {string} o.orgId
 * @param {string} o.engagementId
 * @param {string} o.command   - exact scan command about to run
 * @param {string[]} o.targets - the bastion scan HOST(s) the command runs on
 * @param {string} o.target    - the in-scope engagement asset being scanned
 * @param {string} o.capabilityRisk
 * @returns {Promise<string|null>} grant_base64, or null on any failure
 */
async function mintEngagementGrant({ orgId, engagementId, command, targets, target, capabilityRisk }) {
  if (!orgId || !engagementId || !AUTH_SERVICE_URL) return null;
  try {
    const resp = await fetch(`${AUTH_SERVICE_URL}/api/internal/approval-grants/mint-engagement`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_SERVICE_KEY ? { 'X-Service-Key': INTERNAL_SERVICE_KEY } : {}),
      },
      body: JSON.stringify({
        org_id: orgId,
        engagement_id: engagementId,
        action: 'exec',
        command,
        targets: Array.isArray(targets) ? targets : [targets].filter(Boolean),
        target,
        capability_risk: capabilityRisk,
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error(`[BastionSSH] engagement-grant mint failed (${resp.status}) for engagement ${engagementId}: ${text.slice(0, 300)}`);
      return null;
    }
    const data = await resp.json();
    if (!data || typeof data.grant_base64 !== 'string' || !data.grant_base64) {
      console.error(`[BastionSSH] engagement-grant mint returned no grant_base64 for engagement ${engagementId}`);
      return null;
    }
    return data.grant_base64;
  } catch (err) {
    console.error(`[BastionSSH] engagement-grant mint error for engagement ${engagementId}: ${err.message}`);
    return null;
  }
}

/**
 * Fleet standing grants (2026-10-13): mint a grant anchored to an org admin's
 * STANDING grant (lib/fleetStandingGrants.js) instead of a HITL inbox item.
 * The auth mint-standing route re-validates the standing grant (host, anchored
 * command regex, VMID range, expiry, revocation) via its own keyed callback to
 * the collector BEFORE signing. Returns the base64 grant, or null on any
 * failure; the caller fails CLOSED on null.
 */
async function mintStandingGrant({ orgId, grantId, host, command, targets }) {
  if (!orgId || !grantId || !AUTH_SERVICE_URL) return null;
  try {
    const resp = await fetch(`${AUTH_SERVICE_URL}/api/internal/approval-grants/mint-standing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_SERVICE_KEY ? { 'X-Service-Key': INTERNAL_SERVICE_KEY } : {}),
      },
      body: JSON.stringify({
        org_id: orgId,
        standing_grant_id: grantId,
        action: 'exec',
        host,
        command,
        targets: Array.isArray(targets) ? targets : [targets].filter(Boolean),
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error(`[BastionSSH] standing-grant mint failed (${resp.status}) for ${grantId}: ${text.slice(0, 300)}`);
      return null;
    }
    const data = await resp.json();
    return data && typeof data.grant_base64 === 'string' && data.grant_base64 ? data.grant_base64 : null;
  } catch (err) {
    console.error(`[BastionSSH] standing-grant mint error for ${grantId}: ${err.message}`);
    return null;
  }
}

// AGENT-OVERHAUL-3 (QuoxPlan notes #2332/#2333) — golden-clone snapshot/clone
// executors. DI-testable (take callBastion as a param), shared with the
// native proxmox_templates_list read tool in toolExecutors/proxmox.js so
// clone's template-flag check reuses the exact same egress path. Invoked
// below ONLY after entityToolLoader's requiresApproval -> withApprovalGate
// wrapper resolves — see src/config/entities/tools/proxmox-extended.json.
const { proxmoxVmSnapshot, proxmoxVmClone } = require('./toolExecutors/proxmox');
// QUOXTRUST FND_..SK5C: strict allowlist validator — bastion_ssh is a parallel implementation of
// the native fleet tools and interpolates the same model-supplied fields into shell commands.
const { isSafeShellArg } = require('./shellSafe.js');

// BASTION-CRED Phase 2 — bootstrap-credential escalation fallback for hosts
// whose day-2 user has no NOPASSWD sudo yet.
const { grantNopasswdViaBootstrap, isSudoPasswordFailure } = require('./bootstrapCredential');

/**
 * Execute a command on a remote host via bastion API.
 * (Same logic as callBastion in agentTools.js, duplicated to avoid circular deps.)
 *
 * @param {string} hostId
 * @param {string} command
 * @param {string} [grant] - TRUST-PROOF slice 4: base64 X-Bastion-Approval-Grant
 *   envelope (see mintApprovalGrant above). Optional — omitted entirely when
 *   absent, since the bastion-side gate is a config-gated rollout.
 */
async function callBastion(hostId, command, grant) {
  if (!BASTION_URL || !BASTION_TOKEN) {
    return { success: false, error: BASTION_UNAVAILABLE_MESSAGE };
  }

  const url = `${BASTION_URL}/api/v1/exec`;
  console.log(`[BastionSSH] exec on ${hostId}: ${command.substring(0, 80)}`);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BASTION_TOKEN}`,
        ...(grant ? { [APPROVAL_GRANT_HEADER]: grant } : {})
      },
      body: JSON.stringify({ targets: [hostId], command }),
      signal: AbortSignal.timeout(30000)
    });

    if (!resp.ok) {
      const text = await resp.text();
      return require("./bastionRefusal.js").bastionHttpErrorResult(resp.status, text); // #815: a 403 is a refusal, never an approval card
    }

    const data = await resp.json();
    if (data.results && data.results.length > 0) {
      const r = data.results[0];
      return {
        success: r.exit_code === 0,
        exit_code: r.exit_code,
        stdout: r.stdout,
        stderr: r.stderr,
        error: r.error || (r.exit_code !== 0 ? r.stderr : undefined),
        host: r.host_id,
        duration_ms: r.duration_ms
      };
    }
    return data;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Run one of Bastion's own native builtin tools (sudo-setup, ssh-key-deploy,
 * etc.) via its generic /api/v1/tools/run endpoint, instead of reimplementing
 * the same logic as a raw SSH command. Reuses the real, visudo-validated Go
 * implementation rather than a JS shell-string duplicate.
 */
/**
 * @param {string} toolId
 * @param {string} host
 * @param {object} [params]
 * @param {string} [grant] - TRUST-PROOF slice 4: base64 X-Bastion-Approval-Grant
 *   envelope (see mintApprovalGrant above). Optional, same contract as callBastion.
 */
async function callBastionToolRun(toolId, host, params = {}, grant) {
  if (!BASTION_URL || !BASTION_TOKEN) {
    return { success: false, error: BASTION_UNAVAILABLE_MESSAGE };
  }

  const url = `${BASTION_URL}/api/v1/tools/run`;
  console.log(`[BastionSSH] tool run '${toolId}' on ${host}`);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BASTION_TOKEN}`,
        ...(grant ? { [APPROVAL_GRANT_HEADER]: grant } : {})
      },
      body: JSON.stringify({ tool_id: toolId, targets: [host], params }),
      signal: AbortSignal.timeout(30000)
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { success: false, error: `Bastion tools/run returned ${resp.status}: ${text}` };
    }

    const data = await resp.json();
    const hostResult = Array.isArray(data.results) ? data.results.find(r => r.host_id === host) || data.results[0] : null;
    if (hostResult) {
      return {
        success: !!hostResult.success,
        output: hostResult.output,
        error: hostResult.error,
        exit_code: hostResult.exit_code,
        stderr: hostResult.stderr,
        duration_ms: hostResult.duration_ms
      };
    }
    return data;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================================
// Command Builders — map entity tool IDs to SSH commands
// ============================================================================

/**
 * System tools (system.json)
 */
function buildSystemCommand(toolId, input) {
  const host = input.host || 'localhost';

  switch (toolId) {
    case 'system.uptime':
      return { host, cmd: `uptime && echo '---' && cat /proc/loadavg` };

    case 'system.services': {
      const filter = input.filter || 'all';
      let cmd;
      if (filter === 'failed') {
        cmd = `systemctl list-units --type=service --state=failed --no-pager --plain`;
      } else if (filter === 'running') {
        cmd = `systemctl list-units --type=service --state=running --no-pager --plain | head -50`;
      } else {
        cmd = `systemctl list-units --type=service --no-pager --plain | head -100`;
      }
      if (input.pattern) {
        cmd += ` | grep -i '${input.pattern.replace(/'/g, "'\\''")}'`;
      }
      return { host, cmd };
    }

    case 'system.service_restart': {
      const service = input.service;
      if (!service) return { host, error: 'Missing required field: service' };
      return { host, cmd: `sudo systemctl restart ${service} && systemctl status ${service} --no-pager` };
    }

    case 'system.processes': {
      const sortBy = input.sort_by || 'cpu';
      const limit = Math.min(parseInt(input.limit) || 20, 50);
      const cmd = sortBy === 'memory'
        ? `ps aux --sort=-%mem | head -${limit + 1}`
        : `ps aux --sort=-%cpu | head -${limit + 1}`;
      return { host, cmd: input.filter ? `${cmd} | grep -i '${input.filter.replace(/'/g, "'\\''")}'` : cmd };
    }

    case 'system.disk_usage':
      return {
        host,
        cmd: input.path
          ? `du -sh ${input.path}/* 2>/dev/null | sort -rh | head -20`
          : `df -h --output=source,size,used,avail,pcent,target | grep -v tmpfs | grep -v udev`
      };

    case 'system.logs': {
      const unit = input.unit ? `-u ${input.unit}` : '';
      const priority = input.priority ? `-p ${input.priority}` : '';
      const since = input.since || '1h';
      const lines = Math.min(parseInt(input.lines) || 100, 500);
      let cmd = `journalctl ${unit} ${priority} --since "${since} ago" --no-pager -n ${lines}`;
      if (input.grep) {
        cmd += ` | grep -i '${input.grep.replace(/'/g, "'\\''")}'`;
      }
      return { host, cmd };
    }

    case 'system.cron':
      return {
        host,
        cmd: input.user
          ? `crontab -u ${input.user} -l 2>/dev/null || echo 'No crontab for user'`
          : `for user in $(cut -f1 -d: /etc/passwd); do crontab -u $user -l 2>/dev/null && echo "--- $user ---"; done; cat /etc/crontab 2>/dev/null; ls -la /etc/cron.d/ 2>/dev/null`
      };

    case 'system.memory':
      return { host, cmd: `free -h && echo '---' && cat /proc/meminfo | head -20` };

    default:
      return null;
  }
}

/**
 * Docker extended tools (docker-extended.json)
 */
function buildDockerCommand(toolId, input) {
  const host = input.host || 'docker01';
  const container = input.container || input.container_id || '';

  switch (toolId) {
    case 'docker.logs': {
      if (!container) return { host, error: 'Missing required field: container' };
      const tail = Math.min(parseInt(input.tail) || 100, 500);
      const since = input.since ? ` --since "${input.since}"` : '';
      const grep = input.grep ? ` | grep -i "${input.grep.replace(/"/g, '\\"')}"` : '';
      return { host, cmd: `docker logs ${container} --tail ${tail}${since}${grep}` };
    }

    case 'docker.stats':
      return {
        host,
        cmd: container
          ? `docker stats ${container} --no-stream --format "{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.MemPerc}}\\t{{.NetIO}}\\t{{.BlockIO}}"`
          : `docker stats --no-stream --format "{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.MemPerc}}\\t{{.NetIO}}\\t{{.BlockIO}}"`
      };

    case 'docker.restart': {
      if (!container) return { host, error: 'Missing required field: container' };
      return { host, cmd: `docker restart ${container} && sleep 2 && docker inspect ${container} --format '{{.State.Health.Status}}' 2>/dev/null || echo 'restarted'` };
    }

    case 'docker.inspect': {
      if (!container) return { host, error: 'Missing required field: container' };
      return { host, cmd: `docker inspect ${container} --format '{{json .}}'` };
    }

    case 'docker.images': {
      let cmd = `docker images --format "{{.Repository}}:{{.Tag}}\\t{{.Size}}\\t{{.CreatedSince}}"`;
      if (input.filter) {
        cmd += ` | grep -i '${input.filter.replace(/'/g, "'\\''")}'`;
      }
      return { host, cmd };
    }

    case 'docker.prune': {
      const pruneType = input.type || 'all';
      let cmd;
      switch (pruneType) {
        case 'containers': cmd = 'docker container prune -f'; break;
        case 'images': cmd = 'docker image prune -a -f'; break;
        case 'volumes': cmd = 'docker volume prune -f'; break;
        case 'networks': cmd = 'docker network prune -f'; break;
        default: cmd = 'docker system prune -a -f --volumes';
      }
      return { host, cmd };
    }

    default:
      return null;
  }
}

/**
 * Network tools (network.json, network-extended.json)
 */
function buildNetworkCommand(toolId, input) {
  const host = input.host || input.source || 'gw-01';

  switch (toolId) {
    case 'network.ping': {
      const target = input.target;
      if (!target) return { host, error: 'Missing required field: target' };
      const count = Math.min(parseInt(input.count) || 4, 10);
      return { host, cmd: `ping -c ${count} -W 2 ${target}` };
    }

    case 'network.traceroute': {
      const target = input.target;
      if (!target) return { host, error: 'Missing required field: target' };
      const maxHops = Math.min(parseInt(input.maxHops) || 20, 30);
      return { host, cmd: `traceroute -m ${maxHops} -w 2 ${target}` };
    }

    case 'network.dns': {
      const target = input.target;
      if (!target) return { host, error: 'Missing required field: target' };
      const dnsType = input.dnsType || 'A';
      return { host, cmd: `dig +short ${target} ${dnsType}` };
    }

    case 'network.ports': {
      const target = input.target;
      if (!target) return { host, error: 'Missing required field: target' };
      const ports = input.ports || [22, 80, 443];
      const portList = (Array.isArray(ports) ? ports : [ports]).slice(0, 10);
      const portChecks = portList
        .map(p => `timeout 2 bash -c "echo >/dev/tcp/${target}/${p}" 2>/dev/null && echo "${p}:open" || echo "${p}:closed"`)
        .join('; ');
      return { host, cmd: portChecks };
    }

    case 'network.interfaces': {
      const includeLo = input.include_loopback ? '' : ' | grep -v "^lo"';
      return { host, cmd: `ip -br addr show${includeLo} && echo '---' && ip -s link show${includeLo}` };
    }

    case 'network.connections': {
      const state = input.state || 'established';
      let stateFlag = '';
      if (state === 'established') stateFlag = 'state established';
      else if (state === 'listening') stateFlag = 'state listening';
      else if (state === 'time_wait') stateFlag = 'state time-wait';
      let cmd = `ss -tunp ${stateFlag} | head -100`;
      if (input.port) {
        cmd = `ss -tunp ${stateFlag} | grep ':${input.port}' | head -100`;
      }
      return { host, cmd };
    }

    case 'network.routes':
      return { host, cmd: `ip route show` };

    case 'network.arp':
      return { host, cmd: `ip neigh show` };

    case 'network.bandwidth': {
      const target = input.target;
      if (!target) return { host, error: 'Missing required field: target' };
      const duration = Math.min(parseInt(input.duration) || 10, 30);
      return { host, cmd: `iperf3 -c ${target} -t ${duration} -J 2>/dev/null || echo '{"error": "iperf3 not available or target not listening"}'` };
    }

    case 'network.mtr': {
      const target = input.target;
      if (!target) return { host, error: 'Missing required field: target' };
      const count = Math.min(parseInt(input.count) || 10, 30);
      return { host, cmd: `mtr -r -c ${count} ${target} 2>/dev/null || traceroute -m 20 -w 2 ${target}` };
    }

    default:
      return null;
  }
}

/**
 * Security extended tools (security-extended.json)
 */
function buildSecurityCommand(toolId, input) {
  const host = input.host || 'localhost';

  switch (toolId) {
    case 'security.certificate_check': {
      const targets = input.targets;
      if (!targets || !Array.isArray(targets) || targets.length === 0) {
        return { host: 'gw-01', error: 'Missing required field: targets' };
      }
      const checks = targets.slice(0, 10).map(t => {
        const [domain, port] = t.includes(':') ? t.split(':') : [t, '443'];
        return `echo "=== ${t} ===" && echo | openssl s_client -servername ${domain} -connect ${domain}:${port} 2>/dev/null | openssl x509 -noout -dates -subject -issuer 2>/dev/null || echo "ERROR: Cannot connect"`;
      }).join(' && ');
      return { host: 'gw-01', cmd: checks };
    }

    case 'security.failed_logins': {
      const hours = Math.min(parseInt(input.hours) || 24, 168);
      return { host, cmd: `journalctl -u sshd --since "${hours}h ago" --no-pager | grep -i "failed\\|invalid" | tail -200` };
    }

    case 'security.active_sessions':
      return { host, cmd: `who -u && echo '---' && last -20` };

    case 'security.session_revoke': {
      const sessionId = input.session_id;
      if (!sessionId) return { host, error: 'Missing required field: session_id' };
      // This is an auth-service operation, not SSH — return guidance
      return { host, error: 'Session revocation requires auth service API. Use the auth service endpoint directly.' };
    }

    case 'security.permission_audit': {
      const auditPath = input.path;
      if (!auditPath) return { host, error: 'Missing required field: path' };
      let cmd = `find ${auditPath} -maxdepth 3`;
      const checks = [];
      if (input.check_world_writable !== false) {
        checks.push(`echo "=== World-writable ===" && find ${auditPath} -maxdepth 3 -perm -o+w -type f 2>/dev/null | head -50`);
      }
      if (input.check_setuid !== false) {
        checks.push(`echo "=== SUID/SGID ===" && find ${auditPath} -maxdepth 3 \\( -perm -4000 -o -perm -2000 \\) -type f 2>/dev/null | head -50`);
      }
      cmd = checks.join(' && ');
      return { host, cmd };
    }

    case 'security.user_audit': {
      // This is an auth-service operation — query the database
      const inactiveDays = parseInt(input.check_inactive_days) || 90;
      const authDbPath = '/opt/quoxcore/services/auth/data/auth.db';
      const cmd = `sqlite3 -json ${authDbPath} "SELECT id, email, display_name, role, last_login, created_at FROM users ORDER BY last_login ASC" 2>/dev/null || echo '[]'`;
      return { host: 'localhost', cmd };
    }

    case 'security.audit': {
      // Query auth service audit_events database
      const auditHours = Math.min(parseInt(input.hours) || 24, 168);
      const auditLimit = Math.min(parseInt(input.limit) || 100, 500);
      const since = new Date(Date.now() - auditHours * 60 * 60 * 1000).toISOString();
      let whereClause = `created_at > '${since}'`;
      if (input.eventTypes && Array.isArray(input.eventTypes)) {
        const types = input.eventTypes.map(t => `'${t.replace(/'/g, "''")}'`).join(',');
        whereClause += ` AND action IN (${types})`;
      }
      const dbPath = '/opt/quoxcore/services/auth/data/auth.db';
      return { host: 'localhost', cmd: `sqlite3 -json ${dbPath} "SELECT id, action, actor_type, actor_id, target_type, target_id, status, ip_address, created_at FROM audit_events WHERE ${whereClause} ORDER BY created_at DESC LIMIT ${auditLimit}"` };
    }

    default:
      return null;
  }
}

/**
 * Proxmox extended tools (proxmox-extended.json)
 * These use pvesh CLI commands via SSH to the Proxmox nodes.
 */
function buildProxmoxExtCommand(toolId, input) {
  const node = input.node || 'hyp-01';

  switch (toolId) {
    case 'proxmox.storage.usage':
      return { host: node, cmd: `pvesh get /storage --output-format json 2>/dev/null && echo '---' && df -h | grep -E '/mnt|/var/lib' | head -20` };

    case 'proxmox.snapshots.list': {
      let cmd;
      if (input.vmid) {
        cmd = `pvesh get /nodes/$(hostname)/qemu/${input.vmid}/snapshot --output-format json 2>/dev/null`;
      } else {
        cmd = `for vmid in $(pvesh get /cluster/resources --type vm --output-format json 2>/dev/null | python3 -c "import sys,json; [print(r['vmid']) for r in json.load(sys.stdin)]" 2>/dev/null); do echo "=== VM $vmid ===" && pvesh get /nodes/$(hostname)/qemu/$vmid/snapshot --output-format json 2>/dev/null; done`;
      }
      return { host: node, cmd };
    }

    case 'proxmox.snapshots.cleanup': {
      // Always dry-run first for safety
      return { host: node, error: 'Snapshot cleanup requires approval and is best handled via the Proxmox API. Use proxmox_vm_action with the appropriate parameters.' };
    }

    case 'proxmox.vm.resources':
      return { host: node, cmd: `pvesh get /cluster/resources --type vm --output-format json 2>/dev/null` };

    case 'proxmox.node.resources':
      // $(hostname), not the JS-side `node` value, matching proxmox.snapshots.list's
      // pattern above — the pvesh node path must be resolved server-side by the
      // host actually running the command, not re-embedded from client input.
      return { host: node, cmd: `pvesh get /nodes/$(hostname)/status --output-format json 2>/dev/null` };

    case 'proxmox.backup.status': {
      const days = Math.min(parseInt(input.days) || 7, 30);
      return { host: node, cmd: `pvesh get /cluster/backup --output-format json 2>/dev/null && echo '---TASKS---' && pvesh get /nodes/$(hostname)/tasks --typefilter vzdump --limit 20 --output-format json 2>/dev/null` };
    }

    case 'proxmox.ha.status':
      return { host: node, cmd: `pvesh get /cluster/ha/status/current --output-format json 2>/dev/null && echo '---' && pvesh get /cluster/ha/resources --output-format json 2>/dev/null` };

    default:
      return null;
  }
}

/**
 * Fleet tools (fleet.json)
 * Route to collector's own fleet API endpoints.
 */
async function executeFleetTool(toolId, input) {
  const collectorUrl = process.env.COLLECTOR_URL || 'http://localhost:9848';

  switch (toolId) {
    case 'fleet.health_matrix': {
      try {
        const resp = await fetch(`${collectorUrl}/api/v1/agents`, {
          signal: AbortSignal.timeout(10000)
        });
        if (!resp.ok) return { success: false, error: `Fleet API ${resp.status}` };
        const data = await resp.json();
        const agents = data.agents || [];

        const warnCpu = input.warn_cpu || 80;
        const warnMem = input.warn_memory || 85;
        const warnDisk = input.warn_disk || 80;

        const hosts = agents.map(a => {
          const cpu = a.resources?.cpu?.usage_percent;
          const mem = a.resources?.memory?.usage_percent;
          // Disk is an array of mount points — find root (/) or highest usage
          const diskMounts = Array.isArray(a.resources?.disk) ? a.resources.disk : [];
          const rootDisk = diskMounts.find(d => d.mount_point === '/') || diskMounts[0];
          const disk = rootDisk?.usage_percent;
          return {
            host: a.host_id,
            ip: a.ip,
            health: a.status?.health || 'unknown',
            cpu: cpu != null ? cpu.toFixed(1) + '%' : 'n/a',
            memory: mem != null ? mem.toFixed(1) + '%' : 'n/a',
            disk: disk != null ? disk.toFixed(1) + '%' : 'n/a',
            warnings: [
              ...(cpu > warnCpu ? [`CPU ${cpu.toFixed(1)}% > ${warnCpu}%`] : []),
              ...(mem > warnMem ? [`Memory ${mem.toFixed(1)}% > ${warnMem}%`] : []),
              ...(disk > warnDisk ? [`Disk ${disk.toFixed(1)}% > ${warnDisk}%`] : [])
            ]
          };
        });

        const warnings = hosts.filter(h => h.warnings.length > 0);
        return {
          success: true,
          hosts,
          summary: {
            total: hosts.length,
            healthy: hosts.filter(h => h.health === 'healthy').length,
            warnings: warnings.length
          }
        };
      } catch (err) {
        return { success: false, error: `Fleet API unreachable: ${err.message}` };
      }
    }

    case 'fleet.execute': {
      const hosts = input.hosts;
      const command = input.command;
      if (!hosts || !command) return { success: false, error: 'Missing required fields: hosts, command' };

      // Resolve "all" to actual host list
      let targetHosts = hosts;
      if (hosts === 'all' || (Array.isArray(hosts) && hosts[0] === 'all')) {
        try {
          const resp = await fetch(`${collectorUrl}/api/v1/agents`, { signal: AbortSignal.timeout(5000) });
          const data = await resp.json();
          targetHosts = (data.agents || []).map(a => a.host_id).filter(Boolean);
        } catch (err) {
          return { success: false, error: `Cannot resolve hosts: ${err.message}` };
        }
      }
      if (!Array.isArray(targetHosts)) targetHosts = [targetHosts];

      // Execute via bastion on each host
      const results = await Promise.all(targetHosts.map(async (hostId) => {
        const result = await callBastion(hostId, command);
        return { host: hostId, ...result };
      }));

      return {
        success: results.every(r => r.success !== false),
        results,
        total: results.length,
        succeeded: results.filter(r => r.success !== false).length,
        failed: results.filter(r => r.success === false).length
      };
    }

    case 'fleet.compare': {
      const hosts = input.hosts;
      const compareType = input.compare_type;
      if (!hosts || !compareType) return { success: false, error: 'Missing required fields: hosts, compare_type' };

      let cmd;
      switch (compareType) {
        case 'packages': cmd = `dpkg -l 2>/dev/null | tail -n +6 | awk '{print $2, $3}' | head -200 || rpm -qa --qf '%{NAME} %{VERSION}\\n' 2>/dev/null | head -200`; break;
        case 'services': cmd = `systemctl list-units --type=service --state=running --no-pager --plain | awk '{print $1}' | head -100`; break;
        case 'config_file': {
          if (!input.config_path) return { success: false, error: 'Missing required field: config_path for config_file comparison' };
          cmd = `cat ${input.config_path} 2>/dev/null || echo 'FILE_NOT_FOUND'`;
          break;
        }
        default: return { success: false, error: `Invalid compare_type: ${compareType}` };
      }

      const results = await Promise.all((Array.isArray(hosts) ? hosts : [hosts]).map(async (hostId) => {
        const result = await callBastion(hostId, cmd);
        return { host: hostId, output: result.stdout || '' };
      }));

      return {
        success: true,
        compare_type: compareType,
        results
      };
    }

    default:
      return { success: false, error: `Unknown fleet tool: ${toolId}` };
  }
}

/**
 * Alerts tools (alerts.json)
 * Route to Alertmanager/Prometheus APIs.
 */
async function executeAlertsTool(toolId, input) {
  const alertmanagerUrl = process.env.ALERTMANAGER_URL || '';
  const prometheusUrl = process.env.PROMETHEUS_URL || '';

  switch (toolId) {
    case 'alerts.active': {
      if (!alertmanagerUrl) return { success: false, error: 'Alertmanager not configured. Set ALERTMANAGER_URL.' };
      try {
        const resp = await fetch(`${alertmanagerUrl}/api/v2/alerts?active=true`, {
          signal: AbortSignal.timeout(10000)
        });
        if (!resp.ok) return { success: false, error: `Alertmanager returned ${resp.status}` };
        const alerts = await resp.json();
        const formatted = (Array.isArray(alerts) ? alerts : []).map(a => ({
          alertname: a.labels?.alertname,
          severity: a.labels?.severity,
          instance: a.labels?.instance,
          summary: a.annotations?.summary || a.annotations?.description,
          started_at: a.startsAt
        }));
        if (input.severity && input.severity !== 'all') {
          const filtered = formatted.filter(a => a.severity === input.severity);
          return { success: true, alerts: filtered, count: filtered.length };
        }
        return {
          success: true,
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

    case 'alerts.silence': {
      if (!alertmanagerUrl) return { success: false, error: 'Alertmanager not configured. Set ALERTMANAGER_URL.' };
      if (!input.matchers) return { success: false, error: 'Missing required field: matchers' };
      const startsAt = new Date();
      const hours = parseInt(input.duration) || 2;
      const endsAt = new Date(startsAt.getTime() + hours * 60 * 60 * 1000);
      try {
        const resp = await fetch(`${alertmanagerUrl}/api/v2/silences`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            matchers: Object.entries(input.matchers).map(([name, value]) => ({ name, value: String(value), isRegex: false })),
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            createdBy: input.created_by || 'quox',
            comment: input.comment || 'Silenced via Quox'
          }),
          signal: AbortSignal.timeout(10000)
        });
        if (!resp.ok) { const t = await resp.text(); return { success: false, error: `Silence failed: ${t}` }; }
        const result = await resp.json();
        return { success: true, silence_id: result.silenceID || result.id, ends_at: endsAt.toISOString() };
      } catch (err) {
        return { success: false, error: `Alertmanager unreachable: ${err.message}` };
      }
    }

    case 'alerts.silences': {
      if (!alertmanagerUrl) return { success: false, error: 'Alertmanager not configured. Set ALERTMANAGER_URL.' };
      try {
        const resp = await fetch(`${alertmanagerUrl}/api/v2/silences`, { signal: AbortSignal.timeout(10000) });
        if (!resp.ok) return { success: false, error: `Alertmanager returned ${resp.status}` };
        const all = await resp.json();
        const active = (Array.isArray(all) ? all : []).filter(s => s.status?.state === 'active').map(s => ({
          id: s.id, matchers: s.matchers, created_by: s.createdBy, comment: s.comment, starts_at: s.startsAt, ends_at: s.endsAt
        }));
        return { success: true, silences: active, count: active.length };
      } catch (err) {
        return { success: false, error: `Alertmanager unreachable: ${err.message}` };
      }
    }

    case 'alerts.unsilence': {
      if (!alertmanagerUrl) return { success: false, error: 'Alertmanager not configured. Set ALERTMANAGER_URL.' };
      if (!input.silence_id) return { success: false, error: 'Missing required field: silence_id' };
      try {
        const resp = await fetch(`${alertmanagerUrl}/api/v2/silence/${input.silence_id}`, {
          method: 'DELETE', signal: AbortSignal.timeout(10000)
        });
        if (!resp.ok) { const t = await resp.text(); return { success: false, error: `Unsilence failed: ${t}` }; }
        return { success: true, silence_id: input.silence_id, message: 'Silence removed' };
      } catch (err) {
        return { success: false, error: `Alertmanager unreachable: ${err.message}` };
      }
    }

    case 'alerts.history': {
      if (!prometheusUrl) return { success: false, error: 'Prometheus not configured. Set PROMETHEUS_URL.' };
      const hours = Math.min(parseInt(input.hours) || 24, 168);
      const end = new Date();
      const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
      try {
        const resp = await fetch(`${prometheusUrl}/api/v1/query_range?query=ALERTS&start=${start.toISOString()}&end=${end.toISOString()}&step=60s`, {
          signal: AbortSignal.timeout(15000)
        });
        if (!resp.ok) return { success: false, error: `Prometheus returned ${resp.status}` };
        const data = await resp.json();
        const results = data.data?.result || [];
        const history = results.map(r => ({
          alertname: r.metric?.alertname, severity: r.metric?.severity, instance: r.metric?.instance, datapoints: r.values?.length || 0
        }));
        return { success: true, hours, alerts: history, count: history.length };
      } catch (err) {
        return { success: false, error: `Prometheus unreachable: ${err.message}` };
      }
    }

    case 'alerts.test': {
      if (!prometheusUrl) return { success: false, error: 'Prometheus not configured. Set PROMETHEUS_URL.' };
      if (!input.rule) return { success: false, error: 'Missing required field: rule' };
      try {
        const resp = await fetch(`${prometheusUrl}/api/v1/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `query=${encodeURIComponent(input.rule)}`,
          signal: AbortSignal.timeout(10000)
        });
        if (!resp.ok) { const t = await resp.text(); return { success: false, error: `Prometheus ${resp.status}: ${t.slice(0, 300)}` }; }
        const data = await resp.json();
        const results = data.data?.result || [];
        return {
          success: true,
          would_fire: results.length > 0,
          matching_series: results.length,
          results: results.slice(0, 20).map(r => ({ metric: r.metric, value: r.value?.[1] }))
        };
      } catch (err) {
        return { success: false, error: `Prometheus unreachable: ${err.message}` };
      }
    }

    default:
      return { success: false, error: `Unknown alerts tool: ${toolId}` };
  }
}

/**
 * Uptime tools (uptime.json)
 * HTTP-based service checks.
 */
async function executeUptimeTool(toolId, input) {
  switch (toolId) {
    case 'uptime.check': {
      const urls = input.urls;
      if (!urls || !Array.isArray(urls) || urls.length === 0) {
        return { success: false, error: 'Missing required field: urls (array)' };
      }
      const timeout = Math.min(parseInt(input.timeout) || 10, 30) * 1000;
      const expectedStatus = input.expected_status || 200;

      const results = await Promise.all(urls.slice(0, 20).map(async (url) => {
        const start = Date.now();
        try {
          const resp = await fetch(url, { signal: AbortSignal.timeout(timeout) });
          const latency = Date.now() - start;
          return {
            url,
            status: resp.status,
            latency_ms: latency,
            healthy: resp.status === expectedStatus
          };
        } catch (err) {
          return { url, status: 0, latency_ms: Date.now() - start, healthy: false, error: err.message };
        }
      }));

      return {
        success: true,
        results,
        summary: {
          total: results.length,
          healthy: results.filter(r => r.healthy).length,
          unhealthy: results.filter(r => !r.healthy).length
        }
      };
    }

    case 'uptime.sla_report':
      return { success: false, error: 'SLA reporting requires a monitoring backend (e.g., Uptime Kuma). Not yet connected.' };

    case 'uptime.incidents':
      return { success: false, error: 'Incident history requires a monitoring backend. Not yet connected.' };

    case 'uptime.dependencies':
      return { success: false, error: 'Dependency checking requires a service map. Not yet connected.' };

    default:
      return { success: false, error: `Unknown uptime tool: ${toolId}` };
  }
}

// ============================================================================
// Main execute() entry point
// ============================================================================

module.exports = {
  async execute(toolId, input, ctx) {
    // Determine the tool category from the ID prefix
    const prefix = toolId.split('.')[0];

    // Tools that don't use SSH — handle directly
    if (prefix === 'fleet') {
      return executeFleetTool(toolId, input);
    }
    if (prefix === 'alerts') {
      return executeAlertsTool(toolId, input);
    }
    if (prefix === 'uptime') {
      return executeUptimeTool(toolId, input);
    }

    // Proxmox golden-clone tools — multi-step (template-flag lookup + act),
    // so they bypass the generic single-command build+execute flow below.
    // Real Proxmox calls only happen here, AFTER withApprovalGate resolves
    // (both are requiresApproval:true in proxmox-extended.json).
    if (toolId === 'proxmox.vm.snapshot') {
      return proxmoxVmSnapshot(callBastion, input);
    }
    if (toolId === 'proxmox.vm.clone') {
      return proxmoxVmClone(callBastion, input);
    }

    // system.sudo_setup proxies to Bastion's own native sudo-setup tool
    // (visudo-validated) via /api/v1/tools/run, not a raw SSH command.
    // BASTION-CRED Phase 2: when the day-2 user itself has no sudo (Bastion
    // reports the exact sentinel `sudo_password_required`), fall back to the
    // host's linked bootstrap credential: grant NOPASSWD directly, verify via
    // the day-2 path, then revoke the bootstrap credential. This whole tool
    // is behind requiresApproval, so the fallback runs only inside an
    // already-approved call.
    if (toolId === 'system.sudo_setup') {
      if (!input.host) return { success: false, error: 'Missing required field: host' };
      const user = input.user || 'control';
      // TRUST-PROOF: fail-closed grant mint (see mintGrantForCtx) binding
      // this exact tool+params+target to the approved HITL item.
      let sudoSetupGrant;
      try {
        sudoSetupGrant = await mintGrantForCtx(ctx, {
          action: 'tool',
          toolId: 'sudo-setup',
          params: { user },
          targets: [input.host],
        });
      } catch (err) {
        if (err && err.code === 'grant_mint_failed') return { success: false, error: err.message };
        throw err;
      }
      const result = await callBastionToolRun('sudo-setup', input.host, { user }, sudoSetupGrant);
      if (result.success || !isSudoPasswordFailure(result)) return result;

      const orgId = (ctx && ctx.orgId) || input.org_id || null;
      if (!orgId) {
        return {
          ...result,
          fallback: 'Bootstrap-credential fallback unavailable: no org context on this call.',
        };
      }
      console.log(`[BastionSSH] sudo-setup hit sudo_password_required on ${input.host}, trying bootstrap-credential fallback`);
      const fb = await grantNopasswdViaBootstrap({ hostId: input.host, orgId, user });
      if (!fb.success) {
        return {
          success: false,
          error: `sudo_password_required, and bootstrap fallback failed (${fb.code}): ${fb.detail}`,
          steps: fb.steps,
        };
      }
      return { success: true, output: fb.detail, fallback_used: 'bootstrap_credential', steps: fb.steps };
    }

    // SSH-based tools — build command and execute via bastion
    // QUOXTRUST FND_..SK5C (shell-injection): validate EVERY model-supplied field that any builder
    // below interpolates into the shell command, BEFORE the command is built or a grant is minted.
    // Positive allowlist per field kind (lib/shellSafe.js); refuse (never escape) on violation.
    // This is the single choke for all five builder families — the same discipline applied to the
    // native executors (SGFV/SHGH), now on this parallel bastion_ssh code path. The raw-exec tools
    // (fleet.execute / *.execute, input.command) are handled elsewhere and are approval-gated.
    const _scalarKinds = {
      container: 'container', container_id: 'container', since: 'since', grep: 'grep',
      path: 'path', unit: 'unit', priority: 'priority', user: 'user',
      target: 'host', domain: 'host', node: 'host',
      dns_type: 'dnsrr', dnsType: 'dnsrr', vmid: 'vmid', org_id: 'orgid', db_path: 'path',
    };
    for (const [field, kind] of Object.entries(_scalarKinds)) {
      if (!isSafeShellArg(kind, input[field])) {
        return { success: false, error: `invalid_${field}`, detail: `bastion_ssh: ${field} contains characters not allowed in a shell argument (injection guard)` };
      }
    }
    const _arrayChecks = [['ports', 'port'], ['targets', 'host'], ['eventTypes', 'eventtype']];
    for (const [field, kind] of _arrayChecks) {
      const v = input[field];
      const arr = Array.isArray(v) ? v : (v != null ? [v] : []);
      for (const el of arr) {
        if (!isSafeShellArg(kind, String(el))) {
          return { success: false, error: `invalid_${field}`, detail: `bastion_ssh: ${field} entries contain characters not allowed in a shell argument (injection guard)` };
        }
      }
    }

    let built = null;

    switch (prefix) {
      case 'system':
        built = buildSystemCommand(toolId, input);
        break;
      case 'docker':
        built = buildDockerCommand(toolId, input);
        break;
      case 'network':
        built = buildNetworkCommand(toolId, input);
        break;
      case 'security':
        built = buildSecurityCommand(toolId, input);
        break;
      case 'proxmox':
        built = buildProxmoxExtCommand(toolId, input);
        break;
      default:
        return { success: false, error: `Bastion SSH executor: no handler for tool category '${prefix}' (toolId: ${toolId})` };
    }

    if (!built) {
      return { success: false, error: `Bastion SSH executor: unrecognised tool '${toolId}'` };
    }

    // Check for validation errors from the builder
    if (built.error) {
      return { success: false, error: built.error };
    }

    // TRUST-PROOF: fail-closed grant mint (see mintGrantForCtx) binding
    // this exact command+target to the approved HITL item.
    let execGrant;
    try {
      execGrant = await mintGrantForCtx(ctx, {
        action: 'exec',
        command: built.cmd,
        targets: [built.host],
      });
    } catch (err) {
      if (err && err.code === 'grant_mint_failed') return { success: false, error: err.message };
      throw err;
    }

    // Execute via bastion
    const result = await callBastion(built.host, built.cmd, execGrant);

    // Return raw result with context
    return {
      success: result.success !== false,
      host: built.host,
      tool: toolId,
      output: result.stdout || result.output || '',
      stderr: result.stderr || '',
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      ...(result.error && result.success === false ? { error: result.error } : {})
    };
  }
};

// Test-only surface (bastionGrantFailClosed.test.js pins the fail-closed
// mint semantics without driving a full executor call).
module.exports._internal = { mintGrantForCtx, mintApprovalGrant, mintEngagementGrant, mintStandingGrant };
