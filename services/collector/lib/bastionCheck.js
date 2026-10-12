/**
 * BASTION-UX Layer 1 — preflight SSH auth check
 *
 * Pure function used by the GET /collector/bastion/check endpoint.
 * Probes whether passwordless SSH from the collector to a fleet host
 * succeeds. Returns a structured result the frontend uses to decide
 * whether to mount xterm or render a remediation banner.
 *
 * Inject `execFn` for tests; in production it's wrapped around
 * child_process.execFile.
 *
 * Default execFn signature:
 *   execFn(cmd, args, opts) -> Promise<{ code, stdout, stderr }>
 */

import { execFile } from 'child_process';

/**
 * Default exec wrapper around child_process.execFile.
 */
function defaultExec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout, ...opts }, (err, stdout, stderr) => {
      // execFile callback: err is non-null on non-zero exit OR signal
      const code = err ? (typeof err.code === 'number' ? err.code : 255) : 0;
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/**
 * Classify ssh stderr/exit into one of:
 *   ok | auth | timeout | network | unknown
 */
function classifyResult({ code, stderr }) {
  if (code === 0) return 'ok';
  if (code === 124) return 'timeout';
  const s = (stderr || '').toLowerCase();
  if (s.includes('permission denied')) return 'auth';
  if (s.includes('connection timed out') || s.includes('operation timed out')) return 'timeout';
  if (s.includes('could not resolve hostname') || s.includes('network is unreachable') || s.includes('no route to host')) return 'network';
  return 'unknown';
}

/**
 * @param {Object} args
 * @param {string} args.hostId
 * @param {{ getHost: (id: string) => Object | null }} args.hostRegistry
 * @param {string} args.sshKeyPath  Path to the SSH private key on the collector.
 * @param {number} [args.timeoutMs=3000]
 * @param {Function} [args.execFn]  Injectable for tests.
 * @returns {Promise<{ ok, reason, host?, stderr? }>}
 */
export async function checkHostAuth({
  hostId,
  hostRegistry,
  sshKeyPath,
  timeoutMs = 3000,
  execFn = defaultExec,
}) {
  if (!hostId || !hostRegistry || typeof hostRegistry.getHost !== 'function') {
    return { ok: false, reason: 'unknown_host' };
  }

  const raw = hostRegistry.getHost(hostId);
  if (!raw || !raw.ip) {
    return { ok: false, reason: 'unknown_host' };
  }

  const user = (raw.ssh && raw.ssh.user) || 'control';
  const port = raw.ssh && raw.ssh.port;
  const host = { id: raw.id || hostId, user, ip: raw.ip };

  // Build ssh args
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${Math.max(1, Math.floor(timeoutMs / 1000))}`,
  ];
  if (sshKeyPath) args.push('-i', sshKeyPath);
  if (port && port !== 22) args.push('-p', String(port));
  args.push(`${user}@${raw.ip}`, 'true');

  let result;
  try {
    result = await execFn('ssh', args, { timeout: timeoutMs + 1000 });
  } catch (err) {
    return { ok: false, reason: 'unknown', host, stderr: err && err.message ? err.message : 'exec failed' };
  }

  const reason = classifyResult(result);
  if (reason === 'ok') return { ok: true, reason: 'ok', host };
  return { ok: false, reason, host, stderr: result.stderr || '' };
}

export default { checkHostAuth };
