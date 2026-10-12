/**
 * Core Workflow Registry — maps n8n/QuoxFlow workflow names to system metadata.
 *
 * Keyed by name (not ID) since engine IDs are opaque and may change if
 * workflows are recreated. Names are stable by convention.
 */

export const CORE_WORKFLOWS = {
    'maestro-chat':                       { category: 'chat-pipeline',  description: 'Routes chat messages to Claude via the collector',   plugin: 'core' },
    'maestro-speak':                      { category: 'chat-pipeline',  description: 'Text-to-speech via ElevenLabs',                     plugin: 'core' },
    'maestro-transcribe':                 { category: 'chat-pipeline',  description: 'Speech-to-text via Whisper',                        plugin: 'core' },
    'Core - System Health Check':         { category: 'monitoring',     description: 'Pings auth, bastion, and Prometheus health endpoints', plugin: 'monitoring' },
    'Docker - Container Status':          { category: 'infrastructure', description: 'SSH into hosts to query Docker container state',     plugin: 'quoxagent-fleet' },
    'Docker - Extended Operations':       { category: 'infrastructure', description: 'SSH Docker management (logs, restart, inspect)',     plugin: 'quoxagent-fleet' },
    'Fleet - Host Status Matrix':         { category: 'infrastructure', description: 'Queries MHA collector for fleet host status',        plugin: 'quoxagent-fleet' },
    'Proxmox - Cluster Status':           { category: 'infrastructure', description: 'SSH pvesh cluster status from Proxmox nodes',        plugin: 'quoxagent-fleet' },
    'Proxmox - List Containers':          { category: 'infrastructure', description: 'SSH pvesh LXC container listing',                   plugin: 'quoxagent-fleet' },
    'Proxmox - List VMs':                 { category: 'infrastructure', description: 'SSH pvesh VM listing',                              plugin: 'quoxagent-fleet' },
    'Proxmox - Storage Overview':         { category: 'infrastructure', description: 'SSH pvesh storage resource listing',                plugin: 'quoxagent-fleet' },
    'Proxmox - VM Action (Protected)':    { category: 'infrastructure', description: 'Protected SSH VM actions with input validation',    plugin: 'quoxagent-fleet' },
    'RouterOS API Proxy':                 { category: 'network',        description: 'HTTP proxy to MikroTik RouterOS API',               plugin: 'quoxagent-fleet' },
    'Alerts - Management':                { category: 'monitoring',     description: 'Dynamic alert management HTTP proxy',               plugin: 'monitoring' },
    'Metrics - System Query':             { category: 'monitoring',     description: 'Prometheus query proxy for metrics dashboards',      plugin: 'monitoring' },
    'Network - Connectivity Check':       { category: 'network',        description: 'SSH network connectivity checks across hosts',       plugin: 'quoxagent-fleet' },
    'Network - Interface Monitoring':     { category: 'network',        description: 'SSH network interface monitoring',                  plugin: 'quoxagent-fleet' },
    'Security - Audit Events':            { category: 'security',       description: 'Queries audit_events SQLite for security review',   plugin: 'monitoring' },
    'Security - SSL Certificate Check':   { category: 'security',       description: 'SSH certificate expiry checks',                    plugin: 'monitoring' },
    'System - Administration Tools':      { category: 'infrastructure', description: 'SSH system administration commands',                plugin: 'quoxagent-fleet' },
};

/** Category display colours (CSS variable or hex fallback) */
export const CATEGORY_COLORS = {
    'chat-pipeline':  'var(--color-info, #3b82f6)',
    'monitoring':     'var(--color-warning, #f59e0b)',
    'infrastructure': 'var(--text-secondary, #94a3b8)',
    'network':        '#06b6d4',
    'security':       'var(--color-danger, #ef4444)',
};

/**
 * Org Workflow Registry — engine workflows that belong to a known organisation.
 *
 * These are QuoxFlow workflows created by the platform but not yet registered
 * in the auth backend. They should display with org identity (logo + scope badge)
 * rather than the generic "Engine" indicator.
 *
 * Once the auth system is fully bootstrapped and these workflows are registered
 * via POST /api/orgs/:orgId/workflows, this mapping becomes redundant — the
 * auth-registered version takes precedence (name-based dedup in loadWorkflows).
 */
export const ORG_WORKFLOWS = {
    'Daily AI News Digest → HITL Inbox': { orgName: 'Quox LTD', description: 'Curated AI news digest delivered to the HITL inbox for review' },
    'Gallery Screenshot Refresh':        { orgName: 'Quox LTD', description: 'Weekly automated refresh of the quox.ai product gallery screenshots' },
};

export function isOrgWorkflow(name) {
    return name in ORG_WORKFLOWS;
}

export function getOrgWorkflowMeta(name) {
    return ORG_WORKFLOWS[name] || null;
}

export function isCoreWorkflow(name) {
    return name in CORE_WORKFLOWS;
}

export function getCoreMetadata(name) {
    return CORE_WORKFLOWS[name] || null;
}
