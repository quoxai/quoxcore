/**
 * snapshotClient.js — API client for terminal snapshot share endpoints
 *
 * Communicates with the collector's /terminal/share endpoints.
 */

const BASE = '/collector/terminal';

/**
 * Create a snapshot from the current workspace.
 * @param {{ title: string, layout: string, panes: Array<{mode: string, hostId: string, sessionId: string|null}> }} workspace
 * @returns {Promise<{ shareId: string, expiresAt: string }>}
 */
export async function createSnapshot(workspace) {
  const resp = await fetch(`${BASE}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: workspace.title || workspace.name,
      layout: workspace.layout,
      panes: workspace.panes.map(p => ({
        mode: p.mode,
        hostId: p.hostId || '',
        sessionId: p.sessionId || null,
      })),
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ message: 'Request failed' }));
    throw new Error(err.message || `HTTP ${resp.status}`);
  }

  return resp.json();
}

/**
 * Fetch a snapshot by share ID (public, no auth).
 * @param {string} shareId
 * @returns {Promise<{ shareId: string, title: string, layout: string, panes: Array, createdAt: string, expiresAt: string }|null>}
 */
export async function getSnapshot(shareId) {
  const resp = await fetch(`${BASE}/share/${encodeURIComponent(shareId)}`);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/**
 * Delete a snapshot (owner only).
 * @param {string} shareId
 * @returns {Promise<boolean>}
 */
export async function deleteSnapshot(shareId) {
  const resp = await fetch(`${BASE}/share/${encodeURIComponent(shareId)}`, {
    method: 'DELETE',
  });
  return resp.ok;
}

/**
 * List user's snapshots.
 * @returns {Promise<Array>}
 */
export async function listSnapshots() {
  const resp = await fetch(`${BASE}/shares`);
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.snapshots || [];
}
