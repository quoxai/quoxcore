/**
 * QuoxCLI TUI — Root Application Component
 *
 * Manages the view state machine:
 *   intro -> menu -> specific view (fleet, agents, tools, etc.)
 *
 * Provides TuiContext to all descendants with navigation helpers,
 * the CLI context (config, auth, client), and the app exit function.
 *
 * ── Input-mode registry ────────────────────────────────────────────────
 * `inputMode` on the context tells the global keybinding handler whether
 * it's safe to steal single-character keys like `?` (help) and `q` (quit):
 *   'nav'     - default; global shortcuts are active
 *   'input'   - a text field (chat box, search box) has focus; global
 *               single-char shortcuts are suppressed so typing works
 *   'overlay' - the help overlay or command palette is open; it owns its
 *               own close handler and (for the palette) all keystrokes
 * Escape/back always works regardless of mode (text inputs intentionally
 * ignore Escape so navigation can still happen).
 *
 * ── Command palette + global jump keys ─────────────────────────────────
 * Ctrl+K or ':' (nav mode only) opens the palette (components/Palette.jsx)
 * over the current screen, content-swapped like the help overlay. It's a
 * fuzzy search over lib/tui/registry.js's SCREEN_REGISTRY. Separately,
 * whenever inputMode is 'nav' and a sub-view is active (screen !== 'menu'),
 * pressing a screen's hotkey (1-0 / o i v g h — same as MainMenu's number
 * keys) jumps straight there without returning to the menu first
 * (k9s-style). Both are gated on inputMode === 'nav' so they never steal
 * keystrokes from a focused chat/search box.
 *
 * ── Keep-alive views ───────────────────────────────────────────────────
 * A screen is mounted the first time it's visited and then stays mounted
 * (hidden via `display: none`) so its state — chat history, filters,
 * selections — survives navigating away and back. Views only fetch data
 * on their first activation (see each view's data hook), so this does
 * NOT boot-fetch all screens at startup.
 */

import React, { useState, useCallback, createContext, useContext } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { matchKey } from './keys.js';
import { colors } from './theme.js';
import { MainMenu } from './views/MainMenu.jsx';
import { FleetView } from './views/FleetView.jsx';
import { AgentView } from './views/AgentView.jsx';
import { ToolView } from './views/ToolView.jsx';
import { OrgView } from './views/OrgView.jsx';
import { MemoryView } from './views/MemoryView.jsx';
import { BrainView } from './views/BrainView.jsx';
import { WorkflowView } from './views/WorkflowView.jsx';
import { ChatView } from './views/ChatView.jsx';
import { AdminView } from './views/AdminView.jsx';
import { FilesView } from './views/FilesView.jsx';
import { BackupView } from './views/BackupView.jsx';
import { ObjectivesView } from './views/ObjectivesView.jsx';
import { InboxView } from './views/InboxView.jsx';
import { VaultView } from './views/VaultView.jsx';
import { GovernanceView } from './views/GovernanceView.jsx';
import { HealthView } from './views/HealthView.jsx';
import { StatusBar } from './components/StatusBar.jsx';
import { HelpOverlay } from './components/HelpOverlay.jsx';
import { Palette } from './components/Palette.jsx';
import { Toast } from './components/Toast.jsx';
import { SCREEN_BY_HOTKEY } from './registry.js';

// ── TUI Context ───────────────────────────────────────────────────────
export const TuiContext = createContext(null);

/**
 * Hook to access TUI context from any descendant component.
 * @returns {{ config, auth, client, navigate, goBack, screen, history, exit, inputMode, setInputMode, orgVersion, onOrgChange }}
 */
export const useTui = () => useContext(TuiContext);

// ── Screen registry ───────────────────────────────────────────────────
const SCREENS = [
  'menu',
  'fleet', 'agents', 'tools', 'orgs',
  'memory', 'brain', 'workflows', 'chat',
  'admin', 'files', 'backups',
  'objectives', 'inbox', 'vault', 'governance', 'health',
];

// Sub-views rendered (keep-alive) alongside the menu. Keyed by screen id.
const VIEW_COMPONENTS = {
  fleet: FleetView,
  agents: AgentView,
  tools: ToolView,
  orgs: OrgView,
  memory: MemoryView,
  brain: BrainView,
  workflows: WorkflowView,
  chat: ChatView,
  admin: AdminView,
  files: FilesView,
  backups: BackupView,
  objectives: ObjectivesView,
  inbox: InboxView,
  vault: VaultView,
  governance: GovernanceView,
  health: HealthView,
};

// ── Root component ────────────────────────────────────────────────────
export function App({ ctx, initialScreen = null }) {
  const { exit } = useApp();
  // Deep-link: `quox tui <screen>` (or the web QuoxCLIView ?screen= param) can
  // open directly on a view instead of the menu. Guard against unknown names.
  const startScreen =
    initialScreen && initialScreen !== 'menu' && SCREENS.includes(initialScreen)
      ? initialScreen
      : 'menu';
  const [screen, setScreen] = useState(startScreen);
  const [history, setHistory] = useState([]);
  const [showHelp, setShowHelp] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [toast, setToast] = useState(null);
  const [inputMode, setInputMode] = useState('nav');
  const [orgVersion, setOrgVersion] = useState(0);

  // Screens that have been visited at least once — kept mounted (hidden
  // via display:none when not current) so their state survives navigation.
  const [visited, setVisited] = useState(() =>
    startScreen === 'menu' ? new Set(['menu']) : new Set(['menu', startScreen])
  );

  // Navigation helpers
  const navigate = (target) => {
    if (!SCREENS.includes(target)) return;
    setHistory((prev) => [...prev, screen]);
    setVisited((prev) => (prev.has(target) ? prev : new Set(prev).add(target)));
    setScreen(target);
  };

  const goBack = () => {
    if (history.length > 0) {
      const prev = history[history.length - 1];
      setHistory((h) => h.slice(0, -1));
      setScreen(prev);
    }
  };

  // Toast helper
  const showToast = useCallback((message, type = 'info') => {
    setToast({ message, type });
  }, []);

  const dismissToast = useCallback(() => {
    setToast(null);
  }, []);

  // Called by OrgView after switching the active org — bumps a version
  // counter that org-scoped views include in their fetch deps so they
  // refetch automatically.
  const onOrgChange = useCallback(() => {
    setOrgVersion((v) => v + 1);
  }, []);

  const closeHelp = useCallback(() => {
    setShowHelp(false);
    setInputMode('nav');
  }, []);

  const closePalette = useCallback(() => {
    setShowPalette(false);
    setInputMode('nav');
  }, []);

  // Build context value
  const tuiCtx = {
    ...(ctx || {}),
    navigate,
    goBack,
    screen,
    history,
    exit,
    showToast,
    inputMode,
    setInputMode,
    orgVersion,
    onOrgChange,
  };

  // ── Global keybindings ──────────────────────────────────────────────
  useInput((input, key) => {
    // While the help overlay is open, it owns ? and Esc via its own listener.
    if (showHelp) return;

    // While the command palette is open, it owns all keystrokes (typing,
    // arrows, Enter, Esc) via its own useInput listener.
    if (showPalette) return;

    // Single-character global shortcuts (help, quit, palette) and the
    // global jump keys only fire in 'nav' mode — otherwise typing into a
    // chat/search box would be hijacked.
    if (inputMode === 'nav') {
      if (matchKey('help', input, key)) {
        setShowHelp(true);
        setInputMode('overlay');
        return;
      }

      // Command palette: Ctrl+K (can't be expressed via matchKey's plain
      // string comparison) or ':' (a normal KEYS binding).
      if ((key.ctrl && input === 'k') || matchKey('palette', input, key)) {
        setShowPalette(true);
        setInputMode('overlay');
        return;
      }

      if (screen === 'menu' && matchKey('quit', input, key)) {
        exit();
        return;
      }

      // Global jump keys (k9s-style): from any non-menu screen, a screen's
      // hotkey (1-0 / o i v g h — see SCREEN_BY_HOTKEY) jumps straight
      // there, mirroring MainMenu's own number-key shortcuts.
      if (screen !== 'menu') {
        const target = SCREEN_BY_HOTKEY[input];
        if (target) {
          navigate(target);
          return;
        }
      }
    }

    // Escape goes back from any sub-view — works regardless of input mode
    // (text inputs deliberately ignore Escape so this can still fire).
    if (screen !== 'menu' && matchKey('back', input, key)) {
      goBack();
    }
  });

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <TuiContext.Provider value={tuiCtx}>
      <Box flexDirection="column" width="100%" height="100%">
        {/* Toast notification */}
        {toast && (
          <Toast
            message={toast.message}
            type={toast.type}
            duration={3000}
            onDismiss={dismissToast}
          />
        )}

        {/* Main content area — the palette and help overlay swap in place
            of the screens (no layout shift) rather than pushing them down
            as a sibling. Palette takes priority if somehow both are open. */}
        <Box flexGrow={1}>
          {showPalette ? (
            <Palette
              onSelect={(id) => {
                navigate(id);
                closePalette();
              }}
              onClose={closePalette}
            />
          ) : showHelp ? (
            <HelpOverlay visible={showHelp} onClose={closeHelp} />
          ) : (
            <>
              <Box display={screen === 'menu' ? 'flex' : 'none'} width="100%" height="100%">
                <MainMenu />
              </Box>
              {Object.entries(VIEW_COMPONENTS).map(([name, ViewComponent]) => (
                visited.has(name) && (
                  <Box
                    key={name}
                    display={screen === name ? 'flex' : 'none'}
                    width="100%"
                    height="100%"
                  >
                    <ViewComponent />
                  </Box>
                )
              ))}
            </>
          )}
        </Box>

        {/* Status bar */}
        <StatusBar />
      </Box>
    </TuiContext.Provider>
  );
}
