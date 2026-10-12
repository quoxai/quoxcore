/**
 * Workflow Definition Types
 *
 * 18 archetypes replace n8n's 400+ node types while preserving full capability.
 */

import { z } from 'zod';

/**
 * The 18 Quoxflow Node Archetypes
 *
 * | Category        | Archetypes                              |
 * |-----------------|----------------------------------------|
 * | Triggers        | webhook, schedule, event               |
 * | Control Flow    | condition, switch, loop, parallel, merge |
 * | Actions         | call                                   |
 * | Data            | transform, set, aggregate              |
 * | Error Handling  | try, catch, throw                      |
 * | Utilities       | wait, log, subworkflow                 |
 */
export type NodeType =
  // Triggers (3)
  | 'trigger:webhook'
  | 'trigger:schedule'
  | 'trigger:event'
  // Control Flow (5)
  | 'flow:condition'
  | 'flow:switch'
  | 'flow:loop'
  | 'flow:parallel'
  | 'flow:merge'
  | 'flow:end'
  // Actions (1)
  | 'call'
  // Data (3)
  | 'data:transform'
  | 'data:set'
  | 'data:aggregate'
  // Error Handling (3)
  | 'error:try'
  | 'error:catch'
  | 'error:throw'
  // Utilities (3)
  | 'util:wait'
  | 'util:log'
  | 'util:subworkflow'
  // Human-in-the-loop (2)
  | 'approval:gate'
  | 'human:task'
  // Agent (1)
  | 'agent:invoke'
  // Browser Automation (5)
  | 'browser:navigate'
  | 'browser:screenshot'
  | 'browser:extract'
  | 'browser:fill_form'
  | 'browser:objective'
  // Agentic Execution (QE2)
  | 'agent:agentic'
  // Team Execution (W2.5)
  | 'team:invoke'
  | 'team:member'
  // Assistant (W2.5)
  | 'assistant:invoke'
  // Notification (WB2/NOTIF-1)
  | 'notification:deliver'
  // Webhook Response (MACHINERY)
  | 'respondToWebhook';

/**
 * Base node definition
 */
export interface NodeBase {
  id: string;
  type: NodeType;
  name?: string;
  config: Record<string, unknown>;
  position?: { x: number; y: number };
  disabled?: boolean;
}

// Trigger Nodes
export interface WebhookTriggerNode extends NodeBase {
  type: 'trigger:webhook';
  config: {
    path: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    auth?: {
      type: 'none' | 'basic' | 'bearer' | 'header';
      config?: Record<string, string>;
    };
  };
}

export interface ScheduleTriggerNode extends NodeBase {
  type: 'trigger:schedule';
  config: {
    cron: string;
    timezone?: string;
  };
}

export interface EventTriggerNode extends NodeBase {
  type: 'trigger:event';
  config: {
    event: string;
    filter?: string;  // Expression to filter events
  };
}

// Control Flow Nodes
export interface ConditionNode extends NodeBase {
  type: 'flow:condition';
  config: {
    expression: string;  // Returns boolean
    outputs: {
      true: string;      // Target node ID when true
      false: string;     // Target node ID when false
    };
  };
}

export interface SwitchNode extends NodeBase {
  type: 'flow:switch';
  config: {
    expression: string;  // Value to switch on
    cases: Array<{
      value: unknown;
      target: string;    // Target node ID
    }>;
    default?: string;    // Default target node ID
  };
}

export interface LoopNode extends NodeBase {
  type: 'flow:loop';
  config: {
    items: string;       // Expression returning array
    itemVar?: string;    // Variable name for current item (default: 'item')
    indexVar?: string;   // Variable name for index (default: 'index')
    body: string;        // Target node ID for loop body
    next: string;        // Target node ID after loop completes
  };
}

export interface ParallelNode extends NodeBase {
  type: 'flow:parallel';
  config: {
    branches: string[];  // Array of target node IDs to run in parallel
    mode: 'all' | 'race' | 'any';  // Wait for all, first, or at least one
    next: string;        // Target node ID after parallel completes
  };
}

export interface MergeNode extends NodeBase {
  type: 'flow:merge';
  config: {
    mode: 'append' | 'merge' | 'first' | 'last';
    keys?: string[];     // Keys to merge on (for 'merge' mode)
  };
}

// Action Nodes
export interface CallNode extends NodeBase {
  type: 'call';
  config: {
    url: string;                     // URL or expression
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    headers?: Record<string, string>;
    body?: unknown;
    timeout?: number;                // Timeout in ms
    retry?: {
      attempts: number;
      backoff: 'fixed' | 'exponential';
      delay: number;                 // Base delay in ms
    };
    // Evidence collection
    evidence?: boolean;              // Store response as evidence
  };
}

// Data Nodes
export interface TransformNode extends NodeBase {
  type: 'data:transform';
  config: {
    expression: string;  // JavaScript expression
    mode?: 'single' | 'each';  // Transform whole input or each item
    /**
     * If set, the expression's result is wrapped as
     * `{ [outputField]: <result> }`. The dashboard's NodeConfigDrawer
     * declares this field as required and ships it in every WEAVER-built
     * data:transform — without server-side wrap, downstream nodes reading
     * `${input.<outputField>}` resolve to undefined and inboxes render
     * empty bodies. Leave undefined / empty for the raw-value passthrough.
     */
    outputField?: string;
  };
}

export interface SetNode extends NodeBase {
  type: 'data:set';
  config: {
    values: Record<string, unknown>;  // Key-value pairs to set
    mode?: 'set' | 'merge';           // Replace or merge with existing
  };
}

export interface AggregateNode extends NodeBase {
  type: 'data:aggregate';
  config: {
    mode: 'collect' | 'sum' | 'avg' | 'min' | 'max' | 'count' | 'first' | 'last';
    field?: string;      // Field to aggregate (for sum/avg/min/max)
    groupBy?: string;    // Optional grouping expression
  };
}

// Error Handling Nodes
export interface TryNode extends NodeBase {
  type: 'error:try';
  config: {
    body: string;        // Target node ID for try block
    catch: string;       // Target node ID for catch block
    finally?: string;    // Optional finally block
  };
}

export interface CatchNode extends NodeBase {
  type: 'error:catch';
  config: {
    errorTypes?: string[];  // Optional filter by error type
  };
}

export interface ThrowNode extends NodeBase {
  type: 'error:throw';
  config: {
    type: string;        // Error type
    message: string;     // Error message expression
    details?: unknown;   // Additional error details
  };
}

// Utility Nodes
export interface WaitNode extends NodeBase {
  type: 'util:wait';
  config: {
    duration: number;    // Wait time in ms
    // OR
    until?: string;      // Expression that returns true when ready
    pollInterval?: number;
    timeout?: number;
  };
}

export interface LogNode extends NodeBase {
  type: 'util:log';
  config: {
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;     // Expression for log message
    data?: string;       // Optional data expression
  };
}

export interface SubworkflowNode extends NodeBase {
  type: 'util:subworkflow';
  config: {
    workflowId: string;  // ID of workflow to invoke
    input?: string;      // Expression for input data
    waitForCompletion?: boolean;
  };
}

// Agent Nodes
export interface AgentInvokeNode extends NodeBase {
  type: 'agent:invoke';
  config: {
    agent_id: string;
    prompt: string;
    output_schema?: string;
    timeout_ms?: number;
    max_tokens?: number;
    context?: Record<string, unknown>;
    inject_dependency_results?: boolean;
    evidence?: boolean;
  };
}

export interface TeamInvokeNode extends NodeBase {
  type: 'team:invoke';
  config: {
    team_id: string;        // Required. e.g. 'fleet-ops', 'security-review' — Stream AT team id.
    objective: string;      // Required. Natural-language goal. Supports ${...} expressions.
    timeout_ms?: number;    // Default 1_800_000 (30 min — team runs are long).
    max_tokens?: number;    // Token budget hint for the team's orchestrator.
    context?: Record<string, unknown>;  // Extra metadata passed to the team objective.
    evidence?: boolean;     // Default true. When true, evidence_refs include the team-instance id.
  };
}

export interface TeamMemberNode extends NodeBase {
  type: 'team:member';
  config: {
    role: string;            // Required. e.g. 'orchestrator', 'validator', 'planner'.
    prompt: string;          // Required. Task instruction. Supports ${...} expressions.
    team_id?: string;        // Optional. Falls back to context.workflow.team_id or context vars.
    timeout_ms?: number;     // Default 60_000.
    max_tokens?: number;
    context?: Record<string, unknown>;
    evidence?: boolean;      // Default true.
  };
}

export interface AssistantInvokeNode extends NodeBase {
  type: 'assistant:invoke';
  config: {
    assistant_id: string;    // Required. e.g. 'nova', 'cipher', 'corey'.
    prompt: string;          // Required. Supports ${...} expressions.
    timeout_ms?: number;     // Default 60_000.
    max_tokens?: number;
    context?: Record<string, unknown>;
    evidence?: boolean;      // Default true.
  };
}

export interface NotificationDeliverNode extends NodeBase {
  type: 'notification:deliver';
  config: {
    title?: string;       // Inbox item title. Default: `Notification: <node.name|node.id>`. Supports ${...}.
    message: string;      // Body (markdown). Required. Supports ${...}.
    assignTo?: string[];  // Recipients (user IDs, team IDs, or '*'). Default: ['*'].
    kind?: string;        // Inbox item kind. Default: 'notification'.
    priority?: 'low' | 'normal' | 'high'; // Default: 'normal'.
  };
}

// Webhook Response (MACHINERY)
export interface RespondWebhookNode extends NodeBase {
  type: 'respondToWebhook';
  config: {
    statusCode?: number;               // HTTP status to return. Default: 200. Supports ${...}.
    body?: unknown;                    // Response body. Default: passthrough input. Supports ${...}.
    headers?: Record<string, string>;  // Response headers. Supports ${...} per value.
  };
}

// Union of all node types
export type Node =
  | WebhookTriggerNode
  | ScheduleTriggerNode
  | EventTriggerNode
  | ConditionNode
  | SwitchNode
  | LoopNode
  | ParallelNode
  | MergeNode
  | CallNode
  | TransformNode
  | SetNode
  | AggregateNode
  | TryNode
  | CatchNode
  | ThrowNode
  | WaitNode
  | LogNode
  | SubworkflowNode
  | AgentInvokeNode
  | TeamInvokeNode
  | TeamMemberNode
  | AssistantInvokeNode
  | NotificationDeliverNode
  | RespondWebhookNode;

/**
 * Edge connecting nodes
 */
export interface Edge {
  id?: string;
  source: string;        // Source node ID
  target: string;        // Target node ID
  sourceHandle?: string; // Output handle (for multi-output nodes)
  targetHandle?: string; // Input handle
  condition?: string;    // Optional condition expression
}

/**
 * Workflow definition
 */
export interface Workflow {
  id: string;
  name: string;
  description?: string;
  notes?: string;
  version?: string;
  nodes: Node[];
  edges: Edge[];
  variables?: Record<string, unknown>;  // Workflow-level variables
  credentials?: string[];               // Referenced credential IDs
  settings?: WorkflowSettings;
  metadata?: Record<string, unknown>;
}

export interface WorkflowSettings {
  timezone?: string;
  errorBehavior?: 'stop' | 'continue';
  maxConcurrency?: number;
  timeout?: number;         // Overall workflow timeout in ms
  retryOnFailure?: boolean;
  saveEvidence?: boolean;   // Store all external responses
}

// Zod schemas for validation
export const EdgeSchema = z.object({
  id: z.string().optional(),
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
  condition: z.string().optional(),
});

export const NodeBaseSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string().optional(),
  config: z.record(z.string(), z.unknown()),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  disabled: z.boolean().optional(),
});

export const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  notes: z.string().optional(),
  version: z.string().optional(),
  nodes: z.array(NodeBaseSchema),
  edges: z.array(EdgeSchema),
  variables: z.record(z.string(), z.unknown()).optional(),
  credentials: z.array(z.string()).optional(),
  settings: z.object({
    timezone: z.string().optional(),
    errorBehavior: z.enum(['stop', 'continue']).optional(),
    maxConcurrency: z.number().optional(),
    timeout: z.number().optional(),
    retryOnFailure: z.boolean().optional(),
    saveEvidence: z.boolean().optional(),
  }).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Find entry points (trigger nodes) in a workflow
 */
export function findTriggers(workflow: Workflow): Node[] {
  return workflow.nodes.filter(n => n.type.startsWith('trigger:'));
}

/**
 * Build adjacency list from edges
 */
export function buildAdjacencyList(workflow: Workflow): Map<string, string[]> {
  const adj = new Map<string, string[]>();

  for (const node of workflow.nodes) {
    adj.set(node.id, []);
  }

  for (const edge of workflow.edges) {
    const targets = adj.get(edge.source) ?? [];
    targets.push(edge.target);
    adj.set(edge.source, targets);
  }

  return adj;
}

/**
 * Topologically sort nodes (for execution order)
 */
export function topologicalSort(workflow: Workflow): string[] {
  const adj = buildAdjacencyList(workflow);
  const visited = new Set<string>();
  const result: string[] = [];

  function dfs(nodeId: string) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const neighbors = adj.get(nodeId) ?? [];
    for (const neighbor of neighbors) {
      dfs(neighbor);
    }

    result.unshift(nodeId);
  }

  // Start from triggers
  for (const trigger of findTriggers(workflow)) {
    dfs(trigger.id);
  }

  return result;
}

/**
 * Get node by ID
 */
export function getNode(workflow: Workflow, nodeId: string): Node | undefined {
  return workflow.nodes.find(n => n.id === nodeId);
}

/**
 * Get outgoing edges from a node
 */
export function getOutgoingEdges(workflow: Workflow, nodeId: string): Edge[] {
  return workflow.edges.filter(e => e.source === nodeId);
}

/**
 * Get incoming edges to a node
 */
export function getIncomingEdges(workflow: Workflow, nodeId: string): Edge[] {
  return workflow.edges.filter(e => e.target === nodeId);
}
