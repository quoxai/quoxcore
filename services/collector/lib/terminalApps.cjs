// terminalApps.cjs — DEVSUITE-DEVMODE 5c
//
// The ONLY commands /terminal/ws will ever spawn, keyed by the ?app= query
// value. A strict allowlist: the client picks a key, never a command — an
// unknown key is a rejection, not a fallback, so a typo can't silently land
// in a claude session and a crafted value can't reach spawn.
//
// claude: interactive CLI; a bootstrap types /login (claudeTerminalBootstrap).
// codex:  `codex login --device-auth` (verified codex-cli 0.118.0) prints a
//         URL + one-time code — no localhost callback, works headless.

const TERMINAL_APPS = {
  claude: { cmd: 'claude', args: [] },
  codex: { cmd: 'codex', args: ['login', '--device-auth'] },
};

/**
 * Resolve the requested terminal app from a websocket upgrade request URL.
 * Returns { app, spec } when allowed, { app, spec: null } when unknown.
 * No ?app= means claude (the pre-existing behavior).
 */
function resolveTerminalApp(reqUrl) {
  let app = 'claude';
  try {
    const param = new URL(reqUrl || '', 'http://localhost').searchParams.get('app');
    if (param) app = param;
  } catch { /* keep default */ }
  return { app, spec: TERMINAL_APPS[app] || null };
}

module.exports = { TERMINAL_APPS, resolveTerminalApp };
