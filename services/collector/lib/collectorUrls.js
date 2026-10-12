'use strict';

/**
 * collectorUrls.js — single resolver for the collector's own externally
 * reachable base URL (fleet issue quoxai/quox#431).
 *
 * Two call sites used to carry their own `... || 'http://<dev-host-01 LAN
 * IP>:9848'` fallback chain: the dev-loop spawn seam (server.js, stamped into
 * the agent envelope as `collector_url` so quoxagent's EventForwarder knows
 * where to POST turn batches) and the quoxagent install path
 * (quoxagentExecutor.js, curled by the remote host over the LAN).
 *
 * Both are CROSS-INSTANCE routing: the URL is consumed on a different machine
 * than the one that computed it, so a hardcoded default is not a convenience,
 * it is a mis-route. Any instance that set neither env var told its agents to
 * talk to one specific dev box, whose collector has no row for that session and
 * answers `unknown_session` 404 — silently, only visible in the agent journal.
 *
 * So: no default. Configuration is explicit (COLLECTOR_LAN_URL preferred,
 * COLLECTOR_PUBLIC_URL as the fallback knob), and an unset value fails loud at
 * the point of use with an error that names both knobs, in the actionable style
 * of the GET /install 503 (#421).
 */

const ENV_KNOBS = ['COLLECTOR_LAN_URL', 'COLLECTOR_PUBLIC_URL'];

function unsetError(purpose) {
  return new Error(
    `Collector event-delivery URL is not configured: neither ${ENV_KNOBS[0]} nor ${ENV_KNOBS[1]} is set. ` +
    `This is a deployment misconfiguration: ${purpose} needs a URL that a MANAGED HOST can reach ` +
    `(this collector's LAN or public address, e.g. http://<this-collector-host>:9848), not a container-internal one. ` +
    `Set ${ENV_KNOBS[0]} (preferred) or ${ENV_KNOBS[1]} on the collector service and restart it. ` +
    `There is deliberately no default: a hardcoded one routed every instance's dev-loop turn batches ` +
    `to a single dev box, which answered unknown_session 404 (fleet issue quox#431).`
  );
}

/**
 * Resolve the collector base URL that off-box callers (quoxagent's event
 * forwarder, a host curling /install) should use.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.required=false] throw the actionable error when unset
 * @param {string}  [opts.purpose] what breaks, named in the error text
 * @param {object}  [opts.env=process.env] injectable for tests
 * @returns {string|null} the configured URL, or null when unset and !required
 */
function resolveCollectorEventUrl({
  required = false,
  purpose = 'dev-loop event forwarding (and the quoxagent install bootstrap)',
  env = process.env,
} = {}) {
  const url = env[ENV_KNOBS[0]] || env[ENV_KNOBS[1]] || null;
  if (url) return url;
  if (required) throw unsetError(purpose);
  return null;
}

/**
 * One clear startup warning when the instance has dev capabilities in play and
 * neither knob is set. Called from the server.listen callback with
 * `devEnabled` computed from the durable dev_servers registry, so the warning
 * fires exactly on the instances that can spawn dev loops.
 *
 * Returns { configured, devEnabled, warned } so it is testable without spying
 * on the logger.
 */
function checkStartupConfig({ devEnabled = false, env = process.env, logger = console } = {}) {
  const configured = Boolean(env[ENV_KNOBS[0]] || env[ENV_KNOBS[1]]);
  const warned = !configured && Boolean(devEnabled);
  if (warned) {
    logger.warn(
      `[collector] ${ENV_KNOBS[0]}/${ENV_KNOBS[1]} are BOTH unset, but this instance has dev-capable ` +
      `hosts registered. Dev-loop spawns will FAIL (rather than silently route turn batches to another ` +
      `instance's collector, fleet issue quox#431). Set ${ENV_KNOBS[0]} to this collector's LAN address ` +
      `(e.g. http://<this-collector-host>:9848) and restart the collector.`
    );
  }
  return { configured, devEnabled: Boolean(devEnabled), warned };
}

/**
 * Rewrite install.sh's client-side COLLECTOR_URL default arm to the SERVING
 * collector's address. install.sh ships its own `${COLLECTOR_URL:-<dev box>}`
 * fallback, so `curl <collector>/install | bash` with no --collector flag
 * enrolled the host to whatever box the script's author used, not the one
 * actually serving the script. Only the default arm changes: an explicit
 * COLLECTOR_URL env or --collector flag still wins on the client. Returns the
 * script untouched when no URL is configured (the raw-default behavior is then
 * at least visible in the script the operator is piping to bash).
 */
const INSTALL_DEFAULT_LINE = /^(COLLECTOR_URL="\$\{COLLECTOR_URL:-)[^}"]*(\}")$/m;

function templateInstallScript(script, servingUrl) {
  if (!servingUrl) return script;
  return script.replace(INSTALL_DEFAULT_LINE, `$1${servingUrl}$2`);
}

module.exports = { resolveCollectorEventUrl, checkStartupConfig, templateInstallScript, ENV_KNOBS };
