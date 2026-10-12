/**
 * Fleet commands: status, summary, agents, hosts, tools, watch
 */

import { missingReasonWarning } from '../core/callerSource.js';
import chalk from 'chalk';
import { formatOutput, formatDetail, printSuccess, printWarning, printInfo } from '../core/output.js';
import { events, printEvent, line as glyphLine } from '../core/quoxglyph.js';
import { parseJSON } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

/**
 * Map a raw /api/v1/gpu/nodes row to the flat shape `fleet gpu`'s table
 * expects. Keeps the GPU-specific field munging (device count + first GPU
 * name, MB -> GB, digest shortening, relative last-seen) local to this
 * command instead of teaching the shared table renderer about GPU rows.
 */
function formatGpuRow(node) {
  const summary = node.gpu_summary || {};
  const deviceCount = summary.device_count ?? 0;
  const names = Array.isArray(summary.names) ? summary.names : [];
  const gpus = deviceCount > 0
    ? `${deviceCount}x ${names[0] || 'GPU'}`
    : '—';

  const vramMb = summary.vram_total_mb;
  const vram = typeof vramMb === 'number' ? `${(vramMb / 1024).toFixed(1)} GB` : '—';

  const backends = Array.isArray(node.backends) ? node.backends.join(', ') : (node.backends || '—');

  const ward = node.ward_digest ? `${String(node.ward_digest).slice(0, 12)}…` : '—';

  const lastSeen = relativeTime(node.last_seen_at);

  return {
    host_id: node.host_id,
    gpus,
    vram,
    backends,
    status: node.status,
    ward,
    last_seen: lastSeen,
  };
}

/**
 * Render a Bastion host's status.last_seen for `fleet hosts` (quox#460).
 * Go's zero time.Time serialises as "0001-01-01T00:00:00Z" — a host that
 * has never checked in gets that literal string, not null/undefined, so a
 * plain falsy check would miss it and print a confusing century-old date.
 */
function formatBastionLastSeen(iso) {
  if (!iso) return 'never';
  const str = String(iso);
  if (str.startsWith('0001-01-01')) return 'never';
  return str;
}

/** Format an ISO timestamp as a short relative-time string ("5m ago"). */
function relativeTime(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// ---------------------------------------------------------------------------
// fleet #425 part B — codex-provision / rehome-agent
//
// Both verbs ride the SAME governed exec path as `quox fleet exec` (POST
// /api/v1/tools/execute with tool_name=ssh_exec), never raw ssh, so policy
// evaluation and HITL approval on the risky/sudo steps apply naturally.
//
// THE 60s PROBLEM: QuoxBastion's /api/v1/exec has a hardcoded 60s cap
// (exec.go, known + unfixed) and the collector's own callBastion aborts at
// 30s. `npm install -g` and a QuoxAgent install (~25MB binary + setup) both
// blow through that, and a transport timeout SIGHUPs the child mid-run. So
// every long step is LAUNCHED detached with `systemd-run --collect` and then
// POLLED with short execs against a sentinel file. This is the lesson
// recorded in the quoxpert-deploy skill ("run long installs detached ...
// a transport timeout SIGHUPs the child mid-build").
// ---------------------------------------------------------------------------

/** Default Codex model written to ~/.codex/config.toml. */
export const DEFAULT_CODEX_MODEL = 'gpt-5.4';

/** Tools whose input schema has a `host` field (collector reads input.host, not body.host_id). */
const TOOLS_READING_INPUT_HOST = new Set(['ssh_exec']);

/** Locates the vendored (bwrap-capable) codex binary on the host. */
export const CODEX_VENDOR_FIND_COMMAND =
  "find $(dirname $(readlink -f $(which codex)))/../.. -name codex -path '*vendor*'";

/** The one step a human must run themselves. Never scripted — see below. */
export const CODEX_LOGIN_COMMAND = 'codex login --device-auth';

/** GET <collector>/install must answer with a shell script, not a proxy page. */
export const INSTALL_SCRIPT_MAGIC = '#!/bin/bash';

/**
 * The REAL flag names from quoxagent/deploy/install.sh's Usage block. Kept as
 * a named map (not inlined) so fleet-provision.test.js can drift-guard it
 * against the script itself — guessing these silently installs an agent that
 * enrols nowhere.
 */
export const INSTALL_SH_FLAGS = {
  hostId: '--host-id',
  collector: '--collector',
  org: '--org-id',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** POSIX single-quote a string for safe embedding in a shell command. */
export function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the exact AppArmor profile body for the codex user-namespace rule.
 * `vendorPath` is the path found by CODEX_VENDOR_FIND_COMMAND.
 */
export function buildAppArmorProfile(vendorPath) {
  const path = String(vendorPath || '').trim();
  if (!path) {
    throw new Error(
      'Cannot build the AppArmor profile: no vendor codex path was detected on the host. '
      + `Run \`${CODEX_VENDOR_FIND_COMMAND}\` there and check codex is installed.`
    );
  }
  return [
    'abi <abi/4.0>,',
    'include <tunables/global>',
    `profile codex-userns ${path} flags=(unconfined) {`,
    '  userns,',
    '}',
    '',
  ].join('\n');
}

/**
 * Idempotently set the top-level `model` key in a config.toml body without
 * clobbering any other key. A missing key is inserted BEFORE the first
 * [table] header — appending at the end would silently land the key inside
 * whatever table happens to be last, which is a different setting entirely.
 */
export function upsertModelLine(existing, model) {
  const line = `model = "${model}"`;
  const text = existing == null ? '' : String(existing);
  if (!text.trim()) return `${line}\n`;

  const lines = text.split('\n');
  let firstTable = lines.findIndex((l) => /^[ \t]*\[/.test(l));
  if (firstTable === -1) firstTable = lines.length;

  const idx = lines.findIndex((l, i) => i < firstTable && /^[ \t]*model[ \t]*=/.test(l));
  if (idx !== -1) lines[idx] = line;
  else lines.splice(firstTable, 0, line);

  const out = lines.join('\n');
  return out.endsWith('\n') ? out : `${out}\n`;
}

/** Write a full config.toml body back to the host in one exec. */
export function buildConfigWriteCommand(content) {
  const body = String(content).endsWith('\n') ? String(content) : `${content}\n`;
  return `mkdir -p ~/.codex && cat > ~/.codex/config.toml <<'QUOX_CODEX_EOF'\n${body}QUOX_CODEX_EOF`;
}

/** Write the AppArmor profile and reload it (sudo — the governed path gates it). */
export function buildAppArmorInstallCommand(profileBody, target = '/etc/apparmor.d/codex-userns') {
  const body = String(profileBody).endsWith('\n') ? String(profileBody) : `${profileBody}\n`;
  return `sudo tee ${target} > /dev/null <<'QUOX_AA_EOF'\n${body}QUOX_AA_EOF\n`
    + `sudo apparmor_parser -r ${target}`;
}

/** Sentinel + log paths for a detached unit. */
export function detachedPaths(unit) {
  return { sentinel: `/tmp/${unit}.exit`, log: `/tmp/${unit}.log` };
}

/**
 * Launch `command` as a transient systemd unit so it survives the exec
 * transport closing, recording its exit code in a sentinel file.
 */
export function buildDetachedRun({ unit, command, sentinel, log }) {
  const inner = `{ ${command}; } > ${log} 2>&1; echo $? > ${sentinel}`;
  return `rm -f ${sentinel} ${log}; sudo systemd-run --collect --unit ${unit} `
    + `/bin/bash -lc ${shellSingleQuote(inner)}`;
}

/** Short exec used to poll a detached unit for completion. */
export function buildSentinelPollCommand(sentinel) {
  return `if [ -f ${sentinel} ]; then echo "DONE=$(cat ${sentinel})"; else echo PENDING; fi`;
}

/** Parse the sentinel poll output. */
export function parseSentinel(output) {
  const m = /DONE=(-?\d+)/.exec(String(output == null ? '' : output));
  if (!m) return { done: false, exitCode: null };
  return { done: true, exitCode: Number(m[1]) };
}

/** The full install pipe, using install.sh's REAL flags. */
export function buildRehomeInstallCommand({ collector, hostId, orgId }) {
  const base = String(collector).replace(/\/+$/, '');
  return `curl -sSL ${base}/install | sudo bash -s --`
    + ` ${INSTALL_SH_FLAGS.hostId} ${shellSingleQuote(hostId)}`
    + ` ${INSTALL_SH_FLAGS.collector} ${shellSingleQuote(base)}`
    + ` ${INSTALL_SH_FLAGS.org} ${shellSingleQuote(orgId)}`;
}

/** Argument validation for `fleet codex-provision`. Returns a list of errors. */
export function validateCodexProvisionArgs(hostId, options = {}) {
  const usage = 'Usage: quox fleet codex-provision <hostId> [--model <model>]';
  const errors = [];
  if (!hostId || !String(hostId).trim()) errors.push(`Missing <hostId>. ${usage}`);
  if (options.model !== undefined && !String(options.model).trim()) {
    errors.push(`--model needs a model name, e.g. --model ${DEFAULT_CODEX_MODEL}. ${usage}`);
  }
  return errors;
}

/** Argument validation for `fleet rehome-agent`. Returns a list of errors. */
export function validateRehomeArgs(hostId, options = {}) {
  const usage = 'Usage: quox fleet rehome-agent <hostId> --collector <url> --org <orgId>';
  const errors = [];
  if (!hostId || !String(hostId).trim()) errors.push(`Missing <hostId>. ${usage}`);
  const collector = options.collector == null ? '' : String(options.collector).trim();
  const org = options.org == null ? '' : String(options.org).trim();
  if (!collector) errors.push(`Missing --collector <url>. ${usage}`);
  else if (!/^https?:\/\//i.test(collector)) {
    errors.push(
      '--collector must be an absolute http(s) URL, e.g. --collector http://192.0.2.126:9848'
    );
  }
  if (!org) errors.push(`Missing --org <orgId>. ${usage}`);
  return errors;
}

/**
 * Normalise a governed-exec response into { ok, pending, text, error }.
 * `pending: true` is the collector's real approval-gate shape (agentTools.js:
 * { success:false, pending:true, approvalId, instructions }) — a gated step is
 * NOT a failure, it is waiting on a human.
 */
export function describeGovernedResult(data) {
  const raw = (data && typeof data === 'object' && data.result !== undefined) ? data.result : data;
  if (raw && typeof raw === 'object') {
    if (raw.pending === true) {
      return {
        ok: false,
        pending: true,
        approvalId: raw.approvalId || null,
        text: raw.instructions || raw.message || 'Awaiting human approval.',
        error: null,
      };
    }
    const text = [raw.stdout, raw.stderr].filter(Boolean).join('\n').trim()
      || (typeof raw.output === 'string' ? raw.output.trim() : '');
    const ok = raw.success === false
      ? false
      : (typeof raw.exit_code === 'number' ? raw.exit_code === 0 : true);
    return { ok, pending: false, text, error: raw.error || null };
  }
  return { ok: true, pending: false, text: raw == null ? '' : String(raw), error: null };
}

/** Fail loudly with the pending-approval detail when a governed step is gated. */
function approvalError(step, described) {
  return new Error(
    `${step} is waiting on human approval${described.approvalId ? ` (approval ${described.approvalId})` : ''}. `
    + `${described.text}\nApprove it, then re-run this command — every step is idempotent.`
  );
}

export function registerFleetCommands(program, ctx) {
  const { client, auth } = ctx;

  const fleet = program
    .command('fleet')
    .description('Fleet monitoring and management');

  fleet
    .command('status')
    .alias('health') // #620: 'quox fleet health' was a dead end; it's the verb people reach for.
    .description('Show fleet status (connection counts plus per-host state)')
    .action(async () => {
      auth.requireAuth();
      // fleet #458: /api/v1/fleet/status is a summary-shaped alias
      // ({ status, total_agents, connected, stale, dead, timestamp }) — it
      // has never returned an `agents`/`hosts` array. Reading data.agents ||
      // data.hosts always fell through to [], so the table rendered zero
      // rows and printed only a dim "No results." line: functionally
      // silent. Render the real status fields plus the per-host table
      // (same shape as `fleet agents`) so the verb actually says something.
      const statusEp = resolveEndpoint('v1.fleet.status.list');
      const status = await client.get(statusEp.path, { service: statusEp.service });
      const agentsEp = resolveEndpoint('v1.agents.list');
      const agentsData = await client.get(agentsEp.path, { service: agentsEp.service });
      const hosts = (agentsData.agents || agentsData || []).map(a => ({
        ...a,
        status: typeof a.status === 'object' ? (a.status?.health ?? a.status?.state ?? '-') : a.status,
        last_seen: typeof a.status?.last_seen_seconds === 'number'
          ? `${a.status.last_seen_seconds}s ago`
          : (a.last_seen ?? '-'),
      }));

      const format = program.opts().output;

      if (format === 'json') {
        console.log(JSON.stringify({ ...status, hosts }, null, 2));
        return;
      }

      if (format === 'quiet') {
        formatOutput({
          columns: ['host_id', 'status', 'version', 'last_seen'],
          rows: hosts,
        }, { format, emptyMessage: 'No hosts reporting.' });
        return;
      }

      formatDetail(status, {
        format,
        title: 'Fleet Status',
        fields: ['status', 'total_agents', 'connected', 'stale', 'dead', 'timestamp'],
        labels: {
          status: 'Status', total_agents: 'Total Agents', connected: 'Connected',
          stale: 'Stale', dead: 'Dead', timestamp: 'As Of',
        },
      });
      console.log('');
      formatOutput({
        columns: ['host_id', 'status', 'version', 'last_seen'],
        headers: ['Host', 'Status', 'Version', 'Last Seen'],
        rows: hosts,
      }, { format, emptyMessage: 'No hosts reporting.' });
    });

  fleet
    .command('summary')
    .description('Show fleet summary')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('v1.fleet.summary.list').path, { service: resolveEndpoint('v1.fleet.summary.list').service });
      // fleet #387: the route returns a NESTED shape —
      // { total_agents, connection: {connected, stale, dead},
      //   health: {healthy, warning, critical}, resources: {...} } —
      // but this read five flat keys that don't exist at the top level, so
      // every field rendered as a dash. Flattened here rather than renaming
      // the labels, so the display keeps its meaning:
      //   Degraded <- health.warning, Down <- connection.dead.
      // `warning` and `critical` are distinct health states, so `critical`
      // is surfaced too instead of being silently folded into Down.
      const flat = {
        total: data.total_agents,
        connected: data.connection?.connected,
        healthy: data.health?.healthy,
        degraded: data.health?.warning,
        critical: data.health?.critical,
        stale: data.connection?.stale,
        down: data.connection?.dead,
      };
      formatDetail({ ...data, ...flat }, {
        format: program.opts().output,
        title: 'Fleet Summary',
        fields: ['total', 'connected', 'healthy', 'degraded', 'critical', 'stale', 'down'],
        labels: {
          total: 'Total', connected: 'Connected', healthy: 'Healthy',
          degraded: 'Degraded', critical: 'Critical', stale: 'Stale', down: 'Down',
        },
      });
    });

  fleet
    .command('agents')
    .description('List fleet agents')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('v1.agents.list').path, { service: resolveEndpoint('v1.agents.list').service });
      formatOutput({
        // fleet #392: status is a nested object and last_seen only exists
        // inside it as last_seen_seconds; both rendered as dashes flat.
        columns: ['host_id', 'status', 'version', 'last_seen'],
        headers: ['Host', 'Status', 'Version', 'Last Seen'],
        rows: (data.agents || data || []).map(a => ({
          ...a,
          status: typeof a.status === 'object' ? (a.status?.health ?? a.status?.state ?? '-') : a.status,
          last_seen: typeof a.status?.last_seen_seconds === 'number'
            ? `${a.status.last_seen_seconds}s ago`
            : (a.last_seen ?? '-'),
        })),
      }, { format: program.opts().output });
    });

  fleet
    .command('hosts')
    .description('List hosts known to the Bastion registry (quox#460) — the full inventory, not just heartbeating agents')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.fleet.hosts.list');
      const data = await client.get(ep.path, { service: ep.service });
      const raw = data.hosts || data || [];
      const rows = (raw || []).map(h => ({
        id: h.id,
        ip: h.ip,
        group: h.group,
        state: h.status?.state ?? '-',
        health: h.status?.health ?? '-',
        last_seen: formatBastionLastSeen(h.status?.last_seen),
      }));
      formatOutput({
        columns: ['id', 'ip', 'group', 'state', 'health', 'last_seen'],
        headers: ['Host', 'IP', 'Group', 'State', 'Health', 'Last Seen'],
        rows,
      }, { format: program.opts().output, emptyMessage: 'No hosts in the Bastion registry.' });
    });

  fleet
    .command('gpu')
    .description('List the durable GPU fleet')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('v1.gpu.nodes.list').path, { service: resolveEndpoint('v1.gpu.nodes.list').service });
      const nodes = data.nodes || data.rows || data;
      const rows = (nodes || []).map(formatGpuRow);
      formatOutput({
        columns: ['host_id', 'gpus', 'vram', 'backends', 'status', 'ward', 'last_seen'],
        headers: ['Host', 'GPUs', 'VRAM', 'Backends', 'Status', 'Ward', 'Last Seen'],
        rows,
      }, { format: program.opts().output, emptyMessage: 'No GPU nodes enrolled yet.' });
    });

  fleet
    .command('tools')
    .description('List available fleet tools')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('v1.tools.list').path, { service: resolveEndpoint('v1.tools.list').service });
      formatOutput({
        columns: ['name', 'description', 'category'],
        headers: ['Name', 'Description', 'Category'],
        rows: data.tools || data,
      }, { format: program.opts().output });
    });

  fleet
    .command('exec')
    .description('Execute a fleet tool')
    .requiredOption('--tool <name>', 'tool name')
    .option('--input <json>', 'input parameters as JSON')
    .option('--host <hostId>', 'target host')
    .option('--org <id>', 'org ID (overrides active org; required for QUOX_SERVICE_KEY automation callers unless QUOX_ORG_ID is set)')
    .option('--reason <text>', 'why you are running this; shown on the approval card if the call is held for a human')
    .option('--session-label <name>', 'name this session on approval cards (default: $QUOX_SESSION)')
    .action(async (options) => {
      auth.requireAuth();
      // Route reads req.body.tool_name (collector server.js /api/v1/tools/execute)
      // — `tool` was silently 400ing every fleet exec. Same body-key bug
      // family as the fixed run.js/chat.js keys.
      const body = { tool_name: options.tool };
      if (options.input) body.input = parseJSON(options.input, '--input');
      if (options.host) body.host_id = options.host;
      // quox#789: tools whose input schema reads input.host (ssh_exec) never
      // see body.host_id, so the approval was stored with targets [null] and
      // failed after the human approved it. Merge --host into input.host.
      if (options.host && TOOLS_READING_INPUT_HOST.has(options.tool)) {
        const inp = body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : {};
        if (inp.host && String(inp.host) !== String(options.host)) {
          throw new Error(`--host ${options.host} conflicts with input.host ${inp.host}. Give one or make them match.`);
        }
        body.input = { ...inp, host: inp.host || options.host };
      }
      // HITL-CONTEXT: the reason + session label ride to the approval card.
      if (options.reason) body.reason = String(options.reason);
      { const w = missingReasonWarning(options.tool, options.reason); if (w) console.error(w); }
      if (options.sessionLabel) body.session_label = String(options.sessionLabel);

      // Collector's /api/v1/tools/execute requires org_id in the body for
      // service-key authenticated callers (isServiceKeyAuth = !req.user,
      // services/collector/server.js) — it has no session to derive org from,
      // so it 400s with "org_id is required for service-key authenticated
      // MCP calls" if the body omits it. A human-logged-in caller has
      // req.user and the server derives org from the session instead, which
      // is why this never surfaced for interactive use.
      //
      // Precedence for the org this CLI sends: explicit --org flag > the
      // QUOX_ORG_ID env var (the automation-mode org, named to match
      // QUOX_SERVICE_KEY) > the logged-in profile's stored org.
      const orgId = auth.getOrgId(options.org || process.env.QUOX_ORG_ID);
      if (!orgId && process.env.QUOX_SERVICE_KEY) {
        throw new Error(
          'QUOX_SERVICE_KEY is set but no org could be resolved. '
          + 'Set QUOX_ORG_ID=<org> for automation callers, or pass --org <id>.'
        );
      }
      if (orgId) body.org_id = orgId;

      const data = await client.post(resolveEndpoint('v1.tools.execute').path, { service: resolveEndpoint('v1.tools.execute').service, body, timeout: 120000 });
      if (program.opts().output === 'json') {
        console.log(JSON.stringify(data, null, 2));
      } else {
        if (data.result) console.log(data.result);
        else console.log(JSON.stringify(data, null, 2));
      }
    });

  fleet
    .command('host-update <hostId>')
    .description('Update a host in the Bastion registry (link/clear its bootstrap credential)')
    .option('--bootstrap-credential-id <credId>', 'link a QuoxVault bootstrap (purpose:bootstrap) credential to this host')
    .option('--clear-bootstrap-credential', 'clear the host\'s bootstrap credential link')
    .action(async (hostId, options) => {
      auth.requireAuth();

      if (options.bootstrapCredentialId && options.clearBootstrapCredential) {
        throw new Error('Pass either --bootstrap-credential-id or --clear-bootstrap-credential, not both.');
      }
      if (!options.bootstrapCredentialId && !options.clearBootstrapCredential) {
        throw new Error('Nothing to update. Pass --bootstrap-credential-id <id> or --clear-bootstrap-credential.');
      }

      // The Bastion update handler merges: only the ssh fields present in the
      // body are changed, so a partial {ssh:{bootstrap_credential_id}} leaves
      // user/port/key_id intact. An empty string clears the link.
      const bootstrapId = options.clearBootstrapCredential ? '' : options.bootstrapCredentialId;
      const ep = resolveEndpoint('v1.fleet.host.update', { id: hostId });
      const data = await client.put(ep.path, {
        service: ep.service,
        body: { ssh: { bootstrap_credential_id: bootstrapId } },
      });

      const linked = data?.ssh?.bootstrap_credential_id;
      if (program.opts().output === 'json') {
        console.log(JSON.stringify(data, null, 2));
      } else {
        printEvent(events.updated(
          'bastion',
          'host',
          hostId,
          options.clearBootstrapCredential ? 'bootstrap credential cleared' : `bootstrap credential linked: ${linked || bootstrapId}`
        ));
      }
    });

  // ── fleet #425 part B ────────────────────────────────────────────────────

  /**
   * One governed exec against a host. Same body construction, org precedence
   * and error text as `fleet exec --tool ssh_exec` above — deliberately, so a
   * gated step behaves identically whichever verb the operator reached for.
   */
  async function governedExec(hostId, command, { orgOverride, timeout = 120000 } = {}) {
    const body = { tool_name: 'ssh_exec', input: { host: hostId, command } };
    const orgId = auth.getOrgId(orgOverride || process.env.QUOX_ORG_ID);
    if (!orgId && process.env.QUOX_SERVICE_KEY) {
      throw new Error(
        'QUOX_SERVICE_KEY is set but no org could be resolved. '
        + 'Set QUOX_ORG_ID=<org> for automation callers, or pass --exec-org <id>.'
      );
    }
    if (orgId) body.org_id = orgId;
    const ep = resolveEndpoint('v1.tools.execute');
    return client.post(ep.path, { service: ep.service, body, timeout });
  }

  /**
   * Launch a long step detached and poll its sentinel. Returns
   * { state: 'done'|'failed'|'timeout', exitCode, text }.
   */
  async function runDetachedStep(hostId, { unit, command, orgOverride, attempts = 30, intervalMs = 10000 }) {
    const { sentinel, log } = detachedPaths(unit);

    const launch = describeGovernedResult(
      await governedExec(hostId, buildDetachedRun({ unit, command, sentinel, log }), { orgOverride })
    );
    if (launch.pending) throw approvalError(`Launching ${unit}`, launch);
    if (!launch.ok) {
      return { state: 'failed', exitCode: null, text: launch.error || launch.text, log };
    }

    for (let i = 0; i < attempts; i++) {
      await sleep(intervalMs);
      const poll = describeGovernedResult(
        await governedExec(hostId, buildSentinelPollCommand(sentinel), { orgOverride, timeout: 60000 })
      );
      if (poll.pending) throw approvalError(`Polling ${unit}`, poll);
      const parsed = parseSentinel(poll.text);
      if (!parsed.done) continue;
      if (parsed.exitCode === 0) return { state: 'done', exitCode: 0, text: '', log };
      const tail = describeGovernedResult(
        await governedExec(hostId, `tail -40 ${log}`, { orgOverride, timeout: 60000 })
      );
      return { state: 'failed', exitCode: parsed.exitCode, text: tail.text, log };
    }
    return { state: 'timeout', exitCode: null, text: '', log };
  }

  fleet
    .command('codex-provision <hostId>')
    .description('Provision Codex on a fleet host (npm install, AppArmor userns profile, model config) up to the manual device-auth login')
    .option('--model <model>', `model written to ~/.codex/config.toml (default: ${DEFAULT_CODEX_MODEL})`)
    .option('--exec-org <id>', 'org ID for the governed exec calls (overrides active org; required for QUOX_SERVICE_KEY automation callers unless QUOX_ORG_ID is set)')
    .action(async (hostId, options) => {
      auth.requireAuth();

      const errors = validateCodexProvisionArgs(hostId, options);
      if (errors.length) throw new Error(errors.join('\n'));

      const model = (options.model || DEFAULT_CODEX_MODEL).trim();
      const orgOverride = options.execOrg;
      const isJson = program.opts().output === 'json';
      const steps = [];
      const say = (fn, msg) => { if (!isJson) fn(msg); };

      // 1. npm install -g @openai/codex — detached, it can outlive the 60s cap.
      say(printInfo, `[1/4] Installing @openai/codex on ${hostId} (detached, polled)...`);
      const npm = await runDetachedStep(hostId, {
        unit: 'codex-provision-npm',
        command: 'npm install -g @openai/codex',
        orgOverride,
      });
      steps.push({ step: 'npm_install', ...npm });
      if (npm.state === 'timeout') {
        throw new Error(
          `npm install did not finish within the poll window on ${hostId}. `
          + `It may still be running: check \`systemctl status codex-provision-npm\` and ${npm.log} on the host, then re-run.`
        );
      }
      if (npm.state === 'failed') {
        throw new Error(`npm install -g @openai/codex failed on ${hostId} (exit ${npm.exitCode}):\n${npm.text}`);
      }
      say(printSuccess, '  codex installed.');

      // 2. Detect the vendored bwrap-capable binary (fast, single exec).
      say(printInfo, '[2/4] Detecting the vendor codex path...');
      const find = describeGovernedResult(
        await governedExec(hostId, CODEX_VENDOR_FIND_COMMAND, { orgOverride })
      );
      if (find.pending) throw approvalError('Vendor path detection', find);
      const vendorPath = String(find.text || '').split('\n').map((l) => l.trim()).filter(Boolean)[0];
      if (!vendorPath) {
        throw new Error(
          `No vendored codex binary found on ${hostId}. Ran: ${CODEX_VENDOR_FIND_COMMAND}\n`
          + `${find.error || find.text || '(no output)'}\n`
          + 'Check codex is on PATH for the exec user and that this npm release still ships a vendor/ tree.'
        );
      }
      steps.push({ step: 'vendor_path', vendor_path: vendorPath });
      say(printSuccess, `  ${vendorPath}`);

      // 3. AppArmor userns profile (sudo — the governed path gates it).
      say(printInfo, '[3/4] Writing /etc/apparmor.d/codex-userns and reloading...');
      const profile = buildAppArmorProfile(vendorPath);
      const aa = describeGovernedResult(
        await governedExec(hostId, buildAppArmorInstallCommand(profile), { orgOverride })
      );
      if (aa.pending) throw approvalError('The AppArmor profile write', aa);
      if (!aa.ok) {
        throw new Error(`Failed to install the AppArmor profile on ${hostId}: ${aa.error || aa.text}`);
      }
      steps.push({ step: 'apparmor', profile_path: '/etc/apparmor.d/codex-userns' });
      say(printSuccess, '  profile loaded.');

      // 4. ~/.codex/config.toml — read, upsert the model line locally, write
      //    back only if it changed. Other keys are preserved verbatim.
      say(printInfo, `[4/4] Setting model = "${model}" in ~/.codex/config.toml...`);
      const read = describeGovernedResult(
        await governedExec(hostId, 'cat ~/.codex/config.toml 2>/dev/null || true', { orgOverride })
      );
      if (read.pending) throw approvalError('Reading ~/.codex/config.toml', read);
      const current = read.ok ? (read.text || '') : '';
      const next = upsertModelLine(current, model);
      const currentNormalised = (current === '' || current.endsWith('\n')) ? current : `${current}\n`;
      let configChanged = false;
      if (next !== currentNormalised) {
        const write = describeGovernedResult(
          await governedExec(hostId, buildConfigWriteCommand(next), { orgOverride })
        );
        if (write.pending) throw approvalError('Writing ~/.codex/config.toml', write);
        if (!write.ok) throw new Error(`Failed to write ~/.codex/config.toml on ${hostId}: ${write.error || write.text}`);
        configChanged = true;
      }
      steps.push({ step: 'config_toml', model, changed: configChanged });
      say(printSuccess, configChanged ? `  model set to ${model}.` : `  already model = "${model}", left alone.`);

      if (isJson) {
        console.log(JSON.stringify({
          host_id: hostId,
          model,
          vendor_path: vendorPath,
          steps,
          manual_step: { command: CODEX_LOGIN_COMMAND, host: hostId, reason: 'device-auth is interactive and must not be scripted' },
        }, null, 2));
        return;
      }

      console.log();
      console.log(chalk.bold('One manual step remains — it cannot be scripted.'));
      console.log();
      console.log(`  On ${chalk.cyan(hostId)}, run:  ${chalk.bold(CODEX_LOGIN_COMMAND)}`);
      console.log();
      console.log(chalk.dim('  It prints a URL and a one-time code. Open the URL, enter the code,'));
      console.log(chalk.dim('  and finish the sign-in in a browser. The code expires after 15 minutes,'));
      console.log(chalk.dim('  so start it when you are ready to complete it.'));
      console.log(chalk.dim('  Quox never brokers that login: the device-auth code is a human credential.'));
      console.log();
    });

  fleet
    .command('rehome-agent <hostId>')
    .description('Re-enrol a host\'s QuoxAgent against a different collector by clean reinstall from that collector')
    .requiredOption('--collector <url>', 'the NEW collector base URL, e.g. http://192.0.2.126:9848')
    // NOT requiredOption: --org shadows the root program's global --org
    // <slug> (bin/quox.js). Commander's mandatory-option check runs BEFORE
    // the mergeShadowedGlobals preAction hook, so a requiredOption here
    // always fired "required option '--org' not specified" even when the
    // user supplied it (quox#457). validateRehomeArgs below already reports
    // a missing --org with the same usage string.
    .option('--org <orgId>', 'org the agent should enrol into on the new collector')
    .option('--exec-org <id>', 'org ID for the governed exec calls against the CURRENT collector (defaults to the active org)')
    .option('--wait <seconds>', 'how long to wait for the host to appear on the new collector', '120')
    .action(async (hostId, options) => {
      auth.requireAuth();

      const errors = validateRehomeArgs(hostId, options);
      if (errors.length) throw new Error(errors.join('\n'));

      const collector = String(options.collector).trim().replace(/\/+$/, '');
      const orgId = String(options.org).trim();
      const orgOverride = options.execOrg;
      const isJson = program.opts().output === 'json';
      const say = (fn, msg) => { if (!isJson) fn(msg); };

      // 1. Preflight the NEW collector actually serves the installer. Same
      //    actionable-error shape as the collector's own GET /install 503.
      const installUrl = `${collector}/install`;
      say(printInfo, `[1/3] Preflight: GET ${installUrl}`);
      let resp;
      try {
        resp = await fetch(installUrl, { signal: AbortSignal.timeout(10000) });
      } catch (err) {
        throw new Error(
          `Preflight failed: could not reach ${installUrl} (${err.message}). `
          + 'Check the new collector is running and reachable from this machine, then retry.'
        );
      }
      if (!resp.ok) {
        const body = (await resp.text().catch(() => '')).slice(0, 300);
        throw new Error(
          `Preflight failed: GET ${installUrl} returned HTTP ${resp.status}.\n${body}\n`
          + 'The new collector must serve quoxagent/deploy/install.sh: set QuoxAgent_ROOT on that '
          + 'collector and make sure the quoxagent checkout is mounted into its container.'
        );
      }
      const script = await resp.text();
      if (!script.startsWith(INSTALL_SCRIPT_MAGIC)) {
        throw new Error(
          `Preflight failed: GET ${installUrl} returned 200 but the body does not start with `
          + `"${INSTALL_SCRIPT_MAGIC}" (got "${script.slice(0, 60).replace(/\n/g, '\\n')}").\n`
          + 'Something other than the QuoxAgent installer is answering there (a proxy error page '
          + 'or a login redirect). Point --collector at the collector itself, not a gateway.'
        );
      }
      say(printSuccess, `  ${script.length} bytes of installer, starts with ${INSTALL_SCRIPT_MAGIC}.`);

      // 2. Clean reinstall from the new collector — detached: it downloads a
      //    ~25MB binary plus setup, well over the exec cap.
      say(printInfo, `[2/3] Reinstalling QuoxAgent on ${hostId} from ${collector} (detached, polled)...`);
      const install = await runDetachedStep(hostId, {
        unit: 'quoxagent-rehome',
        command: buildRehomeInstallCommand({ collector, hostId, orgId }),
        orgOverride,
      });
      if (install.state === 'timeout') {
        throw new Error(
          `The install did not finish within the poll window on ${hostId}. `
          + `It may still be running: check \`systemctl status quoxagent-rehome\` and ${install.log} on the host, then re-run.`
        );
      }
      if (install.state === 'failed') {
        throw new Error(`QuoxAgent install failed on ${hostId} (exit ${install.exitCode}):\n${install.text}`);
      }
      say(printSuccess, '  install completed.');

      // 3. Bounded wait for the host to heartbeat into the NEW collector.
      //    Same endpoint `fleet agents` reads, pointed at the new base URL.
      const waitSeconds = Math.max(0, Number.parseInt(options.wait, 10) || 0);
      const agentsPath = resolveEndpoint('v1.agents.list').path;
      say(printInfo, `[3/3] Waiting up to ${waitSeconds}s for ${hostId} on ${collector}${agentsPath}...`);
      const deadline = Date.now() + waitSeconds * 1000;
      let enrolled = false;
      let lastDetail = 'no successful listing yet';
      do {
        try {
          const listResp = await fetch(`${collector}${agentsPath}`, { signal: AbortSignal.timeout(10000) });
          if (!listResp.ok) {
            // An error body is not data: a 401 is "cannot see", not "absent".
            lastDetail = `HTTP ${listResp.status} from ${collector}${agentsPath}`;
          } else {
            const data = await listResp.json();
            const agents = data.agents || data || [];
            enrolled = (Array.isArray(agents) ? agents : []).some((a) => a.host_id === hostId);
            lastDetail = enrolled ? 'heartbeating' : `listing returned ${Array.isArray(agents) ? agents.length : 0} agents, none matching ${hostId}`;
          }
        } catch (err) {
          lastDetail = err.message;
        }
        if (enrolled || Date.now() >= deadline) break;
        await sleep(5000);
      } while (Date.now() < deadline);

      if (isJson) {
        console.log(JSON.stringify({
          host_id: hostId,
          collector,
          org_id: orgId,
          install: { state: install.state, exit_code: install.exitCode },
          enrolled,
          detail: lastDetail,
          reminder: 'dev.register/dev.sessions capability profiles are signed per-collector; dev-enabled hosts must re-register with the new collector.',
        }, null, 2));
        return;
      }

      if (enrolled) printEvent(glyphLine('bastion', 'agent rehomed', { result: `${hostId} -> ${collector}`, status: 'ok' }));
      else printWarning(`${hostId} has NOT been seen on ${collector} yet (${lastDetail}). The install succeeded; verify with \`quox fleet agents\` against the new collector.`);

      console.log();
      console.log(chalk.bold('Reminder: dev capability profiles are per-collector.'));
      console.log(chalk.dim('  dev.register / dev.sessions profiles are SIGNED by the collector that issued them,'));
      console.log(chalk.dim(`  so a dev-enabled host must re-register with ${collector} before dev sessions work again.`));
      console.log();
    });

  fleet
    .command('watch')
    .description('Watch fleet status in real-time')
    .action(async () => {
      auth.requireAuth();
      console.log(chalk.dim('Watching fleet status... (Ctrl+C to stop)\n'));

      const poll = async () => {
        try {
          const data = await client.get(resolveEndpoint('v1.fleet.status.list').path, { service: resolveEndpoint('v1.fleet.status.list').service });
          const agents = data.agents || data.hosts || [];
          console.clear();
          console.log(chalk.bold('Fleet Status') + chalk.dim(` (${new Date().toLocaleTimeString()})`));
          console.log();
          formatOutput({
            columns: ['host_id', 'ip', 'status', 'cpu_percent', 'memory_percent', 'uptime'],
            headers: ['Host', 'IP', 'Status', 'CPU%', 'Mem%', 'Uptime'],
            rows: agents,
          }, { format: 'table' });
        } catch (err) {
          console.error(chalk.red(`Error: ${err.message}`));
        }
      };

      await poll();
      const interval = setInterval(poll, 5000);
      process.on('SIGINT', () => {
        clearInterval(interval);
        console.log(chalk.dim('\nStopped watching.'));
        process.exit(0);
      });

      // Keep alive
      await new Promise(() => {});
    });
}
