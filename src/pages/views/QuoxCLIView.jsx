/**
 * QuoxCLIView — Web-based Quox CLI TUI
 *
 * Embeds an xterm.js terminal that connects to a WebSocket endpoint
 * which spawns `quox tui` in a PTY. Provides the full TUI experience
 * in the browser.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useAuth } from '../../contexts/AuthContext';

const TERM_THEME = {
    background: '#0a0e14',
    foreground: '#e4e4e7',
    cursor: '#3b82f6',
    cursorAccent: '#0a0e14',
    selectionBackground: '#1a1f29',
    selectionForeground: '#e6e1cf',
    black: '#01060e',
    red: '#ef4444',
    green: '#22c55e',
    yellow: '#fbbf24',
    blue: '#3b82f6',
    magenta: '#c084fc',
    cyan: '#38bdf8',
    white: '#e4e4e7',
    brightBlack: '#71717a',
    brightRed: '#ef4444',
    brightGreen: '#22c55e',
    brightYellow: '#fbbf24',
    brightBlue: '#3b82f6',
    brightMagenta: '#c084fc',
    brightCyan: '#38bdf8',
    brightWhite: '#ffffff',
};

function buildWsUrl(params = {}) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v) qs.set(k, v);
    }
    const q = qs.toString();
    return `${proto}//${host}/collector/terminal/quox-cli/ws${q ? `?${q}` : ''}`;
}

export default function QuoxCLIView() {
    const termRef = useRef(null);
    const terminalRef = useRef(null);
    const fitAddonRef = useRef(null);
    const wsRef = useRef(null);
    const { token } = useAuth();
    const [status, setStatus] = useState('connecting');
    const [error, setError] = useState(null);

    const connect = useCallback(() => {
        if (wsRef.current) {
            try { wsRef.current.close(); } catch {}
        }

        // Auth handled via cookies (access_token) — same as main terminal.
        // Optional ?screen=<view> deep-links the TUI straight to that view.
        const screen = new URLSearchParams(window.location.search).get('screen') || '';
        const wsUrl = buildWsUrl({ token, screen });
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        setStatus('connecting');
        setError(null);

        ws.onopen = () => {
            setStatus('connected');
            // Send terminal size
            if (terminalRef.current) {
                const { cols, rows } = terminalRef.current;
                ws.send(JSON.stringify({ type: 'resize', cols, rows }));
            }
        };

        ws.onmessage = (event) => {
            if (terminalRef.current && typeof event.data === 'string') {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'data') {
                        terminalRef.current.write(msg.data);
                    } else if (msg.type === 'error') {
                        setError(msg.message || msg.error);
                        setStatus('error');
                    }
                } catch {
                    // Raw data
                    terminalRef.current.write(event.data);
                }
            }
        };

        ws.onclose = (ev) => {
            if (status !== 'error') {
                setStatus('disconnected');
            }
        };

        ws.onerror = () => {
            setError('WebSocket connection failed');
            setStatus('error');
        };
    }, [token]);

    // Initialize terminal
    useEffect(() => {
        if (!termRef.current) return;

        const terminal = new Terminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: '"Fira Code", "JetBrains Mono", "Cascadia Code", monospace',
            theme: TERM_THEME,
            scrollback: 5000,
            allowProposedApi: true,
        });

        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.loadAddon(new WebLinksAddon());

        terminal.open(termRef.current);
        fitAddon.fit();

        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;

        // Handle terminal input → send to WebSocket
        terminal.onData((data) => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ type: 'data', data }));
            }
        });

        // Handle resize
        terminal.onResize(({ cols, rows }) => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
            }
        });

        // Window resize handler
        const handleResize = () => {
            try { fitAddon.fit(); } catch {}
        };
        window.addEventListener('resize', handleResize);

        // Connect
        connect();

        return () => {
            window.removeEventListener('resize', handleResize);
            if (wsRef.current) {
                try { wsRef.current.close(); } catch {}
            }
            terminal.dispose();
        };
    }, []);

    // Reconnect button handler
    const handleReconnect = () => {
        if (terminalRef.current) {
            terminalRef.current.clear();
        }
        connect();
    };

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            background: '#0a0e14',
        }}>
            {/* Header */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 16px',
                background: '#111827',
                borderBottom: '1px solid #1e293b',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="4 17 10 11 4 5" />
                        <line x1="12" y1="19" x2="20" y2="19" />
                    </svg>
                    <span style={{ color: '#e4e4e7', fontWeight: 'bold', fontSize: '14px' }}>Quox CLI</span>
                    <span style={{ color: '#71717a', fontSize: '12px' }}>Interactive Terminal Interface</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{
                        display: 'inline-block',
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        background: status === 'connected' ? '#22c55e' : status === 'connecting' ? '#fbbf24' : '#ef4444',
                    }} />
                    <span style={{ color: '#a1a1aa', fontSize: '12px' }}>
                        {status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting...' : 'Disconnected'}
                    </span>
                    {status === 'disconnected' && (
                        <button
                            onClick={handleReconnect}
                            style={{
                                background: '#1e293b',
                                color: '#3b82f6',
                                border: '1px solid #334155',
                                borderRadius: '4px',
                                padding: '4px 12px',
                                cursor: 'pointer',
                                fontSize: '12px',
                            }}
                        >
                            Reconnect
                        </button>
                    )}
                </div>
            </div>

            {/* Error banner */}
            {error && (
                <div style={{
                    padding: '8px 16px',
                    background: '#1a0000',
                    borderBottom: '1px solid #ef4444',
                    color: '#ef4444',
                    fontSize: '12px',
                }}>
                    {error}
                </div>
            )}

            {/* Terminal */}
            <div
                ref={termRef}
                style={{
                    flex: 1,
                    padding: '4px',
                    minHeight: 0,
                }}
            />
        </div>
    );
}
