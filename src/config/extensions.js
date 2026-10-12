import { hasRoleLevel } from '../lib/policy';

/**
 * Extensions Registry
 *
 * Central configuration for all QUOX extensions/plugins.
 * Designed to handle many extensions (10, 20, 50+) with:
 * - Categories for organization
 * - Enable/disable state
 * - Icon mapping
 * - Route configuration
 * - Metadata (description, version, author)
 * - minRole for role-based visibility
 *
 * Extensions are loaded dynamically and can be enabled/disabled
 * through settings or programmatically.
 */

// Extension categories for grouping in the sidebar
export const EXTENSION_CATEGORIES = {
    OPERATIONS: {
        id: 'operations',
        label: 'Operations',
        description: 'Security and network operations centers',
        order: 1
    },
    AUTOMATION: {
        id: 'automation',
        label: 'Automation',
        description: 'Workflow and process automation tools',
        order: 2
    },
    INTELLIGENCE: {
        id: 'intelligence',
        label: 'Intelligence',
        description: 'AI and data analysis tools',
        order: 3
    },
    INTEGRATIONS: {
        id: 'integrations',
        label: 'Integrations',
        description: 'Third-party service integrations',
        order: 4
    },
    UTILITIES: {
        id: 'utilities',
        label: 'Utilities',
        description: 'General purpose tools and utilities',
        order: 5
    }
};

// Default extension definitions
// Add new extensions here following this pattern
const DEFAULT_EXTENSIONS = [
    // ===== Operations =====
    {
        id: 'soc',
        name: 'SOC',
        fullName: 'Security Operations Center',
        description: 'Security monitoring, threat detection, and incident response',
        category: 'operations',
        icon: 'shield',
        path: '/soc',
        enabled: true,
        version: '1.0.0',
        author: 'QUOX Core',
        shortcut: '2',
        badge: null, // Can be 'new', 'beta', or a number for notifications
        requiredLicense: null, // null = free, 'pro', 'enterprise'
        minRole: 'runner',
    },
    {
        id: 'noc',
        name: 'NOC',
        fullName: 'Network Operations Center',
        description: 'Network monitoring, health checks, and infrastructure status',
        category: 'operations',
        icon: 'server',
        path: '/noc',
        enabled: true,
        version: '1.0.0',
        author: 'QUOX Core',
        shortcut: '3',
        badge: null,
        requiredLicense: null,
        minRole: 'runner',
    },

    {
        id: 'routeros',
        name: 'RouterOS',
        fullName: 'MikroTik RouterOS Manager',
        description: 'Intelligent MikroTik router management with plain English explanations',
        category: 'operations',
        icon: 'network',
        path: '/routeros',
        enabled: true,
        version: '1.0.0',
        author: 'QUOX Core',
        badge: 'new',
        requiredLicense: 'tier_b',
        minRole: 'builder',
    },

    {
        id: 'tailscale',
        name: 'TailMesh',
        fullName: 'TailMesh — Tailscale Mesh Manager',
        description: 'Tailscale mesh monitoring, route management, key lifecycle, and MESHNET agent',
        category: 'operations',
        icon: 'globe',
        path: '/tailscale',
        enabled: true,
        version: '1.0.0',
        author: 'QUOX Core',
        badge: 'new',
        requiredLicense: 'tier_b',
        minRole: 'viewer',
    },

    // ===== Automation =====
    {
        id: 'hitl',
        name: 'HITL',
        fullName: 'Human-in-the-Loop',
        description: 'Approval workflows, review queues, and human oversight',
        category: 'automation',
        icon: 'userCheck',
        path: '/hitl',
        enabled: false,
        version: '0.1.0',
        author: 'QUOX Core',
        badge: 'beta',
        requiredLicense: 'pro',
        minRole: 'runner',
    },

    // ===== Intelligence =====
    {
        id: 'memory-tools',
        name: 'Memory Tools',
        fullName: 'Advanced Memory Tools',
        description: 'Memory search, analysis, and management utilities',
        category: 'intelligence',
        icon: 'brain',
        path: '/memory-tools',
        enabled: false,
        version: '0.1.0',
        author: 'QUOX Core',
        badge: 'new',
        requiredLicense: null,
        minRole: null,
    },
    {
        id: 'analytics',
        name: 'Analytics',
        fullName: 'Usage Analytics',
        description: 'System usage statistics and performance insights',
        category: 'intelligence',
        icon: 'barChart',
        path: '/analytics',
        enabled: false,
        version: '0.1.0',
        author: 'QUOX Core',
        badge: null,
        requiredLicense: 'enterprise',
        minRole: null,
    },

    // ===== Integrations =====
    {
        id: 'slack',
        name: 'Slack',
        fullName: 'Slack Integration',
        description: 'Receive notifications and send commands via Slack',
        category: 'integrations',
        icon: 'messageSquare',
        path: '/integrations/slack',
        enabled: false,
        version: '0.1.0',
        author: 'QUOX Core',
        badge: null,
        requiredLicense: 'pro',
        minRole: null,
    },
    {
        id: 'telegram',
        name: 'Telegram',
        fullName: 'Telegram Integration',
        description: 'Bot integration for Telegram notifications',
        category: 'integrations',
        icon: 'send',
        path: '/integrations/telegram',
        enabled: false,
        version: '0.1.0',
        author: 'QUOX Core',
        badge: null,
        requiredLicense: 'pro',
        minRole: null,
    },

    // ===== Utilities =====
    {
        id: 'audit-log',
        name: 'Audit Log',
        fullName: 'Audit Log Viewer',
        description: 'View and search system audit logs',
        category: 'utilities',
        icon: 'fileText',
        path: '/audit-log',
        enabled: false,
        version: '0.1.0',
        author: 'QUOX Core',
        badge: null,
        requiredLicense: 'enterprise',
        minRole: 'admin',
    },
    {
        id: 'backup',
        name: 'Backup',
        fullName: 'Backup Manager',
        description: 'Manage system backups and restoration',
        category: 'utilities',
        icon: 'archive',
        path: '/backup',
        enabled: true,
        version: '0.1.0',
        author: 'QUOX Core',
        badge: null,
        requiredLicense: 'enterprise',
        minRole: 'admin',
    },
];

/**
 * Get all extensions
 */
export function getExtensions() {
    return DEFAULT_EXTENSIONS.map(ext => ({ ...ext }));
}

/**
 * Get only enabled extensions
 */
export function getEnabledExtensions() {
    return getExtensions().filter(ext => ext.enabled);
}

/**
 * Get extensions grouped by category
 */
export function getExtensionsByCategory() {
    const extensions = getExtensions();
    const grouped = {};

    // Initialize categories in order
    Object.values(EXTENSION_CATEGORIES)
        .sort((a, b) => a.order - b.order)
        .forEach(cat => {
            grouped[cat.id] = {
                ...cat,
                extensions: []
            };
        });

    // Group extensions
    extensions.forEach(ext => {
        if (grouped[ext.category]) {
            grouped[ext.category].extensions.push(ext);
        }
    });

    // Filter out empty categories
    return Object.values(grouped).filter(cat => cat.extensions.length > 0);
}

/**
 * Get enabled extensions grouped by category
 * @param {string} [role] - Optional user role to filter by minRole
 */
export function getEnabledExtensionsByCategory(role) {
    let extensions = getEnabledExtensions();

    // Filter by role if provided
    if (role !== undefined) {
        extensions = extensions.filter(ext =>
            !ext.minRole || hasRoleLevel(role, ext.minRole)
        );
    }

    const grouped = {};

    Object.values(EXTENSION_CATEGORIES)
        .sort((a, b) => a.order - b.order)
        .forEach(cat => {
            grouped[cat.id] = {
                ...cat,
                extensions: []
            };
        });

    extensions.forEach(ext => {
        if (grouped[ext.category]) {
            grouped[ext.category].extensions.push(ext);
        }
    });

    return Object.values(grouped).filter(cat => cat.extensions.length > 0);
}

/**
 * Get a specific extension by ID
 */
export function getExtension(extensionId) {
    return getExtensions().find(e => e.id === extensionId);
}

/**
 * Search extensions by name or description
 */
export function searchExtensions(query) {
    const lowerQuery = query.toLowerCase();
    return getExtensions().filter(ext =>
        ext.name.toLowerCase().includes(lowerQuery) ||
        ext.fullName.toLowerCase().includes(lowerQuery) ||
        ext.description.toLowerCase().includes(lowerQuery)
    );
}

/**
 * Register a custom extension dynamically
 * (For third-party plugins or runtime additions)
 */
export function registerExtension(extension) {
    // Validate required fields
    const required = ['id', 'name', 'path', 'icon', 'category'];
    for (const field of required) {
        if (!extension[field]) {
            throw new Error(`Extension missing required field: ${field}`);
        }
    }

    // Check for duplicate ID
    if (DEFAULT_EXTENSIONS.find(e => e.id === extension.id)) {
        throw new Error(`Extension with ID "${extension.id}" already exists`);
    }

    // Add to runtime extensions
    DEFAULT_EXTENSIONS.push({
        enabled: true,
        version: '1.0.0',
        author: 'Custom',
        badge: null,
        requiredLicense: null,
        ...extension
    });
}

// Export default for convenience
export default {
    EXTENSION_CATEGORIES,
    getExtensions,
    getEnabledExtensions,
    getExtensionsByCategory,
    getEnabledExtensionsByCategory,
    getExtension,
    searchExtensions,
    registerExtension
};
