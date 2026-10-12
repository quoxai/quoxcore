/**
 * RetentionDefaultsPanel — SET-IA Phase 4b.
 *
 * Instance-wide data lifecycle policy. Drives the daily cleanup
 * cron in services/auth/services/retentionService.js.
 */

import { useState, useMemo } from 'react';
import { useInstanceConfig } from '../../../hooks/useInstanceConfig.js';
import { Field, inputStyle, fieldsetStyle, legendStyle, saveButtonStyle, SaveStatus }
    from './instancePanelStyles.jsx';

const SPEC = [
    { key: 'retention.default_days',           type: 'number',  default: 90 },
    { key: 'retention.audit_events_days',      type: 'number',  default: 365 },
    { key: 'retention.sessions_days',          type: 'number',  default: 30 },
    { key: 'retention.cleanup_enabled',        type: 'boolean', default: true },
    { key: 'retention.cleanup_hour',           type: 'number',  default: 3 },
    { key: 'retention.min_user_retention_days', type: 'number', default: 7 },
];

export default function RetentionDefaultsPanel() {
    const cfg = useInstanceConfig(SPEC);
    const [draft, setDraft] = useState({});
    const [errors, setErrors] = useState({});

    const v = useMemo(() => ({ ...cfg.values, ...draft }), [cfg.values, draft]);

    if (cfg.loading) return <div style={{ padding: 24, opacity: 0.6 }}>Loading retention defaults…</div>;
    if (cfg.error && Object.keys(cfg.values).length === 0) {
        return (
            <div style={{ padding: 24 }}>
                <h2 style={{ marginTop: 0 }}>Retention Defaults</h2>
                <p style={{ color: '#f87171' }}>Failed to load: {cfg.error}</p>
            </div>
        );
    }

    const validateDays = (n) => Number.isInteger(n) && n >= 1 && n <= 36500;
    const validate = () => {
        const errs = {};
        if (!validateDays(v['retention.default_days']))         errs.def    = 'Default retention must be 1–36500 days.';
        if (!validateDays(v['retention.audit_events_days']))    errs.audit  = 'Audit retention must be 1–36500 days.';
        if (!validateDays(v['retention.sessions_days']))        errs.sess   = 'Session retention must be 1–36500 days.';
        if (!validateDays(v['retention.min_user_retention_days'])) errs.minUser = 'Min user retention must be 1–36500 days.';
        const h = v['retention.cleanup_hour'];
        if (!Number.isInteger(h) || h < 0 || h > 23) errs.hour = 'Cleanup hour must be 0–23.';
        return errs;
    };

    const onSubmit = async (e) => {
        e.preventDefault();
        const errs = validate();
        setErrors(errs);
        if (Object.keys(errs).length) return;
        try {
            await cfg.save(draft);
            setDraft({});
        } catch (err) {
            setErrors({ submit: err.message });
        }
    };

    return (
        <form onSubmit={onSubmit} noValidate style={{ padding: 24, maxWidth: 720 }}>
            <h2 style={{ marginTop: 0 }}>Retention Defaults</h2>
            <p style={{ opacity: 0.7, marginBottom: 24 }}>
                How long QuoxCORE keeps each class of data before the daily
                cleanup sweep deletes it. Audit events have the longest
                default for compliance.
            </p>

            <fieldset style={fieldsetStyle}>
                <legend style={legendStyle}>Retention windows (days)</legend>

                <Field id="def" label="Default retention" error={errors.def}>
                    <input id="def" type="number" style={inputStyle}
                        value={v['retention.default_days'] ?? 0}
                        onChange={(e) => setDraft(d => ({ ...d, 'retention.default_days': Number.parseInt(e.target.value, 10) || 0 }))} />
                </Field>

                <Field id="audit" label="Audit events"
                    help="Compliance frameworks typically require 365+ days." error={errors.audit}>
                    <input id="audit" type="number" style={inputStyle}
                        value={v['retention.audit_events_days'] ?? 0}
                        onChange={(e) => setDraft(d => ({ ...d, 'retention.audit_events_days': Number.parseInt(e.target.value, 10) || 0 }))} />
                </Field>

                <Field id="sess" label="Expired/revoked sessions" error={errors.sess}>
                    <input id="sess" type="number" style={inputStyle}
                        value={v['retention.sessions_days'] ?? 0}
                        onChange={(e) => setDraft(d => ({ ...d, 'retention.sessions_days': Number.parseInt(e.target.value, 10) || 0 }))} />
                </Field>

                <Field id="minUser" label="Minimum user-requested retention"
                    help="Floor for any custom retention a user can request."
                    error={errors.minUser}>
                    <input id="minUser" type="number" style={inputStyle}
                        value={v['retention.min_user_retention_days'] ?? 0}
                        onChange={(e) => setDraft(d => ({ ...d, 'retention.min_user_retention_days': Number.parseInt(e.target.value, 10) || 0 }))} />
                </Field>
            </fieldset>

            <fieldset style={fieldsetStyle}>
                <legend style={legendStyle}>Cleanup schedule</legend>

                <Field id="enabled" label="Enable scheduled cleanup"
                    help="When off, cleanup must be triggered manually.">
                    <input id="enabled" type="checkbox"
                        checked={!!v['retention.cleanup_enabled']}
                        onChange={(e) => setDraft(d => ({ ...d, 'retention.cleanup_enabled': e.target.checked }))} />
                </Field>

                <Field id="hour" label="Cleanup hour (0–23)"
                    help="Hour of the server's day when cleanup runs." error={errors.hour}>
                    <input id="hour" type="number" style={inputStyle}
                        value={v['retention.cleanup_hour'] ?? 0}
                        onChange={(e) => setDraft(d => ({ ...d, 'retention.cleanup_hour': Number.parseInt(e.target.value, 10) || 0 }))} />
                </Field>
            </fieldset>

            <SaveStatus savedAt={cfg.savedAt} error={errors.submit || cfg.error} />

            <button type="submit" disabled={cfg.saving} style={saveButtonStyle(cfg.saving)}>
                {cfg.saving ? 'Saving…' : 'Save changes'}
            </button>
        </form>
    );
}
