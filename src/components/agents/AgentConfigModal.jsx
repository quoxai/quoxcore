/**
 * AgentConfigModal - Create/Edit Agent Configuration
 *
 * A comprehensive modal for configuring agents with:
 * - Basic info (name, description, icon)
 * - Level selection with hierarchy validation
 * - Domain tags (multi-select)
 * - Capability checkboxes
 * - Home scope selector
 * - Parent agent selection (for hierarchy)
 *
 * Follows the entity modal pattern from org/EntityModal.jsx
 */

import { useState, useEffect } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { Input } from '../ui/Input';
import ModelSelector from '../chat/ModelSelector';
import { AGENT_LEVELS, AGENT_DOMAINS, AGENT_CAPABILITIES } from '../../contexts/AgentContext';
import { DEFAULT_LLM_CONFIG } from '../../services/llmService';
import './agent-config.css';

// Icons
const AgentIcon = () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="8" r="5"/>
        <path d="M3 21v-2a7 7 0 0 1 7-7h4a7 7 0 0 1 7 7v2"/>
        <circle cx="12" cy="8" r="2" fill="currentColor" opacity="0.3"/>
    </svg>
);

const CheckIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="20 6 9 17 4 12"/>
    </svg>
);

export default function AgentConfigModal({
    isOpen,
    onClose,
    onSubmit,
    initialData = null,
    agents = [],           // Available agents for parent selection
    scopes = [],           // Available scopes for home scope selection
    loading = false
}) {
    const isEditing = !!initialData?.id;

    // Form state
    const [formData, setFormData] = useState({
        agent_id: '',
        name: '',
        description: '',
        icon: '',
        level: 2,
        parent_agent_id: null,
        home_scope_id: null,
        domains: [],
        capabilities: [],
        system_prompt_additions: '',
        config: {
            llm: { ...DEFAULT_LLM_CONFIG }
        }
    });

    const [errors, setErrors] = useState({});

    // Reset form when modal opens or initialData changes
    useEffect(() => {
        if (isOpen) {
            if (initialData) {
                setFormData({
                    agent_id: initialData.agent_id || '',
                    name: initialData.name || '',
                    description: initialData.description || '',
                    icon: initialData.icon || '',
                    level: initialData.level ?? 2,
                    parent_agent_id: initialData.parent_agent_id || null,
                    home_scope_id: initialData.home_scope_id || null,
                    domains: initialData.domains || [],
                    capabilities: initialData.capabilities || [],
                    system_prompt_additions: initialData.system_prompt_additions || '',
                    config: {
                        ...(initialData.config || {}),
                        llm: {
                            ...DEFAULT_LLM_CONFIG,
                            ...(initialData.config?.llm || {})
                        }
                    }
                });
            } else {
                setFormData({
                    agent_id: '',
                    name: '',
                    description: '',
                    icon: '',
                    level: 2,
                    parent_agent_id: null,
                    home_scope_id: null,
                    domains: [],
                    capabilities: [],
                    system_prompt_additions: '',
                    config: {
                        llm: { ...DEFAULT_LLM_CONFIG }
                    }
                });
            }
            setErrors({});
        }
    }, [isOpen, initialData]);

    // Auto-generate agent_id from name
    useEffect(() => {
        if (!isEditing && formData.name && !formData.agent_id) {
            const generated = formData.name
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, '')
                .replace(/\s+/g, '_')
                .slice(0, 32);
            setFormData(prev => ({ ...prev, agent_id: generated }));
        }
    }, [formData.name, isEditing]);

    const handleChange = (field, value) => {
        setFormData(prev => ({ ...prev, [field]: value }));
        if (errors[field]) {
            setErrors(prev => ({ ...prev, [field]: null }));
        }
    };

    const handleLlmChange = (updates) => {
        setFormData(prev => ({
            ...prev,
            config: {
                ...(prev.config || {}),
                llm: {
                    ...DEFAULT_LLM_CONFIG,
                    ...(prev.config?.llm || {}),
                    ...updates
                }
            }
        }));
    };

    const toggleDomain = (domain) => {
        setFormData(prev => ({
            ...prev,
            domains: prev.domains.includes(domain)
                ? prev.domains.filter(d => d !== domain)
                : [...prev.domains, domain]
        }));
    };

    const toggleCapability = (capability) => {
        setFormData(prev => ({
            ...prev,
            capabilities: prev.capabilities.includes(capability)
                ? prev.capabilities.filter(c => c !== capability)
                : [...prev.capabilities, capability]
        }));
    };

    const validate = () => {
        const newErrors = {};

        if (!formData.name?.trim()) {
            newErrors.name = 'Name is required';
        } else if (formData.name.length < 2) {
            newErrors.name = 'Name must be at least 2 characters';
        } else if (formData.name.length > 64) {
            newErrors.name = 'Name must be less than 64 characters';
        }

        if (!formData.agent_id?.trim()) {
            newErrors.agent_id = 'Agent ID is required';
        } else if (!/^[a-z][a-z0-9_]*$/.test(formData.agent_id)) {
            newErrors.agent_id = 'Must start with lowercase letter, contain only lowercase letters, numbers, underscores';
        } else if (formData.agent_id.length > 32) {
            newErrors.agent_id = 'Agent ID must be less than 32 characters';
        }

        if (formData.level < 0 || formData.level > 4) {
            newErrors.level = 'Invalid level';
        }

        // Validate parent relationship
        if (formData.parent_agent_id) {
            const parent = agents.find(a => a.id === formData.parent_agent_id);
            if (parent && formData.level <= parent.level) {
                newErrors.parent_agent_id = `Level must be higher than parent's level (${parent.level})`;
            }
        }

        setErrors(newErrors);
        return Object.keys(newErrors).length === 0;
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!validate()) return;

        try {
            await onSubmit(formData);
        } catch (err) {
            setErrors({ submit: err.message });
        }
    };

    const handleClose = () => {
        if (!loading) {
            onClose();
        }
    };

    // Filter valid parent agents (must have lower level number = higher authority)
    const validParentAgents = agents.filter(a =>
        a.id !== initialData?.id && a.level < formData.level
    );

    const selectedLevel = AGENT_LEVELS.find(l => l.value === formData.level);

    return (
        <Modal
            isOpen={isOpen}
            onClose={handleClose}
            size="lg"
        >
            <Modal.Header
                title={isEditing ? 'Edit Agent' : 'Create Agent'}
                description={isEditing ? `Editing ${initialData.name}` : 'Configure a new agent for your organization'}
                icon={<AgentIcon />}
                onClose={handleClose}
            />

            <form onSubmit={handleSubmit}>
                <Modal.Body>
                    {errors.submit && (
                        <div className="agent-config-error">
                            {errors.submit}
                        </div>
                    )}

                    <div className="agent-config-grid">
                        {/* Left column - Basic info */}
                        <div className="agent-config-section">
                            <h4 className="agent-config-section__title">Basic Information</h4>

                            <div className="agent-config-field">
                                <label className="agent-config-field__label" htmlFor="agent-name">
                                    Name *
                                </label>
                                <Input
                                    id="agent-name"
                                    value={formData.name}
                                    onChange={(e) => handleChange('name', e.target.value)}
                                    placeholder="e.g., Security Analyst"
                                    error={errors.name}
                                    autoFocus
                                    disabled={loading}
                                />
                                {errors.name && (
                                    <span className="agent-config-field__error">{errors.name}</span>
                                )}
                            </div>

                            <div className="agent-config-field">
                                <label className="agent-config-field__label" htmlFor="agent-id">
                                    Agent ID *
                                </label>
                                <Input
                                    id="agent-id"
                                    value={formData.agent_id}
                                    onChange={(e) => handleChange('agent_id', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                                    placeholder="e.g., security_analyst"
                                    error={errors.agent_id}
                                    disabled={loading || isEditing}
                                />
                                <span className="agent-config-field__hint">
                                    Unique identifier. Lowercase letters, numbers, underscores only.
                                </span>
                                {errors.agent_id && (
                                    <span className="agent-config-field__error">{errors.agent_id}</span>
                                )}
                            </div>

                            <div className="agent-config-field">
                                <label className="agent-config-field__label" htmlFor="agent-description">
                                    Description
                                </label>
                                <textarea
                                    id="agent-description"
                                    value={formData.description}
                                    onChange={(e) => handleChange('description', e.target.value)}
                                    placeholder="What does this agent do?"
                                    rows={3}
                                    disabled={loading}
                                    className="agent-config-textarea"
                                />
                            </div>

                            <div className="agent-config-field">
                                <label className="agent-config-field__label" htmlFor="agent-icon">
                                    Icon (emoji)
                                </label>
                                <Input
                                    id="agent-icon"
                                    value={formData.icon}
                                    onChange={(e) => handleChange('icon', e.target.value)}
                                    placeholder="e.g., 🔐"
                                    maxLength={4}
                                    disabled={loading}
                                    style={{ width: '80px', textAlign: 'center', fontSize: '20px' }}
                                />
                            </div>
                        </div>

                        {/* Right column - Hierarchy & scope */}
                        <div className="agent-config-section">
                            <h4 className="agent-config-section__title">Hierarchy & Scope</h4>

                            <div className="agent-config-field">
                                <label className="agent-config-field__label" htmlFor="agent-level">
                                    Level *
                                </label>
                                <select
                                    id="agent-level"
                                    value={formData.level}
                                    onChange={(e) => handleChange('level', parseInt(e.target.value))}
                                    disabled={loading}
                                    className="agent-config-select"
                                >
                                    {AGENT_LEVELS.map(level => (
                                        <option key={level.value} value={level.value}>
                                            L{level.value}: {level.label}
                                        </option>
                                    ))}
                                </select>
                                {selectedLevel && (
                                    <span className="agent-config-field__hint">
                                        {selectedLevel.description}
                                    </span>
                                )}
                            </div>

                            <div className="agent-config-field">
                                <label className="agent-config-field__label" htmlFor="agent-parent">
                                    Parent Agent
                                </label>
                                <select
                                    id="agent-parent"
                                    value={formData.parent_agent_id || ''}
                                    onChange={(e) => handleChange('parent_agent_id', e.target.value || null)}
                                    disabled={loading || validParentAgents.length === 0}
                                    className="agent-config-select"
                                >
                                    <option value="">None (top-level)</option>
                                    {validParentAgents.map(agent => (
                                        <option key={agent.id} value={agent.id}>
                                            L{agent.level}: {agent.name}
                                        </option>
                                    ))}
                                </select>
                                {errors.parent_agent_id && (
                                    <span className="agent-config-field__error">{errors.parent_agent_id}</span>
                                )}
                                <span className="agent-config-field__hint">
                                    Parent must have higher authority (lower level number)
                                </span>
                            </div>

                            {scopes.length > 0 && (
                                <div className="agent-config-field">
                                    <label className="agent-config-field__label" htmlFor="agent-scope">
                                        Home Scope
                                    </label>
                                    <select
                                        id="agent-scope"
                                        value={formData.home_scope_id || ''}
                                        onChange={(e) => handleChange('home_scope_id', e.target.value || null)}
                                        disabled={loading}
                                        className="agent-config-select"
                                    >
                                        <option value="">Organization-wide</option>
                                        {scopes.map(scope => (
                                            <option key={scope.id} value={scope.id}>
                                                {scope.path || scope.name}
                                            </option>
                                        ))}
                                    </select>
                                    <span className="agent-config-field__hint">
                                        Limits agent's visibility to this scope and descendants
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Domains section */}
                    <div className="agent-config-section agent-config-section--full">
                        <h4 className="agent-config-section__title">Domains</h4>
                        <p className="agent-config-section__description">
                            Select the domains this agent specializes in. Assistants use domains to route tasks.
                        </p>
                        <div className="agent-config-tags">
                            {AGENT_DOMAINS.map(domain => (
                                <button
                                    key={domain}
                                    type="button"
                                    className={`agent-config-tag ${formData.domains.includes(domain) ? 'agent-config-tag--selected' : ''}`}
                                    onClick={() => toggleDomain(domain)}
                                    disabled={loading}
                                >
                                    {formData.domains.includes(domain) && <CheckIcon />}
                                    {domain}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Capabilities section */}
                    <div className="agent-config-section agent-config-section--full">
                        <h4 className="agent-config-section__title">Capabilities</h4>
                        <p className="agent-config-section__description">
                            Define what this agent is allowed to do. These are enforced at runtime.
                        </p>
                        <div className="agent-config-capabilities">
                            {AGENT_CAPABILITIES.map(capability => (
                                <label
                                    key={capability}
                                    className={`agent-config-capability ${formData.capabilities.includes(capability) ? 'agent-config-capability--checked' : ''}`}
                                >
                                    <input
                                        type="checkbox"
                                        checked={formData.capabilities.includes(capability)}
                                        onChange={() => toggleCapability(capability)}
                                        disabled={loading}
                                    />
                                    <span className="agent-config-capability__checkbox">
                                        {formData.capabilities.includes(capability) && <CheckIcon />}
                                    </span>
                                    <span className="agent-config-capability__label">
                                        {capability.replace(/_/g, ' ')}
                                    </span>
                                </label>
                            ))}
                        </div>
                    </div>

                    {/* Advanced section */}
                    <div className="agent-config-section agent-config-section--full">
                        <h4 className="agent-config-section__title">LLM Settings</h4>
                        <p className="agent-config-section__description">
                            Choose the default model for this custom agent. Live user overrides can still supersede it at runtime.
                        </p>
                        <div className="agent-config-grid">
                            <div className="agent-config-section">
                                <div className="agent-config-field">
                                    <label className="agent-config-field__label">
                                        Provider & Model
                                    </label>
                                    <ModelSelector
                                        provider={formData.config?.llm?.provider || DEFAULT_LLM_CONFIG.provider}
                                        model={formData.config?.llm?.model || DEFAULT_LLM_CONFIG.model}
                                        onChange={(provider, model) => handleLlmChange({ provider, model })}
                                        defaultProvider={DEFAULT_LLM_CONFIG.provider}
                                        defaultModel={DEFAULT_LLM_CONFIG.model}
                                    />
                                </div>
                            </div>
                            <div className="agent-config-section">
                                <div className="agent-config-field">
                                    <label className="agent-config-field__label" htmlFor="agent-llm-temperature">
                                        Temperature
                                    </label>
                                    <Input
                                        id="agent-llm-temperature"
                                        type="number"
                                        min="0"
                                        max="2"
                                        step="0.1"
                                        value={formData.config?.llm?.temperature ?? DEFAULT_LLM_CONFIG.temperature}
                                        onChange={(e) => handleLlmChange({ temperature: parseFloat(e.target.value || DEFAULT_LLM_CONFIG.temperature) })}
                                        disabled={loading}
                                    />
                                </div>
                                <div className="agent-config-field">
                                    <label className="agent-config-field__label" htmlFor="agent-llm-max-tokens">
                                        Max Tokens
                                    </label>
                                    <Input
                                        id="agent-llm-max-tokens"
                                        type="number"
                                        min="1"
                                        step="1"
                                        value={formData.config?.llm?.maxTokens ?? DEFAULT_LLM_CONFIG.maxTokens}
                                        onChange={(e) => handleLlmChange({ maxTokens: parseInt(e.target.value || DEFAULT_LLM_CONFIG.maxTokens, 10) })}
                                        disabled={loading}
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    <details className="agent-config-advanced">
                        <summary className="agent-config-advanced__toggle">
                            Advanced Options
                        </summary>
                        <div className="agent-config-advanced__content">
                            <div className="agent-config-field">
                                <label className="agent-config-field__label" htmlFor="agent-prompt">
                                    System Prompt Additions
                                </label>
                                <textarea
                                    id="agent-prompt"
                                    value={formData.system_prompt_additions}
                                    onChange={(e) => handleChange('system_prompt_additions', e.target.value)}
                                    placeholder="Additional instructions appended to the agent's system prompt..."
                                    rows={4}
                                    disabled={loading}
                                    className="agent-config-textarea"
                                />
                                <span className="agent-config-field__hint">
                                    Custom instructions that modify the agent's behavior
                                </span>
                            </div>
                        </div>
                    </details>
                </Modal.Body>

                <Modal.Footer>
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={handleClose}
                        disabled={loading}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        loading={loading}
                        style={{ marginLeft: 'auto' }}
                    >
                        {isEditing ? 'Save Changes' : 'Create Agent'}
                    </Button>
                </Modal.Footer>
            </form>
        </Modal>
    );
}
