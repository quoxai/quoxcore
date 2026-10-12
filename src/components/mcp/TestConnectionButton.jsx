/**
 * TestConnectionButton — shared component for testing MCP collector connectivity.
 * Extracted from ClaudeDesktopInstall.jsx (MCPB-HARDEN Phase 3F).
 *
 * Props:
 *   collectorUrl {string} — base URL of the collector (default '/collector')
 */

import { useState, useCallback } from 'react';

const DEFAULT_AGENT_ID = 'quox';

// ── ZapIcon ────────────────────────────────────────────────────────────────
const ZapIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        style={{ stroke: 'currentColor', flexShrink: 0 }}>
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
);

// ── TestConnectionButton ───────────────────────────────────────────────────
export default function TestConnectionButton({ collectorUrl = '/collector' }) {
    const [status, setStatus]     = useState(null); // null | { ok, message }
    const [busy, setBusy]         = useState(false);
    const [cooldown, setCooldown] = useState(false);

    const handleTest = useCallback(async () => {
        if (busy || cooldown) return;
        setBusy(true);
        setStatus(null);

        try {
            const res = await fetch(
                `${collectorUrl}/api/v1/tools/list?agent_id=${DEFAULT_AGENT_ID}`,
                {
                    headers: { 'X-Service-Key': '' },
                    signal: AbortSignal.timeout(10000),
                }
            );
            if (res.ok) {
                const data = await res.json();
                const n = Array.isArray(data.tools) ? data.tools.length : 0;
                setStatus({ ok: true, message: `Connected — ${n} tool${n !== 1 ? 's' : ''} available` });
            } else {
                let detail = '';
                try {
                    const body = await res.json();
                    detail = body.message || body.error || '';
                } catch { /* ignore */ }
                const msg = detail ? `${detail}` : `HTTP ${res.status}`;
                setStatus({ ok: false, message: `Connection failed — ${msg}` });
            }
        } catch (err) {
            const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
            const label = isTimeout
                ? 'Request timed out'
                : `Could not reach collector at ${collectorUrl}`;
            setStatus({ ok: false, message: label });
        } finally {
            setBusy(false);
            setCooldown(true);
            // Auto-clear result after 5 seconds
            setTimeout(() => {
                setCooldown(false);
                setStatus(null);
            }, 5000);
        }
    }, [collectorUrl, busy, cooldown]);

    return (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button
                type="button"
                onClick={handleTest}
                disabled={busy || cooldown}
                className="qx-btn qx-btn--ghost qx-btn--sm"
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                }}
            >
                <ZapIcon />
                {busy ? 'Testing…' : 'Test Connection'}
            </button>

            {status && (
                <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    fontSize: 12,
                    color: status.ok ? 'rgba(52,211,153,0.95)' : 'rgba(248,113,113,0.95)',
                    fontWeight: 500,
                }}>
                    <span style={{ fontWeight: 700 }}>{status.ok ? '✓' : '✗'}</span>
                    {status.message}
                </span>
            )}
        </div>
    );
}
