/**
 * Launcher for the LUCID deck TUI. Alt screen via fullscreen-ink when the
 * terminal supports raw mode; restores the terminal on every exit path.
 */
export async function launchDeck(api, { intervalMs = 10000, noIntro = false } = {}) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function' || !process.stdout.isTTY) {
    console.error('quox lucid deck needs an interactive terminal. Use `quox lucid --sitrep` for a one-shot snapshot.');
    process.exitCode = 1;
    return;
  }
  const { shouldIntro } = await import('./fmt.js');
  const intro = shouldIntro({ noIntro: noIntro || process.argv.includes('--no-intro'), isTTY: true });
  // A long-running TUI must use React's production build: the development build keeps debug
  // records per render and grew the heap steadily (measured flat at 14MB in production).
  if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
  await import('../tui/index.js'); // registers the .jsx loader hook
  const React = (await import('react')).default;
  const { LucidDeck } = await import('../tui/views/LucidDeck.jsx');
  const { withFullScreen } = await import('fullscreen-ink');
  const app = withFullScreen(React.createElement(LucidDeck, { api, intervalMs, intro }), { exitOnCtrlC: true });
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
