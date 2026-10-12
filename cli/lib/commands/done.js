/**
 * `quox done` — Quox DoneEngine from the terminal.
 *
 * The house gate is that nothing ships without CLI support, and the north star
 * is Claude running Quox headless. That matters more here than for most
 * surfaces: DoneEngine's primary users are AGENTS, not people. "Is this
 * actually done?" is a question something asks before it acts, so a completion
 * engine reachable only from a dashboard fails its own premise.
 *
 * This is a thin wrapper over the quox-gauge engine rather than a
 * reimplementation. Two implementations of a rule set is how a rule set
 * drifts, which is the thing DoneEngine exists to catch, so there is exactly
 * one engine and the CLI shells out to it.
 *
 * ENGINE RESOLUTION (#456, extended by the fetch follow-on below): defaults
 * to ~/quox-gauge/gauge.mjs, which only ever existed on the box quox-gauge
 * was developed on, so every other dev-enabled host got a bare "not found"
 * error. `quox dev enable` delivers the engine to /opt/quoxgauge and points
 * QUOX_DONEENGINE_PATH at it via the generated CLI wrapper (see
 * devServerRefresh.js), so a fresh dev-enabled host resolves it there
 * without any local checkout.
 *
 * FETCH FOLLOW-ON: enable is correctly human-gated (requireHumanAdmin), so a
 * RESIDENT agent with a missing or stale engine on a host nobody has run
 * `quox dev enable` on had no self-service path — permanently stuck waiting
 * on a human. `quox done fetch` closes that: it pulls the same public bundle
 * (/download/quoxgauge-bundle.tar.gz) directly and installs it, no human in
 * the loop, no new permission (see cli/lib/core/doneEngineFetch.js for the
 * fetch/extract/verify logic). Resolution now also checks a user-local
 * fallback (~/.local/share/quox/gauge/gauge.mjs), which is where fetch lands
 * when /opt/quoxgauge is not writable and there is no passwordless sudo. A
 * missing engine or packs directory names `quox done fetch` first (the
 * self-service fix) and `quox dev enable` second.
 *
 * EXIT CODES are the contract, and `check` passes the engine's through
 * unchanged:
 *   0  CLEAR    every gate in the pack passes and the running code agrees
 *   1  REFUSED  a named gate fails; reasons are printed
 *   2  UNKNOWN  insufficient evidence to say either way
 *
 * UNKNOWN is deliberately not folded into either neighbour. Treating "no
 * evidence" as approval is the exact failure this engine was built after, and
 * treating it as refusal trains people to ignore refusals.
 *
 * ADVISORY. `quox done check` never blocks anything. Whether DoneEngine may
 * refuse a deploy is an open owner decision on the DONEENGINE stream, and a
 * tool that started refusing other people's deploys before that was settled
 * would be taking a governance power nobody granted it.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveFetchDestination,
  fetchEngine,
  OPT_GAUGE_DIR,
  userLocalGaugeDir,
  legacyGaugeDir,
} from '../core/doneEngineFetch.js';
import { printSuccess, printInfo } from '../core/output.js';

/**
 * Engine resolution order (see the FETCH FOLLOW-ON note above):
 *   1. QUOX_DONEENGINE_PATH (explicit override, wins even if the file is
 *      missing — the honest "not found" error below still needs a concrete
 *      path to name)
 *   2. /opt/quoxgauge/gauge.mjs — where `quox dev enable` and a sudo-capable
 *      `quox done fetch` both put it
 *   3. ~/.local/share/quox/gauge/gauge.mjs — where `quox done fetch` puts it
 *      when /opt/quoxgauge is not writable and there is no passwordless sudo
 *   4. ~/quox-gauge/gauge.mjs — legacy default, kept as the final fallback so
 *      the error message always names a concrete path
 *
 * Exported (rather than inlined into the ENGINE constant) so this order is
 * unit-testable with an injected existsSync/env/home instead of the real
 * filesystem.
 */
export function resolveEnginePath({ env = process.env, existsSync = fs.existsSync, home = os.homedir() } = {}) {
  if (env.QUOX_DONEENGINE_PATH) return env.QUOX_DONEENGINE_PATH;
  const optPath = path.join(OPT_GAUGE_DIR, 'gauge.mjs');
  if (existsSync(optPath)) return optPath;
  const userLocalPath = path.join(userLocalGaugeDir(home), 'gauge.mjs');
  if (existsSync(userLocalPath)) return userLocalPath;
  return path.join(legacyGaugeDir(home), 'gauge.mjs');
}

const ENGINE = resolveEnginePath();

function runEngine(args) {
  if (!fs.existsSync(ENGINE)) {
    process.stderr.write(
      `DoneEngine not found at ${ENGINE}\n` +
      'Self-heal: `quox done fetch` pulls the engine bundle straight from ' +
      'the collector, no human in the loop. Otherwise `quox dev enable` ' +
      'delivers it to /opt/quoxgauge as part of full dev-server ' +
      'provisioning. Or set QUOX_DONEENGINE_PATH to a checkout.\n',
    );
    // 2, not 1: a missing engine is "cannot tell", not "refused".
    return 2;
  }
  const r = spawnSync(process.execPath, [ENGINE, ...args], { stdio: 'inherit' });
  if (r.error) {
    process.stderr.write(`DoneEngine failed to run: ${r.error.message}\n`);
    return 2;
  }
  return r.status ?? 2;
}

function defaultExecFn(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8' });
}

function defaultIsWritable(dir) {
  let probe = dir;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    fs.accessSync(probe, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultFsOps() {
  return {
    existsSync: fs.existsSync,
    readdirSync: fs.readdirSync,
    writeFileSync: fs.writeFileSync,
    rmSync: fs.rmSync,
    isWritable: defaultIsWritable,
    mkdtemp: () => fs.mkdtempSync(path.join(os.tmpdir(), 'quoxgauge-backup-')),
    tmpFile: () => path.join(os.tmpdir(), `quoxgauge-bundle-${process.pid}-${Date.now()}.tar.gz`),
  };
}

export function registerDoneCommands(program, ctx = {}) {
  const done = program
    .command('done')
    .description('Quox DoneEngine: is this actually done, and what is the evidence?');

  done
    .command('check [subject]')
    .description('Can this ship? exit 0 clear, 1 refused with reasons, 2 unknown. Advisory: never blocks.')
    .option('--pack <id>', 'rule pack to judge against', 'launch-spine')
    .option('--json', 'structured verdict for agents')
    .option('--root <path>', 'judge <subject> in this repo, reading its own STATUS map with the selected pack (e.g. a plugin with --pack plugin)')
    .action((subject, options) => {
      const args = ['--can-ship', subject || 'all', '--pack', options.pack];
      if (options.root) {
        if (!subject) {
          process.stderr.write('quox done check: --root needs a subject (the surface to judge in that repo).\n');
          process.exitCode = 2;
          return;
        }
        args.push('--subject', subject, '--root', path.resolve(options.root));
      }
      if (options.json) args.push('--json');
      process.exitCode = runEngine(args);
    });

  done
    .command('checklist [pack]')
    .description('The builder checklist GENERATED from a pack (every gate the engine judges); --check verifies a doc that embeds it')
    .option('--check <file>', 'exit 1 if the checklist block in this file has drifted from the pack')
    .action((pack, options) => {
      const args = ['--checklist', pack || 'plugin'];
      if (options.check) args.push('--check', path.resolve(options.check));
      process.exitCode = runEngine(args);
    });

  done
    .command('board')
    .description('Estate scoreboard: every surface, score, attested gates, deploy state')
    .option('--json', 'machine-readable, includes raw deploy state')
    .option('--dod', 'per-surface gates, split by evidence class')
    .option('--no-deploy', 'skip docker/git; Deployed Ready becomes unknown, which is not a pass')
    .action((options) => {
      const args = [];
      if (options.json) args.push('--json');
      if (options.dod) args.push('--dod');
      if (options.deploy === false) args.push('--no-deploy');
      process.exitCode = runEngine(args);
    });

  done
    .command('bar [pack]')
    .description('One rule pack against its subjects: BOTH finish lines, build and deployed')
    .option('--snapshot', 'append this reading to the snapshot history')
    .option('--org <id>', 'measure FOR this org: plan evidence reads as it, the snapshot is stamped with it (default: the pack\'s own org field)')
    .action((pack, options) => {
      const args = pack ? ['--pack', pack] : ['--launch'];
      if (options.snapshot) args.push('--snapshot');
      if (options.org) args.push('--org', options.org);
      process.exitCode = runEngine(args);
    });

  done
    .command('history [pack]')
    .description('Movement between snapshots, regressions listed first')
    .action((pack) => {
      process.exitCode = runEngine(pack ? ['--history', '--pack', pack] : ['--history']);
    });

  done
    .command('packs')
    .description('List available rule packs')
    .action(() => {
      const dir = path.join(path.dirname(ENGINE), 'packs');
      if (!fs.existsSync(dir)) {
        process.stderr.write(
          `No packs directory at ${dir}\n` +
          'This usually means the engine delivery is missing or stale. ' +
          'Run `quox done fetch` to self-heal it (no human needed), or ' +
          're-run `quox dev enable`, or set QUOX_DONEENGINE_PATH to a ' +
          'checkout that has one.\n',
        );
        process.exitCode = 2;
        return;
      }
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
        try {
          const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          const scoped = p.subjects ? `${p.subjects.length} subjects` : 'base pack';
          process.stdout.write(`${(p.id || f).padEnd(16)} v${p.version || '?'}  ${scoped}  ${p.name || ''}\n`);
        } catch {
          process.stdout.write(`${f} (unreadable)\n`);
        }
      }
    });

  done
    .command('fetch')
    .description('Self-fetch the DoneEngine bundle, no human in the loop (quox#456 follow-on)')
    .option('--dest <path>', 'install destination (default: $QUOX_DONEENGINE_HOME, else /opt/quoxgauge if writable/sudo-reachable, else ~/.local/share/quox/gauge)')
    .option('--force', 'refetch and reinstall even if the current install already looks healthy')
    .action(async (options) => {
      const client = ctx.client;
      if (!client) {
        process.stderr.write('quox done fetch: no HTTP client available in this context.\n');
        process.exitCode = 2;
        return;
      }
      const execFn = ctx.execFn || defaultExecFn;
      const isWritable = ctx.isWritable || defaultIsWritable;
      const fsOps = ctx.fsOps || defaultFsOps();

      const { dest, reason, needsSudo } = resolveFetchDestination({
        destOption: options.dest,
        env: process.env,
        isWritable,
        execFn,
      });
      process.stdout.write(`Destination: ${dest} (${reason})\n`);

      try {
        const result = await fetchEngine({ dest, needsSudo, force: !!options.force, client, execFn, fsOps });
        if (result.status === 'noop') {
          printInfo(result.message);
        } else {
          printSuccess(result.message);
        }
      } catch (err) {
        process.stderr.write(`quox done fetch failed: ${err.message}\n`);
        process.exitCode = 1;
      }
    });

  return done;
}

export default registerDoneCommands;
