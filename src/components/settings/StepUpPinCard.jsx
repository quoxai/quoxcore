/**
 * StepUpPinCard (QUOXON-STEPUP): set, change or remove the approval step-up PIN.
 *
 * This is the ONLY place a PIN can be set. The server refuses set/change from CLI tokens, agent logins,
 * service keys and MCP tokens, and requires your password in the same request, so a terminal an agent is
 * driving cannot do it. The PIN is stored as a slow hash; it is never shown again.
 *
 *   GET    /api/auth/me/step-up-pin   status only
 *   PUT    /api/auth/me/step-up-pin   { pin, current_password }
 *   DELETE /api/auth/me/step-up-pin   { current_password }
 */
import { useCallback, useEffect, useState } from 'react';
import { csrfFetch } from '../../utils/csrfFetch';
import Button from '../ui/Button';
import SettingsSection from './SettingsSection';
import SettingsCard from './SettingsCard';

const cssVar = (name, fallback) => `var(${name}, ${fallback})`;
const fieldStyle = { padding: '8px 10px', borderRadius: 6, border: '1px solid rgba(148,163,184,0.4)', background: 'transparent', color: 'inherit', fontSize: 14, width: 220 };

export default function StepUpPinCard() {
    const [status, setStatus] = useState(null);
    const [pin, setPin] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch('/api/auth/me/step-up-pin', { credentials: 'include' });
            if (res.ok) setStatus(await res.json());
        } catch { /* leave status unknown; the form still works */ }
    }, []);
    useEffect(() => { load(); }, [load]);

    const send = async (method, body, okText) => {
        setBusy(true); setMsg(null);
        try {
            const res = await csrfFetch('/api/auth/me/step-up-pin', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) { setMsg({ kind: 'error', text: data.message || data.error || 'That did not work' }); return; }
            setPin(''); setPassword(''); setMsg({ kind: 'ok', text: okText }); load();
        } catch { setMsg({ kind: 'error', text: 'Network error, please try again' }); }
        finally { setBusy(false); }
    };

    const valid = /^\d{6}$/.test(pin) && password.length > 0;
    return (
        <SettingsSection title="Approval PIN"
            description="A 6-digit PIN a person types to approve what an agent raised, or to override a policy block. Set it here; it cannot be set from the terminal.">
            <SettingsCard glass>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ fontSize: 14 }}>
                        {status == null ? 'Checking...' : status.set ? `A PIN is set (since ${status.pin_set_at}).${status.locked_until ? ` Locked until ${status.locked_until} UTC after too many wrong tries.` : ''}` : 'No PIN set. Agent-raised approvals cannot be approved from a terminal until you set one.'}
                    </div>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                        New PIN (6 digits)
                        <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={pin}
                            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} style={fieldStyle} aria-label="New PIN" />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                        Your password (to confirm it is you)
                        <input type="password" autoComplete="current-password" value={password}
                            onChange={(e) => setPassword(e.target.value)} style={fieldStyle} aria-label="Current password" />
                    </label>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                        <Button variant="primary" disabled={busy || !valid}
                            onClick={() => send('PUT', { pin, current_password: password }, status?.set ? 'PIN changed. You have been emailed.' : 'PIN set. You have been emailed.')}>
                            {status?.set ? 'Change PIN' : 'Set PIN'}
                        </Button>
                        {status?.set && (
                            <Button variant="ghost" disabled={busy || !password}
                                onClick={() => send('DELETE', { current_password: password }, 'PIN removed.')}>Remove PIN</Button>
                        )}
                    </div>
                    {msg && (
                        <div role="status" aria-live="polite" style={{ fontSize: 13, color: msg.kind === 'error' ? cssVar('--ui-red-light', '#f87171') : cssVar('--ui-green', '#34d399') }}>{msg.text}</div>
                    )}
                </div>
            </SettingsCard>
        </SettingsSection>
    );
}
