/**
 * Shared chrome for instance panels. Visual recipe matches
 * SettingsCard / SettingsSection (qx glass: var(--m-bg-base),
 * var(--m-border-default), var(--qx-radius)) so an instance panel
 * sits next to an account panel without a visible style break.
 *
 * Panels still drive their own forms — these are pure styling
 * primitives, not components with submit semantics.
 */

export const inputStyle = {
    width: '100%', maxWidth: 360, padding: '10px 12px',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid var(--m-border-default, rgba(255,255,255,0.18))',
    borderRadius: 8, color: 'inherit', fontSize: 14,
    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
};

export const fieldsetStyle = {
    position: 'relative', isolation: 'isolate',
    background: 'var(--m-bg-base, rgba(255,255,255,0.08))',
    border: '1px solid var(--m-border-default, rgba(255,255,255,0.18))',
    borderRadius: 'var(--qx-radius, 20px)',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.45)',
    padding: '16px 20px', marginBottom: 16,
};

export const legendStyle = {
    padding: '0 8px', fontSize: 14, fontWeight: 600,
    color: '#fff', letterSpacing: '-0.01em',
};

// Primary "Save changes" button — matches Button variant="primary"
// visually (cyan/purple gradient pill, white text).
export const saveButtonStyle = (saving) => ({
    background: 'linear-gradient(145deg, rgba(168, 85, 247, 0.32), rgba(56, 189, 248, 0.18))',
    color: '#fff',
    border: '1px solid rgba(168, 85, 247, 0.45)',
    borderRadius: 8,
    padding: '10px 22px',
    fontWeight: 600,
    fontSize: 13,
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 0 16px rgba(168, 85, 247, 0.18)',
    cursor: saving ? 'progress' : 'pointer',
    opacity: saving ? 0.7 : 1,
    transition: 'opacity 0.15s ease',
});

export function Field({ id, label, help, error, children }) {
    return (
        <div style={{ marginBottom: 16 }}>
            <label htmlFor={id} style={{
                display: 'block', marginBottom: 6,
                fontSize: 13, fontWeight: 500,
                color: 'rgba(255,255,255,0.85)',
            }}>
                {label}
            </label>
            {children}
            {help  && <p style={{ margin: '6px 0 0', opacity: 0.6, fontSize: 12 }}>{help}</p>}
            {error && <p style={{ margin: '6px 0 0', color: '#f87171', fontSize: 12 }} role="alert">{error}</p>}
        </div>
    );
}

export function SaveStatus({ savedAt, error }) {
    if (error)   return <p style={{ color: '#f87171', fontSize: 13, marginTop: 12 }} role="alert">{error}</p>;
    if (savedAt) return <p style={{ color: '#34d399', fontSize: 13, marginTop: 12 }} aria-live="polite">Saved at {savedAt.toLocaleTimeString()}.</p>;
    return null;
}
