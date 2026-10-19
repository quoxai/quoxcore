'use strict';

/**
 * quox#1223: the remote install command must fail loudly. `curl ... | sudo bash` exits 0 when curl fails
 * (the pipeline status is bash's, and bash got an empty script), so a TLS or HTTP failure looked like a
 * successful install. This downloads to a temp file with `curl -f` and only then runs it, inside a
 * subshell, so curl's non-zero exit is the command's exit and nothing is run. TLS verification stays ON.
 *
 * `envPrefix` is the optional `env BINARY_SHA256=<sha> ` text delivered ahead of bash (trailing space).
 * Every interpolated value must already be shell-safe (host ids pass isSafeHostId; URLs come from config).
 */
function buildFailLoudInstallCommand({ installerUrl, args = '', envPrefix = '' }) {
  const url = String(installerUrl).replace(/\/+$/, '');
  return `( f=$(mktemp) && trap 'rm -f "$f"' EXIT && curl -fsSL ${url} -o "$f" && sudo ${envPrefix}bash "$f"${args ? ` ${args}` : ''} )`;
}

module.exports = { buildFailLoudInstallCommand };
