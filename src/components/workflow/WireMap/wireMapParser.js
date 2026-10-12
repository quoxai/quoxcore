/**
 * WireMap Parser - Converts workflow JSON to normalized graph format
 *
 * Supports both QuoxFlow format ({ nodes, edges }) and legacy n8n format
 * ({ nodes, connections }). Auto-detects which format is provided.
 */

// Node category mapping
const NODE_CATEGORIES = {
    trigger: ['trigger', 'cron', 'schedule', 'interval', 'webhook', 'start'],
    logic: ['if', 'switch', 'merge', 'split', 'filter', 'loop', 'wait', 'code', 'function', 'set', 'condition'],
    io: ['httpRequest', 'ssh', 'ftp', 'executeCommand', 'call'],
    storage: ['postgres', 'mysql', 'mongodb', 'redis', 'googleSheets', 'airtable', 'notion'],
    notify: ['telegram', 'slack', 'email', 'gmail', 'discord', 'twilio', 'sms'],
    ai: ['openai', 'anthropic', 'langchain', 'agent', 'llm', 'embedding', 'vector'],
    transform: ['json', 'xml', 'csv', 'html', 'markdown', 'spreadsheet', 'pdf', 'set', 'aggregate']
};

// Sensitive keys to redact
const SENSITIVE_KEYS = [
    'token', 'apikey', 'api_key', 'authorization', 'password', 'secret',
    'cookie', 'bearer', 'credential', 'key', 'auth', 'private'
];

/**
 * Determine node category from type
 */
export function getNodeCategory(nodeType) {
    if (!nodeType) return 'other';
    const typeLower = nodeType.toLowerCase();

    for (const [category, keywords] of Object.entries(NODE_CATEGORIES)) {
        if (keywords.some(kw => typeLower.includes(kw))) {
            return category;
        }
    }
    return 'other';
}

/**
 * Get short type name from full type string
 * Handles both QuoxFlow types (trigger:webhook, call, data:transform)
 * and legacy n8n types (n8n-nodes-base.httpRequest)
 */
export function getShortType(nodeType) {
    if (!nodeType) return 'unknown';
    // QuoxFlow types — already short
    if (nodeType.includes(':') && !nodeType.includes('n8n')) {
        return nodeType.replace(/^(trigger|flow|data|error|util|proxy):/, '');
    }
    // Legacy n8n types
    return nodeType
        .replace('n8n-nodes-base.', '')
        .replace('@n8n/n8n-nodes-langchain.', 'ai.')
        .replace(/([A-Z])/g, ' $1')
        .trim();
}

/**
 * Sanitize node parameters (redact sensitive data)
 */
export function sanitizeParameters(params, depth = 0) {
    if (depth > 5) return '[max depth]';
    if (!params || typeof params !== 'object') return params;

    if (Array.isArray(params)) {
        return params.map(item => sanitizeParameters(item, depth + 1));
    }

    const sanitized = {};
    for (const [key, value] of Object.entries(params)) {
        const keyLower = key.toLowerCase();
        if (SENSITIVE_KEYS.some(sk => keyLower.includes(sk))) {
            sanitized[key] = '[REDACTED]';
        } else if (typeof value === 'object') {
            sanitized[key] = sanitizeParameters(value, depth + 1);
        } else if (typeof value === 'string' && value.length > 100) {
            sanitized[key] = value.substring(0, 100) + '...';
        } else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

/**
 * Generate safe summary of node
 */
export function generateNodeSummary(node) {
    const type = getShortType(node.type);
    const category = getNodeCategory(node.type);

    let summary = `${type}`;

    // Add specific details based on node type
    if (node.parameters) {
        if (node.parameters.url) {
            summary += ` → ${node.parameters.url.substring(0, 50)}`;
        }
        if (node.parameters.operation) {
            summary += ` (${node.parameters.operation})`;
        }
        if (node.parameters.resource) {
            summary += ` on ${node.parameters.resource}`;
        }
    }

    return summary;
}

/**
 * Parse n8n workflow JSON into normalized graph format
 */
export function parseN8nWorkflow(workflowJson) {
    if (!workflowJson) {
        return { nodes: [], edges: [], metadata: { valid: false, error: 'No workflow provided' } };
    }

    const nodes = [];
    const edges = [];
    const nodeMap = new Map(); // name -> id mapping
    const errors = [];

    // Parse nodes
    const rawNodes = workflowJson.nodes || [];
    rawNodes.forEach((node, index) => {
        const id = node.id || `node_${index}`;
        const name = node.name || `Node ${index}`;

        nodeMap.set(name, id);

        nodes.push({
            id,
            name,
            type: node.type || 'unknown',
            shortType: getShortType(node.type),
            category: getNodeCategory(node.type),
            position: node.position || null,
            parameters: node.parameters || {},
            sanitizedParams: sanitizeParameters(node.parameters),
            summary: generateNodeSummary(node),
            rawNode: node,
            // Track connections (will be filled in)
            inputs: [],
            outputs: []
        });
    });

    // Parse connections
    const connections = workflowJson.connections || {};
    let edgeIndex = 0;

    for (const [sourceName, outputs] of Object.entries(connections)) {
        const sourceId = nodeMap.get(sourceName);
        if (!sourceId) {
            errors.push(`Connection source not found: ${sourceName}`);
            continue;
        }

        // outputs can be { main: [[...], [...]] } or direct array
        const outputChannels = outputs.main || outputs;

        if (Array.isArray(outputChannels)) {
            outputChannels.forEach((connections, outputIndex) => {
                if (!Array.isArray(connections)) return;

                connections.forEach((conn) => {
                    const targetName = conn.node;
                    const targetId = nodeMap.get(targetName);

                    if (!targetId) {
                        errors.push(`Connection target not found: ${targetName}`);
                        return;
                    }

                    const edgeId = `edge_${edgeIndex++}`;
                    edges.push({
                        id: edgeId,
                        source: sourceId,
                        target: targetId,
                        sourceHandle: `output_${outputIndex}`,
                        targetHandle: `input_${conn.index || 0}`,
                        outputIndex,
                        inputIndex: conn.index || 0
                    });

                    // Update node connection info
                    const sourceNode = nodes.find(n => n.id === sourceId);
                    const targetNode = nodes.find(n => n.id === targetId);
                    if (sourceNode) sourceNode.outputs.push(targetId);
                    if (targetNode) targetNode.inputs.push(sourceId);
                });
            });
        }
    }

    // Identify trigger/entry nodes (no inputs)
    const triggerNodes = nodes.filter(n => n.inputs.length === 0);

    // Identify terminal nodes (no outputs)
    const terminalNodes = nodes.filter(n => n.outputs.length === 0);

    // Detect disconnected subgraphs
    const visited = new Set();
    const subgraphs = [];

    function dfs(nodeId, subgraph) {
        if (visited.has(nodeId)) return;
        visited.add(nodeId);
        subgraph.push(nodeId);

        const node = nodes.find(n => n.id === nodeId);
        if (node) {
            [...node.inputs, ...node.outputs].forEach(connId => dfs(connId, subgraph));
        }
    }

    nodes.forEach(node => {
        if (!visited.has(node.id)) {
            const subgraph = [];
            dfs(node.id, subgraph);
            subgraphs.push(subgraph);
        }
    });

    return {
        nodes,
        edges,
        metadata: {
            valid: true,
            name: workflowJson.name || 'Unnamed Workflow',
            nodeCount: nodes.length,
            edgeCount: edges.length,
            triggerNodes: triggerNodes.map(n => n.id),
            terminalNodes: terminalNodes.map(n => n.id),
            subgraphCount: subgraphs.length,
            subgraphs,
            hasDisconnected: subgraphs.length > 1,
            errors
        }
    };
}

/**
 * Calculate node depths using longest path from triggers
 */
export function calculateDepths(graph) {
    const { nodes, edges, metadata } = graph;
    const depths = new Map();
    const nodeById = new Map(nodes.map(n => [n.id, n]));

    // Initialize trigger nodes at depth 0
    metadata.triggerNodes.forEach(id => depths.set(id, 0));

    // BFS to calculate depths
    let changed = true;
    let iterations = 0;
    const maxIterations = nodes.length * 2;

    while (changed && iterations < maxIterations) {
        changed = false;
        iterations++;

        edges.forEach(edge => {
            const sourceDepth = depths.get(edge.source);
            if (sourceDepth !== undefined) {
                const currentTargetDepth = depths.get(edge.target);
                const newDepth = sourceDepth + 1;

                if (currentTargetDepth === undefined || newDepth > currentTargetDepth) {
                    depths.set(edge.target, newDepth);
                    changed = true;
                }
            }
        });
    }

    // Handle disconnected nodes (no path from trigger)
    const maxDepth = Math.max(0, ...depths.values());
    nodes.forEach(node => {
        if (!depths.has(node.id)) {
            // Put disconnected nodes at the end
            depths.set(node.id, maxDepth + 1);
        }
    });

    return depths;
}

/**
 * Layout graph in layered DAG format
 */
export function layoutGraph(graph, options = {}) {
    const {
        nodeSpacingX = 200,
        nodeSpacingY = 80,
        startX = 50,
        startY = 50
    } = options;

    const { nodes, edges, metadata } = graph;
    const depths = calculateDepths(graph);

    // Group nodes by depth
    const layers = new Map();
    nodes.forEach(node => {
        const depth = depths.get(node.id) || 0;
        if (!layers.has(depth)) layers.set(depth, []);
        layers.get(depth).push(node);
    });

    // Sort layers by depth
    const sortedLayers = [...layers.entries()].sort((a, b) => a[0] - b[0]);

    // Position nodes
    const positions = new Map();
    sortedLayers.forEach(([depth, layerNodes]) => {
        const layerHeight = layerNodes.length * nodeSpacingY;
        const startYForLayer = startY + (nodes.length * nodeSpacingY - layerHeight) / 2;

        layerNodes.forEach((node, index) => {
            positions.set(node.id, {
                x: startX + depth * nodeSpacingX,
                y: startYForLayer + index * nodeSpacingY
            });
        });
    });

    // Detect back-edges (cycles)
    const backEdges = edges.filter(edge => {
        const sourceDepth = depths.get(edge.source) || 0;
        const targetDepth = depths.get(edge.target) || 0;
        return targetDepth <= sourceDepth;
    });

    return {
        ...graph,
        positions,
        depths,
        layers: sortedLayers,
        backEdges: backEdges.map(e => e.id),
        layout: {
            width: (sortedLayers.length) * nodeSpacingX + startX * 2,
            height: Math.max(...[...layers.values()].map(l => l.length)) * nodeSpacingY + startY * 2
        }
    };
}

/**
 * Parse QuoxFlow workflow JSON into normalized graph format.
 * QuoxFlow format: { nodes: [{ id, type, name, category, config }], edges: [{ id, source, target }] }
 */
export function parseQuoxFlowWorkflow(workflowJson) {
    if (!workflowJson) {
        return { nodes: [], edges: [], metadata: { valid: false, error: 'No workflow provided' } };
    }

    const rawNodes = workflowJson.nodes || [];
    const rawEdges = workflowJson.edges || [];
    const errors = [];

    // Build adjacency from edges
    const nodeInputs = new Map();
    const nodeOutputs = new Map();
    for (const node of rawNodes) {
        nodeInputs.set(node.id, []);
        nodeOutputs.set(node.id, []);
    }
    for (const edge of rawEdges) {
        if (nodeOutputs.has(edge.source)) nodeOutputs.get(edge.source).push(edge.target);
        if (nodeInputs.has(edge.target)) nodeInputs.get(edge.target).push(edge.source);
    }

    const nodes = rawNodes.map((node, index) => {
        const category = node.category || getNodeCategory(node.type);
        return {
            id: node.id || `node_${index}`,
            name: node.name || node.id || `Node ${index}`,
            type: node.type || 'unknown',
            shortType: getShortType(node.type),
            category,
            position: node.position || null,
            parameters: node.config || {},
            sanitizedParams: sanitizeParameters(node.config),
            summary: `${getShortType(node.type)}${node.config?._originalType ? ` (${node.config._originalType.replace('n8n-nodes-base.', '')})` : ''}`,
            rawNode: node,
            inputs: nodeInputs.get(node.id) || [],
            outputs: nodeOutputs.get(node.id) || [],
        };
    });

    const edges = rawEdges.map((edge, index) => ({
        id: edge.id || `edge_${index}`,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle || 'output_0',
        targetHandle: edge.targetHandle || 'input_0',
    }));

    const triggerNodes = nodes.filter(n => n.inputs.length === 0);
    const terminalNodes = nodes.filter(n => n.outputs.length === 0);

    // Detect subgraphs
    const visited = new Set();
    const subgraphs = [];
    function dfs(nodeId, subgraph) {
        if (visited.has(nodeId)) return;
        visited.add(nodeId);
        subgraph.push(nodeId);
        const node = nodes.find(n => n.id === nodeId);
        if (node) {
            [...node.inputs, ...node.outputs].forEach(connId => dfs(connId, subgraph));
        }
    }
    nodes.forEach(node => {
        if (!visited.has(node.id)) {
            const subgraph = [];
            dfs(node.id, subgraph);
            subgraphs.push(subgraph);
        }
    });

    return {
        nodes,
        edges,
        metadata: {
            valid: true,
            name: workflowJson.name || 'Unnamed Workflow',
            nodeCount: nodes.length,
            edgeCount: edges.length,
            triggerNodes: triggerNodes.map(n => n.id),
            terminalNodes: terminalNodes.map(n => n.id),
            subgraphCount: subgraphs.length,
            subgraphs,
            hasDisconnected: subgraphs.length > 1,
            errors
        }
    };
}

/**
 * Auto-detect format and parse workflow JSON.
 * - QuoxFlow: has `edges` array (and no `connections` object with content)
 * - n8n: has `connections` object
 */
export function parseWorkflow(workflowJson) {
    if (!workflowJson) {
        return { nodes: [], edges: [], metadata: { valid: false, error: 'No workflow provided' } };
    }
    // QuoxFlow format: has edges array
    if (Array.isArray(workflowJson.edges)) {
        return parseQuoxFlowWorkflow(workflowJson);
    }
    // n8n format: has connections object
    if (workflowJson.connections && typeof workflowJson.connections === 'object') {
        return parseN8nWorkflow(workflowJson);
    }
    // Fallback: try QuoxFlow
    return parseQuoxFlowWorkflow(workflowJson);
}

export default {
    parseWorkflow,
    parseN8nWorkflow,
    parseQuoxFlowWorkflow,
    layoutGraph,
    getNodeCategory,
    getShortType,
    sanitizeParameters,
    generateNodeSummary
};
