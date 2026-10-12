/**
 * GlassEscalationCard — QCX-5d
 *
 * Handoff-to-human card. status: requested | queued | connected | failed.
 * Visible cancel CTA while pending; operator name shown on connected.
 */

import './glass-chat.css';

const STATUS = {
  requested: { label: 'Requesting a human…', mod: 'requested' },
  queued:    { label: 'In queue — an agent will be with you shortly.', mod: 'queued' },
  connected: { label: 'Connected', mod: 'connected' },
  failed:    { label: "Couldn't connect — please try again.", mod: 'failed' },
};

export function GlassEscalationCard({ status = 'requested', operatorName, onCancel, etaSeconds }) {
  const s = STATUS[status] || STATUS.requested;
  const pending = status === 'requested' || status === 'queued';
  return (
    <div className={`gec gec--${s.mod}`} role="status" aria-live="polite">
      <div className="gec__head">
        <span className="gec__dot" />
        <span className="gec__label">{s.label}</span>
      </div>
      {status === 'connected' && operatorName && (
        <div className="gec__operator">You're now chatting with {operatorName}.</div>
      )}
      {pending && typeof etaSeconds === 'number' && etaSeconds > 0 && (
        <div className="gec__eta">~{etaSeconds}s</div>
      )}
      {pending && typeof onCancel === 'function' && (
        <button type="button" className="gec__cancel" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}
