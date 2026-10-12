export const DEFAULT_ASSISTANT_LLM = {
    provider: null,
    model: null,
    temperature: 0.7,
    maxTokens: 4096
};

export function safeParseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

export function inferProviderFromModel(modelId) {
    if (!modelId) return null;
    if (modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3') || modelId.startsWith('o4')) return 'openai';
    if (modelId.startsWith('claude-')) return 'anthropic';
    if (modelId.startsWith('gemini-')) return 'gemini';
    if (modelId.includes('sonar')) return 'perplexity';
    if (modelId.startsWith('llama-')) return 'perplexity';
    return null;
}

export function parseAssistantPersona(rowOrPersona) {
    if (!rowOrPersona) return {};
    if (rowOrPersona.persona && typeof rowOrPersona.persona === 'object') return rowOrPersona.persona;
    if (rowOrPersona.persona_json !== undefined) return safeParseJson(rowOrPersona.persona_json, {});
    return typeof rowOrPersona === 'object' ? rowOrPersona : {};
}

export function extractAssistantLlm(row, persona = parseAssistantPersona(row)) {
    const modelConfig = safeParseJson(row?.model_config_json, {});

    const model = persona.model
        || modelConfig.model
        || row?.model_id
        || DEFAULT_ASSISTANT_LLM.model;

    const provider = persona.provider
        || modelConfig.provider
        || inferProviderFromModel(model)
        || DEFAULT_ASSISTANT_LLM.provider;

    const temperature = persona.temperature
        ?? modelConfig.temperature
        ?? DEFAULT_ASSISTANT_LLM.temperature;

    const maxTokens = persona.maxTokens
        ?? persona.max_tokens
        ?? modelConfig.maxTokens
        ?? modelConfig.max_tokens
        ?? DEFAULT_ASSISTANT_LLM.maxTokens;

    return {
        ...DEFAULT_ASSISTANT_LLM,
        ...modelConfig,
        provider,
        model,
        temperature,
        maxTokens
    };
}

export function buildAssistantPersistencePayload({ persona = {}, llm = null, row = null } = {}) {
    const basePersona = row ? parseAssistantPersona(row) : {};
    const currentLlm = row ? extractAssistantLlm(row, basePersona) : DEFAULT_ASSISTANT_LLM;
    const nextPersona = { ...basePersona, ...(persona || {}) };
    const nextModel = llm?.model || nextPersona.model || currentLlm.model || null;
    const nextProvider = llm?.provider
        || nextPersona.provider
        || currentLlm.provider
        || inferProviderFromModel(nextModel)
        || null;
    const nextLlm = {
        ...currentLlm,
        ...(llm || {}),
        provider: nextProvider,
        model: nextModel,
        temperature: llm?.temperature ?? nextPersona.temperature ?? currentLlm.temperature,
        maxTokens: llm?.maxTokens
            ?? llm?.max_tokens
            ?? nextPersona.maxTokens
            ?? nextPersona.max_tokens
            ?? currentLlm.maxTokens
    };

    const normalizedPersona = {
        ...nextPersona,
        temperature: nextLlm.temperature,
        maxTokens: nextLlm.maxTokens
    };
    if (nextLlm.provider) normalizedPersona.provider = nextLlm.provider;
    else delete normalizedPersona.provider;
    if (nextLlm.model) normalizedPersona.model = nextLlm.model;
    else delete normalizedPersona.model;

    const modelConfig = {
        ...safeParseJson(row?.model_config_json, {}),
        temperature: nextLlm.temperature,
        maxTokens: nextLlm.maxTokens
    };
    if (nextLlm.provider) modelConfig.provider = nextLlm.provider;
    else delete modelConfig.provider;
    if (nextLlm.model) modelConfig.model = nextLlm.model;
    else delete modelConfig.model;

    return {
        persona: normalizedPersona,
        personaJson: JSON.stringify(normalizedPersona),
        modelId: nextLlm.model || null,
        modelConfig,
        modelConfigJson: JSON.stringify(modelConfig),
        llm: nextLlm
    };
}

export function serializeAssistantResponse(row, extras = {}) {
    const persona = parseAssistantPersona(row);
    return {
        ...row,
        ...extras,
        persona,
        llm: extractAssistantLlm(row, persona)
    };
}

export function serializeAssistantVersionResponse(versionRecord) {
    const persona = parseAssistantPersona(versionRecord);
    return {
        ...versionRecord,
        persona,
        llm: extractAssistantLlm(versionRecord, persona)
    };
}
