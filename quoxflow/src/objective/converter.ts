/**
 * Objective Template → QuoxFlow Workflow Converter
 *
 * Converts QuoxCORE objective templates into QuoxFlow workflow definitions.
 *
 * Mapping rules:
 *   - Each task → agent:invoke node
 *   - depends_on_indices → edges
 *   - {{variable}} → ${vars.variable}
 *   - Optional schedule → trigger:schedule node
 *   - Optional approval gate → approval:gate node before first task
 *   - Workflow variables from template variables with defaults
 */

import { Workflow, Node, Edge } from '../core/workflow.js';
import {
  ObjectiveTemplate,
  ObjectiveTask,
  ConversionWarning,
  NodeMappingEntry,
  ObjectiveConversionResult,
} from './types.js';

export interface ConvertObjectiveOptions {
  schedule?: {
    cron: string;
    timezone?: string;
  };
  includeApprovalGate?: boolean;
  workflowIdOverride?: string;
}

/**
 * Convert an objective template to a QuoxFlow workflow.
 */
export function convertObjectiveTemplate(
  template: ObjectiveTemplate,
  options: ConvertObjectiveOptions = {}
): ObjectiveConversionResult {
  const warnings: ConversionWarning[] = [];
  const nodeMapping: NodeMappingEntry[] = [];
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  if (!template.tasks || template.tasks.length === 0) {
    return {
      success: false,
      workflow: { id: 'empty', name: 'Empty', nodes: [], edges: [] },
      warnings: [{ message: 'Template has no tasks' }],
      nodeMapping: [],
    };
  }

  // --- Trigger node ---
  const triggerId = 'trigger';
  if (options.schedule) {
    nodes.push({
      id: triggerId,
      type: 'trigger:schedule',
      name: 'Schedule',
      config: {
        // #1172: the schedule executor reads expression; the template's schedule.cron is the input name.
        expression: options.schedule.cron,
        timezone: options.schedule.timezone,
      },
    } as Node);
  } else {
    nodes.push({
      id: triggerId,
      type: 'trigger:event',
      name: 'Manual Start',
      config: { event: 'manual' },
    } as Node);
  }

  // --- Optional approval gate ---
  const approvalNodeId = 'approval-gate';
  const needsApproval = options.includeApprovalGate || template.require_approval_before_start;
  if (needsApproval) {
    nodes.push({
      id: approvalNodeId,
      type: 'approval:gate',
      name: 'Pre-Start Approval',
      config: {
        approvers: ['*'],
        message: `Approve execution of: ${template.title}`,
      },
    } as unknown as Node);
    edges.push({ id: 'e-trigger-approval', source: triggerId, target: approvalNodeId });
  }

  // --- Build sequence_num → node ID map ---
  const seqToNodeId = new Map<number, string>();
  for (const task of template.tasks) {
    const nodeId = sanitizeNodeId(task.title, task.sequence_num);
    seqToNodeId.set(task.sequence_num, nodeId);
  }

  // --- Convert each task to an agent:invoke node ---
  let edgeIdx = 0;
  for (const task of template.tasks) {
    const nodeId = seqToNodeId.get(task.sequence_num)!;

    // Translate variable syntax: {{var}} → ${vars.var}
    const translatedPrompt = translateVariables(task.prompt);

    const agentNode: Node = {
      id: nodeId,
      type: 'agent:invoke' as any,
      name: task.title,
      config: {
        agent_id: task.agent_id || 'quox',
        prompt: translatedPrompt,
        ...(task.output_schema ? { output_schema: task.output_schema } : {}),
        inject_dependency_results: true,
        evidence: template.checkpoint_after_each_task !== false,
      },
      position: {
        x: 300,
        y: 100 + task.sequence_num * 150,
      },
    } as Node;

    nodes.push(agentNode);

    nodeMapping.push({
      taskIndex: task.sequence_num,
      taskTitle: task.title,
      agentId: task.agent_id || 'quox',
      nodeId,
      nodeType: 'agent:invoke',
    });

    // --- Build edges from dependencies ---
    if (task.depends_on_indices.length === 0) {
      // No deps: connect from trigger (or approval gate)
      const sourceId = needsApproval ? approvalNodeId : triggerId;
      edges.push({
        id: `e${edgeIdx++}`,
        source: sourceId,
        target: nodeId,
      });
    } else {
      // Deduplicate and validate dependency indices
      const seen = new Set<number>();
      for (const depIdx of task.depends_on_indices) {
        if (seen.has(depIdx)) continue;
        seen.add(depIdx);

        if (depIdx === task.sequence_num) {
          warnings.push({
            taskIndex: task.sequence_num,
            taskTitle: task.title,
            message: `Task depends on itself (index ${depIdx}), skipping self-edge`,
          });
          continue;
        }

        const depNodeId = seqToNodeId.get(depIdx);
        if (!depNodeId) {
          warnings.push({
            taskIndex: task.sequence_num,
            taskTitle: task.title,
            message: `Dependency index ${depIdx} not found in task list`,
          });
          continue;
        }
        edges.push({
          id: `e${edgeIdx++}`,
          source: depNodeId,
          target: nodeId,
        });
      }
    }

    // Warn if agent_id looks unusual
    if (!task.agent_id) {
      warnings.push({
        taskIndex: task.sequence_num,
        taskTitle: task.title,
        nodeId,
        message: 'No agent_id specified, defaulting to "quox"',
      });
    }
  }

  // --- Build workflow variables from template variables ---
  const variables: Record<string, unknown> = {};
  if (template.variables) {
    for (const v of template.variables) {
      variables[v.name] = v.defaultValue;
    }
  }

  // --- Workflow settings ---
  const workflowId = options.workflowIdOverride || sanitizeWorkflowId(template.title);

  const workflow: Workflow = {
    id: workflowId,
    name: template.title,
    description: template.description || `Converted from objective template: ${template.title}`,
    nodes,
    edges,
    variables: Object.keys(variables).length > 0 ? variables : undefined,
    settings: {
      errorBehavior: 'stop',
      timeout: template.max_duration_ms,
      saveEvidence: true,
    },
    metadata: {
      importedFrom: 'objective-template',
      importedAt: new Date().toISOString(),
      originalTaskCount: template.tasks.length,
      team_id: template.team_id || undefined,
      max_tokens: template.max_tokens,
      max_tool_calls: template.max_tool_calls,
    },
  };

  return {
    success: true,
    workflow,
    warnings,
    nodeMapping,
  };
}

/**
 * Translate {{variable}} syntax to ${vars.variable} for the expression engine.
 */
export function translateVariables(text: string): string {
  return text.replace(/\{\{(\w+)\}\}/g, '${vars.$1}');
}

/**
 * Sanitize a task title into a node ID.
 */
function sanitizeNodeId(title: string, sequenceNum: number): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return base ? `${base}-${sequenceNum}` : `task-${sequenceNum}`;
}

/**
 * Sanitize a workflow name into a workflow ID.
 */
function sanitizeWorkflowId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  return base || 'objective-workflow';
}
