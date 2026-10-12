'use strict';

/**
 * devServerRefresh.js — DEVSUITE phase 7 (ENABLE PROVISIONS EVERYTHING),
 * agent-refresh slice: `quox dev enable` delivers the CURRENT agent binary
 * and restarts the agent so the just-signed capability profile is adopted,
 * with zero hand steps.
 *
 * The two hand-steps this kills, both hit live on 2026-08-20:
 *  - stale binaries: a host's agent sat on an old build even after an
 *    install run, and every capability fix needed a manual scp+restart;
 *  - "restart the agent yourself": quoxagent loads its signed capability
 *    profile ONCE at startup, so the enable flow ended with the CLI telling
 *    a human to run systemctl.
 *
 * Restart safety: an agent restart kills live STRUCTURED sessions (QLoop
 * children die with the process; only tmux sessions survive via the scope
 * escape). So the caller counts live sessions first and a non-zero count
 * DEFERS the restart, loudly, in the response — never silently. The binary
 * still lands so the next natural restart picks it up.
 *
 * Shell discipline: sentinels are strings only this command emits (grep
 * discipline, same as buildProfileWriteCommand); sudo is always `sudo -n`
 * so a host without passwordless sudo fails fast instead of hanging the
 * Bastion exec against its hardcoded 60s ceiling.
 */

const SENTINELS = {
  current: 'AGENT_BINARY_CURRENT',
  updated: 'AGENT_BINARY_UPDATED',
  restarted: 'AGENT_RESTARTED',
  noUnit: 'AGENT_UNIT_NOT_FOUND',
};

/**
 * One idempotent shell command: detect the agent unit (user unit first —
 * dev VMs run it that way — else the system unit), download the current
 * binary, swap only when the hash differs, restart unless skipRestart.
 * mv-over-path is safe for a running binary (the old inode keeps running
 * until restart).
 */
function buildAgentRefreshCommand({ downloadUrl, skipRestart = false }) {
  if (!downloadUrl || !/^https?:\/\//.test(downloadUrl)) {
    throw new Error('devServerRefresh: downloadUrl is required');
  }
  const restart = skipRestart
    ? ''
    : ` && $UNIT_CMD restart quoxagent && echo ${SENTINELS.restarted}`;
  return [
    `set -e`,
    `TMP=$(mktemp)`,
    `curl -fsS -m 40 '${downloadUrl}' -o "$TMP"`,
    `export XDG_RUNTIME_DIR="/run/user/$(id -u)"`,
    `if systemctl --user is-active quoxagent >/dev/null 2>&1; then UNIT_CMD="systemctl --user";`,
    `elif sudo -n systemctl is-active quoxagent >/dev/null 2>&1; then UNIT_CMD="sudo -n systemctl";`,
    `else echo ${SENTINELS.noUnit}; rm -f "$TMP"; exit 0; fi`,
    `BIN=$($UNIT_CMD show quoxagent -p ExecStart --value | sed -n 's/.*path=\\([^ ;]*\\).*/\\1/p')`,
    `[ -n "$BIN" ] || BIN=/opt/quoxagent/bin/quoxagent`,
    `NEW=$(sha256sum "$TMP" | cut -d' ' -f1)`,
    `CUR=$(sha256sum "$BIN" 2>/dev/null | cut -d' ' -f1 || true)`,
    `if [ "$NEW" = "$CUR" ]; then echo ${SENTINELS.current}; rm -f "$TMP";`,
    `else chmod 755 "$TMP";`,
    `  if mv "$TMP" "$BIN" 2>/dev/null; then :; else sudo -n mv "$TMP" "$BIN" && sudo -n chmod 755 "$BIN"; fi;`,
    `  echo ${SENTINELS.updated};`,
    `fi`,
    `true${restart}`,
  ].join('\n');
}

/**
 * CLI refresh (DEVSUITE phase 8, CLI-FIRST): keep /opt/quoxcli current with
 * the served bundle. Hash-gated: the host stores the installed bundle's sha
 * in /opt/quoxcli/.bundle-sha, so a matching sha costs one stat, never a
 * 19MB download. Pre-existing installs (install.sh writes no sha file)
 * hash-mismatch once and self-heal. Same wrapper install.sh writes,
 * QUOX_URL defaulting to this install's collector host. Extraction is -C
 * into the install dir: the bundle is FLAT and quoxmcp's installer already
 * shipped the extract-to-/opt bug once.
 */
function buildCliRefreshCommand({ bundleUrl, bundleSha, collectorHost }) {
  if (!bundleUrl || !bundleSha || !collectorHost) {
    throw new Error('devServerRefresh: bundleUrl, bundleSha and collectorHost are required');
  }
  return [
    `set -e`,
    `if ! command -v node >/dev/null 2>&1; then echo CLI_SKIPPED_NO_NODE; exit 0; fi`,
    `CUR=$(cat /opt/quoxcli/.bundle-sha 2>/dev/null || true)`,
    `if [ "$CUR" = "${bundleSha}" ]; then echo CLI_CURRENT; exit 0; fi`,
    `TMP=$(mktemp)`,
    `curl -fsS -m 40 '${bundleUrl}' -o "$TMP"`,
    `GOT=$(sha256sum "$TMP" | cut -d' ' -f1)`,
    `if [ "$GOT" != "${bundleSha}" ]; then echo "CLI_BUNDLE_HASH_MISMATCH $GOT"; rm -f "$TMP"; exit 1; fi`,
    `sudo -n rm -rf /opt/quoxcli && sudo -n mkdir -p /opt/quoxcli`,
    `sudo -n tar -xzf "$TMP" -C /opt/quoxcli`,
    `rm -f "$TMP"`,
    `printf '%s' "${bundleSha}" | sudo -n tee /opt/quoxcli/.bundle-sha > /dev/null`,
    // Dev-server reach-back wiring (found live 2026-08-20): auth binds
    // loopback on the collector box, so auth calls must ride the dashboard's
    // nginx proxy (https :3000, /api/auth), while the collector is directly
    // reachable on :9848 http. The dashboard cert is self-signed on LAN
    // installs, hence QUOX_INSECURE=1 (prints its warning on every run,
    // never silent). User-set values always win.
    // #456: DoneEngine (`quox done`) shelled out to a hardcoded
    // ~/quox-gauge/gauge.mjs, which only ever existed on the box it was
    // developed on. The gauge leg below delivers the engine to
    // /opt/quoxgauge; this line points the wrapper at it, same pattern as
    // the URLs above (user-set QUOX_DONEENGINE_PATH always wins).
    `printf '#!/bin/sh\\nexport QUOX_URL="\${QUOX_URL:-https://${collectorHost}:3000}"\\nexport QUOX_AUTH_URL="\${QUOX_AUTH_URL:-https://${collectorHost}:3000}"\\nexport QUOX_COLLECTOR_URL="\${QUOX_COLLECTOR_URL:-http://${collectorHost}:9848}"\\nexport QUOX_INSECURE="\${QUOX_INSECURE:-1}"\\nexport QUOX_DONEENGINE_PATH="\${QUOX_DONEENGINE_PATH:-/opt/quoxgauge/gauge.mjs}"\\nexec node /opt/quoxcli/bin/quox.js "\$@"\\n' | sudo -n tee /usr/local/bin/quox > /dev/null`,
    `sudo -n chmod 755 /usr/local/bin/quox`,
    `echo CLI_UPDATED`,
  ].join('\n');
}

/** Read the CLI sentinels back out. */
function parseCliRefreshOutput(stdout) {
  const out = String(stdout || '');
  if (out.includes('CLI_UPDATED')) return { cli: 'updated' };
  if (out.includes('CLI_CURRENT')) return { cli: 'current' };
  if (out.includes('CLI_SKIPPED_NO_NODE')) return { cli: 'skipped_no_node' };
  return { cli: 'unknown' };
}

/**
 * DoneEngine refresh (#456): keep /opt/quoxgauge current with the served
 * gauge bundle, same hash-gated shape as the CLI leg above. Deliberately
 * simpler than the CLI leg: DoneEngine has no wrapper of its own to write.
 * `quox done` finds it via QUOX_DONEENGINE_PATH, which the CLI wrapper
 * above already points at this exact path.
 */
function buildGaugeRefreshCommand({ bundleUrl, bundleSha }) {
  if (!bundleUrl || !bundleSha) {
    throw new Error('devServerRefresh: bundleUrl and bundleSha are required');
  }
  return [
    `set -e`,
    `CUR=$(cat /opt/quoxgauge/.bundle-sha 2>/dev/null || true)`,
    `if [ "$CUR" = "${bundleSha}" ]; then echo GAUGE_CURRENT; exit 0; fi`,
    `TMP=$(mktemp)`,
    `curl -fsS -m 40 '${bundleUrl}' -o "$TMP"`,
    `GOT=$(sha256sum "$TMP" | cut -d' ' -f1)`,
    `if [ "$GOT" != "${bundleSha}" ]; then echo "GAUGE_BUNDLE_HASH_MISMATCH $GOT"; rm -f "$TMP"; exit 1; fi`,
    `sudo -n rm -rf /opt/quoxgauge && sudo -n mkdir -p /opt/quoxgauge`,
    `sudo -n tar -xzf "$TMP" -C /opt/quoxgauge`,
    `rm -f "$TMP"`,
    `printf '%s' "${bundleSha}" | sudo -n tee /opt/quoxgauge/.bundle-sha > /dev/null`,
    `echo GAUGE_UPDATED`,
  ].join('\n');
}

/** Read the gauge sentinels back out. */
function parseGaugeRefreshOutput(stdout) {
  const out = String(stdout || '');
  if (out.includes('GAUGE_UPDATED')) return { gauge: 'updated' };
  if (out.includes('GAUGE_CURRENT')) return { gauge: 'current' };
  return { gauge: 'unknown' };
}

/**
 * Precompacticus refresh (DEVSUITE-DEVMODE phase 14): deliver context-limit
 * alerts + pre-compaction snapshots to every dev server the way the skill
 * pack and DoneEngine already flow. Today this is a hand-run script,
 * scripts/install-precompacticus.sh, once per box — its own header names
 * this leg as the registered productisation path it is a bridge to.
 *
 * Unlike the CLI/gauge legs, the destination is $HOME/.claude/precompacticus
 * (user space), never /opt, so this leg needs no sudo at all.
 *
 * Three parts, same hash-gated shape as the CLI/gauge legs for the bundle
 * itself, then two rules install-precompacticus.sh already enforces by hand
 * and this leg must mirror exactly:
 *  - the conf file (precompacticus.conf) is operator surface and is NEVER
 *    clobbered — only installed from the bundled .example when absent;
 *  - settings.json gains the UserPromptSubmit hook, the PreCompact hook and
 *    statusLine ONLY if each is absent; an existing statusLine pointing
 *    somewhere else is left alone and reported, never replaced; the file is
 *    backed up before any edit.
 * The merge itself is done with jq, never hand-rolled JSON editing in bash:
 * a host with no jq gets the bundle and the conf, but skips the settings
 * merge and reports it honestly rather than pretending success.
 */
const PC_SENTINELS = {
  bundleCurrent: 'PC_BUNDLE_CURRENT',
  bundleUpdated: 'PC_BUNDLE_UPDATED',
  bundleHashMismatch: 'PC_BUNDLE_HASH_MISMATCH',
  confInstalled: 'PC_CONF_INSTALLED',
  confKept: 'PC_CONF_KEPT',
  settingsMerged: 'PC_SETTINGS_MERGED',
  settingsUnchanged: 'PC_SETTINGS_UNCHANGED',
  statuslineForeign: 'PC_STATUSLINE_FOREIGN',
  noJq: 'PC_NO_JQ',
};

// jq program: adds the nudge hook to UserPromptSubmit and the precompact
// hook to PreCompact only when no existing hook command already mentions
// precompacticus (idempotent — a second run is a no-op), reusing an
// existing empty-matcher group when one exists, same shape
// install-precompacticus.sh's Python merge builds by hand. statusLine is
// set only when entirely absent; an existing one is passed through
// untouched (the PC_STATUSLINE_FOREIGN sentinel above is emitted
// separately, before this filter runs, so the warning survives even though
// the filter itself makes no change in that case).
const PC_SETTINGS_FILTER = `
  (.hooks.UserPromptSubmit // []) as $up
  | (any($up[]; .hooks[]? | ((.command // "") | test("precompacticus")))) as $uphas
  | (.hooks.PreCompact // []) as $pcomp
  | (any($pcomp[]; .hooks[]? | ((.command // "") | test("precompacticus")))) as $pchas
  | .hooks.UserPromptSubmit = (
      if $uphas then $up
      elif (any($up[]; .matcher == "")) then
        ($up | map(if .matcher == "" then .hooks += [{"type":"command","command":$nudge,"timeout":8}] else . end))
      else
        $up + [{"matcher":"","hooks":[{"type":"command","command":$nudge,"timeout":8}]}]
      end
    )
  | .hooks.PreCompact = (
      if $pchas then $pcomp
      elif (any($pcomp[]; .matcher == "")) then
        ($pcomp | map(if .matcher == "" then .hooks += [{"type":"command","command":$precompact,"timeout":20,"statusMessage":"Precompacticus: saving snapshot..."}] else . end))
      else
        $pcomp + [{"matcher":"","hooks":[{"type":"command","command":$precompact,"timeout":20,"statusMessage":"Precompacticus: saving snapshot..."}]}]
      end
    )
  | .statusLine = (if (.statusLine // null) == null then {"type":"command","command":$statusline,"padding":0} else .statusLine end)
`.trim();

function buildPrecompacticusRefreshCommand({ bundleUrl, bundleSha }) {
  if (!bundleUrl || !bundleSha) {
    throw new Error('devServerRefresh: bundleUrl and bundleSha are required');
  }
  return [
    `set -e`,
    `DEST="$HOME/.claude/precompacticus"`,
    `mkdir -p "$DEST/snapshots"`,
    `CUR=$(cat "$DEST/.bundle-sha" 2>/dev/null || true)`,
    `if [ "$CUR" = "${bundleSha}" ]; then echo ${PC_SENTINELS.bundleCurrent};`,
    `else`,
    `  TMP=$(mktemp)`,
    `  curl -fsS -m 40 '${bundleUrl}' -o "$TMP"`,
    `  GOT=$(sha256sum "$TMP" | cut -d' ' -f1)`,
    `  if [ "$GOT" != "${bundleSha}" ]; then echo "${PC_SENTINELS.bundleHashMismatch} $GOT"; rm -f "$TMP"; exit 1; fi`,
    `  tar -xzf "$TMP" -C "$DEST"`,
    `  rm -f "$TMP"`,
    `  printf '%s' "${bundleSha}" > "$DEST/.bundle-sha"`,
    `  echo ${PC_SENTINELS.bundleUpdated};`,
    `fi`,
    // The bundle only ever carries precompacticus.conf.example — never a
    // file literally named precompacticus.conf — so extraction above can
    // never clobber the operator's conf. This step is the only thing that
    // ever creates precompacticus.conf, and only when it does not exist yet.
    `if [ -f "$DEST/precompacticus.conf" ]; then echo ${PC_SENTINELS.confKept};`,
    `else`,
    `  [ -f "$DEST/precompacticus.conf.example" ] && cp "$DEST/precompacticus.conf.example" "$DEST/precompacticus.conf"`,
    `  echo ${PC_SENTINELS.confInstalled};`,
    `fi`,
    `if ! command -v jq >/dev/null 2>&1; then echo ${PC_SENTINELS.noJq};`,
    `else`,
    `  SETTINGS="$HOME/.claude/settings.json"`,
    `  [ -f "$SETTINGS" ] || printf '{}' > "$SETTINGS"`,
    `  cp "$SETTINGS" "$SETTINGS.pre-precompacticus.bak"`,
    `  EXIST_SL=$(jq -r '(.statusLine.command // "")' "$SETTINGS")`,
    `  case "$EXIST_SL" in`,
    `    *precompacticus*) : ;;`,
    `    "") : ;;`,
    `    *) echo ${PC_SENTINELS.statuslineForeign} ;;`,
    `  esac`,
    `  PY_CMD="python3 $DEST/precompacticus.py"`,
    `  NUDGE_CMD="$PY_CMD nudge"`,
    `  PRECOMPACT_CMD="$PY_CMD precompact"`,
    `  STATUSLINE_CMD="$PY_CMD statusline"`,
    `  FILTER='${PC_SETTINGS_FILTER}'`,
    `  NEW=$(jq --arg nudge "$NUDGE_CMD" --arg precompact "$PRECOMPACT_CMD" --arg statusline "$STATUSLINE_CMD" "$FILTER" "$SETTINGS")`,
    `  OLD_NORM=$(jq -S . "$SETTINGS")`,
    `  NEW_NORM=$(printf '%s' "$NEW" | jq -S .)`,
    `  if [ "$NEW_NORM" = "$OLD_NORM" ]; then echo ${PC_SENTINELS.settingsUnchanged};`,
    `  else printf '%s\\n' "$NEW" > "$SETTINGS"; echo ${PC_SENTINELS.settingsMerged}; fi`,
    `fi`,
  ].join('\n');
}

/** Read the precompacticus sentinels back out into the single response field
 * enable reports ('updated' beats 'current' beats 'skipped_no_jq'), plus an
 * out-of-band flag when an existing statusLine was left alone. */
function parsePrecompacticusRefreshOutput(stdout) {
  const out = String(stdout || '');
  const has = (s) => out.includes(s);
  const result = {};
  if (has(PC_SENTINELS.noJq)) {
    result.precompacticus = 'skipped_no_jq';
  } else if (has(PC_SENTINELS.bundleUpdated) || has(PC_SENTINELS.settingsMerged) || has(PC_SENTINELS.confInstalled)) {
    result.precompacticus = 'updated';
  } else if (has(PC_SENTINELS.bundleCurrent) || has(PC_SENTINELS.settingsUnchanged)) {
    result.precompacticus = 'current';
  } else {
    result.precompacticus = 'unknown';
  }
  if (has(PC_SENTINELS.statuslineForeign)) {
    result.precompacticus_statusline_conflict = true;
  }
  return result;
}

/**
 * Verifier env leg (#462, footgun 4, exampleestate-website 2026-08-22): a signed
 * profile only counts if the agent can VERIFY it, and verification needs the
 * org signing-key fetch at startup, which needs QUOXAGENT_ORG_ID and
 * QUOXAGENT_COLLECTOR_URL (plus the seam service key) in the agent's unit
 * environment. Hosts installed by the generic /install script (legacy root
 * system unit) have none of that, so enable delivered, restarted, and the
 * host still reported profile_verified:false with zero adopted capabilities.
 *
 * This leg stamps the two NON-SECRET values into a unit drop-in
 * (dev-env.conf) for whichever unit layout the host runs (user or system),
 * plus an optional EnvironmentFile pointing at the seam service key file.
 * The key itself is deliberately NOT delivered here: putting the secret in
 * a Bastion exec command line would write it into the witnessed audit log.
 * Instead the leg REPORTS whether the key file exists, so enable can say
 * exactly why verification will still fail. Runs BEFORE the agent leg so
 * the restart that follows adopts the stamped env.
 */
const ENV_SENTINELS = {
  current: 'DEV_ENV_CURRENT',
  stamped: 'DEV_ENV_STAMPED',
  noUnit: 'DEV_ENV_UNIT_NOT_FOUND',
  keyPresent: 'SEAM_KEY_PRESENT',
  keyMissing: 'SEAM_KEY_MISSING',
};

function buildVerifierEnvCommand({ orgId, collectorUrl } = {}) {
  // Both values land inside a shell command over the Bastion: allowlist the
  // shapes, never trust-and-quote (signed-payload delimiter-injection rule).
  if (!orgId || !/^[A-Za-z0-9_-]+$/.test(orgId)) {
    throw new Error('devServerRefresh: orgId is required and must be [A-Za-z0-9_-]');
  }
  if (!collectorUrl || !/^https?:\/\/[A-Za-z0-9.\-]+(:\d+)?$/.test(collectorUrl)) {
    throw new Error('devServerRefresh: collectorUrl must be a plain http(s) origin');
  }
  return [
    `set -e`,
    `export XDG_RUNTIME_DIR="/run/user/$(id -u)"`,
    `if systemctl --user is-active quoxagent >/dev/null 2>&1; then UNIT_MODE=user;`,
    `elif sudo -n systemctl is-active quoxagent >/dev/null 2>&1; then UNIT_MODE=system;`,
    `else echo ${ENV_SENTINELS.noUnit}; exit 0; fi`,
    `if [ "$UNIT_MODE" = user ]; then DDIR="$HOME/.config/systemd/user/quoxagent.service.d"; KEYFILE="$HOME/.quoxagent/seam-service-key.env"; RUN=""; RELOAD="systemctl --user daemon-reload";`,
    `else DDIR="/etc/systemd/system/quoxagent.service.d"; KEYFILE="/etc/quoxagent/seam-service-key.env"; RUN="sudo -n"; RELOAD="sudo -n systemctl daemon-reload"; fi`,
    `DESIRED=$(printf '[Service]\\nEnvironment=QUOXAGENT_ORG_ID=${orgId}\\nEnvironment=QUOXAGENT_COLLECTOR_URL=${collectorUrl}\\nEnvironmentFile=-'"$KEYFILE")`,
    `CUR=$($RUN cat "$DDIR/dev-env.conf" 2>/dev/null || true)`,
    `if [ "$CUR" = "$DESIRED" ]; then echo ${ENV_SENTINELS.current};`,
    `else $RUN mkdir -p "$DDIR"; printf '%s\\n' "$DESIRED" | $RUN tee "$DDIR/dev-env.conf" >/dev/null; $RELOAD; echo ${ENV_SENTINELS.stamped}; fi`,
    `if $RUN test -f "$KEYFILE"; then echo ${ENV_SENTINELS.keyPresent}; else echo ${ENV_SENTINELS.keyMissing}; fi`,
  ].join('\n');
}

/** Read the verifier-env sentinels back out. */
function parseVerifierEnvOutput(stdout) {
  const out = String(stdout || '');
  const env = out.includes(ENV_SENTINELS.noUnit) ? 'unit_not_found'
    : out.includes(ENV_SENTINELS.stamped) ? 'stamped'
      : out.includes(ENV_SENTINELS.current) ? 'current'
        : 'unknown';
  const seamKey = out.includes(ENV_SENTINELS.keyPresent) ? 'present'
    : out.includes(ENV_SENTINELS.keyMissing) ? 'missing'
      : 'unknown';
  return { env, seamKey };
}

/** Read the sentinels back out of the command's stdout. */
function parseRefreshOutput(stdout) {
  const out = String(stdout || '');
  if (out.includes(SENTINELS.noUnit)) {
    return { binary: 'unknown', restarted: false, unitFound: false };
  }
  return {
    binary: out.includes(SENTINELS.updated) ? 'updated' : (out.includes(SENTINELS.current) ? 'current' : 'unknown'),
    restarted: out.includes(SENTINELS.restarted),
    unitFound: true,
  };
}

/**
 * Refresh hostId's agent. Never throws — enable must report a refresh
 * failure, not fail on one. countLiveSessions errors count as zero: on a
 * first enable dev.sessions is not reachable yet, and "cannot ask" must
 * not block the restart that makes it reachable.
 */
async function refreshDevServerAgent({ hostId, downloadUrl, callBastion, countLiveSessions, cli, gauge, precompacticus, verifierEnv }) {
  let liveSessions = 0;
  try {
    liveSessions = Number(await countLiveSessions()) || 0;
  } catch {
    liveSessions = 0;
  }

  // Verifier env leg (#462) runs FIRST: the agent restart below is what
  // adopts the stamped env, so stamping after it would need a second
  // restart. Own failure domain, same isolation as the cli/gauge legs.
  let envOut;
  if (verifierEnv) {
    try {
      const envResult = await callBastion(hostId, buildVerifierEnvCommand(verifierEnv), 55000);
      if (envResult && envResult.success) {
        const parsedEnv = parseVerifierEnvOutput(envResult.stdout);
        envOut = { verifier_env: parsedEnv.env, seam_key: parsedEnv.seamKey };
      } else {
        envOut = { verifier_env: 'error', verifier_env_error: (envResult && (envResult.error || envResult.stderr || envResult.stdout)) || 'no result' };
      }
    } catch (err) {
      envOut = { verifier_env: 'error', verifier_env_error: err.message };
    }
  }

  const command = buildAgentRefreshCommand({ downloadUrl, skipRestart: liveSessions > 0 });
  let result;
  try {
    result = await callBastion(hostId, command, 55000);
  } catch (err) {
    return { ok: false, error: `agent refresh delivery failed: ${err.message}`, deferred_live_sessions: liveSessions };
  }
  if (!result || !result.success) {
    return { ok: false, error: `agent refresh delivery failed: ${(result && (result.error || result.stderr)) || 'no result'}`, deferred_live_sessions: liveSessions };
  }

  const parsed = parseRefreshOutput(result.stdout);
  const out = {
    ok: true,
    binary: parsed.binary,
    restarted: parsed.restarted,
    unit_found: parsed.unitFound,
    deferred_live_sessions: liveSessions,
    ...(envOut || {}),
  };

  // CLI leg (phase 8): its own exec, its own failure domain. A CLI problem
  // is reported, never allowed to fail the agent refresh that already
  // happened.
  if (cli) {
    try {
      const cliResult = await callBastion(hostId, buildCliRefreshCommand(cli), 55000);
      if (cliResult && cliResult.success) {
        out.cli = parseCliRefreshOutput(cliResult.stdout).cli;
      } else {
        out.cli = 'error';
        out.cli_error = (cliResult && (cliResult.error || cliResult.stderr || cliResult.stdout)) || 'no result';
      }
    } catch (err) {
      out.cli = 'error';
      out.cli_error = err.message;
    }
  }

  // Gauge leg (#456): DoneEngine's own delivery, own failure domain, same
  // reasoning as the CLI leg: a gauge problem never fails the agent refresh
  // that already happened.
  if (gauge) {
    try {
      const gaugeResult = await callBastion(hostId, buildGaugeRefreshCommand(gauge), 55000);
      if (gaugeResult && gaugeResult.success) {
        out.gauge = parseGaugeRefreshOutput(gaugeResult.stdout).gauge;
      } else {
        out.gauge = 'error';
        out.gauge_error = (gaugeResult && (gaugeResult.error || gaugeResult.stderr || gaugeResult.stdout)) || 'no result';
      }
    } catch (err) {
      out.gauge = 'error';
      out.gauge_error = err.message;
    }
  }

  // Precompacticus leg (DEVSUITE-DEVMODE phase 14): its own exec, its own
  // failure domain, same reasoning as the CLI/gauge legs above — a
  // precompacticus problem never fails the agent refresh that already
  // happened.
  if (precompacticus) {
    try {
      const pcResult = await callBastion(hostId, buildPrecompacticusRefreshCommand(precompacticus), 55000);
      if (pcResult && pcResult.success) {
        Object.assign(out, parsePrecompacticusRefreshOutput(pcResult.stdout));
      } else {
        out.precompacticus = 'error';
        out.precompacticus_error = (pcResult && (pcResult.error || pcResult.stderr || pcResult.stdout)) || 'no result';
      }
    } catch (err) {
      out.precompacticus = 'error';
      out.precompacticus_error = err.message;
    }
  }
  return out;
}

module.exports = {
  buildAgentRefreshCommand,
  parseRefreshOutput,
  buildVerifierEnvCommand,
  parseVerifierEnvOutput,
  buildCliRefreshCommand,
  parseCliRefreshOutput,
  buildGaugeRefreshCommand,
  parseGaugeRefreshOutput,
  buildPrecompacticusRefreshCommand,
  parsePrecompacticusRefreshOutput,
  refreshDevServerAgent,
};
