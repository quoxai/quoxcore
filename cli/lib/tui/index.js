/**
 * QuoxCLI TUI Entry Point
 *
 * Creates the Ink app instance and renders the root App component.
 * Receives the CLI context object containing config, auth credentials,
 * and API client.
 *
 * Supports two modes:
 *   - Native TTY: uses fullscreen-ink for alternate screen buffer
 *   - PTY/Web terminal: falls back to basic Ink render (no raw mode needed)
 *
 * Registers a custom JSX loader hook via esbuild before importing .jsx files.
 */

import { register } from 'node:module';

// Register JSX support before importing any .jsx files
register('./jsx-loader.js', import.meta.url);

/**
 * Launch the QuoxCLI TUI.
 *
 * @param {Object} ctx - CLI context
 * @param {Object} ctx.config  - resolved configuration
 * @param {Object} ctx.auth    - auth credentials / token
 * @param {Object} ctx.client  - API client instance
 */
export async function launchTUI(ctx, opts = {}) {
  const React = (await import('react')).default;
  const { App } = await import('./app.jsx');
  const initialScreen = opts.initialScreen || null;

  // Check if raw mode is supported (it's not when spawned via node-pty in a container)
  const rawModeSupported = process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';

  if (rawModeSupported) {
    // Native terminal — use fullscreen (alternate screen buffer)
    try {
      const { withFullScreen } = await import('fullscreen-ink');
      const app = withFullScreen(
        React.createElement(App, { ctx, initialScreen }),
        { exitOnCtrlC: true }
      );
      await app.start();
      await app.waitUntilExit();
      return;
    } catch {
      // Fall through to basic mode if fullscreen fails
    }
  }

  // PTY / web terminal — use basic Ink render without raw mode requirement
  const { render } = await import('ink');
  const instance = render(React.createElement(App, { ctx, initialScreen }));
  await instance.waitUntilExit();
}
