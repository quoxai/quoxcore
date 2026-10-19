/**
 * Launcher for the HYPERION deck TUI (`quox hyperion deck`). Same shape as lucid/deck.js: alt screen via
 * fullscreen-ink when the terminal supports raw mode; the terminal is restored on every exit path.
 */
export async function launchHyperionDeck(api, { intervalMs = 10000 } = {}) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function' || !process.stdout.isTTY) {
    console.error('quox hyperion deck needs an interactive terminal. Use `quox hyperion` for a one-shot view.');
    process.exitCode = 1;
    return;
  }
  // A long-running TUI must use React's production build (the development build grows the heap per render).
  if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
  await import('../tui/index.js'); // registers the .jsx loader hook
  const React = (await import('react')).default;
  const { HyperionDeck } = await import('../tui/views/HyperionDeck.jsx');
  const { withFullScreen } = await import('fullscreen-ink');
  const app = withFullScreen(React.createElement(HyperionDeck, { api, intervalMs }), { exitOnCtrlC: true });
  const restore = () => { try { process.stdout.write('\x1b[?1049l\x1b[?25h'); } catch { /* best effort */ } };
  process.once('SIGTERM', () => { restore(); process.exit(143); });
  process.once('SIGHUP', () => { restore(); process.exit(129); });
  process.once('exit', restore);
  process.once('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });
  try {
    await app.start();
    await app.waitUntilExit();
  } finally {
    restore();
  }
}
