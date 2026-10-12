/**
 * UndoToast — Fixed bottom-center toast for undo operations
 *
 * Shows a slide-up toast with "N items [action] — Undo" message.
 * Auto-dismisses after 8 seconds.
 */

import { useEffect, useRef } from 'react';

export default function UndoToast({ message, onUndo, onDismiss, duration = 8000 }) {
    const timerRef = useRef(null);
    const onDismissRef = useRef(onDismiss);

    // Keep dismiss ref current without retriggering the timer effect
    useEffect(() => { onDismissRef.current = onDismiss; }, [onDismiss]);

    // Auto-dismiss timer — resets when message changes (new toast)
    useEffect(() => {
        if (!message) return;
        timerRef.current = setTimeout(() => {
            onDismissRef.current?.();
        }, duration);

        return () => clearTimeout(timerRef.current);
    }, [message, duration]);

    if (!message) return null;

    return (
        <div className="inbox-undo-toast">
            <span className="inbox-undo-toast__message">{message}</span>
            {onUndo && (
                <button className="inbox-undo-toast__action" onClick={() => { clearTimeout(timerRef.current); onUndo(); }}>
                    Undo
                </button>
            )}
            <button className="inbox-undo-toast__close" onClick={() => { clearTimeout(timerRef.current); onDismissRef.current?.(); }} aria-label="Dismiss">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            </button>
        </div>
    );
}
