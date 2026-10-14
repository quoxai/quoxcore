/**
 * Registration of a COMMUNITY (sandboxed frame) plugin's declared agent into the
 * client agent registry. Pure so it is testable without the plugin host.
 *
 * Trust rules (the manifest persona is untrusted community text):
 *  - never overwrite an agent the registry already has under that id (a plugin
 *    declaring id "quox" must not replace the orchestrator);
 *  - only OFFICIAL installs may be added to quox's canDelegateTo; a community
 *    agent is chat-only via its own host-rendered dock;
 *  - the entry is tagged ownership.community = true so ChatEngine sends the
 *    turn as a plugin-agent turn (the server then grants it no tools).
 */
export function registerFramePluginAgent(registry, pluginId, manifest, { official = false } = {}) {
    const agentDef = manifest && manifest.agentDefinition;
    if (!agentDef || typeof agentDef !== 'object') return { registered: false, reason: 'no-agent' };
    const agentId = agentDef.id || pluginId;
    const existing = registry.agents[agentId];
    if (existing && !(existing.ownership && existing.ownership.plugin === pluginId)) {
        return { registered: false, reason: 'id-taken', agentId };
    }
    registry.agents[agentId] = {
        ...agentDef,
        ownership: { source: 'plugin', plugin: pluginId, community: !official },
    };
    if (!registry.hierarchy.pluginAgents.includes(agentId)) registry.hierarchy.pluginAgents.push(agentId);
    if (official && registry.agents.quox && !registry.agents.quox.canDelegateTo.includes(agentId)) {
        registry.agents.quox.canDelegateTo.push(agentId);
    }
    return { registered: true, agentId };
}

/** ChatEngine display config for a community plugin agent, or null. */
export function buildCommunityAgentConfig(registry, agentId) {
    const reg = registry.agents[agentId];
    if (!reg || !reg.ownership || reg.ownership.source !== 'plugin' || reg.ownership.community !== true) return null;
    const name = String(reg.name || agentId);
    return {
        name,
        shortName: name.charAt(0),
        systemPrompt: typeof reg.systemPrompt === 'string' ? reg.systemPrompt.slice(0, 4000) : '',
        specialty: reg.description || '',
        voice: null,
        color: { primary: typeof reg.color === 'string' ? reg.color : '#a78bfa' },
        role: reg.role || 'specialist',
        level: 1,
        llm: null,
        llmPolicy: null,
    };
}
