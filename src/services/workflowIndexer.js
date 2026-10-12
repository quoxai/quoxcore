/**
 * Workflow Indexer (Browser-based)
 *
 * Processes n8n workflow JSON files and generates AEE-compatible manifests.
 * Used for importing ZIP files or folders of workflows into the library.
 */

// Node type to integration mapping
const NODE_TO_INTEGRATION = {
    'n8n-nodes-base.telegram': 'telegram',
    'n8n-nodes-base.telegramTrigger': 'telegram',
    'n8n-nodes-base.slack': 'slack',
    'n8n-nodes-base.slackTrigger': 'slack',
    'n8n-nodes-base.discord': 'discord',
    'n8n-nodes-base.gmail': 'gmail',
    'n8n-nodes-base.gmailTrigger': 'gmail',
    'n8n-nodes-base.googleSheets': 'google-sheets',
    'n8n-nodes-base.googleSheetsTrigger': 'google-sheets',
    'n8n-nodes-base.googleDrive': 'google-drive',
    'n8n-nodes-base.notion': 'notion',
    'n8n-nodes-base.airtable': 'airtable',
    'n8n-nodes-base.github': 'github',
    'n8n-nodes-base.githubTrigger': 'github',
    'n8n-nodes-base.gitlab': 'gitlab',
    'n8n-nodes-base.jira': 'jira',
    'n8n-nodes-base.trello': 'trello',
    'n8n-nodes-base.asana': 'asana',
    'n8n-nodes-base.wordpress': 'wordpress',
    'n8n-nodes-base.twitter': 'twitter',
    'n8n-nodes-base.instagram': 'instagram',
    'n8n-nodes-base.facebook': 'facebook',
    'n8n-nodes-base.whatsapp': 'whatsapp',
    'n8n-nodes-base.whatsappTrigger': 'whatsapp',
    'n8n-nodes-base.postgres': 'postgres',
    'n8n-nodes-base.mysql': 'mysql',
    'n8n-nodes-base.mongodb': 'mongodb',
    'n8n-nodes-base.redis': 'redis',
    'n8n-nodes-base.elasticsearch': 'elasticsearch',
    '@n8n/n8n-nodes-langchain.lmChatOpenAi': 'openai',
    '@n8n/n8n-nodes-langchain.openAi': 'openai',
    '@n8n/n8n-nodes-langchain.lmChatAnthropic': 'anthropic',
    '@n8n/n8n-nodes-langchain.agent': 'langchain',
    '@n8n/n8n-nodes-langchain.vectorStoreQdrant': 'qdrant',
    '@n8n/n8n-nodes-langchain.vectorStorePinecone': 'pinecone',
    '@n8n/n8n-nodes-langchain.chainLlm': 'langchain',
    '@n8n/n8n-nodes-langchain.memoryBufferWindow': 'langchain',
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
    'n8n-nodes-base.interval': 'schedule',
    'n8n-nodes-base.webhook': 'webhook',
    'n8n-nodes-base.telegramTrigger': 'webhook',
    'n8n-nodes-base.slackTrigger': 'webhook',
    'n8n-nodes-base.gmailTrigger': 'event',
    'n8n-nodes-base.googleSheetsTrigger': 'event',
    'n8n-nodes-base.githubTrigger': 'webhook',
    'n8n-nodes-base.whatsappTrigger': 'webhook',
    'n8n-nodes-base.notionTrigger': 'event'
};

// Action keywords
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
    'automate': 'automate-task',
    'chatbot': 'chatbot',
    'bot': 'chatbot',
    'rag': 'rag',
    'ai': 'ai-assistant'
};

// Category configuration (shared across components)
export const CATEGORY_CONFIG = {
    'monitoring': { icon: '📊', color: '#10b981' },
    'automation': { icon: '⚡', color: '#f59e0b' },
    'integration': { icon: '🔗', color: '#6366f1' },
    'notification': { icon: '🔔', color: '#ef4444' },
    'data-processing': { icon: '🗄️', color: '#8b5cf6' },
    'ai-llm': { icon: '🧠', color: '#ec4899' },
    'security': { icon: '🛡️', color: '#3b82f6' },
    'devops': { icon: '🔧', color: '#14b8a6' },
    'communication': { icon: '💬', color: '#06b6d4' },
    'productivity': { icon: '📁', color: '#84cc16' },
    'other': { icon: '📦', color: '#6b7280' }
};

/**
 * Normalize name to ID
 */
function normalizeToId(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 60);
}

/**
 * Extract tags from name and nodes
 */
function extractTags(name, nodes = []) {
    const tags = new Set();
    const text = name.toLowerCase();

    const keywords = [
        'ai', 'chatbot', 'bot', 'automation', 'sync', 'backup',
        'alert', 'notification', 'monitor', 'scrape', 'api',
        'webhook', 'scheduled', 'rag', 'llm', 'gpt', 'claude',
        'data', 'report', 'dashboard', 'integration', 'workflow',
        'pdf', 'document', 'image', 'video', 'audio', 'voice',
        'lead', 'sales', 'marketing', 'crm', 'hr', 'recruitment'
    ];

    keywords.forEach(kw => {
        if (text.includes(kw)) tags.add(kw);
    });

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
 * Detect trigger type from nodes
 */
function detectTriggerType(nodes = []) {
    for (const node of nodes) {
        const triggerType = TRIGGER_NODES[node.type];
        if (triggerType) return triggerType;
    }
    return 'manual';
}

/**
 * Extract integrations from nodes
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
 * Extract unique node types
 */
function extractNodeTypes(nodes = []) {
    return [...new Set(nodes.map(n => n.type).filter(Boolean))];
}

/**
 * Generate intents based on category and integrations
 */
function generateIntents(category, integrations, actions) {
    const intents = [];

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

    integrations.forEach(integration => {
        intents.push(`integration.${integration}.execute`);
    });

    return [...new Set(intents)];
}

/**
 * Determine DEFCON safety level
 */
function determineDefconLevel(integrations, actions) {
    if (actions.includes('delete-resource')) return 'AMBER';
    if (integrations.length > 0) return 'BLUE';
    if (actions.includes('update-resource') || actions.includes('create-resource')) return 'BLUE';
    return 'GREEN';
}

/**
 * Determine output type
 */
function determineOutputType(nodes, integrations) {
    const notifyIntegrations = ['telegram', 'slack', 'discord', 'email', 'gmail', 'twilio'];
    if (integrations.some(i => notifyIntegrations.includes(i))) {
        return 'notification';
    }
    return 'action';
}

/**
 * Infer category from workflow content
 */
export function inferCategory(workflow) {
    const name = (workflow.name || '').toLowerCase();
    const nodes = workflow.nodes || [];
    const integrations = extractIntegrations(nodes);

    // AI/LLM workflows
    if (integrations.some(i => ['openai', 'anthropic', 'langchain', 'qdrant', 'pinecone'].includes(i))) {
        return 'ai-llm';
    }
    if (name.includes('ai') || name.includes('llm') || name.includes('gpt') || name.includes('rag')) {
        return 'ai-llm';
    }

    // Communication
    if (integrations.some(i => ['telegram', 'slack', 'discord', 'gmail', 'whatsapp'].includes(i))) {
        return 'communication';
    }

    // Productivity
    if (integrations.some(i => ['notion', 'google-sheets', 'google-drive', 'airtable'].includes(i))) {
        return 'productivity';
    }

    // Data processing
    if (name.includes('pdf') || name.includes('document') || name.includes('transform') || name.includes('etl')) {
        return 'data-processing';
    }

    // Integration
    if (integrations.some(i => ['github', 'gitlab', 'jira', 'hubspot', 'salesforce'].includes(i))) {
        return 'integration';
    }

    // Automation
    if (name.includes('automat') || name.includes('schedule') || name.includes('backup')) {
        return 'automation';
    }

    // Monitoring
    if (name.includes('monitor') || name.includes('alert') || name.includes('check')) {
        return 'monitoring';
    }

    return 'other';
}

/**
 * Clean filename to human-readable name
 */
function cleanFilename(filename) {
    return filename
        .replace(/\.json$/i, '')
        .replace(/_/g, ' ')
        .replace(/-/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Generate AEE-compatible manifest from n8n workflow
 */
export function generateManifest(n8nWorkflow, options = {}) {
    const {
        category = inferCategory(n8nWorkflow),
        source = 'imported',
        author = 'User Import',
        filePath = ''
    } = options;

    const nodes = n8nWorkflow.nodes || [];
    // Use workflow name, or clean filename as fallback
    const filename = filePath.split('/').pop() || '';
    const name = n8nWorkflow.name || cleanFilename(filename) || 'Unnamed Workflow';

    const triggerType = detectTriggerType(nodes);
    const integrations = extractIntegrations(nodes);
    const nodeTypes = extractNodeTypes(nodes);
    const tags = extractTags(name, nodes);
    const actions = extractActions(name);
    const intents = generateIntents(category, integrations, actions);
    const defconLevel = determineDefconLevel(integrations, actions);
    const config = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.other;

    return {
        v: '1.0',
        type: 'workflow',
        id: normalizeToId(name),

        identity: {
            name: name,
            shortName: name.length > 30 ? name.substring(0, 27) + '...' : name,
            description: `${name}. Uses ${integrations.length > 0 ? integrations.join(', ') : 'built-in nodes'}.`,
            useCases: actions.slice(0, 5).map(a => `Can ${a.replace(/-/g, ' ')}`),
            category: category,
            tags: tags,
            icon: config.icon,
            color: config.color
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
            source: source,
            author: author
        },

        safety: {
            defconLevel: defconLevel,
            requiresApproval: defconLevel !== 'GREEN',
            externalAccess: integrations.length > 0,
            credentialsRequired: integrations
        },

        execution: {
            engine: 'n8n'
        },

        workflowFile: filePath,
        n8nWorkflowJson: n8nWorkflow,

        metadata: {
            version: '1.0.0',
            importedFrom: filePath,
            originalName: name,
            indexedAt: new Date().toISOString()
        }
    };
}

/**
 * Check if content looks like n8n workflow JSON
 */
export function isN8nWorkflow(content) {
    try {
        const json = typeof content === 'string' ? JSON.parse(content) : content;
        // n8n workflows have nodes array and typically connections
        return json && Array.isArray(json.nodes);
    } catch {
        return false;
    }
}

/**
 * Process multiple workflows and generate index
 */
export function indexWorkflows(workflows, options = {}) {
    const {
        source = 'imported',
        author = 'User Import',
        collectionName = 'Imported Collection'
    } = options;

    const manifests = [];
    const usedIds = new Set();
    const categoryStats = {};
    const errors = [];

    for (const { content, path } of workflows) {
        try {
            const json = typeof content === 'string' ? JSON.parse(content) : content;

            if (!isN8nWorkflow(json)) {
                errors.push({ path, error: 'Not a valid n8n workflow' });
                continue;
            }

            const manifest = generateManifest(json, {
                source,
                author,
                filePath: path
            });

            // Ensure unique ID
            let finalId = manifest.id;
            let counter = 1;
            while (usedIds.has(finalId)) {
                finalId = `${manifest.id}-${counter}`;
                counter++;
            }
            manifest.id = finalId;
            usedIds.add(finalId);

            manifests.push(manifest);

            // Track category stats
            const cat = manifest.identity.category;
            categoryStats[cat] = (categoryStats[cat] || 0) + 1;
        } catch (err) {
            errors.push({ path, error: err.message });
        }
    }

    return {
        version: '1.0',
        generatedAt: new Date().toISOString(),
        source: collectionName,
        totalWorkflows: manifests.length,
        categories: categoryStats,
        workflows: manifests,
        errors: errors
    };
}

export default {
    generateManifest,
    inferCategory,
    isN8nWorkflow,
    indexWorkflows
};
