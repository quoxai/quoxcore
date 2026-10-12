#!/usr/bin/env node
/**
 * Workflow Library Indexer
 *
 * Scans a directory of n8n workflow JSON files and generates
 * AEE-compatible manifests for the workflow library.
 *
 * Usage:
 *   node scripts/index-workflows.js [source-dir] [output-file]
 *
 * Default source: /opt/quoxcore/uploads/AI_Agent_Vault_extracted/AI_Agent_Vault-main
 * Default output: src/config/workflow-library-index.json
 */

const fs = require('fs');
const path = require('path');

// Category mapping from folder names
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
    'Wordpress': 'integration'
};

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
 * Extract tags
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
 * Extract actions
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
 * Detect trigger type
 */
function detectTriggerType(nodes = []) {
    for (const node of nodes) {
        const triggerType = TRIGGER_NODES[node.type];
        if (triggerType) return triggerType;
    }
    return 'manual';
}

/**
 * Extract integrations
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
 * Extract node types
 */
function extractNodeTypes(nodes = []) {
    return [...new Set(nodes.map(n => n.type).filter(Boolean))];
}

/**
 * Generate intents
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
 * Determine DEFCON level
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
 * Generate manifest from n8n workflow
 */
function generateManifest(n8nWorkflow, category, relativePath) {
    const nodes = n8nWorkflow.nodes || [];
    // Use workflow name, or clean filename as fallback
    const filename = path.basename(relativePath);
    const name = n8nWorkflow.name || cleanFilename(filename);

    const triggerType = detectTriggerType(nodes);
    const integrations = extractIntegrations(nodes);
    const nodeTypes = extractNodeTypes(nodes);
    const tags = extractTags(name, nodes);
    const actions = extractActions(name);
    const intents = generateIntents(category, integrations, actions);
    const defconLevel = determineDefconLevel(integrations, actions);

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
            externalAccess: integrations.length > 0,
            credentialsRequired: integrations
        },

        execution: {
            engine: 'n8n'
        },

        n8nWorkflowFile: relativePath,

        // Store node count for preview (full JSON loaded on demand)
        n8nNodeCount: (n8nWorkflow.nodes || []).length,

        metadata: {
            version: '1.0.0',
            importedFrom: relativePath,
            originalName: name,
            indexedAt: new Date().toISOString()
        }
    };
}

/**
 * Walk directory recursively
 */
function walkDir(dir, callback, basePath = '') {
    const files = fs.readdirSync(dir);

    for (const file of files) {
        const filePath = path.join(dir, file);
        const relativePath = path.join(basePath, file);
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
            walkDir(filePath, callback, relativePath);
        } else if (file.endsWith('.json') && !file.startsWith('.')) {
            callback(filePath, relativePath, path.basename(basePath));
        }
    }
}

/**
 * Main indexer
 */
function indexWorkflows(sourceDir, outputFile) {
    console.log(`\n[WorkflowIndexer] Starting indexing...`);
    console.log(`  Source: ${sourceDir}`);
    console.log(`  Output: ${outputFile}\n`);

    const manifests = [];
    const usedIds = new Set();
    let processed = 0;
    let failed = 0;
    const categoryStats = {};

    walkDir(sourceDir, (filePath, relativePath, folderName) => {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const workflow = JSON.parse(content);

            // Get category from folder
            const category = FOLDER_TO_CATEGORY[folderName] || 'other';

            // Generate manifest
            const manifest = generateManifest(workflow, category, relativePath);

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
            processed++;

            // Track category stats
            categoryStats[category] = (categoryStats[category] || 0) + 1;

            if (processed % 100 === 0) {
                process.stdout.write(`  Processed: ${processed}\r`);
            }
        } catch (err) {
            failed++;
            // Silently skip invalid files
        }
    });

    console.log(`\n[WorkflowIndexer] Indexing complete:`);
    console.log(`  Total processed: ${processed}`);
    console.log(`  Failed: ${failed}`);
    console.log(`\n  By category:`);
    Object.entries(categoryStats)
        .sort((a, b) => b[1] - a[1])
        .forEach(([cat, count]) => {
            console.log(`    ${cat}: ${count}`);
        });

    // Create output
    const output = {
        version: '1.0',
        generatedAt: new Date().toISOString(),
        source: sourceDir,
        totalWorkflows: manifests.length,
        categories: categoryStats,
        workflows: manifests
    };

    // Ensure output directory exists
    const outDir = path.dirname(outputFile);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
    console.log(`\n  Output written to: ${outputFile}`);
    console.log(`  File size: ${(fs.statSync(outputFile).size / 1024 / 1024).toFixed(2)} MB\n`);
}

// CLI
const args = process.argv.slice(2);
const sourceDir = args[0] || '/opt/quoxcore/uploads/AI_Agent_Vault_extracted/AI_Agent_Vault-main';
const outputFile = args[1] || path.join(__dirname, '../src/config/workflow-library-index.json');

if (!fs.existsSync(sourceDir)) {
    console.error(`Error: Source directory not found: ${sourceDir}`);
    process.exit(1);
}

indexWorkflows(sourceDir, outputFile);
