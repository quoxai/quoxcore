/**
 * QUOXPERTICUS-REVISIT P3 "Resident lifecycle v1" — server-side guard on
 * INTERACTIVE resident slot checkouts.
 *
 * Wired into POST /api/v1/slots/:name/checkout (server.js) ahead of
 * devSlots.checkoutSlot(): when a checkout names holder_kind='interactive'
 * AND a host_id, AND that host is a registered dev server with dev.sessions
 * enabled, the named holder_session must actually be a live tmux session on
 * that host's tmux plane (lib/devSessionsProxy.js's list-sessions method)
 * before the checkout is allowed to proceed. This stops a checkout from
 * naming a session that never existed, or one that has already died.
 *
 * Every other checkout is UNTOUCHED and returns { ok: true } without ever
 * calling listSessions: no host_id (a plain human/free-text session), a
 * host with no dev.sessions server, or holder_kind !== 'interactive' (e.g.
 * the headless supervisor's 'resident' kind, which never names a tmux
 * session — see cli/lib/commands/devSupervisor.js's checkoutSlot()).
 *
 * Fails OPEN on a transport/agent error reaching the sessions plane: a
 * Bastion hiccup or a slow agent must never block every interactive
 * checkout on a host, only the case where the plane is reachable and
 * plainly does not know the named session. Same "best-effort, never seize
 * or block on a probe failure" posture as the supervisor's foreign-hold
 * checks (cli/lib/commands/devSupervisor.js status/idle-heartbeat).
 */

const DEV_SESSIONS_CAPABILITY = 'dev.sessions';

/**
 * @param {object} deps
 * @param {(hostId: string) => object|null} deps.getServer - dev_servers row lookup (host_id, enabled_capabilities)
 * @param {(args: {orgId: string, hostId: string}) => Promise<{sessions?: Array<{session_id?: string, name?: string}>}>} [deps.listSessions]
 * @param {object} params
 * @param {string} params.orgId
 * @param {string|null|undefined} params.hostId
 * @param {string|null|undefined} params.holderKind
 * @param {string} params.holderSession
 * @returns {Promise<{ok: true, unverified?: boolean, reason?: string} | {ok: false, code: string, message: string}>}
 */
async function checkResidentSessionGate({ getServer, listSessions } = {}, { orgId, hostId, holderKind, holderSession } = {}) {
  // Untouched paths: no host named, or not an interactive checkout at all.
  if (holderKind !== 'interactive' || !hostId) return { ok: true };

  const server = typeof getServer === 'function' ? getServer(hostId) : null;
  // Host isn't a registered dev server: nothing to verify against, and
  // refusing here would break every non-dev-server interactive checkout
  // that happens to pass a host_id (e.g. a plain human session on their
  // own box). Stay permissive.
  if (!server) return { ok: true };

  const enabled = Array.isArray(server.enabled_capabilities) ? server.enabled_capabilities : [];
  if (!enabled.includes(DEV_SESSIONS_CAPABILITY)) return { ok: true };

  // The sessions plane exists on this host, but this deployment didn't wire
  // a listSessions dependency in for this caller (e.g. a route registered
  // outside the block that builds the dev-sessions invoke closure). Stay
  // permissive rather than refuse based on a capability we cannot check.
  if (typeof listSessions !== 'function') return { ok: true };

  let sessions;
  try {
    const out = await listSessions({ orgId, hostId });
    sessions = Array.isArray(out && out.sessions) ? out.sessions : [];
  } catch (err) {
    return { ok: true, unverified: true, reason: err && err.message ? err.message : String(err) };
  }

  const found = sessions.some((s) => s && (s.session_id === holderSession || s.name === holderSession));
  if (!found) {
    return {
      ok: false,
      code: 'session_not_found',
      message: `holder_session "${holderSession}" is not a live tmux session on ${hostId} `
        + `(checked dev.sessions list-sessions; ${sessions.length} session(s) found)`,
    };
  }
  return { ok: true };
}

module.exports = { checkResidentSessionGate, DEV_SESSIONS_CAPABILITY };
