/**
 * useVimMode — Per-pane vim keybinding state and key handler
 *
 * Manages NORMAL/INSERT mode toggle for terminal panes.
 * In NORMAL mode, navigation keys scroll the terminal buffer.
 * In INSERT mode (default), all keys pass through to the shell.
 *
 * Supported NORMAL mode commands:
 *   j/k       — scroll one line down/up
 *   Ctrl+d/u  — scroll half page down/up
 *   G         — scroll to bottom (most recent output)
 *   gg        — scroll to top of scrollback
 *   i/a       — enter INSERT mode
 *   Escape    — no-op (already in NORMAL)
 *
 * INSERT mode:
 *   Escape    — enter NORMAL mode
 *   All other keys pass through to xterm/shell
 */

import { useState, useCallback, useRef } from 'react';
import { VIM_BINDINGS } from '../config/terminalConfig';

/**
 * @param {Object} options
 * @param {boolean} options.enabled - Whether vim mode is active for this workspace
 * @param {Object} options.scrollRef - Ref with { current: { scrollLines, scrollPages, scrollToTop, scrollToBottom } }
 * @returns {{ vimMode: string, vimKeyHandler: Function, resetMode: Function }}
 */
export default function useVimMode({ enabled, scrollRef }) {
  const [vimMode, setVimMode] = useState('insert');

  // gg state machine: track pending 'g' press
  const pendingGRef = useRef(false);
  const pendingGTimerRef = useRef(null);

  const vimKeyHandler = useCallback((event) => {
    if (!enabled) return true; // vim off — pass everything through

    // Only handle keydown events
    if (event.type !== 'keydown') return true;

    // ── INSERT mode ──────────────────────────────────────────────
    if (vimMode === 'insert') {
      if (event.key === 'Escape') {
        setVimMode('normal');
        return false; // consume
      }
      return true; // pass all other keys to shell
    }

    // ── NORMAL mode ──────────────────────────────────────────────

    // Ctrl combos in NORMAL mode: only handle Ctrl+d and Ctrl+u for scrolling.
    // All other Ctrl combos (Ctrl+1-4, Ctrl+\, etc.) return true so workspace
    // shortcuts still work (parent handler runs first, but if it passes through,
    // we might get Ctrl combos here too).
    if (event.ctrlKey || event.metaKey) {
      const scroll = scrollRef?.current;
      if (event.key === VIM_BINDINGS.SCROLL_HALF_PAGE_DOWN) {
        if (scroll?.scrollPages) scroll.scrollPages(0.5);
        return false;
      }
      if (event.key === VIM_BINDINGS.SCROLL_HALF_PAGE_UP) {
        if (scroll?.scrollPages) scroll.scrollPages(-0.5);
        return false;
      }
      // Let other Ctrl combos pass through to workspace handler
      return true;
    }

    const scroll = scrollRef?.current;

    switch (event.key) {
      // Enter INSERT mode
      case 'i':
      case 'a':
        setVimMode('insert');
        return false;

      // Line scroll
      case VIM_BINDINGS.SCROLL_LINE_DOWN:
        if (scroll?.scrollLines) scroll.scrollLines(1);
        return false;
      case VIM_BINDINGS.SCROLL_LINE_UP:
        if (scroll?.scrollLines) scroll.scrollLines(-1);
        return false;

      // Jump to bottom
      case VIM_BINDINGS.SCROLL_TO_BOTTOM:
        if (scroll?.scrollToBottom) scroll.scrollToBottom();
        return false;

      // gg — jump to top (two g presses within timeout)
      case VIM_BINDINGS.SCROLL_TO_TOP_TRIGGER:
        if (pendingGRef.current) {
          // Second g — scroll to top
          clearTimeout(pendingGTimerRef.current);
          pendingGRef.current = false;
          if (scroll?.scrollToTop) scroll.scrollToTop();
        } else {
          // First g — start timer
          pendingGRef.current = true;
          pendingGTimerRef.current = setTimeout(() => {
            pendingGRef.current = false;
          }, VIM_BINDINGS.GG_TIMEOUT_MS);
        }
        return false;

      case 'Escape':
        // Already in NORMAL — no-op but consume
        return false;

      default:
        // Consume all other keys in NORMAL mode to prevent shell input
        return false;
    }
  }, [enabled, vimMode, scrollRef]);

  // Reset to INSERT mode (e.g. on workspace switch)
  const resetMode = useCallback(() => {
    setVimMode('insert');
    pendingGRef.current = false;
    clearTimeout(pendingGTimerRef.current);
  }, []);

  return { vimMode, vimKeyHandler, resetMode };
}
