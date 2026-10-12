/**
 * ResponseForm — Schema-driven form for structured HITL responses
 *
 * Renders form fields from a response_schema definition in payload_json.
 * Supports: text, textarea, select, checkbox, radio, number, date
 *
 * The form data is sent as the `data` field in the respond API call.
 */

import { useReducer, useCallback } from 'react';
import './response-form.css';

// ─── Field Types ────────────────────────────────────────────────────

function TextField({ field, value, onChange, error }) {
    return (
        <input
            type="text"
            className={`response-form__input${error ? ' response-form__input--error' : ''}`}
            value={value || ''}
            onChange={(e) => onChange(field.name, e.target.value)}
            placeholder={field.placeholder || ''}
        />
    );
}

function TextareaField({ field, value, onChange, error }) {
    return (
        <textarea
            className={`response-form__textarea${error ? ' response-form__textarea--error' : ''}`}
            value={value || ''}
            onChange={(e) => onChange(field.name, e.target.value)}
            placeholder={field.placeholder || ''}
            rows={3}
        />
    );
}

function SelectField({ field, value, onChange, error }) {
    return (
        <select
            className={`response-form__select${error ? ' response-form__select--error' : ''}`}
            value={value || ''}
            onChange={(e) => onChange(field.name, e.target.value)}
        >
            <option value="">Select...</option>
            {(field.options || []).map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
            ))}
        </select>
    );
}

function CheckboxField({ field, value, onChange }) {
    return (
        <label className="response-form__checkbox-label">
            <input
                type="checkbox"
                className="response-form__checkbox"
                checked={!!value}
                onChange={(e) => onChange(field.name, e.target.checked)}
            />
            <span className="response-form__checkbox-text">{field.label}</span>
        </label>
    );
}

function RadioField({ field, value, onChange, error }) {
    return (
        <div className={`response-form__radio-group${error ? ' response-form__radio-group--error' : ''}`}>
            {(field.options || []).map((opt) => (
                <label key={opt} className="response-form__radio-label">
                    <input
                        type="radio"
                        className="response-form__radio"
                        name={field.name}
                        value={opt}
                        checked={value === opt}
                        onChange={(e) => onChange(field.name, e.target.value)}
                    />
                    <span className="response-form__radio-text">{opt}</span>
                </label>
            ))}
        </div>
    );
}

function NumberField({ field, value, onChange, error }) {
    return (
        <input
            type="number"
            className={`response-form__input response-form__input--number${error ? ' response-form__input--error' : ''}`}
            value={value ?? ''}
            onChange={(e) => onChange(field.name, e.target.value === '' ? '' : Number(e.target.value))}
            min={field.min}
            max={field.max}
            step={field.step || 1}
            placeholder={field.placeholder || ''}
        />
    );
}

function DateField({ field, value, onChange, error }) {
    return (
        <input
            type="date"
            className={`response-form__input response-form__input--date${error ? ' response-form__input--error' : ''}`}
            value={value || ''}
            onChange={(e) => onChange(field.name, e.target.value)}
        />
    );
}

const FIELD_COMPONENTS = {
    text: TextField,
    textarea: TextareaField,
    select: SelectField,
    checkbox: CheckboxField,
    radio: RadioField,
    number: NumberField,
    date: DateField,
};

// ─── Validation ─────────────────────────────────────────────────────

export function validateFormData(fields, data) {
    const errors = {};
    for (const field of fields) {
        const val = data[field.name];
        if (field.required) {
            if (val === undefined || val === null || val === '' || val === false) {
                errors[field.name] = `${field.label || field.name} is required`;
                continue;
            }
        }
        if (val !== undefined && val !== null && val !== '') {
            if (field.type === 'number') {
                if (typeof val !== 'number' || isNaN(val)) {
                    errors[field.name] = `${field.label || field.name} must be a number`;
                } else {
                    if (field.min !== undefined && val < field.min) {
                        errors[field.name] = `Minimum value is ${field.min}`;
                    }
                    if (field.max !== undefined && val > field.max) {
                        errors[field.name] = `Maximum value is ${field.max}`;
                    }
                }
            }
            if ((field.type === 'select' || field.type === 'radio') && field.options) {
                if (!field.options.includes(val)) {
                    errors[field.name] = `Invalid selection`;
                }
            }
        }
    }
    return errors;
}

// ─── Form Reducer ───────────────────────────────────────────────────

function formReducer(state, action) {
    switch (action.type) {
        case 'SET_FIELD':
            return {
                ...state,
                values: { ...state.values, [action.name]: action.value },
                errors: { ...state.errors, [action.name]: undefined },
            };
        case 'SET_ERRORS':
            return { ...state, errors: action.errors };
        case 'RESET':
            return { values: {}, errors: {} };
        default:
            return state;
    }
}

// ─── Main Component ─────────────────────────────────────────────────

export default function ResponseForm({ schema, onSubmit, disabled = false }) {
    const fields = schema?.fields || [];
    const [state, dispatch] = useReducer(formReducer, { values: {}, errors: {} });

    const handleChange = useCallback((name, value) => {
        dispatch({ type: 'SET_FIELD', name, value });
    }, []);

    const handleSubmit = useCallback((e) => {
        e.preventDefault();
        const errors = validateFormData(fields, state.values);
        if (Object.keys(errors).length > 0) {
            dispatch({ type: 'SET_ERRORS', errors });
            return;
        }
        onSubmit?.(state.values);
    }, [fields, state.values, onSubmit]);

    if (!fields.length) return null;

    return (
        <form className="response-form" onSubmit={handleSubmit}>
            <div className="response-form__title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                </svg>
                Response Details
            </div>
            {fields.map((field) => {
                const FieldComponent = FIELD_COMPONENTS[field.type];
                if (!FieldComponent) return null;

                const isCheckbox = field.type === 'checkbox';

                return (
                    <div key={field.name} className="response-form__field">
                        {!isCheckbox && (
                            <label className="response-form__label">
                                {field.label || field.name}
                                {field.required && <span className="response-form__required"> *</span>}
                            </label>
                        )}
                        <FieldComponent
                            field={field}
                            value={state.values[field.name]}
                            onChange={handleChange}
                            error={state.errors[field.name]}
                        />
                        {state.errors[field.name] && (
                            <div className="response-form__error">{state.errors[field.name]}</div>
                        )}
                    </div>
                );
            })}
            <button
                type="submit"
                className="response-form__submit"
                disabled={disabled}
            >
                Save Response Details
            </button>
        </form>
    );
}
