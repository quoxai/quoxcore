import { useCallback, useMemo, useRef, useState } from 'react';
import { createStepUpClient } from '../services/stepUpClient.js';
import StepUpPinModal from '../components/inbox/StepUpPinModal.jsx';

/**
 * QUOXON-STEPUP: wrap authFetch so a 403 step_up_required opens the PIN card and retries with the token.
 * Returns { stepUpFetch, stepUpModal }; render {stepUpModal} once in the view.
 */
export function useStepUp(authFetch) {
    const [card, setCard] = useState(null);
    const resolveRef = useRef(null);
    const authRef = useRef(authFetch);
    authRef.current = authFetch;

    const askPin = useCallback((info) => new Promise((resolve) => {
        resolveRef.current = resolve;
        setCard({ ...info, phase: info.problem && info.problem !== 'wrong' ? info.problem : (info.problem === 'wrong' ? 'denied' : 'input'), key: Date.now() });
    }), []);
    const close = useCallback((pin) => {
        const r = resolveRef.current; resolveRef.current = null;
        if (pin == null) setCard(null); else setCard((c) => (c ? { ...c, phase: 'verifying' } : c));
        r?.(pin);
    }, []);
    const settle = useCallback(({ ok }) => {
        if (!ok) { setCard(null); return; }
        setCard((c) => (c ? { ...c, phase: 'ok' } : c));
        setTimeout(() => setCard(null), 900);
    }, []);

    const client = useMemo(() => createStepUpClient({ authFetch: (...a) => authRef.current(...a), askPin, settle }), [askPin, settle]);
    return { stepUpFetch: client, stepUpModal: card ? <StepUpPinModal card={card} onSubmit={close} onCancel={() => close(null)} /> : null };
}
