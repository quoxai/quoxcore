/**
 * Docker Tool Executor
 *
 * Native executor for docker_status and docker_extended tools.
 * Replaces docker-status.json and docker-extended.json n8n workflows.
 * Calls bastion SSH → parses output → returns structured response.
 */

const { isSafeShellArg } = require('../shellSafe.js');

/**
 * docker_status — list containers on a host
 */
async function dockerStatus(callBastion, input) {
  const host = input.host || 'docker01';
  const showAll = input.show_all ? '-a ' : '';
  const cmd = `docker ps ${showAll}--format "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}"`;

  const result = await callBastion(host, cmd);
  if (!result.success && !result.output) {
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
async function dockerExtended(callBastion, input) {
  const host = input.host || 'docker01';
  const operation = input.operation || 'status';
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
    default:
      cmd = `docker ps --format "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}"`;
  }

  const result = await callBastion(host, cmd);
  if (!result.success && !result.output) {
    return result;
  }

  const raw = result.output || result.stdout || '';
  return formatDockerExtended(operation, raw, host, container);
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
        const data = JSON.parse(raw);
        return {
          success: true, host, container, operation: 'inspect',
          details: {
            name: data.Name,
            image: data.Config?.Image,
            status: data.State?.Status,
            created: data.Created,
            ports: data.NetworkSettings?.Ports || {},
            mounts: (data.Mounts || []).map(m => ({
              type: m.Type, source: m.Source, destination: m.Destination
            }))
          }
        };
      } catch {
        return { success: true, host, container, operation: 'inspect', raw };
      }
    }

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

module.exports = { dockerStatus, dockerExtended };
