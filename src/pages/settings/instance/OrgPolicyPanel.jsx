/**
 * OrgPolicyPanel — SET-IA Phase 4b.
 *
 * Instance-wide org/key policy: who can create orgs, how many per
 * user, and whether org-scoped or user-scoped API keys are allowed
 * to override the instance default provider.
 */

import { useState, useMemo } from 'react';
import { useInstanceConfig } from '../../../hooks/useInstanceConfig.js';
import { Field, inputStyle, fieldsetStyle, legendStyle, saveButtonStyle, SaveStatus }
    from './instancePanelStyles.jsx';

const PROVIDER_CHOICES = [
    { value: 'anthropic', label: 'Anthropic (Claude)' },
    { value: 'openai',    label: 'OpenAI' },
    { value: 'gemini',    label: 'Google Gemini' },
    { value: 'codex',     label: 'Codex' },
    { value: 'perplexity', label: 'Perplexity' },
];

const SPEC = [
    { key: 'orgs.allow_user_creation', type: 'boolean', default: false },
    { key: 'orgs.max_per_user',        type: 'number',  default: 3 },
    { key: 'keys.allow_org_override',  type: 'boolean', default: true },
    { key: 'keys.allow_user_byok',     type: 'boolean', default: true },
    { key: 'keys.default_provider',    type: 'string',  default: 'anthropic' },
];

export default function OrgPolicyPanel() {
    const cfg = useInstanceConfig(SPEC);
    const [draft, setDraft] = useState({});
    const [errors, setErrors] = useState({});

    const v = useMemo(() => ({ ...cfg.values, ...draft }), [cfg.values, draft]);

    if (cfg.loading) return <div style={{ padding: 24, opacity: 0.6 }}>Loading org policy…</div>;
    if (cfg.error && Object.keys(cfg.values).length === 0) {
        return (
            <div style={{ padding: 24 }}>
                <h2 style={{ marginTop: 0 }}>Org Policy</h2>
                <p style={{ color: '#f87171' }}>Failed to load: {cfg.error}</p>
            </div>
        );
    }

    const validate = () => {
        const errs = {};
        const m = v['orgs.max_per_user'];
        if (!Number.isInteger(m) || m < 1 || m > 1000) errs.max = 'Max orgs per user must be 1–1000.';
        if (!PROVIDER_CHOICES.some(p => p.value === v['keys.default_provider'])) {
            errs.provider = 'Pick a known provider.';
        }
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
            <h2 style={{ marginTop: 0 }}>Org Policy</h2>
            <p style={{ opacity: 0.7, marginBottom: 24 }}>
                Rules for organisation creation and how API key precedence
                resolves across instance / org / user scopes.
            </p>

            <fieldset style={fieldsetStyle}>
                <legend style={legendStyle}>Organisation creation</legend>

                <Field id="allowCreate" label="Allow users to create orgs"
                    help="If off, orgs are created by an instance admin and users are invited.">
                    <input id="allowCreate" type="checkbox"
                        checked={!!v['orgs.allow_user_creation']}
                        onChange={(e) => setDraft(d => ({ ...d, 'orgs.allow_user_creation': e.target.checked }))} />
                </Field>

                <Field id="maxPerUser" label="Maximum orgs per user"
                    help="Only enforced when user creation is allowed." error={errors.max}>
                    <input id="maxPerUser" type="number" style={inputStyle}
                        value={v['orgs.max_per_user'] ?? 0}
                        onChange={(e) => setDraft(d => ({ ...d, 'orgs.max_per_user': Number.parseInt(e.target.value, 10) || 0 }))} />
                </Field>
            </fieldset>

            <fieldset style={fieldsetStyle}>
                <legend style={legendStyle}>API key precedence</legend>

                <Field id="orgOverride" label="Allow orgs to override instance keys"
                    help="When on, an org-scoped API key wins over the instance default for members of that org.">
                    <input id="orgOverride" type="checkbox"
                        checked={!!v['keys.allow_org_override']}
                        onChange={(e) => setDraft(d => ({ ...d, 'keys.allow_org_override': e.target.checked }))} />
                </Field>

                <Field id="userByok" label="Allow users to bring their own keys"
                    help="When on, a user-scoped API key wins over both the org and instance keys for that user.">
                    <input id="userByok" type="checkbox"
                        checked={!!v['keys.allow_user_byok']}
                        onChange={(e) => setDraft(d => ({ ...d, 'keys.allow_user_byok': e.target.checked }))} />
                </Field>

                <Field id="provider" label="Default provider"
                    help="Used when no key is configured at any scope." error={errors.provider}>
                    <select id="provider" style={inputStyle}
                        value={v['keys.default_provider'] || ''}
                        onChange={(e) => setDraft(d => ({ ...d, 'keys.default_provider': e.target.value }))}>
                        {PROVIDER_CHOICES.map(p => (
                            <option key={p.value} value={p.value}>{p.label}</option>
                        ))}
                    </select>
                </Field>
            </fieldset>

            <SaveStatus savedAt={cfg.savedAt} error={errors.submit || cfg.error} />

            <button type="submit" disabled={cfg.saving} style={saveButtonStyle(cfg.saving)}>
                {cfg.saving ? 'Saving…' : 'Save changes'}
            </button>
        </form>
    );
}
