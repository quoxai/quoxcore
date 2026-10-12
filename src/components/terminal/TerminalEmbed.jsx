/**
 * TerminalEmbed — Reusable xterm.js terminal component
 *
 * Connects to a WebSocket PTY endpoint and renders an interactive terminal.
 * Supports session persistence: receives sessionId from backend, auto-reconnects
 * with exponential backoff on unexpected disconnect, replays buffered scrollback.
 *
 * Props:
 *   wsUrl        — WebSocket URL to connect to (required)
 *   sessionId    — Existing session ID for reconnection
 *   onConnect    — Callback when terminal connects
 *   onDisconnect — Callback when terminal disconnects
 *   onSessionId  — Callback when server assigns/confirms a session ID
 *   onData       — Callback for terminal output data (for AI capture later)
 *   className    — Additional CSS class
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './TerminalEmbed.css';
import { TERMINAL_LIMITS } from '../../config/terminalConfig';
import { buildObserverWsUrl } from '../../services/observerClient';

const MAX_RECONNECT_ATTEMPTS = 8;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

/** Build a reconnect URL by replacing mode/host params with session param */
function buildReconnectUrl(baseWsUrl, sessionId) {
  try {
    // WebSocket URLs need http(s) scheme for URL parsing
    const httpUrl = baseWsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const url = new URL(httpUrl);
    url.searchParams.delete('mode');
    url.searchParams.delete('host');
    url.searchParams.set('session', sessionId);
    // Convert back to ws(s) scheme
    return url.toString().replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  } catch (e) {
    return baseWsUrl;
  }
}

const TERM_THEME = {
  background: '#0a0e14',
  foreground: '#b3b1ad',
  cursor: '#22c55e',
  cursorAccent: '#0a0e14',
  selectionBackground: '#1a1f29',
  selectionForeground: '#e6e1cf',
  black: '#01060e',
  red: '#ea6c73',
  green: '#91b362',
  yellow: '#f9af4f',
  blue: '#53bdfa',
  magenta: '#fae994',
  cyan: '#90e1c6',
  white: '#c7c7c7',
  brightBlack: '#686868',
  brightRed: '#f07178',
  brightGreen: '#c2d94c',
  brightYellow: '#ffb454',
  brightBlue: '#59c2ff',
  brightMagenta: '#ffee99',
  brightCyan: '#95e6cb',
  brightWhite: '#ffffff'
};

export default function TerminalEmbed({
  wsUrl,
  sessionId: initialSessionId,
  onConnect,
  onDisconnect,
  onSessionId,
  onData,
  customKeyHandler,
  clearRef,
  reconnectRef,
  scrollRef,
  className = '',
  isObserver = false,
  observeSessionId = null,
  visible = true,
  initialCommand = null,
}) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const wsRef = useRef(null);
  const resizeObserverRef = useRef(null);
  const sessionIdRef = useRef(initialSessionId || null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const termDataListenerRef = useRef(null);
  const termResizeListenerRef = useRef(null);

  // Store callbacks in refs to avoid re-render loops
  const onConnectRef = useRef(onConnect);
  const onDisconnectRef = useRef(onDisconnect);
  const onSessionIdRef = useRef(onSessionId);
  const onDataRef = useRef(onData);
  const customKeyHandlerRef = useRef(customKeyHandler);
  const wsUrlRef = useRef(wsUrl);
  const [status, setStatus] = useState('disconnected');
  const [observerCount, setObserverCount] = useState(0);
  const [statusDetail, setStatusDetail] = useState(null);

  // Keep refs current
  onConnectRef.current = onConnect;
  onDisconnectRef.current = onDisconnect;
  onSessionIdRef.current = onSessionId;
  onDataRef.current = onData;
  customKeyHandlerRef.current = customKeyHandler;
  wsUrlRef.current = wsUrl;

  // Update sessionId ref when prop changes
  useEffect(() => {
    sessionIdRef.current = initialSessionId || null;
  }, [initialSessionId]);

  /** Close WebSocket only (keep terminal instance alive for reconnect) */
  const closeWs = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    // Detach terminal I/O listeners (will be re-wired on reconnect)
    if (termDataListenerRef.current) {
      termDataListenerRef.current.dispose();
      termDataListenerRef.current = null;
    }
    if (termResizeListenerRef.current) {
      termResizeListenerRef.current.dispose();
      termResizeListenerRef.current = null;
    }
  }, []);

  /** Full cleanup — terminal + WS + timers */
  const cleanup = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptRef.current = 0;
    closeWs();
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
      resizeObserverRef.current = null;
    }
    if (termRef.current) {
      termRef.current.dispose();
      termRef.current = null;
    }
    fitAddonRef.current = null;
  }, [closeWs]);

  /** Connect (or reconnect) WebSocket to existing terminal instance */
  const connectWebSocket = useCallback((isReconnect) => {
    const term = termRef.current;
    const currentWsUrl = wsUrlRef.current;
    if (!term || (!currentWsUrl && !isObserver)) return;

    closeWs();

    // Observer mode: connect to the observer endpoint
    let url;
    if (isObserver && observeSessionId) {
      url = buildObserverWsUrl(observeSessionId);
    } else if (isReconnect && sessionIdRef.current) {
      url = buildReconnectUrl(currentWsUrl, sessionIdRef.current);
    } else {
      url = currentWsUrl;
    }

    setStatus(isObserver ? 'observing' : (isReconnect ? 'reconnecting' : 'connecting'));
    setStatusDetail(null);

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus(isObserver ? 'observing' : 'connected');
      reconnectAttemptRef.current = 0;
      if (!isObserver) term.focus();
      // Send initial resize (not for observers — they're read-only)
      if (!isObserver) {
        const { cols, rows } = term;
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
      if (onConnectRef.current) onConnectRef.current();

      // CLI-4.0: Auto-send initial command after connection (e.g., "bastion tui")
      if (initialCommand && !isObserver) {
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'data', data: initialCommand + '\r' }));
        }, 300); // Brief delay for shell prompt to appear
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'connected':
            // New session — store the session ID
            if (msg.sessionId) {
              sessionIdRef.current = msg.sessionId;
              if (onSessionIdRef.current) onSessionIdRef.current(msg.sessionId);
            }
            break;
          case 'reconnected':
            // Session reattached — store sessionId + replay buffer
            if (msg.sessionId) {
              sessionIdRef.current = msg.sessionId;
              if (onSessionIdRef.current) onSessionIdRef.current(msg.sessionId);
            }
            if (msg.bufferedOutput) {
              term.write(msg.bufferedOutput);
            }
            break;
          case 'observer_init':
            // Observer connected — replay buffered output
            if (msg.bufferedOutput) {
              term.write(msg.bufferedOutput);
            }
            if (msg.isDetached) {
              term.write('\r\n\x1b[33m[Owner disconnected — session detached]\x1b[0m\r\n');
            }
            break;
          case 'owner_detached':
            term.write('\r\n\x1b[33m[Owner disconnected — waiting for reconnect...]\x1b[0m\r\n');
            break;
          case 'owner_reconnected':
            term.write('\r\n\x1b[32m[Owner reconnected]\x1b[0m\r\n');
            break;
          case 'observer_count':
            setObserverCount(msg.count || 0);
            break;
          case 'data':
            term.write(msg.data);
            if (onDataRef.current) onDataRef.current(msg.data);
            break;
          case 'exit':
            term.write('\r\n\x1b[33m[Session ended]\x1b[0m\r\n');
            sessionIdRef.current = null; // Session is gone
            setStatus('disconnected');
            break;
          case 'error':
            // Session errors (not found, mismatch) — clear sessionId and auto-fallback to fresh session
            if (!isObserver && (msg.error === 'session_not_found' || msg.error === 'session_owner_mismatch')) {
              sessionIdRef.current = null;
              if (onSessionIdRef.current) onSessionIdRef.current(null); // Clear stale sessionId in parent state
              // Auto-fallback: start a fresh connection instead of showing error
              term.write(`\r\n\x1b[36m[Session expired, starting fresh...]\x1b[0m\r\n`);
              setTimeout(() => connectWebSocket(false), 100);
              break;
            }
            term.write(`\r\n\x1b[31m[Error: ${msg.message}]\x1b[0m\r\n`);
            setStatusDetail({
              code: msg.error || msg.reason || 'terminal_error',
              message: msg.message || 'Terminal error',
              detail: msg.detail || null,
            });
            setStatus('error');
            break;
        }
      } catch (e) {
        // Raw data fallback
        term.write(event.data);
      }
    };

    ws.onclose = (event) => {
      // Normal close or session ended — don't auto-reconnect
      if (event.code === 1000) {
        setStatus('disconnected');
        setStatusDetail(null);
        if (onDisconnectRef.current) onDisconnectRef.current(event.code, event.reason);
        return;
      }

      // Application-level errors (auth, validation, limit) — don't auto-reconnect
      if (event.code >= 4001 && event.code <= 4009) {
        if (!statusDetail) {
          setStatusDetail({
            code: `ws_${event.code}`,
            message: event.reason || 'Terminal connection failed',
            detail: null,
          });
        }
        setStatus('error');
        if (onDisconnectRef.current) onDisconnectRef.current(event.code, event.reason);
        return;
      }

      // Observers don't auto-reconnect
      if (isObserver) {
        setStatus('disconnected');
        if (onDisconnectRef.current) onDisconnectRef.current(event.code, event.reason);
        return;
      }

      // Unexpected disconnect — try auto-reconnect if we have a session ID
      if (onDisconnectRef.current) onDisconnectRef.current(event.code, event.reason);

      if (sessionIdRef.current && reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS) {
        const attempt = reconnectAttemptRef.current;
        const delay = Math.min(
          RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500,
          RECONNECT_MAX_DELAY_MS
        );
        setStatus('reconnecting');
        try { term.write(`\r\n\x1b[36m[Reconnecting in ${Math.round(delay / 1000)}s...]\x1b[0m\r\n`); } catch (e) { /* */ }
        reconnectTimerRef.current = setTimeout(() => {
          reconnectAttemptRef.current++;
          connectWebSocket(true);
        }, delay);
      } else {
        setStatus('disconnected');
        setStatusDetail({
          code: 'connection_lost',
          message: 'Terminal connection lost.',
          detail: null,
        });
        try { term.write('\r\n\x1b[31m[Connection lost]\x1b[0m\r\n'); } catch (e) { /* */ }
      }
    };

    ws.onerror = () => {
      // Let onclose handle the reconnect logic
    };

    // Wire terminal I/O to WebSocket (observers are read-only — no input wiring)
    if (!isObserver) {
      termDataListenerRef.current = term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'data', data }));
        }
      });

      termResizeListenerRef.current = term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      });
    }
  }, [closeWs, isObserver, observeSessionId]);

  // Create terminal + initial connection — runs when wsUrl changes
  useEffect(() => {
    if (!containerRef.current || !wsUrl) return;

    cleanup();
    setStatus('connecting');

    // Create terminal instance
    // rightClickSelectsWord + macOptionClickForcesSelection let users select text
    // even when the running app (e.g. Claude CLI / Ink) has enabled mouse reporting,
    // which otherwise hijacks drag-to-select and blocks copy of the OAuth URL.
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: TERM_THEME,
      allowProposedApi: true,
      scrollback: TERMINAL_LIMITS.MAX_SCROLLBACK,
      rightClickSelectsWord: true,
      macOptionClickForcesSelection: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);

    // Attach custom key handler — uses ref so handler identity can change
    // without recreating the terminal. Return false to intercept, true to pass through.
    // Observers skip all custom key handling (read-only).
    term.attachCustomKeyEventHandler((event) => {
      if (isObserver) return true; // pass through, but input won't be sent (no onData wiring)
      if (customKeyHandlerRef.current) {
        return customKeyHandlerRef.current(event);
      }
      return true; // pass all keys to xterm by default
    });

    // Expose term.clear() via clearRef callback
    if (clearRef) {
      clearRef.current = () => { try { term.clear(); } catch (e) { /* */ } };
    }

    // Expose reconnect trigger via reconnectRef callback
    if (reconnectRef) {
      reconnectRef.current = () => {
        reconnectAttemptRef.current = 0;
        connectWebSocket(!!sessionIdRef.current);
      };
    }

    // Expose scroll APIs for vim mode navigation
    if (scrollRef) {
      scrollRef.current = {
        scrollLines: (n) => { try { term.scrollLines(n); } catch (e) { /* */ } },
        scrollPages: (n) => { try { term.scrollPages(n); } catch (e) { /* */ } },
        scrollToTop: () => { try { term.scrollToTop(); } catch (e) { /* */ } },
        scrollToBottom: () => { try { term.scrollToBottom(); } catch (e) { /* */ } },
      };
    }

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Initial fit after layout settles
    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch (e) { /* container may not be visible yet */ }
    });

    // ResizeObserver for auto-fitting (debounced, skip hidden containers)
    let resizeTimer = null;
    const observer = new ResizeObserver(() => {
      const el = containerRef.current;
      if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try {
          if (fitAddonRef.current) fitAddonRef.current.fit();
        } catch (e) { /* ignore */ }
      }, 100);
    });
    observer.observe(containerRef.current);
    resizeObserverRef.current = observer;

    // Determine if this is a reconnection (sessionId present in URL)
    const isReconnect = !!(initialSessionId || sessionIdRef.current);
    connectWebSocket(isReconnect);

    return cleanup;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl]);

  // Refit terminal when workspace becomes visible (tab switch)
  useEffect(() => {
    if (visible && fitAddonRef.current && termRef.current) {
      // Double-rAF ensures CSS layout has settled after display:none → visible
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try { fitAddonRef.current.fit(); } catch (e) { /* */ }
          if (!isObserver) {
            try { termRef.current.focus(); } catch (e) { /* */ }
          }
        });
      });
    }
  }, [visible, isObserver]);

  // Manual reconnect button handler
  const handleReconnect = useCallback(() => {
    reconnectAttemptRef.current = 0;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setStatusDetail(null);
    if (sessionIdRef.current) {
      connectWebSocket(true);
    } else {
      connectWebSocket(false);
    }
  }, [connectWebSocket]);

  return (
    <div className={`terminal-embed ${className}`}>
      <div className="terminal-embed__header">
        <div className="terminal-embed__status">
          <span className={`terminal-embed__dot terminal-embed__dot--${status}`} />
          <span className="terminal-embed__status-text">
            {status === 'observing' && 'Observing'}
            {status === 'connected' && 'Connected'}
            {status === 'connecting' && 'Connecting...'}
            {status === 'reconnecting' && 'Reconnecting...'}
            {status === 'disconnected' && 'Disconnected'}
            {status === 'error' && 'Connection Error'}
          </span>
          {isObserver && status === 'observing' && (
            <span className="terminal-embed__observer-badge">READ-ONLY</span>
          )}
          {!isObserver && observerCount > 0 && (
            <span className="terminal-embed__watcher-badge" title={`${observerCount} observer${observerCount !== 1 ? 's' : ''} watching`}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              {observerCount}
            </span>
          )}
        </div>
        <div className="terminal-embed__actions">
          {!isObserver && (status === 'disconnected' || status === 'error') && (
            <button
              className="terminal-embed__btn"
              onClick={handleReconnect}
              title="Reconnect"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              <span>Reconnect</span>
            </button>
          )}
        </div>
      </div>
      {statusDetail && (
        <div
          className="terminal-embed__status-detail"
          style={{
            padding: '8px 12px',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            background: 'rgba(127, 29, 29, 0.18)',
            color: 'rgba(255,255,255,0.82)',
            fontSize: '12px',
            lineHeight: 1.45,
          }}
        >
          <strong style={{ color: '#fca5a5' }}>{statusDetail.message}</strong>
          {statusDetail.detail && <div style={{ opacity: 0.78 }}>{statusDetail.detail}</div>}
        </div>
      )}
      <div className="terminal-embed__terminal" ref={containerRef} />
    </div>
  );
}

// Exports for testing
export { buildReconnectUrl, MAX_RECONNECT_ATTEMPTS, RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS };
