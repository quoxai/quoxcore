/**
 * Inbox Components — shared UI for inbox item detail views
 *
 * PayloadRenderer: renders structured payload key-value data
 * PayloadSections: collapsible sections within a payload
 * AttachmentList: displays file/link attachments
 * ResponseForm: dynamic form from response_schema
 * CustomActions: renders custom action buttons
 */

import { useState } from 'react';

/**
 * Render a payload object as a list of key-value pairs.
 * Skips internal keys (custom_actions, response_schema, sections, attachments).
 */
export function PayloadRenderer({ payload }) {
    if (!payload || typeof payload !== 'object') return null;

    const skip = new Set(['custom_actions', 'response_schema', 'sections', 'attachments']);
    const entries = Object.entries(payload).filter(([k]) => !skip.has(k));

    if (entries.length === 0) return null;

    return (
        <div className="inbox-payload">
            {entries.map(([key, value]) => (
                <div key={key} className="inbox-payload__row">
                    <span className="inbox-payload__key">{key.replace(/_/g, ' ')}</span>
                    <span className="inbox-payload__value">
                        {typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}
                    </span>
                </div>
            ))}
        </div>
    );
}

/**
 * Render collapsible sections within a payload.
 */
export function PayloadSections({ sections }) {
    const [expanded, setExpanded] = useState({});

    if (!Array.isArray(sections) || sections.length === 0) return null;

    return (
        <div className="inbox-payload-sections">
            {sections.map((section, i) => {
                const isOpen = expanded[i] !== false; // default open
                return (
                    <div key={i} className="inbox-payload-section">
                        <button
                            className="inbox-payload-section__header"
                            onClick={() => setExpanded(prev => ({ ...prev, [i]: !isOpen }))}
                        >
                            <span>{section.title || `Section ${i + 1}`}</span>
                            <span style={{ opacity: 0.5 }}>{isOpen ? '▼' : '▶'}</span>
                        </button>
                        {isOpen && (
                            <div className="inbox-payload-section__content">
                                {section.content || (section.data && <PayloadRenderer payload={section.data} />)}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

/**
 * Render a list of attachments.
 */
export function AttachmentList({ attachments }) {
    if (!Array.isArray(attachments) || attachments.length === 0) return null;

    return (
        <div className="inbox-attachments">
            <h4 style={{ margin: '0 0 8px', fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)' }}>
                Attachments ({attachments.length})
            </h4>
            {attachments.map((att, i) => (
                <div key={i} className="inbox-attachment">
                    <span className="inbox-attachment__name">{att.name || att.filename || `Attachment ${i + 1}`}</span>
                    {att.url && (
                        <a href={att.url} target="_blank" rel="noopener noreferrer" className="inbox-attachment__link">
                            View
                        </a>
                    )}
                    {att.size && (
                        <span className="inbox-attachment__size">
                            {att.size > 1048576 ? `${(att.size / 1048576).toFixed(1)}MB` : `${Math.round(att.size / 1024)}KB`}
                        </span>
                    )}
                </div>
            ))}
        </div>
    );
}

/**
 * Render a dynamic form from a response_schema.
 */
export function ResponseForm({ schema, onSubmit, disabled }) {
    const [formData, setFormData] = useState({});

    if (!schema || !Array.isArray(schema.fields)) return null;

    const handleSubmit = (e) => {
        e.preventDefault();
        onSubmit?.(formData);
    };

    return (
        <form className="inbox-response-form" onSubmit={handleSubmit}>
            {schema.title && <h4 className="inbox-response-form__title">{schema.title}</h4>}
            {schema.fields.map((field) => (
                <div key={field.name} className="inbox-response-form__field">
                    <label>{field.label || field.name}</label>
                    {field.type === 'textarea' ? (
                        <textarea
                            value={formData[field.name] || ''}
                            onChange={e => setFormData(prev => ({ ...prev, [field.name]: e.target.value }))}
                            disabled={disabled}
                            required={field.required}
                            placeholder={field.placeholder}
                        />
                    ) : field.type === 'select' ? (
                        <select
                            value={formData[field.name] || ''}
                            onChange={e => setFormData(prev => ({ ...prev, [field.name]: e.target.value }))}
                            disabled={disabled}
                            required={field.required}
                        >
                            <option value="">Select...</option>
                            {(field.options || []).map(opt => (
                                <option key={opt.value || opt} value={opt.value || opt}>
                                    {opt.label || opt}
                                </option>
                            ))}
                        </select>
                    ) : (
                        <input
                            type={field.type || 'text'}
                            value={formData[field.name] || ''}
                            onChange={e => setFormData(prev => ({ ...prev, [field.name]: e.target.value }))}
                            disabled={disabled}
                            required={field.required}
                            placeholder={field.placeholder}
                        />
                    )}
                </div>
            ))}
            <button type="submit" disabled={disabled} className="inbox-response-form__submit">
                {schema.submitLabel || 'Submit'}
            </button>
        </form>
    );
}

/**
 * Render custom action buttons.
 */
export function CustomActions({ actions, onAction, disabled }) {
    if (!Array.isArray(actions) || actions.length === 0) return null;

    return (
        <div className="inbox-custom-actions">
            {actions.map((action) => (
                <button
                    key={action.action}
                    className={`inbox-custom-action inbox-custom-action--${action.style || 'secondary'}`}
                    onClick={() => onAction?.(action.action, action.value)}
                    disabled={disabled}
                >
                    {action.label}
                </button>
            ))}
        </div>
    );
}
