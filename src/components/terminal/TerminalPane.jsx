/**
 * TerminalPane — Per-pane wrapper for multi-pane terminal workspace
 *
 * Renders a compact header with mode/host selectors and wraps TerminalEmbed.
 * Each pane manages its own WebSocket connection independently.
 */

import { useMemo, useCallback, useRef } from 'react';
import TerminalEmbed from './TerminalEmbed';
import ErrorNotificationBar from './ErrorNotificationBar';
import HostKnowledgeCard from './HostKnowledgeCard';
import { useTerminalErrorDetection } from '../../hooks/useTerminalErrorDetection';
import useVimMode from '../../hooks/useVimMode';
import { trackSessionStart, trackSessionEnd } from '../../services/terminalMemoryBridge';
import './TerminalPane.css';

/**
 * Build WebSocket URL for a shell session.
 * If sessionId is provided, builds a reconnection URL.
 */
function buildShellWsUrl(protocol, host, mode, hostId, sessionId) {
  const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
  if (sessionId) {
    return `${wsProto}//${host}/collector/terminal/shell/ws?session=${encodeURIComponent(sessionId)}`;
  }
  const params = new URLSearchParams({ mode });
  if (mode === 'ssh' && hostId) params.set('host', hostId);
  return `${wsProto}//${host}/collector/terminal/shell/ws?${params.toString()}`;
}

/**
 * Group hosts by their group field for select optgroups
 */
function groupHostsByGroup(hosts) {
  const groups = {};
  for (const h of hosts) {
    const group = h.group || 'ungrouped';
    if (!groups[group]) groups[group] = [];
    groups[group].push(h);
  }
  return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
}

export default function TerminalPane({
  paneId,
  mode,
  hostId,
  sessionId,
  hosts,
  hostsLoading,
  isFocused,
  showCloseBtn,
  terminalMode,
  vimEnabled,
  onModeChange,
  onHostChange,
  onConnect,
  onDisconnect,
  onSessionId,
  onFocus,
  onClose,
  onErrorAction,
  customKeyHandler,
  clearRef,
  reconnectRef,
  isObserver = false,
  observeSessionId = null,
  visible = true,
  initialCommand = null,
}) {
  const canConnect = mode === 'local' || !!(mode === 'ssh' && hostId);

  // Scroll ref for vim mode navigation (exposed by TerminalEmbed)
  const scrollRef = useRef({ current: null });

  // Vim keybindings — per-pane NORMAL/INSERT state (disabled for observers)
  const { vimMode, vimKeyHandler } = useVimMode({ enabled: vimEnabled && !isObserver, scrollRef });

  // Compose parent workspace shortcuts + vim key handler into single handler
  const composedKeyHandler = useCallback((event) => {
    // First: let workspace-level shortcuts run (Ctrl combos)
    if (customKeyHandler) {
      const result = customKeyHandler(event);
      if (result === false) return false; // consumed by workspace shortcut
    }
    // Second: vim mode handler
    if (vimEnabled) {
      return vimKeyHandler(event);
    }
    return true; // pass to xterm
  }, [customKeyHandler, vimEnabled, vimKeyHandler]);

  // Error detection hook — debounced polling after terminal output (disabled for observers)
  const { detectedError, dismissError, signalActivity } = useTerminalErrorDetection(
    isObserver ? null : sessionId, terminalMode, hostId
  );

  // wsUrl is for fresh connections only. Reconnection is handled inside TerminalEmbed
  // using the sessionId prop — do NOT include sessionId here or it causes an infinite
  // connect loop (sessionId change → wsUrl change → useEffect → new connection → repeat).
  const wsUrl = useMemo(() => {
    if (!canConnect) return null;
    return buildShellWsUrl(location.protocol, location.host, mode, hostId);
  }, [mode, hostId, canConnect]);

  const groupedHosts = useMemo(() => groupHostsByGroup(hosts || []), [hosts]);

  const handleModeChange = useCallback((e) => {
    onModeChange(paneId, e.target.value);
  }, [paneId, onModeChange]);

  const handleHostChange = useCallback((e) => {
    onHostChange(paneId, e.target.value);
  }, [paneId, onHostChange]);

  const handleConnect = useCallback(() => {
    onConnect(paneId);
  }, [paneId, onConnect]);

  const handleDisconnect = useCallback(() => {
    if (!isObserver && sessionId) trackSessionEnd(sessionId);
    onDisconnect(paneId);
  }, [paneId, onDisconnect, sessionId, isObserver]);

  const handleFocus = useCallback(() => {
    onFocus(paneId);
  }, [paneId, onFocus]);

  const handleSessionId = useCallback((newSessionId) => {
    if (onSessionId) onSessionId(paneId, newSessionId);
    if (!isObserver) trackSessionStart(hostId, newSessionId, mode);
  }, [paneId, onSessionId, hostId, mode, isObserver]);

  const handleClose = useCallback(() => {
    onClose(paneId);
  }, [paneId, onClose]);

  return (
    <div
      className={`terminal-pane ${isFocused ? 'terminal-pane--focused' : ''}`}
      onClick={handleFocus}
    >
      <div className="terminal-pane__header">
        <select
          className="terminal-pane__select"
          value={mode}
          onChange={handleModeChange}
          disabled={isObserver}
        >
          <option value="local">Local</option>
          <option value="ssh">SSH</option>
        </select>

        {mode === 'ssh' && (
          <select
            className="terminal-pane__select terminal-pane__select--host"
            value={hostId}
            onChange={handleHostChange}
            disabled={hostsLoading || isObserver}
          >
            <option value="">
              {hostsLoading ? 'Loading...' : 'Select host...'}
            </option>
            {groupedHosts.map(([group, groupHosts]) => (
              <optgroup key={group} label={group}>
                {groupHosts.map(h => (
                  <option key={h.id} value={h.id}>
                    {h.id} ({h.ip})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}

        <div className="terminal-pane__spacer" />

        {vimEnabled && (
          <span
            className={`terminal-pane__vim-badge terminal-pane__vim-badge--${vimMode}`}
            title={vimMode === 'normal'
              ? 'Vim NORMAL mode — press i to type'
              : 'Vim INSERT mode — press Esc for navigation'}
          >
            {vimMode === 'normal' ? 'NORMAL' : 'INSERT'}
          </span>
        )}

        {showCloseBtn && (
          <button
            className="terminal-pane__close"
            onClick={handleClose}
            title="Close pane"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      <HostKnowledgeCard hostId={hostId} sessionId={sessionId} />

      <div className="terminal-pane__body">
        {isObserver && observeSessionId ? (
          <TerminalEmbed
            key={`observer-${paneId}`}
            wsUrl={null}
            isObserver={true}
            observeSessionId={observeSessionId}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onSessionId={handleSessionId}
            clearRef={clearRef}
            scrollRef={scrollRef}
            visible={visible}
          />
        ) : canConnect && wsUrl ? (
          <TerminalEmbed
            key={paneId}
            wsUrl={wsUrl}
            sessionId={sessionId}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onSessionId={handleSessionId}
            onData={signalActivity}
            customKeyHandler={composedKeyHandler}
            clearRef={clearRef}
            reconnectRef={reconnectRef}
            scrollRef={scrollRef}
            visible={visible}
            initialCommand={initialCommand}
          />
        ) : (
          <div className="terminal-pane__placeholder">
            <p>Select a host to connect</p>
          </div>
        )}
      </div>
      {!isObserver && (
        <ErrorNotificationBar
          error={detectedError}
          onAction={(action, error) => onErrorAction?.(action, error)}
          onDismiss={dismissError}
          mode={terminalMode}
        />
      )}
    </div>
  );
}

// Exports for testing
export { buildShellWsUrl, groupHostsByGroup };
