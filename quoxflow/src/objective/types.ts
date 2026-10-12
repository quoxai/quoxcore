/**
 * Objective Template Types
 *
 * Mirrors the QuoxCORE objective template structure from
 * quox-dashboard/services/tasks/lib/objectiveChaining.js
 */

export interface ObjectiveTask {
  title: string;
  agent_id: string;
  prompt: string;
  sequence_num: number;
  depends_on_indices: number[];
  output_schema?: string | null;
}

export interface ObjectiveVariable {
  name: string;
  type: string;
  defaultValue: string;
  label: string;
}

export interface ObjectiveTemplate {
  title: string;
  description?: string;
  max_tokens?: number;
  max_tool_calls?: number;
  max_duration_ms?: number;
  team_id?: string | null;
  checkpoint_after_each_task?: boolean;
  require_approval_before_start?: boolean;
  tasks: ObjectiveTask[];
  variables?: ObjectiveVariable[];
}

export interface ConversionWarning {
  taskIndex?: number;
  taskTitle?: string;
  nodeId?: string;
  message: string;
}

export interface NodeMappingEntry {
  taskIndex: number;
  taskTitle: string;
  agentId: string;
  nodeId: string;
  nodeType: string;
}

export interface ObjectiveConversionResult {
  success: boolean;
  workflow: import('../core/workflow.js').Workflow;
  warnings: ConversionWarning[];
  nodeMapping: NodeMappingEntry[];
}
