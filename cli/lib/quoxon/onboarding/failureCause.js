/**
 * FIRSTRUN (2026-10-19): a failed install says WHY in one plain line, for the causes a stranger can act on.
 * Input: installer output plus the tail of the build log setup.sh names. Output: { kind, host?, message } | null.
 * Prebuilt images being unavailable ("error from registry: denied") is never a cause: the installer builds instead.
 */
const RETRY = 'then press r to try again.';

const NETWORK = [
  /Could not connect to ([a-z0-9.-]+\.[a-z]{2,}):\d+/i,
  /Temporary failure resolving '([^']+)'/i,
  /Failed to fetch https?:\/\/([a-z0-9.-]+\.[a-z]{2,})\/\S*\s+(?:Could not connect|Unable to connect|Connection failed|Temporary failure)/i,
  /request to https?:\/\/([a-z0-9.-]+\.[a-z]{2,})\/\S* failed, reason: (?:connect )?(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)/i,
  /getaddrinfo (?:EAI_AGAIN|ENOTFOUND) ([a-z0-9.-]+\.[a-z]{2,})/i
];

export function explainInstallFailure(text) {
  const t = String(text ?? '');
  if (!t.trim()) return null;
  for (const re of NETWORK) {
    const m = re.exec(t);
    if (m) {
      const host = m[1].toLowerCase();
      return { kind: 'network', host, message: `The build could not reach ${host}, a package server. Check this machine's internet connection, firewall or proxy, ${RETRY}` };
    }
  }
  if (/no space left on device/i.test(t)) {
    return { kind: 'disk', message: `The disk filled up during the build. Free some space (docker system prune -f frees old build cache), ${RETRY}` };
  }
  if (/heap out of memory|exit code: 137\b|\bOOMKilled\b|Cannot allocate memory/i.test(t)) {
    return { kind: 'memory', message: `The build ran out of memory. Close other programs or give this machine more RAM (8 GB is recommended), ${RETRY}` };
  }
  return null;
}
