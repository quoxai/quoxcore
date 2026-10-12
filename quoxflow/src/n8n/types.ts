/**
 * n8n Workflow Types
 *
 * Type definitions for n8n workflow JSON format.
 */

/**
 * n8n node types that map to Quoxflow archetypes
 */
export const N8N_NODE_MAPPING: Record<string, { type: string; category: string }> = {
  // Triggers → trigger:webhook, trigger:schedule, trigger:event
  'n8n-nodes-base.webhook': { type: 'trigger:webhook', category: 'trigger' },
  'n8n-nodes-base.httpRequest': { type: 'call', category: 'action' },
  'n8n-nodes-base.cron': { type: 'trigger:schedule', category: 'trigger' },
  'n8n-nodes-base.scheduleTrigger': { type: 'trigger:schedule', category: 'trigger' },
  'n8n-nodes-base.manualTrigger': { type: 'trigger:webhook', category: 'trigger' },
  'n8n-nodes-base.emailTrigger': { type: 'trigger:event', category: 'trigger' },
  'n8n-nodes-base.start': { type: 'trigger:webhook', category: 'trigger' },

  // Control flow → flow:*
  'n8n-nodes-base.if': { type: 'flow:condition', category: 'flow' },
  'n8n-nodes-base.switch': { type: 'flow:switch', category: 'flow' },
  'n8n-nodes-base.splitInBatches': { type: 'flow:loop', category: 'flow' },
  'n8n-nodes-base.merge': { type: 'flow:merge', category: 'flow' },
  'n8n-nodes-base.noOp': { type: 'data:transform', category: 'data' },

  // Data transformation → data:*
  'n8n-nodes-base.set': { type: 'data:set', category: 'data' },
  'n8n-nodes-base.function': { type: 'data:transform', category: 'data' },
  'n8n-nodes-base.functionItem': { type: 'data:transform', category: 'data' },
  'n8n-nodes-base.code': { type: 'data:transform', category: 'data' },
  'n8n-nodes-base.itemLists': { type: 'data:aggregate', category: 'data' },
  'n8n-nodes-base.spreadsheetFile': { type: 'data:transform', category: 'data' },
  'n8n-nodes-base.xml': { type: 'data:transform', category: 'data' },
  'n8n-nodes-base.html': { type: 'data:transform', category: 'data' },
  'n8n-nodes-base.markdown': { type: 'data:transform', category: 'data' },
  'n8n-nodes-base.crypto': { type: 'data:transform', category: 'data' },
  'n8n-nodes-base.dateTime': { type: 'data:transform', category: 'data' },
  'n8n-nodes-base.renameKeys': { type: 'data:transform', category: 'data' },
  'n8n-nodes-base.moveBinaryData': { type: 'data:transform', category: 'data' },

  // Error handling → error:*
  'n8n-nodes-base.errorTrigger': { type: 'error:catch', category: 'error' },
  'n8n-nodes-base.stopAndError': { type: 'error:throw', category: 'error' },

  // Utilities → util:*
  'n8n-nodes-base.wait': { type: 'util:wait', category: 'util' },
  'n8n-nodes-base.executeWorkflow': { type: 'util:subworkflow', category: 'util' },
  'n8n-nodes-base.stickyNote': { type: 'util:log', category: 'util' },

  // Data processing nodes
  'n8n-nodes-base.filter': { type: 'flow:condition', category: 'flow' },
  'n8n-nodes-base.aggregate': { type: 'data:aggregate', category: 'data' },
  'n8n-nodes-base.splitOut': { type: 'data:transform', category: 'data' },
  'n8n-nodes-base.removeDuplicates': { type: 'data:transform', category: 'data' },
  'n8n-nodes-base.sort': { type: 'data:transform', category: 'data' },
  'n8n-nodes-base.limit': { type: 'data:transform', category: 'data' },

  // Additional triggers
  'n8n-nodes-base.executeWorkflowTrigger': { type: 'trigger:webhook', category: 'trigger' },
  '@n8n/n8n-nodes-langchain.chatTrigger': { type: 'trigger:webhook', category: 'trigger' },
  'n8n-nodes-base.formTrigger': { type: 'trigger:webhook', category: 'trigger' },

  // Webhook Response (MACHINERY — dedicated executor, see respond-webhook.executor.ts)
  'n8n-nodes-base.respondToWebhook': { type: 'respondToWebhook', category: 'util' },

  // Vendor integrations with a real connector (src/n8n/connectors/) —
  // buildCallConfig() produces an actual vendor API request for these,
  // not the generic placeholder. See connectors/index.ts for the list.
  'n8n-nodes-base.slack': { type: 'call', category: 'action' },
  'n8n-nodes-base.telegram': { type: 'call', category: 'action' },
  'n8n-nodes-base.gmail': { type: 'call', category: 'action' },
  'n8n-nodes-base.googleSheets': { type: 'call', category: 'action' },
  'n8n-nodes-base.googleDrive': { type: 'call', category: 'action' },
  'n8n-nodes-base.airtable': { type: 'call', category: 'action' },
  'n8n-nodes-base.notion': { type: 'call', category: 'action' },
  'n8n-nodes-base.emailSend': { type: 'call', category: 'action' },
  '@n8n/n8n-nodes-langchain.openAi': { type: 'call', category: 'action' },

  // LangChain-family "agent orchestration" primitives → agent:invoke /
  // assistant:invoke. These do NOT connect via connections.main at all —
  // see src/n8n/agent-resolver.ts for how their attached chat-model/
  // memory/tool nodes are resolved via the ai_* sub-connection types and
  // folded into a single composed node by buildAgentInvokeConfig() /
  // buildAssistantInvokeConfig() in workflow-converter.ts.
  '@n8n/n8n-nodes-langchain.agent': { type: 'agent:invoke', category: 'ai' },
  '@n8n/n8n-nodes-langchain.chainLlm': { type: 'assistant:invoke', category: 'ai' },

  // Gmail/Telegram triggers are poll/webhook entry points, not calls —
  // map onto the existing trigger:webhook archetype (same as the
  // plain webhook/manualTrigger nodes above). The generated webhook
  // endpoint is real; registering it with Google Pub/Sub or
  // Telegram's setWebhook API is an out-of-band step, same as for any
  // n8n webhook-based trigger.
  'n8n-nodes-base.gmailTrigger': { type: 'trigger:webhook', category: 'trigger' },
  'n8n-nodes-base.telegramTrigger': { type: 'trigger:webhook', category: 'trigger' },

  // All other integrations → call (HTTP-based)
  // This is the default for any node not explicitly mapped
};

/**
 * n8n workflow JSON structure
 */
export interface N8nWorkflow {
  name: string;
  nodes: N8nNode[];
  connections: N8nConnections;
  active?: boolean;
  settings?: N8nSettings;
  staticData?: unknown;
  tags?: string[];
  id?: string;
  meta?: {
    instanceId?: string;
  };
}

export interface N8nNode {
  id?: string;
  name: string;
  type: string;
  typeVersion?: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
  disabled?: boolean;
  notes?: string;
  notesInFlow?: boolean;
  webhookId?: string;
}

/**
 * An n8n connection edge list — array of output ports, each port an array
 * of `{node, type, index}` targets (n8n allows fan-out per port).
 */
export type N8nConnectionEdges = Array<Array<{ node: string; type: string; index: number }>>;

export interface N8nConnections {
  [nodeName: string]: {
    main?: N8nConnectionEdges;
    /**
     * LangChain-family "sub-connection" types — `ai_languageModel`,
     * `ai_memory`, `ai_tool`, `ai_outputParser`, `ai_embedding`,
     * `ai_document`, `ai_textSplitter`, and others n8n has added/will add
     * for new LangChain node types. Deliberately an open index signature
     * rather than an enumerated key list — new ai_* roles ship with new
     * n8n LangChain nodes over time and this shouldn't need editing every
     * time one does. Same `[[{node,type,index}]]` shape as `main`. See
     * agent-resolver.ts for how these are traced back to the provider
     * node that supplies each role to a given Agent/Chain node.
     */
    [aiConnectionType: string]: N8nConnectionEdges | undefined;
  };
}

export interface N8nSettings {
  executionOrder?: string;
  saveExecutionProgress?: boolean;
  saveManualExecutions?: boolean;
  saveDataErrorExecution?: string;
  saveDataSuccessExecution?: string;
  timezone?: string;
  errorWorkflow?: string;
}

/**
 * Result of importing an n8n workflow
 */
export interface ImportResult {
  success: boolean;
  workflow?: import('../core/workflow.js').Workflow;
  warnings: ImportWarning[];
  errors: ImportError[];
  nodeMapping: NodeMappingInfo[];
}

export interface ImportWarning {
  nodeId: string;
  nodeName: string;
  message: string;
  suggestion?: string;
}

export interface ImportError {
  nodeId?: string;
  nodeName?: string;
  message: string;
  fatal: boolean;
}

export interface NodeMappingInfo {
  n8nName: string;
  n8nType: string;
  quoxflowId: string;
  quoxflowType: string;
  expressionsConverted: number;
  credentialsRequired: string[];
  notes?: string;
}

/**
 * Get Quoxflow type for an n8n node type
 */
export function getQuoxflowType(n8nType: string): { type: string; category: string } {
  // Check explicit mapping first
  if (N8N_NODE_MAPPING[n8nType]) {
    return N8N_NODE_MAPPING[n8nType];
  }

  // Default: any integration becomes a 'call' node
  return { type: 'call', category: 'integration' };
}

/**
 * Check if an n8n node type is a trigger
 */
export function isTriggerNode(n8nType: string): boolean {
  const mapping = getQuoxflowType(n8nType);
  return mapping.type.startsWith('trigger:') ||
         n8nType.toLowerCase().includes('trigger') ||
         n8nType === 'n8n-nodes-base.start' ||
         n8nType === 'n8n-nodes-base.webhook';
}
