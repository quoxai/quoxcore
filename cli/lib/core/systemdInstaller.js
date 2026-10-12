/**
 * Systemd USER unit installer for the resident supervisor, Option A
 * persistence (DEVSUITE-DEVMODE follow-on, quox#453 phase 15 follow-on).
 *
 * A resident's `quox dev supervisor run` proved out one-shot passes; this
 * module is the delivery half: a `Restart=always` systemd --user unit so the
 * runner answers its slot channel with no session open and comes back after
 * a crash, a logout, or a reboot (the last of those needs `loginctl
 * enable-linger`, see installSupervisorService below).
 *
 * GOVERNANCE NOTE: installing this unit is deliberately NOT the autonomy
 * grant. The unit only ever answers a message when the human-gated
 * server-side switch (`quox dev supervisor enable`, requireHumanAdmin on the
 * collector) is on, see supervisorEngine.js's kill-switch check in
 * runPollOnce. A resident may install its own service on its own host (the
 * scoped self-service pattern), while a human still decides whether it may
 * act. Installing the unit and being allowed to act are two different
 * switches on purpose.
 *
 * Every systemctl/loginctl call goes through one injectable `execFn` seam
 * (see realExecFn below) so this is fully testable without touching the
 * real system: tests pass a fake execFn and never spawn systemctl.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export const SERVICE_NAME = 'quox-resident-supervisor.service';
export const DEFAULT_RESTART_SEC = 10;

// Item 2 (found by the acceptance owner driving this on a real host,
// 2026-08-23): `systemctl --user enable --now` reporting success only
// proves systemd ACCEPTED the unit, not that it stayed up. A unit whose
// ExecStart dies immediately (the item 1 slot bug is exactly this) is
// already crash-looping under Restart=always by the time enable returns.
// Give it a few seconds, then read the live state back through the same
// injectable execFn seam before calling install a success.
export const DEFAULT_VERIFY_DELAY_MS = 3000;

export function defaultUnitDir() {
  return join(homedir(), '.config', 'systemd', 'user');
}

export function defaultUnitPath() {
  return join(defaultUnitDir(), SERVICE_NAME);
}

/**
 * Build the unit file content. Pure string building, no I/O, so it is
 * trivially snapshot-testable.
 *
 * `env`: extra `Environment=KEY=VALUE` lines, baked in at install time
 * (item 1, live outage 2026-08-23). A systemd unit inherits none of the
 * caller's shell environment, so this is how a resident's reach-back URLs
 * (QUOX_URL/QUOX_AUTH_URL/QUOX_COLLECTOR_URL/QUOX_INSECURE) survive into a
 * unit that runs with no login shell present. A value containing a newline
 * or a quote would break the unit file's own line-based format, or the
 * shell-like word-splitting systemd applies to `Environment=`, so it is
 * refused outright rather than escaped: an unrenderable value is a defect
 * in the caller, not something this function should paper over.
 */
export function buildUnitFile({ quoxBin, extraArgs = [], restartSec = DEFAULT_RESTART_SEC, home = homedir(), env = {} } = {}) {
  const bin = quoxBin || 'quox';
  const argsSuffix = extraArgs.length ? ` ${extraArgs.join(' ')}` : '';
  const envLines = Object.entries(env || {}).map(([key, value]) => {
    const v = String(value);
    if (/[\n"']/.test(v)) {
      throw new Error(
        `buildUnitFile: refusing to bake ${key} into the unit: its value contains a newline or a quote character `
        + `(value withheld from this message). Fix the source value rather than escaping it.`
      );
    }
    return `Environment=${key}=${v}`;
  });
  return [
    '[Unit]',
    'Description=Quox resident supervisor (answers the slot channel headlessly, no session open)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${bin} dev supervisor run --service${argsSuffix}`,
    'Restart=always',
    `RestartSec=${restartSec}`,
    `Environment=HOME=${home}`,
    ...envLines,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/**
 * Real systemctl/loginctl runner (the non-test default). Never throws for a
 * nonzero exit: callers read `.ok`/`.stderr`, so a failed `enable-linger`
 * (e.g. no permission) is data, not a crash.
 */
export async function realExecFn(cmd, args) {
  return execFileAsync(cmd, args, { timeout: 15000 });
}

/** Parses `systemctl --user show <unit> -p A,B,C` stdout ("KEY=value" per line) into an object. */
function parseSystemctlShow(stdout) {
  const props = {};
  for (const line of String(stdout || '').split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    props[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return props;
}

async function runExec(execFn, cmd, args) {
  try {
    const res = await execFn(cmd, args);
    return { ok: true, code: 0, stdout: (res && res.stdout) || '', stderr: (res && res.stderr) || '' };
  } catch (err) {
    return {
      ok: false,
      code: err && err.code != null ? err.code : 1,
      stdout: (err && err.stdout) || '',
      stderr: (err && (err.stderr || err.message)) || String(err),
    };
  }
}

/**
 * Write the unit, reload the daemon, enable + start it now, and attempt
 * linger. Every step's outcome is reported back rather than thrown, because
 * a partial success (unit written, enabled, but linger refused) is the
 * single most important case this reports honestly: the service DOES start
 * now, but will not survive a reboot or logout until linger is granted.
 */
export async function installSupervisorService({
  execFn,
  writeFileFn,
  mkdirFn,
  unitPath = defaultUnitPath(),
  unitDir = defaultUnitDir(),
  unitContent,
  user,
  // Injectable so tests never wait the real delay. Defaults to a real sleep
  // outside tests, same seam discipline as execFn/writeFileFn/mkdirFn.
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  verifyDelayMs = DEFAULT_VERIFY_DELAY_MS,
}) {
  mkdirFn(unitDir, { recursive: true });
  writeFileFn(unitPath, unitContent);

  const reload = await runExec(execFn, 'systemctl', ['--user', 'daemon-reload']);
  const enable = await runExec(execFn, 'systemctl', ['--user', 'enable', '--now', SERVICE_NAME]);
  const linger = await runExec(execFn, 'loginctl', ['enable-linger', user]);

  // Item 2: post-start verification. Only meaningful once `enable --now`
  // itself reported success — if enable failed outright there is nothing
  // running to crash-loop, and the enable_error above already says so.
  let verified = false;
  let active = false;
  let restartCount = null;
  let crashLoop = false;
  let crashJournal = null;
  if (enable.ok) {
    await sleepFn(verifyDelayMs);
    const show = await runExec(execFn, 'systemctl', ['--user', 'show', SERVICE_NAME, '-p', 'NRestarts,ActiveState,SubState']);
    verified = true;
    if (show.ok) {
      const props = parseSystemctlShow(show.stdout);
      active = props.ActiveState === 'active';
      const n = Number(props.NRestarts);
      restartCount = Number.isFinite(n) ? n : null;
      // Restart=always means one crash silently reads as "started fine"
      // unless something checks back: any restart already counted, or a
      // state that isn't active, in our short observation window is a
      // crash loop, not a success, however cheerfully `enable --now` read.
      crashLoop = !active || (restartCount != null && restartCount > 0);
    } else {
      // Could not read the live state back at all: never claim success on
      // silence — same "an error body is not data" discipline as the rest
      // of this codebase's proof-before-claim rule.
      crashLoop = true;
    }
    if (crashLoop) {
      const journal = await runExec(execFn, 'journalctl', ['--user', '-u', SERVICE_NAME, '-n', '20', '--no-pager']);
      crashJournal = journal.ok ? journal.stdout : null;
    }
  }

  return {
    unit_path: unitPath,
    daemon_reloaded: reload.ok,
    daemon_reload_error: reload.ok ? null : (reload.stderr || `exit ${reload.code}`),
    enabled: enable.ok,
    enable_error: enable.ok ? null : (enable.stderr || `exit ${enable.code}`),
    linger_enabled: linger.ok,
    linger_error: linger.ok ? null : (linger.stderr || `exit ${linger.code}`),
    verified,
    active,
    restart_count: restartCount,
    crash_loop: crashLoop,
    crash_journal: crashJournal,
  };
}

export async function uninstallSupervisorService({
  execFn,
  existsFn,
  unlinkFn,
  unitPath = defaultUnitPath(),
}) {
  const disable = await runExec(execFn, 'systemctl', ['--user', 'disable', '--now', SERVICE_NAME]);

  let removed = false;
  if (existsFn(unitPath)) {
    unlinkFn(unitPath);
    removed = true;
  }

  const reload = await runExec(execFn, 'systemctl', ['--user', 'daemon-reload']);

  return {
    disabled: disable.ok,
    disable_error: disable.ok ? null : (disable.stderr || `exit ${disable.code}`),
    unit_removed: removed,
    daemon_reloaded: reload.ok,
  };
}

/**
 * Read-only install/enable/active/linger report for `quox dev supervisor
 * status`. Never throws: an unreadable systemctl/loginctl reports as
 * false/unknown rather than crashing a status check.
 */
export async function getServiceInstallStatus({
  execFn,
  existsFn,
  unitPath = defaultUnitPath(),
  user,
}) {
  const installed = existsFn(unitPath);
  const enabledRes = await runExec(execFn, 'systemctl', ['--user', 'is-enabled', SERVICE_NAME]);
  const activeRes = await runExec(execFn, 'systemctl', ['--user', 'is-active', SERVICE_NAME]);
  const lingerRes = await runExec(execFn, 'loginctl', ['show-user', user, '--property=Linger', '--value']);

  return {
    installed,
    enabled: enabledRes.stdout.trim() === 'enabled',
    active: activeRes.stdout.trim() === 'active',
    linger: lingerRes.stdout.trim().toLowerCase() === 'yes',
  };
}
