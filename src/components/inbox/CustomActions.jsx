/**
 * CustomActions — N-way action buttons for HITL responses
 *
 * Replaces hardcoded approve/deny/dismiss buttons when custom_actions
 * is present in payload_json. Supports styles: primary, danger,
 * secondary, warning.
 *
 * `variant` picks the visual chrome for the call site so callers never
 * need to hand-roll their own button markup:
 *   - "default" (default) — standalone pill buttons (custom-actions__btn),
 *     always appends a Dismiss button as universal fallback.
 *   - "chip" — response dock option chips (response-dock__option), used
 *     inline with the free-text response box.
 *   - "btn" — response dock action-row buttons (response-dock__btn), used
 *     by the paused-workflow resume panel.
 *   - "quick" — top-of-page quick action bar (inbox-item-detail__quick-btn).
 * "chip"/"btn"/"quick" never auto-append Dismiss — the host view already
 * renders one elsewhere on the page for those layouts.
 */

import './response-form.css';

const Icons = {
    dismiss: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/>
        </svg>
    ),
};

// style -> response-dock__btn suffix (mirrors the pill-button chrome used by
// the generic approve/deny/resolve/override actions).
const BTN_STYLE_MAP = { primary: 'approve', danger: 'deny', warning: 'warning', secondary: 'resolve' };
// style -> inbox-item-detail__quick-btn suffix (only approve/deny/resolve/override exist there).
const QUICK_STYLE_MAP = { primary: 'approve', danger: 'deny', warning: 'resolve', secondary: 'resolve' };

function actionId(action) {
    if (action.action) return action.action;
    const label = action.label || 'Action';
    return label.toLowerCase().replace(/\s+/g, '_');
}

export default function CustomActions({ actions = [], onAction, disabled = false, loadingAction = null, loadingLabel = 'Processing…', variant = 'default' }) {
    if (!actions || actions.length === 0) return null;

    if (variant === 'chip') {
        return (
            <div className="response-dock__options">
                {actions.map((action, idx) => {
                    const id = actionId(action);
                    const label = action.label || id;
                    return (
                        <button
                            key={id + (action.value ?? '') + idx}
                            className={`response-dock__option response-dock__option--${action.style || 'secondary'}`}
                            onClick={() => onAction?.(id, action.value)}
                            disabled={disabled}
                            type="button"
                        >
                            {loadingAction === id ? loadingLabel : label}
                        </button>
                    );
                })}
            </div>
        );
    }

    if (variant === 'btn' || variant === 'quick') {
        const styleMap = variant === 'quick' ? QUICK_STYLE_MAP : BTN_STYLE_MAP;
        const prefix = variant === 'quick' ? 'inbox-item-detail__quick-btn' : 'response-dock__btn';
        return (
            <>
                {actions.map((action, idx) => {
                    const id = actionId(action);
                    const label = action.label || id;
                    const variantClass = styleMap[action.style] || 'resolve';
                    return (
                        <button
                            key={id + (action.value ?? '') + idx}
                            className={`${prefix} ${prefix}--${variantClass}`}
                            onClick={() => onAction?.(id, action.value)}
                            disabled={disabled}
                            type="button"
                        >
                            {loadingAction === id ? loadingLabel : label}
                        </button>
                    );
                })}
            </>
        );
    }

    // Check if dismiss already exists in custom actions
    const hasDismiss = actions.some(a => a.action === 'dismissed' || a.action === 'dismiss');

    return (
        <div className="custom-actions">
            {actions.map((action) => (
                <button
                    key={action.action}
                    className={`custom-actions__btn custom-actions__btn--${action.style || 'secondary'}`}
                    onClick={() => onAction?.(action.action, action.value)}
                    disabled={disabled}
                    type="button"
                >
                    {loadingAction === action.action ? loadingLabel : action.label}
                </button>
            ))}
            {!hasDismiss && (
                <>
                    <div className="custom-actions__divider" />
                    <button
                        className="custom-actions__btn custom-actions__btn--secondary"
                        onClick={() => onAction?.('dismissed')}
                        disabled={disabled}
                        type="button"
                    >
                        {Icons.dismiss}
                        Dismiss
                    </button>
                </>
            )}
        </div>
    );
}
