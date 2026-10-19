'use strict';
/**
 * fleetReadAllowlist.cjs — QUOXTRUST F14 (FND_01M3R9X647CMRA4NBBXFCMRA4N).
 *
 * A live read-only fleet log-collection loop (~94/hr journalctl reads) is 403'd by
 * the bastion's risky-mode approval gate. The owner's chosen fix is grant-minting:
 * keep EVERYTHING gated, but let a governed automation identity AUTO-MINT a signed,
 * short-lived, single-use X-Bastion-Approval-Grant for a small, explicit set of
 * read-only commands. This module is the crown jewel of that design: the classifier
 * that decides whether a command may auto-mint.
 *
 * It is DEFAULT-DENY and deliberately paranoid. It is the ONE source of truth used by
 * BOTH the collector (pre-mint gate) AND the auth signer (independent re-validation
 * before signing) so the two can never drift — a command auth would refuse to sign is
 * a command the collector refuses to present, and vice versa. A command that is NOT
 * allowlisted is NOT an error; it simply falls back to the normal human-approval path.
 *
 * A false positive here is a real hole (an auto-minted grant runs on live fleet hosts
 * with no human in the loop), so the bar is: obviously-read-only, no shell power, no
 * mutating flag/subcommand. When in doubt, DENY.
 */

// Shell metacharacters that enable chaining / substitution / redirection / globbing.
// The bastion runs the command through a remote shell, so ANY of these turns a
// "read" into arbitrary execution. Their presence is an immediate DENY.
const SHELL_METACHARS = /[;|&$`()<>\n\r\\{}\[\]*?!#]/;

// Read-only binaries whose every documented sub-operation is a read, so flags are
// safe once shell metacharacters are excluded.
const PURE_READ_BINARIES = new Set(['uptime', 'df', 'free', 'uname', 'w', 'vmstat', 'iostat', 'lsblk', 'lscpu',
  // 2026-10-03 (owner: stop approval spam for harmless diagnostics): identity
  // and liveness probes. echo only prints (metachars are already refused, so
  // no substitution); whoami/id/nproc have no mutating mode.
  'whoami', 'id', 'echo', 'nproc']);

// Dual-use binaries allowed only in their read forms.
// hostname: bare or read flags only ('hostname x' / -F SET the hostname).
const HOSTNAME_READ_FLAGS = new Set(['-f', '--fqdn', '-s', '--short', '-i', '--ip-address', '-I', '--all-ip-addresses', '-d', '--domain', '-A', '--all-fqdns']);
// date: anything but -s/--set (which sets the clock).
const DATE_SET_FLAG = /^(-s|--set)(=|$)/;
// ping: must be bounded (-c 1..10), no flood/fast-interval/oversize/preload.
const PING_MAX_COUNT = 10;
const PING_ALLOWED_FLAGS = new Set(['-c', '-W', '-w', '-q', '-n', '-4', '-6']);

// journalctl is read-only EXCEPT for a handful of log-mutating flags — reject those.
const JOURNALCTL_MUTATING_FLAG = /^--(vacuum-size|vacuum-time|vacuum-files|rotate|flush|sync|relinquish-var|smart-relinquish-var|update-catalog|setup-keys)\b/;

// systemctl / *ctl are dual-use: only these subcommands are reads.
const SYSTEMCTL_READ_SUBCMDS = new Set([
  'status', 'is-active', 'is-enabled', 'is-failed', 'show', 'cat',
  'list-units', 'list-unit-files', 'list-timers', 'list-sockets',
  'list-dependencies', 'list-jobs', 'get-default', 'show-environment',
]);
const CTL_STATUS_ONLY = new Set(['status', 'show', 'list-users', 'list-sessions', 'list-timezones']);
const CTL_BINARIES_STATUS_ONLY = new Set(['hostnamectl', 'timedatectl', 'loginctl', 'localectl']);

// QUOXON 2026-10-19 (owner: "recon the fleet and dockers for claude installations and grab the version numbers";
// both probes were dropped, nothing ran). Version / presence probes, EXACT shapes only:
//   <bin> --version              bin from this fixed set (an unknown binary is not a read just because it says --version)
//   command -v <name>...         -v / -V only: bare `command <name>` RUNS the program
//   which [-a] <name>...
//   docker exec [-u <user>] <container> <bin> --version    the inner command must be the version probe above
const VERSION_PROBE_BINARIES = new Set(['claude', 'codex', 'gemini', 'node', 'npm', 'git', 'docker', 'python3', 'quoxagent']);
const NAME_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
function isVersionProbe(t) {
  if (t.length === 2 && t[0] === 'quoxagent' && t[1] === 'version') return true;
  return t.length === 2 && VERSION_PROBE_BINARIES.has(t[0]) && t[1] === '--version';
}
function isPresenceProbe(t) {
  if (t[0] === 'command') return (t[1] === '-v' || t[1] === '-V') && t.length >= 3 && t.slice(2).every((n) => NAME_TOKEN.test(n));
  if (t[0] === 'which') {
    const names = t[1] === '-a' ? t.slice(2) : t.slice(1);
    return names.length >= 1 && names.every((n) => NAME_TOKEN.test(n));
  }
  return false;
}
function isDockerExecVersionProbe(t) {
  if (t[0] !== 'docker' || t[1] !== 'exec') return false;
  let i = 2;
  if (t[i] === '-u') {
    if (!NAME_TOKEN.test(t[i + 1] || '')) return false;
    i += 2;
  }
  if (!NAME_TOKEN.test(t[i] || '')) return false;     // container name; a flag here (-it, --privileged, -e) is refused
  return isVersionProbe(t.slice(i + 1));
}

// QUOXON-FLEETREAD: plain `ls` (names only) with a tiny flag set and 1..8 absolute, secret-free paths.
const LS_FLAG = /^-[lahdtrS1]+$/;
const LS_PATH = /^\/[A-Za-z0-9._/@+-]*$/;
const LS_DENIED_PATH = /(^\/proc\/[^/]*\/environ|^\/etc\/g?shadow|^\/root(\/|$)|secret|key|\.ssh)/i;
function isLsRead(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (!(LS_FLAG.test(args[i]) || args[i] === '--all')) return false;
    i += 1;
  }
  const paths = args.slice(i);
  if (paths.length < 1 || paths.length > 8) return false;
  return paths.every((p) => LS_PATH.test(p) && !p.includes('..') && !LS_DENIED_PATH.test(p));
}

// QUOXON-FLEETREAD: system_cron's one vetted read-only composite (cat/ls/crontab -l/systemctl list-timers style reads;
// no writes, no sudo, no network). EXACT byte-match only, imported (never copied) from the collector's single
// definition so the two cannot drift. Unresolvable => null => fails CLOSED (the general chain rule stays strict).
// Repo layout: ../collector/lib; collector image layout: /app/services-shared -> /app/lib.
const VETTED_CRON_ALL_CMD = (() => {
  for (const p of ['../collector/lib/cronReadCommand.js', '../lib/cronReadCommand.js']) {
    try {
      const v = require(p).CRON_ALL_CMD;
      if (typeof v === 'string' && v) return v;
    } catch (_) { /* try next */ }
  }
  return null;
})();

function tokens(command) {
  return command.trim().split(/\s+/).filter(Boolean);
}

/**
 * @param {string} command
 * @returns {boolean} true iff `command` is a read-only fleet command safe to auto-mint.
 */
function isAllowlistedFleetRead(command) {
  if (typeof command !== 'string') return false;
  let cmd = command.trim();
  if (VETTED_CRON_ALL_CMD !== null && command === VETTED_CRON_ALL_CMD) return true;  // exact match, before any stripping
  if (!cmd || cmd.length > 512) return false;
  // The ONLY redirect allowed: a single trailing ` 2>/dev/null` (stderr to the void), stripped before checking.
  // Chains (; && ||) and pipes stay refused by SHELL_METACHARS below: one allowlisted command per call.
  cmd = cmd.replace(/\s2>\/dev\/null$/, '');
  // Exact fixed-path file reads; the glob is this literal and nothing else.
  if (cmd === 'cat /etc/os-release' || cmd === 'cat /etc/*-release') return true;
  if (SHELL_METACHARS.test(cmd)) return false;          // no shell power, at all
  // QUOXON-FLEETREAD: exact `cat /etc/crontab` and `cat /etc/cron.d/<name>` (plain filename, no slash/../glob).
  if (cmd === 'cat /etc/crontab') return true;
  {
    const m = /^cat \/etc\/cron\.d\/([A-Za-z0-9._-]+)$/.exec(cmd);
    if (m && !m[1].includes('..')) return true;
  }

  const t = tokens(cmd);
  const bin = t[0];
  const args = t.slice(1);

  if (PURE_READ_BINARIES.has(bin)) return true;

  if (isVersionProbe(t) || isPresenceProbe(t) || isDockerExecVersionProbe(t)) return true;

  if (bin === 'ls') return isLsRead(args);

  if (bin === 'crontab') return args.length === 1 && args[0] === '-l';

  if (bin === 'hostname') return args.every((a) => HOSTNAME_READ_FLAGS.has(a));

  if (bin === 'date') return !args.some((a) => DATE_SET_FLAG.test(a));

  if (bin === 'ping') {
    let count = null; let target = 0;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('-')) {
        if (!PING_ALLOWED_FLAGS.has(a)) return false;      // -f, -i, -s, -l, -p ... refused
        if (a === '-c' || a === '-W' || a === '-w') {
          const v = args[i + 1];
          if (!/^\d+$/.test(v || '')) return false;
          if (a === '-c') count = Number(v);
          if ((a === '-W' || a === '-w') && Number(v) > 30) return false;
          i += 1;
        }
      } else {
        target += 1;
      }
    }
    return target === 1 && count !== null && count >= 1 && count <= PING_MAX_COUNT;
  }

  if (bin === 'journalctl') {
    // read-only unless a mutating flag is present
    return !args.some((a) => JOURNALCTL_MUTATING_FLAG.test(a));
  }

  if (bin === 'systemctl') {
    // first non-flag token is the subcommand; it MUST be a read subcommand.
    const sub = args.find((a) => !a.startsWith('-'));
    if (!sub) return false;                              // bare `systemctl` (interactive) — deny
    return SYSTEMCTL_READ_SUBCMDS.has(sub);
  }

  if (CTL_BINARIES_STATUS_ONLY.has(bin)) {
    const sub = args.find((a) => !a.startsWith('-'));
    if (!sub) return true;                               // bare `hostnamectl` etc. is a read
    return CTL_STATUS_ONLY.has(sub);                     // any set-* subcommand → deny
  }

  return false;                                          // default deny
}

module.exports = { isAllowlistedFleetRead, SHELL_METACHARS };
