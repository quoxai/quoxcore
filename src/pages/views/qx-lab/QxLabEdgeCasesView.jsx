/**
 * QX Lab — Edge Cases (compact)
 *
 * Table + wizard + modal/toast triggers in one screen.
 */

import { useState } from 'react';
import QHorn from '../../../components/ui/QHorn';

const I = {
  play:  <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
  close: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>,
  chev:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
};

function Modal({ open, onClose, title, children, footer }) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="qx-card"
        style={{ padding: 0, width: '100%', maxWidth: 480 }}
      >
        <div style={{ padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--m-border-default)', position: 'relative', zIndex: 2 }}>
          <QHorn size={14} />
          <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', flex: 1 }}>{title}</div>
          <button className="qx-row-action" onClick={onClose}>{I.close}</button>
        </div>
        <div style={{ padding: 20, position: 'relative', zIndex: 2 }}>{children}</div>
        {footer && (
          <div style={{ padding: '12px 20px', borderTop: '1px solid var(--m-border-default)', display: 'flex', justifyContent: 'flex-end', gap: 8, position: 'relative', zIndex: 2 }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

function Toast({ open, variant = 'info', message }) {
  if (!open) return null;
  return (
    <div
      className="qx-card"
      style={{
        position: 'fixed', bottom: 24, right: 24, zIndex: 3000,
        padding: '12px 16px', minWidth: 260,
        display: 'flex', alignItems: 'center', gap: 10,
      }}
    >
      <span className={`qx-dot qx-dot--${variant === 'success' ? 'online' : variant === 'error' ? 'offline' : 'info'}`} />
      <div style={{ fontSize: 12, color: '#fff', flex: 1, position: 'relative', zIndex: 2 }}>{message}</div>
    </div>
  );
}

const AUDIT_ROWS = Array.from({ length: 10 }, (_, i) => ({
  id: 100 + i,
  ts: `00:${String(55 - i).padStart(2, '0')}`,
  actor: ['adam', 'system', 'metrics', 'cipher', 'nova'][i % 5],
  action: ['auth.login', 'host.scan', 'workflow.run', 'key.rotate', 'memory.save'][i % 5],
  target: ['gw-01', 'hyp-02', 'edge-01', 'vault', 'memory'][i % 5],
  severity: ['info', 'low', 'medium', 'high', 'critical'][i % 5],
}));

export default function QxLabEdgeCasesView() {
  const [modalOpen, setModalOpen] = useState(false);
  const [toastOpen, setToastOpen] = useState(false);
  const [step, setStep] = useState(1);

  const fire = v => {
    setToastOpen({ variant: v, message: v === 'success' ? 'Playbook executed on 4 hosts.' : v === 'error' ? 'Connection failed.' : 'Heads up — 1 host degraded.' });
    setTimeout(() => setToastOpen(false), 3200);
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 12, alignItems: 'start' }}>
      {/* LEFT: Compact audit table */}
      <div className="qx-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--m-border-default)', position: 'relative', zIndex: 2 }}>
          <QHorn size={12} />
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#fff' }}>Audit log</span>
          <span className="qx-badge" style={{ marginLeft: 4 }}>{AUDIT_ROWS.length}</span>
          <span className="qx-pill qx-pill--info qx-pill--sm" style={{ marginLeft: 'auto' }}>
            <span className="qx-dot qx-dot--loading qx-dot--sm" /> live
          </span>
        </div>
        <table className="qx-table">
          <thead>
            <tr>
              <th style={{ width: 64 }}>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Severity</th>
            </tr>
          </thead>
          <tbody>
            {AUDIT_ROWS.map(r => (
              <tr key={r.id}>
                <td className="qx-mono">{r.ts}</td>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span className="qx-avatar qx-avatar--xs">{r.actor.slice(0, 2).toUpperCase()}</span>
                    {r.actor}
                  </span>
                </td>
                <td className="qx-mono" style={{ fontSize: 12 }}>{r.action}</td>
                <td><span className={`qx-severity qx-severity--${r.severity}`}>{r.severity}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* RIGHT: Stack of cells */}
      <div className="qx-stack" style={{ gap: 12 }}>
        {/* Wizard */}
        <div className="qx-card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <QHorn size={12} />
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#fff' }}>Wizard — step {step}/3</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
            {[1, 2, 3].map(n => (
              <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
                <div
                  className="qx-avatar qx-avatar--xs"
                  style={{
                    background: step >= n ? 'linear-gradient(145deg, rgba(168,85,247,0.4), rgba(56,189,248,0.25))' : 'rgba(255,255,255,0.06)',
                    borderColor: step >= n ? 'rgba(168,85,247,0.5)' : 'var(--m-border-default)',
                  }}
                >
                  {step > n ? I.check : n}
                </div>
                {n < 3 && <div style={{ flex: 1, height: 1, background: step > n ? 'rgba(168,85,247,0.5)' : 'var(--m-border-default)' }} />}
              </div>
            ))}
          </div>

          {step === 1 && (
            <div className="qx-field" style={{ marginBottom: 12 }}>
              <label className="qx-field__label">Target</label>
              <select className="qx-select" style={{ padding: '6px 10px', fontSize: 12 }}><option>All fleet</option><option>Production only</option></select>
            </div>
          )}
          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
              <label className="qx-checkbox" style={{ fontSize: 12 }}>
                <input type="checkbox" defaultChecked />
                <span className="qx-checkbox__box" />
                Dry-run first
              </label>
              <label className="qx-checkbox" style={{ fontSize: 12 }}>
                <input type="checkbox" />
                <span className="qx-checkbox__box" />
                Notify on complete
              </label>
            </div>
          )}
          {step === 3 && (
            <div style={{ marginBottom: 12 }}>
              <div className="qx-stat-row" style={{ padding: '6px 0' }}><span className="qx-stat-row__label">Target</span><span className="qx-stat-row__value">All fleet (8)</span></div>
              <div className="qx-stat-row" style={{ padding: '6px 0' }}><span className="qx-stat-row__label">Mode</span><span className="qx-stat-row__value">dry-run</span></div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button className="qx-btn qx-btn--sm qx-btn--ghost" disabled={step === 1} onClick={() => setStep(s => Math.max(1, s - 1))}>← Back</button>
            {step < 3 ? (
              <button className="qx-btn qx-btn--sm qx-btn--primary" onClick={() => setStep(s => s + 1)}>Next {I.chev}</button>
            ) : (
              <button className="qx-btn qx-btn--sm qx-btn--primary" onClick={() => { setStep(1); fire('success'); }}>{I.play} Run</button>
            )}
          </div>
        </div>

        {/* Modal + toast trigger strip */}
        <div className="qx-card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <QHorn size={12} />
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#fff' }}>Modals & toasts</span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className="qx-btn qx-btn--sm qx-btn--primary" onClick={() => setModalOpen(true)}>Open modal</button>
            <button className="qx-btn qx-btn--sm" onClick={() => fire('info')}>Info</button>
            <button className="qx-btn qx-btn--sm" onClick={() => fire('success')}>Success</button>
            <button className="qx-btn qx-btn--sm qx-btn--danger" onClick={() => fire('error')}>Error</button>
          </div>
        </div>
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Confirm destructive action"
        footer={<>
          <button className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => setModalOpen(false)}>Cancel</button>
          <button className="qx-btn qx-btn--sm qx-btn--danger" onClick={() => { setModalOpen(false); fire('error'); }}>Delete 3 hosts</button>
        </>}
      >
        <p style={{ fontSize: 13, color: '#fff', margin: 0 }}>
          This will deregister 3 hosts and revoke their agent tokens. VOLT evidence retained per policy.
        </p>
        <label className="qx-checkbox" style={{ marginTop: 14, fontSize: 12 }}>
          <input type="checkbox" />
          <span className="qx-checkbox__box" />
          I understand this is irreversible.
        </label>
      </Modal>

      <Toast open={!!toastOpen} variant={toastOpen.variant} message={toastOpen.message} />
    </div>
  );
}
