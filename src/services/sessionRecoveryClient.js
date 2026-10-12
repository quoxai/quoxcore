/**
 * sessionRecoveryClient — Discovers detached terminal sessions via REST API
 *
 * Calls GET /collector/terminal/shell/my-sessions to find sessions that survived
 * navigation away from the terminal page. Sessions are kept alive server-side
 * for a 30-minute grace period with buffered scrollback.
 */

/**
 * Fetch the current user's recoverable (detached) terminal sessions.
 * @returns {Promise<Array<{sessionId: string, mode: string, hostId: string, detachedAt: number, gracePeriodRemainingMs: number}>>}
 */
export async function fetchRecoverableSessions() {
  try {
    const res = await fetch('/collector/terminal/shell/my-sessions');
    if (!res.ok) return [];
    const data = await res.json();
    return data.sessions || [];
  } catch {
    return [];
  }
}

/**
 * Match recoverable sessions to workspace panes by mode + hostId.
 * Returns an array of { session, workspaceId, paneId } matches.
 *
 * @param {Array} sessions - From fetchRecoverableSessions()
 * @param {Array} workspaces - From useTerminalWorkspace().workspaces
 * @returns {Array<{session: object, workspaceId: string, paneId: string}>}
 */
export function matchSessionsToPanes(sessions, workspaces) {
  const matches = [];
  const usedSessionIds = new Set();

  for (const ws of workspaces) {
    for (const pane of ws.panes) {
      // Find a detached session matching this pane's mode + hostId
      const match = sessions.find(s =>
        !usedSessionIds.has(s.sessionId) &&
        s.mode === pane.mode &&
        s.hostId === (pane.hostId || '')
      );
      if (match) {
        usedSessionIds.add(match.sessionId);
        matches.push({
          session: match,
          workspaceId: ws.id,
          paneId: pane.id,
        });
      }
    }
  }

  return matches;
}
