/**
 * terminalShare.js — Encode/decode workspace config for share URLs
 *
 * Serializes workspace layout + pane config into a URL-safe base64 string.
 * Used for sharing workspace setups via link — recipient gets the same
 * layout and host selections with fresh terminal connections.
 *
 * Format: compact JSON → base64 → URL query param (?ws=...)
 * Payload contains NO secrets — only layout, pane modes, and hostIds.
 */

import { TERMINAL_LIMITS } from '../config/terminalConfig';

// Whitelist of valid layout IDs
const VALID_LAYOUTS = [
  'single', 'split-h', 'split-v', 'main-side',
  'side-main', 'top-split', 'split-top', 'quad',
];

// Valid pane modes
const VALID_MODES = ['local', 'ssh'];

// HostId validation — matches server-side collector pattern
const HOST_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

/**
 * Encode a workspace object into a URL-safe base64 string.
 * @param {Object} workspace - { name, layout, panes: [{ mode, hostId }] }
 * @returns {string} base64-encoded config
 */
export function encodeWorkspaceShare(workspace) {
  const payload = {
    n: (workspace.name || 'Shared').slice(0, 50),
    l: workspace.layout || 'single',
    p: (workspace.panes || []).slice(0, TERMINAL_LIMITS.MAX_PANES).map(pane => {
      const p = { m: pane.mode || 'local' };
      if (pane.mode === 'ssh' && pane.hostId) p.h = pane.hostId;
      return p;
    }),
  };
  return btoa(JSON.stringify(payload));
}

/**
 * Decode a base64 share string back into workspace config.
 * Returns null if invalid, tampered, or fails validation.
 * @param {string} encoded - base64-encoded config string
 * @returns {{ name: string, layout: string, panes: Array<{mode: string, hostId: string}> } | null}
 */
export function decodeWorkspaceShare(encoded) {
  try {
    const json = atob(encoded);
    const data = JSON.parse(json);

    // Validate layout
    if (!data.l || !VALID_LAYOUTS.includes(data.l)) return null;

    // Validate panes
    if (!Array.isArray(data.p) || data.p.length === 0) return null;

    const panes = data.p.slice(0, TERMINAL_LIMITS.MAX_PANES).map(p => {
      const mode = VALID_MODES.includes(p.m) ? p.m : 'local';
      let hostId = '';
      if (mode === 'ssh' && p.h && typeof p.h === 'string') {
        hostId = HOST_ID_RE.test(p.h) ? p.h : '';
      }
      return { mode, hostId };
    });

    return {
      name: typeof data.n === 'string' ? data.n.slice(0, 50) : 'Shared',
      layout: data.l,
      panes,
    };
  } catch {
    return null;
  }
}

/**
 * Build a full share URL for the current workspace.
 * @param {Object} workspace - workspace object from useTerminalWorkspace
 * @returns {string} full URL with ?ws= param
 */
export function buildShareUrl(workspace) {
  const encoded = encodeWorkspaceShare(workspace);
  const url = new URL(window.location.href);
  url.pathname = '/terminal';
  // Clear all existing params, set only ws
  for (const key of [...url.searchParams.keys()]) {
    url.searchParams.delete(key);
  }
  url.searchParams.set('ws', encoded);
  return url.toString();
}
