export function getProvenanceSourceLabel(source) {
    if (source === 'vault_credential_selection') return 'Vault credential selection';
    if (source === 'toolbar_selection' || source === 'user_selection') return 'Manual toolbar selection';
    if (source === 'personal_preference') return 'Personal capability preference';
    if (source === 'policy_default') return 'Policy default';
    if (source === 'system_default') return 'System default';
    if (source === 'assistant_recommendation') return 'Agent recommendation';
    if (source === 'specialist_lock') return 'Specialist lock';
    return 'Agent default';
}

export function getEffectiveModelSource({ credentialId, isManualModelOverride }) {
    if (credentialId) return getProvenanceSourceLabel('vault_credential_selection');
    if (isManualModelOverride) return getProvenanceSourceLabel('toolbar_selection');
    return getProvenanceSourceLabel('agent_default');
}

export function getEffectiveCredentialLabel({ credentialId, credentialMeta }) {
    return credentialMeta?.label || (credentialId ? 'Selected vault key' : 'Environment/default auth');
}

export function formatExecutionTitle(execution) {
    if (!execution) return '';

    const sourceLabel = getProvenanceSourceLabel(execution.source);
    const credentialLabel = execution.credential_label
        || (execution.credential_id ? 'Selected vault credential' : 'Environment/default auth');
    const overrideNotes = [];
    const policyNote = execution.policy_label
        ? ` Policy: ${execution.policy_label}${execution.capability_label ? ` (${execution.capability_label})` : ''}.`
        : '';
    const reasonNote = execution.reasons?.length
        ? ` Reason: ${execution.reasons.slice(0, 2).join(' ')}`
        : '';
    const coercions = execution.coercions || {};

    if (execution.provider_overridden_by_credential) {
        overrideNotes.push('Credential forced provider alignment');
    }
    if (execution.model_overridden_by_credential) {
        overrideNotes.push('Credential forced model alignment');
    }
    if (coercions.userOverrideBlocked) {
        overrideNotes.push('Policy blocked a manual override');
    }
    if (coercions.credentialIgnoredByPolicy) {
        overrideNotes.push('Policy ignored credential routing priority');
    }
    if (coercions.policyDisabled) {
        overrideNotes.push('Execution policy was disabled for this resolution');
    }
    if (Array.isArray(execution.fallback_chain) && execution.fallback_chain.length > 0) {
        overrideNotes.push(`Declared fallback chain: ${execution.fallback_chain.map(step => `${step.provider}/${step.model}`).join(' -> ')}`);
    }

    const suffix = overrideNotes.length ? `. ${overrideNotes.join('. ')}.` : '';
    return `Executed via ${sourceLabel}. Credential: ${credentialLabel}.${policyNote}${reasonNote}${suffix}`.replace(/\.\./g, '.');
}
