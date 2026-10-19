'use strict';
/**
 * FND_01M50XEEKX9ZGBEB2YAT9ZGBEB (SITE-CLI ruling 2026-10-15, option A): Wazuh indexer reads over governed Bastion
 * exec on the wazuh fleet host. The indexer credential lives ONLY on that host, in a root-only curl config
 * (CURLRC_PATH, placed once by the owner: ~/.quox/wazuh/install-wazuh-indexer-curlrc.sh). The command built here
 * names the config file, never a secret, so nothing sensitive reaches argv, the collector log or Bastion's audit.
 */
const CURLRC_PATH = '/etc/quox/wazuh-indexer.curlrc';
const CURLRC_MISSING_MARKER = 'QUOX_WAZUH_CURLRC_MISSING';
const SUDO_REFUSED_MARKER = 'QUOX_WAZUH_SUDO_REFUSED';
const INDEXES = new Set(['wazuh-alerts-*', 'wazuh-states-vulnerabilities-*']);

/** The fleet host id for WAZUH_HOST (an ip or a host id), or null when the fleet does not know it. */
function resolveWazuhFleetHost(wazuhHost, agents) {
  const want = String(wazuhHost || '').trim();
  if (!want) return null;
  const hit = (Array.isArray(agents) ? agents : []).find((a) => a && (a.host_id === want || a.ip === want));
  return hit ? hit.host_id : null;
}

function buildIndexerCommand(index, body) {
  if (!INDEXES.has(index)) throw new Error(`index not allowed: ${index}`);
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new Error('search body must be JSON'); }
  // Re-serialise: the body in the command is exactly the JSON we parsed, single-quoted for the remote shell.
  const json = JSON.stringify(parsed).replace(/'/g, "'\\''");
  // sudo first, with its own marker: otherwise a refused sudo reads as a missing file (live on dev 2026-10-16).
  return `sudo -n true 2>/dev/null || { echo ${SUDO_REFUSED_MARKER}; exit 4; }; `
    + `sudo -n test -r ${CURLRC_PATH} || { echo ${CURLRC_MISSING_MARKER}; exit 3; }; `
    + `sudo -n curl -sk --config ${CURLRC_PATH} -X POST 'https://127.0.0.1:9200/${index}/_search' -H 'Content-Type: application/json' -d '${json}'`;
}

/** One indexer search on the wazuh fleet host. Returns { ok, json } or { ok:false, error, detail }. */
async function runIndexerQuery({ index, body, wazuhHost, callBastion, listAgents, resolveHost }) {
  let agents = [];
  try { agents = await listAgents(); } catch (err) { return { ok: false, error: 'wazuh_fleet_unavailable', detail: err.message }; }
  // 2026-10-17: right after a collector restart the fleet list comes back EMPTY (200, still loading). That is not
  // "the host is not registered": say so honestly and run nothing, so nobody goes to fix a registration that is fine.
  if (!Array.isArray(agents) || agents.length === 0) return { ok: false, error: 'wazuh_fleet_not_loaded', detail: 'The fleet host list came back empty (the collector may still be loading it after a restart, or no hosts are registered), so the Wazuh host could not be looked up. Retry in a minute; if it stays empty, check `quox fleet list`.' };
  let hostId = resolveWazuhFleetHost(wazuhHost, agents);
  // The fleet agent list may carry no ip (live on dev 2026-10-16: wazuh01 had none), so an ip WAZUH_HOST also goes
  // through Bastion's own registry (resolveHostId). The result must still be a registered fleet host.
  if (!hostId && typeof resolveHost === 'function' && wazuhHost) {
    let viaBastion = null;
    try { viaBastion = await resolveHost(String(wazuhHost).trim()); } catch { viaBastion = null; }
    if (viaBastion && viaBastion !== String(wazuhHost).trim()) hostId = resolveWazuhFleetHost(viaBastion, agents);
  }
  if (!hostId) return { ok: false, error: 'wazuh_host_not_in_fleet', detail: `The Wazuh host ${wazuhHost || '(unset)'} is not a registered fleet host, so it cannot be reached through Bastion.` };
  let cmd;
  try { cmd = buildIndexerCommand(index, body); } catch (err) { return { ok: false, error: 'wazuh_bad_query', detail: err.message }; }
  const r = await callBastion(hostId, cmd);
  const out = String((r && (r.output || r.stdout)) || '');
  if (out.includes(SUDO_REFUSED_MARKER)) {
    return { ok: false, error: 'wazuh_sudo_refused', detail: `The Bastion exec user on ${hostId} cannot run sudo -n, so it cannot read ${CURLRC_PATH}. The owner grants that user a narrow NOPASSWD rule for the indexer read.` };
  }
  if (out.includes(CURLRC_MISSING_MARKER)) {
    return { ok: false, error: 'wazuh_indexer_credential_missing', detail: `The indexer credential file ${CURLRC_PATH} is not on ${hostId}. The owner places it once with ~/.quox/wazuh/install-wazuh-indexer-curlrc.sh.` };
  }
  if (!r || !r.success) {
    const e = String((r && r.error) || '');
    if (/sudo/i.test(e) && /password is required|not allowed|not in the sudoers/i.test(e)) return { ok: false, error: 'wazuh_sudo_refused', detail: `The Bastion exec user on ${hostId} cannot read ${CURLRC_PATH} with sudo -n.` };
    return { ok: false, error: 'wazuh_exec_failed', detail: e.slice(0, 300) };
  }
  try { return { ok: true, json: JSON.parse(out) }; } catch { return { ok: false, error: 'wazuh_parse_error', detail: out.slice(0, 200) }; }
}

module.exports = { CURLRC_PATH, CURLRC_MISSING_MARKER, SUDO_REFUSED_MARKER, resolveWazuhFleetHost, buildIndexerCommand, runIndexerQuery };
