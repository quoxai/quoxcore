/**
 * Network Tool Executor
 *
 * Native executor for network_check tool.
 * Replaces network-check.json n8n workflow.
 * Supports ping, traceroute, dns, and port checking via bastion SSH.
 */

/**
 * network_check — ping, traceroute, DNS, or port scan a target
 */
const { isSafeShellArg } = require('../shellSafe.js');

async function networkCheck(callBastion, input) {
  const host = input.host || 'gw-01';
  const target = input.target;
  const checkType = input.type || 'ping';

  if (!target) {
    return { success: false, error: 'Missing required field: target' };
  }

  // QUOXTRUST FND_..SHGH (shell-injection): target/dns_type/ports are interpolated into a
  // shell command sent to the bastion; validate + REFUSE on any shell metachar before use.
  if (!isSafeShellArg('host', target)) {
    return { success: false, error: 'invalid_target', detail: 'target must be a hostname, domain, or IP (injection guard)' };
  }
  if (!isSafeShellArg('dnsrr', input.dns_type)) {
    return { success: false, error: 'invalid_dns_type', detail: 'dns_type must be a DNS record type like A/AAAA/MX (injection guard)' };
  }
  const _portsIn = input.ports != null ? (Array.isArray(input.ports) ? input.ports : [input.ports]) : [];
  for (const p of _portsIn) {
    if (!isSafeShellArg('port', String(p))) {
      return { success: false, error: 'invalid_port', detail: 'ports must be numeric (injection guard)' };
    }
  }

  let cmd;

  switch (checkType) {
    case 'ping': {
      const count = Math.min(parseInt(input.count) || 4, 10);
      cmd = `ping -c ${count} -W 2 ${target}`;
      break;
    }
    case 'traceroute':
      cmd = `traceroute -m 20 -w 2 ${target}`;
      break;
    case 'dns': {
      const dnsType = input.dns_type || 'A';
      cmd = `dig +short ${target} ${dnsType}`;
      break;
    }
    case 'ports': {
      const ports = input.ports || [22, 80, 443];
      const portList = (Array.isArray(ports) ? ports : [ports]).slice(0, 10);
      const portChecks = portList
        .map(p => `timeout 2 bash -c "echo >/dev/tcp/${target}/${p}" 2>/dev/null && echo "${p}:open" || echo "${p}:closed"`)
        .join('; ');
      cmd = portChecks;
      break;
    }
    default:
      return { success: false, error: `Invalid check type: ${checkType}. Valid: ping, traceroute, dns, ports` };
  }

  const result = await callBastion(host, cmd);
  if (!result.success && !result.output && !result.stdout) {
    return result;
  }

  const raw = result.output || result.stdout || '';
  return formatNetworkResult(checkType, raw, target, input);
}

function formatNetworkResult(checkType, raw, target, input) {
  const base = { success: true, target, type: checkType };

  switch (checkType) {
    case 'ping':
      return { ...base, ...parsePing(raw) };
    case 'traceroute':
      return { ...base, ...parseTraceroute(raw) };
    case 'dns':
      return { ...base, ...parseDns(raw, input.dns_type || 'A') };
    case 'ports':
      return { ...base, ...parsePorts(raw) };
    default:
      return { ...base, raw };
  }
}

function parsePing(raw) {
  const lines = raw.trim().split('\n');

  // Parse summary: "X packets transmitted, Y received, Z% packet loss"
  const summaryLine = lines.find(l => l.includes('packets transmitted'));
  let transmitted = 0, received = 0, lossPercent = 100;
  if (summaryLine) {
    const txMatch = summaryLine.match(/(\d+) packets transmitted/);
    const rxMatch = summaryLine.match(/(\d+) (?:packets )?received/); // iputils "N received" or BSD/inetutils "N packets received"
    const lossMatch = summaryLine.match(/([\d.]+)% packet loss/);
    if (txMatch) transmitted = parseInt(txMatch[1]);
    if (rxMatch) received = parseInt(rxMatch[1]);
    if (lossMatch) lossPercent = parseFloat(lossMatch[1]);
  }

  // Parse RTT: "rtt min/avg/max/mdev = X/Y/Z/W ms"
  const rttLine = lines.find(l => l.includes('rtt') || l.includes('round-trip'));
  let rtt = null;
  if (rttLine) {
    const rttMatch = rttLine.match(/([\d.]+)\/([\d.]+)\/([\d.]+)/);
    if (rttMatch) {
      rtt = { min: rttMatch[1], avg: rttMatch[2], max: rttMatch[3] };
    }
  }

  return {
    ping: {
      reachable: received > 0,
      transmitted,
      received,
      lossPercent,
      rtt
    }
  };
}

function parseTraceroute(raw) {
  const lines = raw.trim().split('\n');
  const hops = [];

  // Skip header line ("traceroute to ...")
  for (const line of lines.slice(1)) {
    const hopMatch = line.match(/^\s*(\d+)\s+(.+)/);
    if (!hopMatch) continue;

    const hopNum = parseInt(hopMatch[1]);
    const rest = hopMatch[2];

    // Check for timeout (* * *)
    if (rest.includes('* * *')) {
      hops.push({ hop: hopNum, host: '*', ip: '*', rtt: null });
      continue;
    }

    // Parse: "hostname (ip) Xms Yms Zms"
    const hostMatch = rest.match(/^(\S+)\s+\((\S+)\)\s+([\d.]+)\s*ms/);
    if (hostMatch) {
      hops.push({
        hop: hopNum,
        host: hostMatch[1],
        ip: hostMatch[2],
        rtt: hostMatch[3]
      });
    } else {
      // Fallback: just grab what we can
      const parts = rest.trim().split(/\s+/);
      hops.push({ hop: hopNum, host: parts[0] || '*', ip: null, rtt: null });
    }
  }

  const lastHop = hops[hops.length - 1];
  return {
    traceroute: {
      hops,
      hopCount: hops.length,
      reachable: lastHop ? lastHop.host !== '*' : false
    }
  };
}

function parseDns(raw, dnsType) {
  const records = raw.trim().split('\n').filter(r => r.trim());
  return {
    dns: {
      type: dnsType,
      records,
      resolved: records.length > 0
    }
  };
}

function parsePorts(raw) {
  const portResults = raw.trim().split('\n').filter(Boolean).map(line => {
    const [port, status] = line.split(':');
    return { port: parseInt(port), status: status || 'unknown' };
  });

  return {
    ports: {
      results: portResults,
      open: portResults.filter(p => p.status === 'open').length,
      closed: portResults.filter(p => p.status === 'closed').length
    }
  };
}

module.exports = { networkCheck };
