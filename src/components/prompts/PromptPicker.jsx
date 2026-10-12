/**
 * PromptPicker — STUDY-REV-2 / P7.E.2
 *
 * Slash-menu popover for the chat composer.
 * Appears when the user types "/" at the start of the input.
 * Shows prompts with deploy_targets.includes('slash').
 * Type-ahead filter, arrow-key navigation, Enter/click to select.
 *
 * If the selected prompt has variables, opens a quick variable-fill dialog
 * before inserting the body into the composer.
 *
 * Props:
 *   query       — text typed after "/" (for type-ahead)
 *   prompts     — Array of prompt objects from /api/prompts (pre-filtered for slash)
 *   onSelect    — (body: string) => void — called with final body to insert
 *   onClose     — () => void — called when menu should close
 */

import { useState, useEffect, useRef } from 'react';

// ─── VariableFillDialog ───────────────────────────────────────────────────────

function VariableFillDialog({ prompt, onConfirm, onCancel }) {
    const variables = prompt.variables || [];
    const [values, setValues] = useState(() => {
        const init = {};
        variables.forEach(v => { init[v.name] = v.default || ''; });
        return init;
    });

    const handleConfirm = () => {
        let body = prompt.body || '';
        variables.forEach(v => {
            const val = values[v.name] || v.default || '';
            body = body.replaceAll(`{{${v.name}}}`, val);
        });
        onConfirm(body);
    };

    return (
        <div className="modal-overlay" onClick={onCancel}>
            <div
                className="modal-content"
                style={{ maxWidth: 420, padding: 24 }}
                onClick={e => e.stopPropagation()}
            >
                <div style={{ marginBottom: 16 }}>
                    <strong style={{ fontSize: 14 }}>Fill variables for: {prompt.name}</strong>
                </div>
                {variables.map(v => (
                    <div key={v.name} style={{ marginBottom: 12 }}>
                        <label style={{ fontSize: 12, display: 'block', marginBottom: 4, color: 'var(--text-secondary, #94a3b8)' }}>
                            {v.name}
                        </label>
                        <input
                            type="text"
                            className="qx-input"
                            value={values[v.name] || ''}
                            onChange={e => setValues(prev => ({ ...prev, [v.name]: e.target.value }))}
                            placeholder={v.default || ''}
                            style={{ width: '100%' }}
                            autoFocus
                        />
                    </div>
                ))}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                    <button className="qx-btn qx-btn--secondary" onClick={onCancel}>Cancel</button>
                    <button className="qx-btn qx-btn--primary" onClick={handleConfirm}>Insert</button>
                </div>
            </div>
        </div>
    );
}

// ─── PromptPicker ─────────────────────────────────────────────────────────────

function PromptPicker({ query, prompts, onSelect, onClose }) {
    const [activeIdx, setActiveIdx] = useState(0);
    const [varDialog, setVarDialog] = useState(null); // prompt object or null

    // Filter by query
    const filtered = prompts.filter(p => {
        if (!query) return true;
        const q = query.toLowerCase();
        return (
            p.name?.toLowerCase().includes(q) ||
            p.description?.toLowerCase().includes(q) ||
            (p.tags || []).some(t => t.toLowerCase().includes(q))
        );
    });

    // Reset active index when filter changes
    useEffect(() => { setActiveIdx(0); }, [query]);

    const listRef = useRef(null);

    // Keyboard navigation
    useEffect(() => {
        const handleKey = (e) => {
            if (e.key === 'Escape') { onClose(); return; }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIdx(i => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIdx(i => Math.max(i - 1, 0));
            } else if (e.key === 'Enter' && filtered.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                pick(filtered[activeIdx]);
            } else if (e.key === 'Tab') {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', handleKey, true);
        return () => window.removeEventListener('keydown', handleKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filtered, activeIdx, onClose]);

    const pick = (prompt) => {
        const vars = prompt.variables || [];
        const hasVars = vars.length > 0;
        if (hasVars) {
            setVarDialog(prompt);
        } else {
            onSelect(prompt.body || '');
        }
    };

    if (filtered.length === 0) return null;

    return (
        <>
            <div
                className="prompt-picker"
                role="listbox"
                aria-label="Prompt suggestions"
                ref={listRef}
            >
                <div className="prompt-picker__header">
                    Prompts — {filtered.length} match{filtered.length !== 1 ? 'es' : ''}
                </div>
                {filtered.slice(0, 8).map((p, idx) => (
                    <button
                        key={p.id}
                        role="option"
                        aria-selected={idx === activeIdx}
                        className={`prompt-picker__item ${idx === activeIdx ? 'active' : ''}`}
                        onClick={() => pick(p)}
                        onMouseEnter={() => setActiveIdx(idx)}
                    >
                        <span className="prompt-picker__name">{p.name}</span>
                        {p.description && (
                            <span className="prompt-picker__desc">{p.description}</span>
                        )}
                    </button>
                ))}
                {filtered.length > 8 && (
                    <div className="prompt-picker__more">+{filtered.length - 8} more — keep typing to filter</div>
                )}
            </div>

            {varDialog && (
                <VariableFillDialog
                    prompt={varDialog}
                    onConfirm={(body) => { setVarDialog(null); onSelect(body); }}
                    onCancel={() => setVarDialog(null)}
                />
            )}
        </>
    );
}

export default PromptPicker;
