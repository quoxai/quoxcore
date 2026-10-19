/**
 * `quox done fetch` engine (quox#456 follow-on).
 *
 * quox#456 pointed `quox done` at /opt/quoxgauge, which is delivered ONLY by
 * `quox dev enable` (see cli/lib/commands/dev.js and
 * services/collector/lib/devServerRefresh.js buildGaugeRefreshCommand).
 * Enable is correctly human-gated (requireHumanAdmin), so a RESIDENT agent
 * with a missing or stale engine had no self-service path and was stuck
 * waiting on a human forever. The bundle download endpoint is already
 * public (see services/collector/utils/collectorAuthGate.js PUBLIC_EXACT:
 * /download/quoxgauge-bundle.tar.gz), so a resident-driven fetch needs no
 * new permission grant, only this verb.
 *
 * Everything here is pure or takes its side effects (HTTP client, exec,
 * filesystem reads/writes) as injected dependencies, so
 * cli/lib/commands/done.js is a thin wrapper and every path below is driven
 * from tests with no real network call, no real `tar`/`sudo`, and no writes
 * outside a scratch fsOps fake.
 *
 * Extraction shape mirrors the collector's own refresh command exactly:
 * flat `tar -xzf <bundle> -C <dest>`, never into a parent directory.
 */

import path from 'node:path';
import os from 'node:os';

export const OPT_GAUGE_DIR = '/opt/quoxgauge';

export function userLocalGaugeDir(home = os.homedir()) {
  return path.join(home, '.local', 'share', 'quox', 'gauge');
}

export function legacyGaugeDir(home = os.homedir()) {
  return path.join(home, 'quox-gauge');
}

/**
 * Decide where a fetched engine should land, and whether getting there
 * needs privilege escalation.
 *
 * Order:
 *   1. --dest (explicit, always wins, never needs sudo)
 *   2. $QUOX_DONEENGINE_HOME (an override for an already server-controlled
 *      path, same precedent as QUOX_DONEENGINE_PATH — not a new feature flag)
 *   3. /opt/quoxgauge, if directly writable, or reachable via passwordless
 *      sudo (`sudo -n true`) — matching where `quox dev enable` puts it, so
 *      a resident does not silently diverge from the host-wide install
 *   4. ~/.local/share/quox/gauge — always-writable fallback
 *
 * `isWritable` and `execFn` are injected so this stays testable without a
 * real filesystem probe or a real `sudo` spawn.
 */
export function resolveFetchDestination({ destOption, env = process.env, isWritable, execFn } = {}) {
  if (destOption) {
    return { dest: destOption, reason: '--dest', needsSudo: false };
  }
  if (env.QUOX_DONEENGINE_HOME) {
    return { dest: env.QUOX_DONEENGINE_HOME, reason: 'QUOX_DONEENGINE_HOME override', needsSudo: false };
  }

  const directlyWritable = typeof isWritable === 'function' ? isWritable(OPT_GAUGE_DIR) : false;
  if (directlyWritable) {
    return { dest: OPT_GAUGE_DIR, reason: `${OPT_GAUGE_DIR} is writable`, needsSudo: false };
  }

  let sudoAvailable = false;
  if (typeof execFn === 'function') {
    try {
      const r = execFn('sudo', ['-n', 'true']);
      sudoAvailable = !!r && r.status === 0;
    } catch {
      sudoAvailable = false;
    }
  }
  if (sudoAvailable) {
    return {
      dest: OPT_GAUGE_DIR,
      reason: `${OPT_GAUGE_DIR} is not directly writable, using passwordless sudo (matches quox dev enable's install)`,
      needsSudo: true,
    };
  }

  return {
    dest: userLocalGaugeDir(),
    reason: `${OPT_GAUGE_DIR} is not writable and no passwordless sudo is available; falling back to a user-writable path`,
    needsSudo: false,
  };
}

/**
 * Inspect an install directory. Never throws: an unreadable or missing
 * directory just reports unhealthy, it is not itself an error.
 */
export function inspectInstall(dest, fsOps) {
  const gaugePath = path.join(dest, 'gauge.mjs');
  const packsPath = path.join(dest, 'packs');
  const gaugeExists = fsOps.existsSync(gaugePath);
  const packsDirExists = fsOps.existsSync(packsPath);
  let packsCount = 0;
  if (packsDirExists) {
    try {
      packsCount = fsOps.readdirSync(packsPath).filter((f) => f.endsWith('.json')).length;
    } catch {
      packsCount = 0;
    }
  }
  return {
    healthy: gaugeExists && packsDirExists && packsCount > 0,
    gaugeExists,
    packsDirExists,
    packsCount,
    gaugePath,
    packsPath,
  };
}

/**
 * Fetch the bundle from the collector and extract it flat into `dest`.
 *
 * A healthy existing install is a no-op unless `force` is set. On failure
 * after a previous install existed, the previous install is restored so a
 * resident is never left worse off than it started (leave the previous
 * install intact where possible).
 *
 * `client` is the CLI's existing HTTP client (already injectable in every
 * command via ctx) — reused here rather than a bare fetch so auth headers,
 * retries and service-url resolution stay identical to every other command.
 * `execFn(cmd, args)` is the child-process seam (mirrors ctx.spawnFn in
 * lib/commands/devSupervisor.js): all destination mutation (mkdir/mv/rm/tar)
 * goes through it, prefixed with `sudo -n` when `needsSudo` is set, so the
 * privileged and unprivileged paths share one code path.
 */
export async function fetchEngine({ dest, needsSudo, force, client, execFn, fsOps } = {}) {
  if (!force) {
    const existing = inspectInstall(dest, fsOps);
    if (existing.healthy) {
      return {
        status: 'noop',
        dest,
        packsCount: existing.packsCount,
        message: `DoneEngine already installed and healthy at ${dest} (${existing.packsCount} packs). `
          + 'Nothing to do; pass --force to re-fetch anyway.',
      };
    }
  }

  const res = await client.get('/download/quoxgauge-bundle.tar.gz', { service: 'collector', raw: true });
  // #988: a public install's collector has no DoneEngine bundle (dev servers build it from the private quox-gauge
  // repo), so a 404 is a fact about this install, not a transient failure worth retrying.
  if (res && res.status === 404) {
    const err = new Error('DoneEngine is not part of this Quox install: this collector does not carry the DoneEngine bundle '
      + '(it is delivered to Quox dev servers by `quox dev enable`). Nothing was changed.');
    err.code = 'DONEENGINE_NOT_SHIPPED';
    throw err;
  }
  if (!res || !res.ok) {
    throw new Error(`Bundle download failed (status ${res ? res.status : 'no response'}) from /download/quoxgauge-bundle.tar.gz`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const tmpFile = fsOps.tmpFile();
  fsOps.writeFileSync(tmpFile, buffer);

  const run = (cmd, args) => (needsSudo ? execFn('sudo', ['-n', cmd, ...args]) : execFn(cmd, args));
  const requireOk = (r, label) => {
    if (!r || r.status !== 0) {
      throw new Error(`${label} failed: ${(r && (r.stderr || r.stdout)) || 'unknown error'}`);
    }
  };

  const hadPrevious = fsOps.existsSync(dest);
  const backupDest = `${dest}.pre-fetch`;
  // A writable dest inside a non-writable parent (e.g. control-owned
  // /opt/quoxgauge under root:root /opt) cannot be renamed to a sibling.
  // Back up its contents into a temp dir instead and mutate dest in place.
  const inPlace = hadPrevious && !needsSudo
    && typeof fsOps.isWritable === 'function'
    && !fsOps.isWritable(path.dirname(dest));
  let inPlaceBackup = null;
  const emptyDest = () => run('find', [dest, '-mindepth', '1', '-delete']);

  try {
    if (inPlace) {
      inPlaceBackup = fsOps.mkdtemp();
      requireOk(run('cp', ['-a', `${dest}/.`, `${inPlaceBackup}/`]), 'backing up previous install in place');
      requireOk(emptyDest(), 'emptying previous install');
    } else if (hadPrevious) {
      if (fsOps.existsSync(backupDest)) requireOk(run('rm', ['-rf', backupDest]), 'clearing stale backup');
      requireOk(run('mv', [dest, backupDest]), 'backing up previous install');
    }

    requireOk(run('mkdir', ['-p', dest]), 'creating destination');
    requireOk(run('tar', ['-xzf', tmpFile, '-C', dest]), 'extracting bundle');

    const verified = inspectInstall(dest, fsOps);
    if (!verified.healthy) {
      throw new Error(
        `Extracted bundle at ${dest} failed verification `
        + `(gauge.mjs present: ${verified.gaugeExists}, packs: ${verified.packsCount}). `
        + 'Left the previous install in place where one existed.',
      );
    }

    if (inPlace) requireOk(run('rm', ['-rf', inPlaceBackup]), 'cleaning up backup');
    else if (hadPrevious) requireOk(run('rm', ['-rf', backupDest]), 'cleaning up backup');

    return {
      status: 'updated',
      dest,
      packsCount: verified.packsCount,
      message: `DoneEngine installed at ${dest} (${verified.packsCount} packs).`,
    };
  } catch (err) {
    if (inPlaceBackup) {
      emptyDest();
      run('cp', ['-a', `${inPlaceBackup}/.`, `${dest}/`]);
    } else if (hadPrevious && fsOps.existsSync(backupDest)) {
      run('rm', ['-rf', dest]);
      run('mv', [backupDest, dest]);
    }
    throw err;
  } finally {
    if (inPlaceBackup) {
      try { run('rm', ['-rf', inPlaceBackup]); } catch { /* best effort cleanup */ }
    }
    try { fsOps.rmSync(tmpFile, { force: true }); } catch { /* best effort cleanup */ }
  }
}
