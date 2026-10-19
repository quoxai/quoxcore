/**
 * Build commands — DEVSUITE-BUILD step 4 (`quox build`).
 *
 * The governed superset of the thin local `quox-build` client: dispatches a
 * PRE-REGISTERED target on a dev server through the collector's dev-build
 * control plane (oracle-signed envelope over Bastion to the host-side
 * quoxagent dev.build executor), reads live executor state, and reads the
 * durable receipts mirror. The local `quox-build` spool client and the
 * Terminal 9 daemon are untouched and keep working; this group is how any
 * authenticated session drives builds on ANY registered dev server.
 *
 * `quox build <target> --host <hostId>` dispatches. Named subcommands
 * (status/targets/history/latest) win over a target of the same name — a
 * target literally called "status" must be dispatched via
 * `quox build dispatch status --host …`.
 */

import { formatDetail, formatOutput, printSuccess, printWarning } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerBuildCommands(program, ctx) {
  const { client, auth } = ctx;

  const build = program
    .command('build')
    .description('QuoxBuild: dispatch and inspect governed builds on dev servers');

  // Commander (non-positional mode) lets the PARENT consume an option it
  // declares even when the token appears after a subcommand name, so the
  // bare-target sugar's group-level --host/--stream/--phase/--msg would
  // otherwise swallow the flags out from under every verb (found live on
  // the first proof drive). Every verb therefore falls back to the group's
  // own parsed opts.
  const groupOpt = (options, key) => options[key] ?? build.opts()[key];

  // An org with exactly one dev server needs no --host: use it and say so. With several, name them;
  // with none, say so (proof cases code/reach-build-status / -targets exited 1 on a one-server org).
  async function resolveHost(options) {
    const given = groupOpt(options, 'host');
    if (given) return given;
    const listEp = resolveEndpoint('v1.dev.servers.list');
    const list = await client.get(listEp.path, { service: listEp.service });
    const ids = (Array.isArray(list?.servers) ? list.servers : []).map((s) => s.host_id).filter(Boolean);
    if (ids.length === 1) {
      printWarning(`No --host given; using the only dev server: ${ids[0]}`);
      return ids[0];
    }
    if (ids.length === 0) throw new Error('No dev server is registered for this org (register one with `quox dev enable <hostId>`).');
    throw new Error(`--host <hostId> is required: this org has ${ids.length} dev servers (${ids.join(', ')}).`);
  }

  async function dispatch(target, options) {
    auth.requireAuth();
    options = {
      host: await resolveHost(options),
      stream: groupOpt(options, 'stream'),
      phase: groupOpt(options, 'phase'),
      msg: groupOpt(options, 'msg'),
    };
    if (!options.host) {
      throw new Error('--host <hostId> is required (the dev server that runs the build)');
    }
    const body = { target };
    const stream = options.stream || process.env.QUOX_STREAM;
    const phase = options.phase || process.env.QUOX_PHASE;
    if (stream) body.stream = stream;
    if (phase) body.phase = phase;
    if (options.msg) body.msg = options.msg;

    const endpoint = resolveEndpoint('v1.dev.build.dispatch', { hostId: options.host });
    const data = await client.post(endpoint.path, { service: endpoint.service, body });
    formatDetail(data, { format: program.opts().output, title: `Build dispatched on ${options.host}` });
    if (data && data.dispatched) {
      printSuccess(`${(data.targets || [target]).join(', ')} queued on ${options.host} (coalesces within the queue window).`);
      printWarning('Queued is not built: check `quox build status --host ' + options.host + '` and the receipt before claiming green.');
    }
  }

  build
    .command('dispatch')
    .description('Queue a build of a pre-registered target on a dev server')
    .argument('<target>', 'pre-registered target name on that host')
    .option('--host <hostId>', 'dev server host_id')
    .option('--stream <code>', 'roadmap stream code for the receipt (default: $QUOX_STREAM)')
    .option('--phase <phase>', 'stream phase for the receipt (default: $QUOX_PHASE)')
    .option('--msg <text>', 'what changed')
    .action(dispatch);

  build
    .command('status')
    .description('Live executor state on a dev server: readiness, prereqs, building-now, last outcomes')
    .option('--host <hostId>', 'dev server host_id')
    .action(async (options) => {
      auth.requireAuth();
      const host = await resolveHost(options);
      const endpoint = resolveEndpoint('v1.dev.build.status', { hostId: host });
      const data = await client.get(endpoint.path, { service: endpoint.service });
      formatDetail(data, { format: program.opts().output, title: `Build status: ${host}` });
    });

  build
    .command('targets')
    .description("List a dev server's pre-registered build targets")
    .option('--host <hostId>', 'dev server host_id')
    .action(async (options) => {
      auth.requireAuth();
      const host = await resolveHost(options);
      const endpoint = resolveEndpoint('v1.dev.build.targets', { hostId: host });
      const data = await client.get(endpoint.path, { service: endpoint.service });
      formatOutput(data.targets || [], {
        format: program.opts().output,
        columns: ['name', 'description', 'steps', 'verify_count'],
        emptyMessage: 'No pre-registered targets on this host.',
      });
    });

  build
    .command('history')
    .description('Durable build receipts (the witnessed mirror), newest first')
    .option('--host <hostname>', 'filter to one host (receipt hostname)')
    .option('--target <name>', 'filter to one target')
    .option('--result <r>', 'filter by result (ok, FAIL, UNVERIFIED, INTERRUPTED)')
    .option('--limit <n>', 'max rows (default 20)', (v) => parseInt(v, 10), 20)
    .action(async (options) => {
      auth.requireAuth();
      const endpoint = resolveEndpoint('v1.build.receipts.list');
      const params = new URLSearchParams();
      const host = groupOpt(options, 'host');
      if (host) params.set('host', host);
      if (options.target) params.set('target', options.target);
      if (options.result) params.set('result', options.result);
      params.set('limit', String(options.limit));
      const data = await client.get(`${endpoint.path}?${params}`, { service: endpoint.service });
      formatOutput(data.receipts || [], {
        format: program.opts().output,
        columns: ['created_at', 'result', 'target', 'host', 'terminal', 'stream', 'phase', 'duration_seconds'],
        emptyMessage: 'No build receipts recorded yet.',
      });
    });

  build
    .command('latest')
    .description('Latest receipt per target (the build-status board)')
    .action(async () => {
      auth.requireAuth();
      const endpoint = resolveEndpoint('v1.build.status.list');
      const data = await client.get(endpoint.path, { service: endpoint.service });
      formatOutput(data.targets || [], {
        format: program.opts().output,
        columns: ['target', 'result', 'host', 'created_at', 'duration_seconds'],
        emptyMessage: 'No build receipts recorded yet.',
      });
    });

  // Bare `quox build <target> --host …` sugar: dispatch without typing the
  // verb, matching the muscle memory of the local quox-build client.
  build
    .argument('[target]', 'pre-registered target name (shorthand for `quox build dispatch <target>`)')
    .option('--host <hostId>', 'dev server host_id')
    .option('--stream <code>', 'roadmap stream code (default: $QUOX_STREAM)')
    .option('--phase <phase>', 'stream phase (default: $QUOX_PHASE)')
    .option('--msg <text>', 'what changed')
    .action(async (target, options) => {
      if (!target) {
        build.help();
        return;
      }
      await dispatch(target, options);
    });
}
