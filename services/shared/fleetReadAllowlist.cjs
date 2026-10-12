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

function tokens(command) {
  return command.trim().split(/\s+/).filter(Boolean);
}

/**
 * @param {string} command
 * @returns {boolean} true iff `command` is a read-only fleet command safe to auto-mint.
 */
function isAllowlistedFleetRead(command) {
  if (typeof command !== 'string') return false;
  const cmd = command.trim();
  if (!cmd || cmd.length > 512) return false;
  if (SHELL_METACHARS.test(cmd)) return false;          // no shell power, at all

  const t = tokens(cmd);
  const bin = t[0];
  const args = t.slice(1);

  if (PURE_READ_BINARIES.has(bin)) return true;

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
