/**
 * Docker Tool Executor
 *
 * Native executor for docker_status and docker_extended tools.
 * Replaces docker-status.json and docker-extended.json n8n workflows.
 * Calls bastion SSH → parses output → returns structured response.
 */

const { isSafeShellArg } = require('../shellSafe.js');
const { runSafeRead, dockerRead } = require('../bastionSafeRead.js');

/**
 * docker_status — list containers on a host
 */
async function dockerStatus(callBastion, input, deps = {}) {
  const host = input.host || 'docker01';
  const showAll = input.show_all ? '-a ' : '';
  const cmd = `docker ps ${showAll}--format "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}"`;

  // DEVFLEET-BUILTINS: builtin first, raw only when Bastion does not know the tool.
  const b = dockerRead.ps(input.show_all, '\t');
  const result = await runSafeRead('docker-read', host, b.params, () => callBastion(host, cmd), { ...deps, convert: b.convert });
  if (!result.success && !result.output) {
    // SITE-CLI 2026-10-17 fleet-offline-host-honest (ev_mvck6fpr_4f4cab): a host Docker cannot find was relayed as
    // "it isn't a host in your fleet" with no roster read. This failure only says Docker had no such host.
    if (/\b404\b|not found|no such host|unknown host/i.test(String(result.error || ''))) {
      return {
        ...result,
        error_code: 'not_found',
        error: `Docker has no host named "${host}" to read. That alone does not show whether ${host} is in the fleet: check fleet_status before saying it does not exist.`,
      };
    }
    return result;
  }

  const raw = result.output || result.stdout || '';
  const containers = raw.split('\n').filter(Boolean).map(line => {
    const [id, name, image, status, ports] = line.split('\t');
    return { id, name, image, status, ports: ports || '' };
  });

  const running = containers.filter(c => c.status && c.status.startsWith('Up')).length;

  return {
    success: true,
    host,
    showAll: !!input.show_all,
    containers,
    summary: {
      total: containers.length,
      running,
      stopped: containers.length - running
    }
  };
}

/**
 * docker_extended — logs, stats, restart, inspect, images
 */
async function dockerExtended(callBastion, input, deps = {}) {
  const host = input.host || 'docker01';
  // 'networks' is an accepted alias of the advertised 'network' op.
  const operation = input.operation === 'networks' ? 'network' : (input.operation || 'status');
  const container = input.container_id || input.container || '';

  // QUOXTRUST FND_..SHGH (shell-injection): container/since/grep are interpolated into a shell
  // command sent to the bastion; validate + REFUSE on any shell metachar before use. (Note:
  // the 'restart' op is a MUTATION and duplicates the gated docker_fleet_container_action — the
  // mediation gap is tracked as a separate finding; this fix removes the injection vector.)
  if (!isSafeShellArg('container', container)) {
    return { success: false, error: 'invalid_container', detail: 'container must be a valid docker name/id (injection guard)' };
  }
  if (!isSafeShellArg('since', input.since)) {
    return { success: false, error: 'invalid_since', detail: 'since contains characters not allowed in a shell argument (injection guard)' };
  }
  if (!isSafeShellArg('grep', input.grep)) {
    return { success: false, error: 'invalid_grep', detail: 'grep pattern contains characters not allowed in a shell argument (injection guard)' };
  }

  // QUOXTRUST FND_..SJS9 (complete mediation): docker_extended is a READ tool (its declared enum
  // is logs/stats/inspect/network). It must NOT perform container MUTATIONS — 'restart' here was
  // an ungated duplicate of the approval-gated docker_fleet_container_action (a parallel-path
  // bypass, the same shape as ssh_exec vs remote_ssh). Refuse it and point to the gated tool.
  const MUTATION_OPS = new Set(['restart', 'start', 'stop', 'kill', 'rm', 'remove']);
  if (MUTATION_OPS.has(operation)) {
    return {
      success: false,
      error: 'operation_not_allowed',
      detail: `docker_extended is read-only; use docker_fleet_container_action (approval-gated) to ${operation} a container.`,
    };
  }

  let cmd;

  switch (operation) {
    case 'logs': {
      const tail = Math.min(parseInt(input.tail) || 100, 500);
      const since = input.since ? ` --since "${input.since}"` : '';
      const grep = input.grep ? ` | grep -i "${input.grep.replace(/"/g, '\\"')}"` : '';
      cmd = `docker logs ${container} --tail ${tail}${since}${grep}`;
      break;
    }
    case 'stats':
      cmd = container
        ? `docker stats ${container} --no-stream --format "{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.MemPerc}}\\t{{.NetIO}}\\t{{.BlockIO}}"`
        : `docker stats --no-stream --format "{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.MemPerc}}\\t{{.NetIO}}\\t{{.BlockIO}}"`;
      break;
    // 'restart' (and other mutations) are refused above — docker_extended is read-only.
    case 'inspect':
      cmd = `docker inspect ${container} --format '{{json .}}'`;
      break;
    case 'images':
      cmd = `docker images --format "{{.Repository}}:{{.Tag}}\\t{{.Size}}\\t{{.CreatedSince}}"`;
      break;
    case 'network':
      cmd = `docker network ls --format "{{.Name}}\\t{{.Driver}}\\t{{.Scope}}\\t{{.ID}}"`;
      break;
    default:
      cmd = `docker ps --format "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}"`;
  }

  // DEVFLEET-BUILTINS: reads go builtin first. logs with since/grep filters keep the raw path
  // (the builtin takes only id + tail).
  let b = null;
  switch (operation) {
    case 'logs': if (!input.since && !input.grep && container) b = dockerRead.logs(container, Math.min(parseInt(input.tail) || 100, 500)); break;
    case 'stats': b = dockerRead.stats(container, '\t'); break;
    case 'inspect': if (container) b = dockerRead.inspect(container); break;
    case 'images': b = dockerRead.images('\t'); break;
    case 'network': b = dockerRead.networks('\t'); break;
    default: b = dockerRead.ps(false, '\t');
  }
  const result = b
    ? await runSafeRead('docker-read', host, b.params, () => callBastion(host, cmd), { ...deps, convert: b.convert, fallbackWhen: b.fallbackWhen })
    : await callBastion(host, cmd);
  // A Bastion whose docker-read predates the networks op rejects it as outside the allowlist.
  // Say so honestly; never fall back to a raw shell for that (raw reads need approval).
  if (operation === 'network' && !result.success && /op is not in the docker-read allowlist/.test(String(result.error || ''))) {
    return {
      success: false,
      error: 'bastion_upgrade_needed',
      detail: "This Bastion's docker-read builtin lacks the networks op; upgrade Bastion to list docker networks.",
    };
  }
  if (!result.success && !result.output) {
    return result;
  }

  const raw = result.output || result.stdout || '';
  return formatDockerExtended(operation, raw, host, container);
}

const NS_SECOND = 1e9;
function fmtDuration(ns) {
  const n = Number(ns);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const sec = n / NS_SECOND;
  return Number.isInteger(sec) ? `${sec}s` : `${Math.round(sec * 10) / 10}s`;
}

/**
 * Compact health block from State.Health + Config.Healthcheck. ALLOWLIST ONLY: status,
 * failing_streak, probe command/interval/timeout/retries, last 3 probe results (output <= 300 chars).
 * Returns undefined when the container has no healthcheck.
 */
function extractHealth(data) {
  const h = data && data.State && data.State.Health;
  const hc = data && data.Config && data.Config.Healthcheck;
  if (!h && !hc) return undefined;
  const test = Array.isArray(hc && hc.Test) ? hc.Test : [];
  const cmd = (test[0] === 'CMD-SHELL' || test[0] === 'CMD') ? test.slice(1).join(' ') : test.join(' ');
  const out = {};
  if (h) {
    out.status = h.Status;
    out.failing_streak = h.FailingStreak || 0;
  }
  if (cmd) out.test = cmd.slice(0, 300);
  if (hc) {
    const iv = fmtDuration(hc.Interval), to = fmtDuration(hc.Timeout);
    if (iv) out.interval = iv;
    if (to) out.timeout = to;
    if (hc.Retries != null) out.retries = hc.Retries;
  }
  if (h) {
    out.last_probes = (Array.isArray(h.Log) ? h.Log : []).slice(-3).map(l => ({
      start: l.Start, end: l.End, exit_code: l.ExitCode, output: String(l.Output == null ? '' : l.Output).trim().slice(0, 300),
    }));
  }
  return out;
}

function formatDockerExtended(operation, raw, host, container) {
  switch (operation) {
    case 'logs':
      return {
        success: true, host, container, operation: 'logs',
        logs: raw.split('\n').filter(Boolean),
        lineCount: raw.split('\n').filter(Boolean).length
      };

    case 'stats':
      return {
        success: true, host, operation: 'stats',
        stats: raw.split('\n').filter(Boolean).map(line => {
          const [name, cpu, memUsage, memPerc, netIO, blockIO] = line.split('\t');
          return { name, cpu, memUsage, memPerc, netIO, blockIO };
        })
      };

    case 'restart':
      return {
        success: true, host, container, operation: 'restart',
        healthStatus: raw.trim(),
        healthy: raw.trim() === 'healthy'
      };

    case 'inspect': {
      try {
        const parsed = JSON.parse(raw);
        const data = Array.isArray(parsed) ? (parsed[0] || {}) : parsed;
        return {
          success: true, host, container, operation: 'inspect',
          details: {
            name: data.Name,
            image: data.Config?.Image,
            status: data.State?.Status,
            created: data.Created,
            ports: data.NetworkSettings?.Ports || {},
            ...(extractHealth(data) ? { health: extractHealth(data) } : {}),
            mounts: (data.Mounts || []).map(m => ({
              type: m.Type, source: m.Source, destination: m.Destination
            }))
          }
        };
      } catch {
        return { success: true, host, container, operation: 'inspect', raw };
      }
    }

    case 'network':
      return {
        success: true, host, operation: 'network',
        networks: raw.split('\n').filter(Boolean).map(line => {
          const [name, driver, scope, id] = line.split('\t');
          return { name, driver, scope, id };
        })
      };

    case 'images':
      return {
        success: true, host, operation: 'images',
        images: raw.split('\n').filter(Boolean).map(line => {
          const [repo, size, created] = line.split('\t');
          return { repository: repo, size, created };
        })
      };

    default:
      return {
        success: true, host, operation: 'status',
        containers: raw.split('\n').filter(Boolean).map(line => {
          const [id, name, image, status, ports] = line.split('\t');
          return { id, name, image, status, ports: ports || '' };
        })
      };
  }
}

module.exports = { dockerStatus, dockerExtended, extractHealth };
