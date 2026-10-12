/**
 * Workflow Library Service
 *
 * Manages a library of workflow templates with AEE-compatible manifests.
 * Enables uniform discovery alongside agents, assistants, and tools.
 *
 * Key Features:
 * - Parse n8n workflow JSON and auto-generate AEE manifests
 * - Index workflows for fast search and discovery
 * - Category and tag-based filtering
 * - Integration detection (telegram, slack, openai, etc.)
 * - Capability extraction for assistant matching
 */

import workflowLibraryIndexUrl from '../config/workflow-library-index.json?url'

// Category mapping from folder names to AEE categories
const FOLDER_TO_CATEGORY = {
    'AI_Research_RAG_and_Data_Analysis': 'ai-llm',
    'Airtable': 'integration',
    'Database_and_Storage': 'data-processing',
    'Discord': 'communication',
    'Forms_and_Surveys': 'integration',
    'Gmail_and_Email_Automation': 'communication',
    'Google_Drive_and_Google_Sheets': 'productivity',
    'HR_and_Recruitment': 'automation',
    'Instagram_Twitter_Social_Media': 'communication',
    'Notion': 'productivity',
    'OpenAI_and_LLMs': 'ai-llm',
    'Other_Workflows': 'other',
    'Old Workflows': 'other',
    'PDF_and_Document_Processing': 'data-processing',
    'Slack': 'communication',
    'Telegram': 'communication',
    'Whatsapp': 'communication',
    'Wordpress': 'integration',
    'monitoring': 'monitoring',
    'security': 'security',
    'devops': 'devops',
    'notification': 'notification',
    'automation': 'automation'
};

// Node type to integration mapping
const NODE_TO_INTEGRATION = {
    'n8n-nodes-base.telegram': 'telegram',
    'n8n-nodes-base.slack': 'slack',
    'n8n-nodes-base.discord': 'discord',
    'n8n-nodes-base.gmail': 'gmail',
    'n8n-nodes-base.googleSheets': 'google-sheets',
    'n8n-nodes-base.googleDrive': 'google-drive',
    'n8n-nodes-base.notion': 'notion',
    'n8n-nodes-base.airtable': 'airtable',
    'n8n-nodes-base.github': 'github',
    'n8n-nodes-base.gitlab': 'gitlab',
    'n8n-nodes-base.jira': 'jira',
    'n8n-nodes-base.trello': 'trello',
    'n8n-nodes-base.asana': 'asana',
    'n8n-nodes-base.wordpress': 'wordpress',
    'n8n-nodes-base.twitter': 'twitter',
    'n8n-nodes-base.instagram': 'instagram',
    'n8n-nodes-base.facebook': 'facebook',
    'n8n-nodes-base.whatsapp': 'whatsapp',
    'n8n-nodes-base.postgres': 'postgres',
    'n8n-nodes-base.mysql': 'mysql',
    'n8n-nodes-base.mongodb': 'mongodb',
    'n8n-nodes-base.redis': 'redis',
    'n8n-nodes-base.elasticsearch': 'elasticsearch',
    '@n8n/n8n-nodes-langchain.lmChatOpenAi': 'openai',
    '@n8n/n8n-nodes-langchain.lmChatAnthropic': 'anthropic',
    '@n8n/n8n-nodes-langchain.agent': 'langchain',
    '@n8n/n8n-nodes-langchain.vectorStoreQdrant': 'qdrant',
    '@n8n/n8n-nodes-langchain.vectorStorePinecone': 'pinecone',
    'n8n-nodes-base.httpRequest': 'http',
    'n8n-nodes-base.webhook': 'webhook',
    'n8n-nodes-base.ssh': 'ssh',
    'n8n-nodes-base.awsS3': 'aws-s3',
    'n8n-nodes-base.awsLambda': 'aws-lambda',
    'n8n-nodes-base.stripe': 'stripe',
    'n8n-nodes-base.shopify': 'shopify',
    'n8n-nodes-base.hubspot': 'hubspot',
    'n8n-nodes-base.salesforce': 'salesforce',
    'n8n-nodes-base.zendesk': 'zendesk',
    'n8n-nodes-base.twilio': 'twilio'
};

// Trigger node types
const TRIGGER_NODES = {
    'n8n-nodes-base.manualTrigger': 'manual',
    'n8n-nodes-base.scheduleTrigger': 'schedule',
    'n8n-nodes-base.cron': 'schedule',
    'n8n-nodes-base.webhook': 'webhook',
    'n8n-nodes-base.telegramTrigger': 'webhook',
    'n8n-nodes-base.slackTrigger': 'webhook',
    'n8n-nodes-base.gmailTrigger': 'event',
    'n8n-nodes-base.googleSheetsTrigger': 'event',
    'n8n-nodes-base.githubTrigger': 'webhook'
};

// Action keywords for capability extraction
const ACTION_KEYWORDS = {
    'send': 'send-notification',
    'notify': 'send-notification',
    'alert': 'send-notification',
    'email': 'send-email',
    'message': 'send-message',
    'fetch': 'fetch-data',
    'get': 'fetch-data',
    'read': 'read-data',
    'create': 'create-resource',
    'update': 'update-resource',
    'delete': 'delete-resource',
    'transform': 'transform-data',
    'convert': 'transform-data',
    'analyze': 'analyze-data',
    'process': 'process-data',
    'monitor': 'monitor',
    'check': 'health-check',
    'backup': 'backup',
    'sync': 'sync-data',
    'import': 'import-data',
    'export': 'export-data',
    'generate': 'generate-content',
    'summarize': 'summarize',
    'translate': 'translate',
    'extract': 'extract-data',
    'scrape': 'scrape-web',
    'schedule': 'schedule-task',
    'automate': 'automate-task'
};

// In-memory workflow library index
let workflowIndex = [];
let libraryInitialized = false;
let workflowLibraryIndexPromise = null

export async function loadWorkflowLibraryIndex() {
    if (workflowLibraryIndexPromise) {
        return workflowLibraryIndexPromise
    }

    workflowLibraryIndexPromise = fetch(workflowLibraryIndexUrl)
        .then(async (response) => {
            if (!response.ok) {
                throw new Error(`Failed to load workflow library index: ${response.status} ${response.statusText}`)
            }
            return response.json()
        })
        .catch((err) => {
            workflowLibraryIndexPromise = null
            throw err
        })

    return workflowLibraryIndexPromise
}

/**
 * Normalize a workflow name to a valid ID
 */
function normalizeToId(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 60);
}

/**
 * Extract tags from workflow name and description
 */
function extractTags(name, nodes = []) {
    const tags = new Set();
    const text = name.toLowerCase();

    // Extract from name
    const keywords = [
        'ai', 'chatbot', 'bot', 'automation', 'sync', 'backup',
        'alert', 'notification', 'monitor', 'scrape', 'api',
        'webhook', 'scheduled', 'rag', 'llm', 'gpt', 'claude',
        'data', 'report', 'dashboard', 'integration', 'workflow'
    ];

    keywords.forEach(kw => {
        if (text.includes(kw)) tags.add(kw);
    });

    // Extract integration names from node types
    nodes.forEach(node => {
        const integration = NODE_TO_INTEGRATION[node.type];
        if (integration) tags.add(integration);
    });

    return Array.from(tags);
}

/**
 * Extract actions from workflow name
 */
function extractActions(name) {
    const actions = new Set();
    const words = name.toLowerCase().split(/\s+/);

    words.forEach(word => {
        Object.entries(ACTION_KEYWORDS).forEach(([keyword, action]) => {
            if (word.includes(keyword)) actions.add(action);
        });
    });

    return Array.from(actions);
}

/**
 * Detect trigger type from workflow nodes
 */
function detectTriggerType(nodes = []) {
    for (const node of nodes) {
        const triggerType = TRIGGER_NODES[node.type];
        if (triggerType) return triggerType;
    }
    return 'manual';
}

/**
 * Extract integrations from workflow nodes
 */
function extractIntegrations(nodes = []) {
    const integrations = new Set();

    nodes.forEach(node => {
        const integration = NODE_TO_INTEGRATION[node.type];
        if (integration) integrations.add(integration);
    });

    return Array.from(integrations);
}

/**
 * Extract node types from workflow
 */
function extractNodeTypes(nodes = []) {
    return [...new Set(nodes.map(n => n.type))];
}

/**
 * Generate AEE intents from workflow characteristics
 */
function generateIntents(category, integrations, actions) {
    const intents = [];

    // Category-based intents
    const categoryIntents = {
        'monitoring': ['ops.monitor.check', 'ops.alert.send'],
        'automation': ['workflow.execute', 'task.automate'],
        'integration': ['data.sync', 'service.integrate'],
        'notification': ['notify.send', 'notify.alert'],
        'data-processing': ['data.transform', 'data.process'],
        'ai-llm': ['ai.generate', 'ai.analyze', 'ai.chat'],
        'security': ['security.scan', 'security.alert'],
        'devops': ['devops.deploy', 'devops.build'],
        'communication': ['message.send', 'channel.notify'],
        'productivity': ['doc.create', 'task.manage']
    };

    if (categoryIntents[category]) {
        intents.push(...categoryIntents[category]);
    }

    // Integration-specific intents
    integrations.forEach(integration => {
        intents.push(`integration.${integration}.execute`);
    });

    return [...new Set(intents)];
}

/**
 * Determine DEFCON level from workflow characteristics
 */
function determineDefconLevel(integrations, actions) {
    // Destructive actions
    if (actions.includes('delete-resource')) return 'AMBER';

    // External service access
    if (integrations.length > 0) return 'BLUE';

    // Data modification
    if (actions.includes('update-resource') || actions.includes('create-resource')) return 'BLUE';

    return 'GREEN';
}

/**
 * Generate an AEE-compatible manifest from an n8n workflow JSON
 */
export function generateManifestFromN8n(n8nWorkflow, sourceCategory = null, sourcePath = null) {
    const { name, nodes = [], id: n8nId } = n8nWorkflow;

    // Extract characteristics
    const triggerType = detectTriggerType(nodes);
    const integrations = extractIntegrations(nodes);
    const nodeTypes = extractNodeTypes(nodes);
    const tags = extractTags(name, nodes);
    const actions = extractActions(name);
    const category = sourceCategory || 'other';

    // Generate manifest ID
    const manifestId = normalizeToId(name);

    // Generate intents
    const intents = generateIntents(category, integrations, actions);

    // Determine safety
    const defconLevel = determineDefconLevel(integrations, actions);
    const hasExternalAccess = integrations.length > 0;

    // Build the AEE-compatible manifest
    const manifest = {
        $schema: '../schemas/workflow.schema.json',
        v: '1.0',
        type: 'workflow',
        id: manifestId,

        identity: {
            name: name,
            shortName: name.length > 30 ? name.substring(0, 27) + '...' : name,
            description: `Workflow for ${name.toLowerCase()}. Uses ${integrations.join(', ') || 'built-in nodes'}.`,
            useCases: actions.map(a => `Can ${a.replace(/-/g, ' ')}`),
            category: category,
            tags: tags,
            icon: getCategoryIcon(category),
            color: getCategoryColor(category)
        },

        capabilities: {
            intents: intents,
            actions: actions,
            integrations: integrations,
            nodeTypes: nodeTypes
        },

        trigger: {
            type: triggerType
        },

        outputs: {
            type: determineOutputType(nodes, integrations),
            destinations: integrations.filter(i =>
                ['telegram', 'slack', 'discord', 'email', 'gmail'].includes(i)
            )
        },

        ownership: {
            scope: 'personal',
            source: 'imported',
            author: 'AI Agent Vault'
        },

        safety: {
            defconLevel: defconLevel,
            requiresApproval: defconLevel !== 'GREEN',
            externalAccess: hasExternalAccess,
            credentialsRequired: integrations
        },

        execution: {
            engine: 'quoxflow'
        },

        workflowFile: sourcePath,

        metadata: {
            version: '1.0.0',
            importedFrom: sourcePath,
            originalName: name
        }
    };

    return manifest;
}

/**
 * Get icon for category
 */
function getCategoryIcon(category) {
    const icons = {
        'monitoring': 'activity',
        'automation': 'zap',
        'integration': 'link',
        'notification': 'bell',
        'data-processing': 'database',
        'ai-llm': 'brain',
        'security': 'shield',
        'devops': 'git-branch',
        'communication': 'message-circle',
        'productivity': 'folder',
        'other': 'box'
    };
    return icons[category] || 'box';
}

/**
 * Get color for category
 */
function getCategoryColor(category) {
    const colors = {
        'monitoring': '#10b981',
        'automation': '#f59e0b',
        'integration': '#6366f1',
        'notification': '#ef4444',
        'data-processing': '#8b5cf6',
        'ai-llm': '#ec4899',
        'security': '#3b82f6',
        'devops': '#14b8a6',
        'communication': '#06b6d4',
        'productivity': '#84cc16',
        'other': '#6b7280'
    };
    return colors[category] || '#6b7280';
}

/**
 * Determine output type from nodes
 */
function determineOutputType(nodes, integrations) {
    // Check for notification integrations
    const notifyIntegrations = ['telegram', 'slack', 'discord', 'email', 'gmail', 'twilio'];
    if (integrations.some(i => notifyIntegrations.includes(i))) {
        return 'notification';
    }

    // Check for data output nodes
    const dataNodes = nodes.filter(n =>
        n.type.includes('Sheet') ||
        n.type.includes('database') ||
        n.type.includes('Store')
    );
    if (dataNodes.length > 0) return 'data';

    return 'action';
}

/**
 * Search workflows in the library
 */
export function searchWorkflows(query, options = {}) {
    const {
        category = null,
        integrations = [],
        tags = [],
        source = null,
        limit = 50,
        offset = 0
    } = options;

    let results = [...workflowIndex];

    // Source filter — 'quox-curated' | 'n8n-imported' | null (all)
    if (source) {
        results = results.filter(w => w.source === source);
    }

    // Text search
    if (query) {
        const q = query.toLowerCase();
        results = results.filter(w =>
            w.identity.name.toLowerCase().includes(q) ||
            w.identity.description.toLowerCase().includes(q) ||
            w.identity.tags.some(t => t.includes(q)) ||
            w.capabilities.integrations.some(i => i.includes(q))
        );
    }

    // Category filter
    if (category) {
        results = results.filter(w => w.identity.category === category);
    }

    // Integration filter
    if (integrations.length > 0) {
        results = results.filter(w =>
            integrations.some(i => w.capabilities.integrations.includes(i))
        );
    }

    // Tag filter
    if (tags.length > 0) {
        results = results.filter(w =>
            tags.some(t => w.identity.tags.includes(t))
        );
    }

    // Pagination
    const total = results.length;
    results = results.slice(offset, offset + limit);

    return {
        workflows: results,
        total,
        offset,
        limit,
        hasMore: offset + limit < total
    };
}

/**
 * Get workflow by ID
 */
export function getWorkflow(id) {
    return workflowIndex.find(w => w.id === id);
}

/**
 * Get all unique categories
 */
export function getCategories() {
    const categories = new Map();

    workflowIndex.forEach(w => {
        const cat = w.identity.category;
        if (!categories.has(cat)) {
            categories.set(cat, {
                id: cat,
                name: cat.charAt(0).toUpperCase() + cat.slice(1).replace(/-/g, ' '),
                count: 0,
                icon: getCategoryIcon(cat),
                color: getCategoryColor(cat)
            });
        }
        categories.get(cat).count++;
    });

    return Array.from(categories.values()).sort((a, b) => b.count - a.count);
}

/**
 * Get all unique integrations
 */
export function getIntegrations() {
    const integrations = new Map();

    workflowIndex.forEach(w => {
        w.capabilities.integrations.forEach(i => {
            if (!integrations.has(i)) {
                integrations.set(i, { name: i, count: 0 });
            }
            integrations.get(i).count++;
        });
    });

    return Array.from(integrations.values()).sort((a, b) => b.count - a.count);
}

/**
 * Get popular tags
 */
export function getPopularTags(limit = 20) {
    const tags = new Map();

    workflowIndex.forEach(w => {
        w.identity.tags.forEach(t => {
            if (!tags.has(t)) {
                tags.set(t, { name: t, count: 0 });
            }
            tags.get(t).count++;
        });
    });

    return Array.from(tags.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
}

/**
 * Get library statistics
 */
export function getLibraryStats() {
    return {
        totalWorkflows: workflowIndex.length,
        categories: getCategories(),
        integrations: getIntegrations(),
        topTags: getPopularTags(10),
        initialized: libraryInitialized
    };
}

/**
 * Add a workflow to the library index
 */
export function addWorkflow(manifest) {
    // Check for duplicate
    const existing = workflowIndex.findIndex(w => w.id === manifest.id);
    if (existing >= 0) {
        // Update with unique ID
        manifest.id = manifest.id + '-' + Date.now().toString(36);
    }
    workflowIndex.push(manifest);
    return manifest;
}

/**
 * Initialize library from pre-indexed data
 */
export function initializeLibrary(workflows) {
    workflowIndex = workflows;
    libraryInitialized = true;
    console.log(`[WorkflowLibrary] Initialized with ${workflows.length} workflows`);
}

/**
 * Clear the library
 */
export function clearLibrary() {
    workflowIndex = [];
    libraryInitialized = false;
}

/**
 * Export for module
 */
export default {
    generateManifestFromN8n,
    searchWorkflows,
    getWorkflow,
    getCategories,
    getIntegrations,
    getPopularTags,
    getLibraryStats,
    addWorkflow,
    initializeLibrary,
    clearLibrary,
    FOLDER_TO_CATEGORY
};
