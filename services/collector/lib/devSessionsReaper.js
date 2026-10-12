'use strict';

/**
 * SLOTS-TMUX step D — idle-and-unheld tmux session reap (QuoxPlan note
 * #2876, task #26).
 *
 * The gap this closes: devSlotsStore.sweepStale frees the SLOT row and
 * never touches the host, so an abandoned session leaves tmux running
 * forever while its slot quietly returns to the pool. quoxagent has
 * KillSession but no idle logic of its own — deliberately: "held" is
 * collector knowledge (the dev_slots table), "idle" is host knowledge
 * (tmux's #{session_activity}), and only this side sees both.
 *
 * The rule, exactly: a session is reaped when NO held/stale slot points at
 * it AND its pane has had no activity for idleMs. Release must never
 * auto-kill — surviving detach is the entire point of tmux — so a held
 * slot always wins, however idle the pane. Unknown activity is never acted
 * on: a reap must not kill on a timestamp it cannot read.
 *
 * Sessions are matched to slots by holder_session against BOTH the tmux
 * session name and the agent session_id (spawn instructions bind slots by
 * session_id; humans may bind by name). A slot with a host_id protects
 * only sessions on that host; a slot with NO host_id protects everywhere
 * (conservative: an un-annotated holder must never cause a kill).
 */

// Log dedup for repeated identical host failures: a stale agent that 404s
// the sweep's list would otherwise emit the same line every 5-minute tick,
// forever (examplevpn-db01/02, live). The ERROR COUNT stays honest each tick;
// only the log line is suppressed while the message is unchanged, with an
// hourly reminder, and a CHANGED message logs immediately.
const LOG_REMIND_MS = 60 * 60 * 1000;
const lastHostFailureLog = new Map(); // hostId -> { message, at }

function shouldLogHostFailure(hostId, message, now) {
  const prev = lastHostFailureLog.get(hostId);
  if (prev && prev.message === message && now - prev.at < LOG_REMIND_MS) return false;
  lastHostFailureLog.set(hostId, { message, at: now });
  return true;
}

/** One sweep across every dev.sessions-enabled host. Injected deps only. */
async function reapIdleTmuxSessions({
  listDevServers,   // () => [{host_id, enabled_capabilities}]
  listHeldSlots,    // () => [{holder_session, host_id, state}] for held+stale rows
  listSessions,     // async ({hostId}) => agent list-sessions output (with .tmux)
  invoke,           // async ({hostId, method, input}) => agent output
  idleMs,
  now = Date.now(),
  emitEnvelope,     // (envelope) => void — evidence, best-effort
  log = () => {},
}) {
  const result = { reaped: 0, protectedHeld: 0, skippedUnknownActivity: 0, hostErrors: 0, hostsWithoutTruth: 0 };

  const holders = listHeldSlots() || [];
  const holderProtects = (hostId, sess) => holders.some((h) => {
    if (!h.holder_session) return false;
    if (h.host_id && h.host_id !== hostId) return false;
    return h.holder_session === sess.name || (sess.session_id && h.holder_session === sess.session_id);
  });

  for (const server of listDevServers() || []) {
    const enabled = Array.isArray(server.enabled_capabilities) ? server.enabled_capabilities : [];
    if (!enabled.includes('dev.sessions')) continue;
    const hostId = server.host_id;

    let listing;
    try {
      listing = await listSessions({ hostId });
    } catch (err) {
      result.hostErrors++;
      if (shouldLogHostFailure(hostId, err.message, now)) {
        log(`[DevSessionsReap] ${hostId}: list failed: ${err.message}`);
      }
      continue;
    }

    // Only tmux-SERVER truth is actionable: it is the view that still sees
    // sessions after an agent restart. An agent that does not report it
    // (old binary, transport without activity) is counted, never guessed at.
    const tmuxSessions = Array.isArray(listing && listing.tmux) ? listing.tmux : null;
    if (!tmuxSessions) {
      result.hostsWithoutTruth++;
      continue;
    }

    for (const sess of tmuxSessions) {
      if (!sess || !sess.name) continue;
      if (holderProtects(hostId, sess)) {
        result.protectedHeld++;
        continue;
      }
      const activityMs = Date.parse(sess.activity_at);
      if (!Number.isFinite(activityMs)) {
        result.skippedUnknownActivity++;
        continue;
      }
      const idleFor = now - activityMs;
      if (idleFor < idleMs) continue;

      try {
        await invoke({ hostId, method: 'kill-session', input: { name: sess.name } });
      } catch (err) {
        result.hostErrors++;
        log(`[DevSessionsReap] ${hostId}: kill ${sess.name} failed: ${err.message}`);
        continue;
      }
      result.reaped++;
      log(`[DevSessionsReap] ${hostId}: reaped ${sess.name} (idle ${Math.round(idleFor / 60000)}m, unheld)`);
      if (typeof emitEnvelope === 'function') {
        try {
          emitEnvelope({
            type: 'event',
            from: 'collector.dev-sessions-reaper',
            to: 'audit.dev_sessions',
            intent: 'quox.dev.sessions.reap',
            corr: `DEV_TMUX_REAP_${hostId}_${sess.name}`,
            payload: {
              host_id: hostId,
              name: sess.name,
              session_id: sess.session_id || null,
              idle_ms: idleFor,
              orphaned: !!sess.orphaned,
            },
          });
        } catch { /* evidence is best-effort here */ }
      }
    }
  }
  return result;
}

module.exports = { reapIdleTmuxSessions };
