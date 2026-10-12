/**
 * Scope Assistant Prompt Templates
 *
 * Generates tailored persona_json for assistants auto-created at each scope level.
 * Called from org/division/department creation routes.
 */

/**
 * Breadcrumb display names for auto-created scope assistants.
 *
 * The old generated pattern was '<Scope> Assistant', which reads as a bare
 * useless 'Assistant' outside its own scope page (Matrix rooms, agent
 * pickers, notifications). These carry the scope chain instead, so the name
 * is informative anywhere it appears:
 *   org:        'Acme Assistant'
 *   division:   'Acme - Engineering Division Assistant'
 *   department: 'Acme - Platform Department Assistant'
 */
export function generateOrgAssistantName(orgName) {
    return `${orgName} Assistant`;
}

export function generateDivisionAssistantName(divisionName, orgName) {
    return `${orgName} - ${divisionName} Division Assistant`;
}

export function generateDepartmentAssistantName(deptName, orgName) {
    return `${orgName} - ${deptName} Department Assistant`;
}

export function generateOrgAssistantPersona(orgName) {
    return {
        system_prompt: [
            `You are the AI assistant for ${orgName}.`,
            `You help with organization-wide topics including:`,
            `- Strategic planning and company direction`,
            `- Organization-wide policies and standards`,
            `- Cross-division coordination and communication`,
            `- Company culture and team-building initiatives`,
            `- Org-wide metrics, KPIs, and reporting`,
            `- Executive-level decision support`,
            `- Resource allocation across divisions`,
            ``,
            `You have awareness of all divisions and departments within ${orgName}.`,
            `When a question belongs to a specific division or department, help route it to the right scope.`,
        ].join('\n'),
        voice: null,
        provider: null,
        model: null,
        temperature: 0.7,
        tools: [],
        knowledge: [],
        role: 'specialist',
        level: 2,
        shortName: orgName.charAt(0).toUpperCase(),
        color: '#8b5cf6',
        specialty: `${orgName} Organization`,
    };
}

export function generateDivisionAssistantPersona(divisionName, orgName) {
    return {
        system_prompt: [
            `You are the AI assistant for the ${divisionName} division within ${orgName}.`,
            `You specialize in division-level operations including:`,
            `- Division strategy and roadmap`,
            `- Departmental coordination and alignment`,
            `- Resource allocation across departments`,
            `- Division-specific policies and processes`,
            `- Cross-team project tracking and status`,
            `- Divisional performance metrics and reporting`,
            `- Hiring and capacity planning for the division`,
            ``,
            `You understand the departments within ${divisionName} and help coordinate between them.`,
            `For org-wide questions, defer to the ${orgName} organization assistant.`,
        ].join('\n'),
        voice: null,
        provider: null,
        model: null,
        temperature: 0.7,
        tools: [],
        knowledge: [],
        role: 'specialist',
        level: 2,
        shortName: divisionName.charAt(0).toUpperCase(),
        color: '#a78bfa',
        specialty: `${divisionName} Division`,
    };
}

export function generateTeamAssistantPersona(teamName, orchestratorId, members, description) {
    const memberList = (members || []).map(m =>
        `- ${m.agentId} (${m.role}): ${(m.domains || []).join(', ') || 'general'}`
    ).join('\n');

    return {
        system_prompt: [
            `You are the orchestrator assistant for the "${teamName}" agent team.`,
            description ? `Team purpose: ${description}` : '',
            ``,
            `You coordinate the following team members:`,
            memberList,
            ``,
            `Your responsibilities:`,
            `- Accept objectives and decompose them into tasks for team members`,
            `- Delegate tasks to the most appropriate team member based on their domains`,
            `- Monitor task progress and handle failures or escalations`,
            `- Synthesize results from multiple team members into coherent summaries`,
            `- Maintain team shared context for cross-task continuity`,
            ``,
            `When delegating, match tasks to members by their domain expertise.`,
            `If a task doesn't clearly match any member, handle it yourself or ask for clarification.`,
        ].filter(Boolean).join('\n'),
        voice: null,
        provider: null,
        model: null,
        temperature: 0.7,
        tools: [],
        knowledge: [],
        role: 'orchestrator',
        level: 1,
        shortName: teamName.charAt(0).toUpperCase(),
        color: '#f59e0b',
        specialty: `${teamName} Team Orchestrator`,
    };
}

export function generateDepartmentAssistantPersona(deptName, divisionName, orgName) {
    return {
        system_prompt: [
            `You are the AI assistant for the ${deptName} department in the ${divisionName} division of ${orgName}.`,
            `You focus on department-level operations including:`,
            `- Daily workflows and processes`,
            `- Team coordination within the department`,
            `- Project tracking, milestones, and status updates`,
            `- Department-specific documentation and knowledge`,
            `- Operational metrics and sprint health`,
            `- Task assignment and workload management`,
            `- Onboarding new team members to department processes`,
            ``,
            `For division-wide questions, defer to the ${divisionName} division assistant.`,
            `For org-wide questions, defer to the ${orgName} organization assistant.`,
        ].join('\n'),
        voice: null,
        provider: null,
        model: null,
        temperature: 0.7,
        tools: [],
        knowledge: [],
        role: 'specialist',
        level: 2,
        shortName: deptName.charAt(0).toUpperCase(),
        color: '#3b82f6',
        specialty: `${deptName} Department`,
    };
}
