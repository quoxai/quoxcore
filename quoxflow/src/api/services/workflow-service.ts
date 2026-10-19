/**
 * Workflow Service
 *
 * Business logic for workflow validation and n8n import.
 */

import { Workflow, WorkflowSchema } from '../../core/workflow.js';
import { convertWorkflow, parseN8nWorkflow, N8nWorkflow } from '../../n8n/index.js';
import { convertObjectiveTemplate, type ConvertObjectiveOptions, type ObjectiveTemplate } from '../../objective/index.js';
import { ExecutorRegistry } from '../../executors/executor.interface.js';

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  warnings: Array<{ path: string; message: string }>;
  unknownNodeTypes: string[];
}

export class WorkflowService {
  constructor(private executors: ExecutorRegistry) {}

  async validate(workflow: Workflow): Promise<ValidationResult> {
    const errors: Array<{ path: string; message: string }> = [];
    const warnings: Array<{ path: string; message: string }> = [];
    const unknownNodeTypes: string[] = [];

    // Schema validation
    const schemaResult = WorkflowSchema.safeParse(workflow);
    if (!schemaResult.success) {
      for (const issue of schemaResult.error.issues) {
        errors.push({
          path: issue.path.join('.'),
          message: issue.message,
        });
      }
    }

    // Check for registered executors, then run each executor's own node validator (#1172: a
    // schedule node with config.cron and no expression validated clean but could never fire).
    for (const node of workflow.nodes) {
      const executor = this.executors.get(node.type);
      if (!executor) {
        unknownNodeTypes.push(node.type);
        warnings.push({
          path: `nodes.${node.id}`,
          message: `Unknown node type: ${node.type}`,
        });
        continue;
      }
      if (typeof executor.validate !== 'function') continue;
      let nodeResult: { valid: boolean; errors?: string[] };
      try {
        nodeResult = executor.validate(node as any);
      } catch (err) {
        nodeResult = { valid: false, errors: [`validator threw: ${err instanceof Error ? err.message : String(err)}`] };
      }
      if (!nodeResult.valid) {
        const msgs = nodeResult.errors && nodeResult.errors.length ? nodeResult.errors : ['node configuration is invalid'];
        for (const message of msgs) errors.push({ path: `nodes.${node.id}`, message });
      }
    }

    // Check for trigger nodes
    const triggers = workflow.nodes.filter(n => n.type.startsWith('trigger:'));
    if (triggers.length === 0) {
      warnings.push({
        path: 'nodes',
        message: 'Workflow has no trigger nodes',
      });
    }

    // Check edge references
    const nodeIds = new Set(workflow.nodes.map(n => n.id));
    for (const edge of workflow.edges) {
      if (!nodeIds.has(edge.source)) {
        errors.push({
          path: `edges.${edge.id || 'unknown'}`,
          message: `Edge source "${edge.source}" does not exist`,
        });
      }
      if (!nodeIds.has(edge.target)) {
        errors.push({
          path: `edges.${edge.id || 'unknown'}`,
          message: `Edge target "${edge.target}" does not exist`,
        });
      }
    }

    // Check for orphan nodes (nodes with no edges)
    const connectedNodes = new Set<string>();
    for (const edge of workflow.edges) {
      connectedNodes.add(edge.source);
      connectedNodes.add(edge.target);
    }

    for (const node of workflow.nodes) {
      if (!connectedNodes.has(node.id) && !node.type.startsWith('trigger:')) {
        warnings.push({
          path: `nodes.${node.id}`,
          message: `Node "${node.name || node.id}" is not connected to any edges`,
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      unknownNodeTypes,
    };
  }

  async importN8n(
    n8nJson: unknown,
    options?: {
      generateIds?: boolean;
      includePositions?: boolean;
    }
  ) {
    // Handle string or object input
    let n8nWorkflow: N8nWorkflow;

    if (typeof n8nJson === 'string') {
      n8nWorkflow = parseN8nWorkflow(n8nJson);
    } else {
      // Validate it looks like an n8n workflow
      const obj = n8nJson as Record<string, unknown>;
      if (!obj.nodes || !obj.connections) {
        throw new Error('Invalid n8n workflow format: missing nodes or connections');
      }
      n8nWorkflow = obj as unknown as N8nWorkflow;
    }

    return convertWorkflow(n8nWorkflow, options);
  }

  async importObjectiveTemplate(
    template: ObjectiveTemplate,
    options?: ConvertObjectiveOptions
  ) {
    if (!template.tasks || !Array.isArray(template.tasks)) {
      throw new Error('Invalid objective template: missing tasks array');
    }
    return convertObjectiveTemplate(template, options);
  }
}
