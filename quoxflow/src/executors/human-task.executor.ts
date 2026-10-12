/**
 * Human Task Executor
 *
 * Handles human:task nodes that pause workflow execution and present
 * a task to a human via the HITL inbox. The human's response becomes
 * the node's output, available to downstream nodes via expressions.
 *
 * Unlike approval:gate (binary approve/deny), human:task supports:
 *   - Structured response data (forms, selections, text input)
 *   - Custom action buttons with values
 *   - Response routing via returnNodes (different actions → different edges)
 *   - Rich context passed to the human (title, description, payload)
 *
 * Node type: human:task
 * Config:
 *   - title: string — inbox item title
 *   - message: string — markdown description shown to the human
 *   - assignTo: string[] — who to assign (user IDs, team IDs, or '*')
 *   - actions: Array<{ action, label, value?, style? }> — custom action buttons
 *   - responseSchema: object — optional JSON schema for form fields
 *   - returnNodes: Record<string, string|null> — maps action → next node ID
 *   - timeout_ms: number — optional timeout
 *   - kind: string — inbox item kind (default: 'task')
 *   - priority: string — inbox item priority (default: 'normal')
 */

import { NodeExecutor, ExecutorResult } from './executor.interface.js';
import { Node } from '../core/workflow.js';
import { ExecutionContext } from '../core/execution.js';
import { Envelope, Intents } from '../core/envelope.js';
import { ApprovalEngine } from '../approval/index.js';
import { createTemplateInterpolator } from '../expression/template.js';
import { normaliseAssignTo } from '../expression/assignees.js';

interface HumanTaskAction {
  action: string;
  label: string;
  value?: string;
  style?: 'primary' | 'secondary' | 'danger' | 'warning';
}

interface HumanTaskConfig {
  title?: string;
  message?: string;
  assignTo?: string[];
  actions?: HumanTaskAction[];
  responseSchema?: Record<string, unknown>;
  returnNodes?: Record<string, string | null>;
  timeout_ms?: number;
  kind?: string;
  priority?: string;
}

export class HumanTaskExecutor implements NodeExecutor {
  readonly nodeTypes = ['human:task'];
  readonly hasExternalEffect = true;
  private approvalEngine: ApprovalEngine;

  constructor(options: { approvalEngine: ApprovalEngine }) {
    this.approvalEngine = options.approvalEngine;
  }

  async execute(
    node: Node,
    input: unknown,
    context: ExecutionContext
  ): Promise<ExecutorResult> {
    const rawConfig = node.config as unknown as HumanTaskConfig;
    // STUDY-REV-2 robustness: WEAVER (and hand-edited workflows) frequently
    // produce config.actions as bare strings — `["Approve", "Dismiss"]` —
    // because that's the most natural shorthand. The inbox UI expects
    // { action, label, value?, style? } objects (`action.label` is read
    // for the button text). Without normalisation the buttons render
    // empty. Normalise once here so every downstream consumer (envelope,
    // metadata, inbox payload) sees the canonical shape.
    const config: HumanTaskConfig = {
      ...rawConfig,
      actions: normaliseActions(rawConfig.actions),
    };
    const factory = context.envelopes;
    const emitted: Envelope[] = [];

    const nodeName = node.name ?? node.id;
    // STUDY-REV-2 P6 hotfix #4 + W3 fix #5: title + message must be
    // expression-interpolated. Plus a compatibility shim — Handlebars-style
    // `{{X.Y}}` markers get rewritten to `${X.Y}` BEFORE interpolation, so
    // workflows authored with the wrong syntax (every WEAVER pre-prompt-
    // update workflow + most user copy-paste) work without re-saving.
    // processValue() then handles the `${...}` form natively.
    const exprContext = context.createExpressionContext(node.id, input);
    const interpolate = createTemplateInterpolator(context, exprContext);
    const title = interpolate(config.title) || `Human task: ${nodeName}`;
    // W3 fix #5: WEAVER occasionally writes the body content into `description`
    // instead of `message`. If the message field is empty / a placeholder
    // default, fall back to description so the inbox body shows the actual
    // content rather than "A workflow step needs human input."
    const messageRaw = config.message;
    const descriptionRaw = (config as { description?: string }).description;
    const messageIsPlaceholder = !messageRaw
      || /^a workflow step (needs|requires) human input/i.test(messageRaw.trim())
      || messageRaw.trim().length < 8;
    const messageSource = messageIsPlaceholder && descriptionRaw ? descriptionRaw : messageRaw;
    // W3 fix #6 cont.: if BOTH message and description are empty, render the
    // pipeline input as a JSON code block so the human still has SOMETHING to
    // act on (rather than the generic "A workflow step requires your input"
    // prose). Workflows authored without an explicit message — common when
    // WEAVER bolts a human:task onto an agentic node — now show the upstream
    // node's output instead of a useless placeholder.
    const interpolated = interpolate(messageSource);
    let message: string;
    if (interpolated && interpolated.trim().length > 0) {
      message = interpolated;
    } else if (input !== undefined && input !== null) {
      try {
        const json = JSON.stringify(input, null, 2);
        message = `Pipeline input from upstream node:\n\n\`\`\`json\n${json.slice(0, 4000)}${json.length > 4000 ? '\n…(truncated)' : ''}\n\`\`\``;
      } catch {
        message = `A workflow step requires your input at node "${nodeName}".`;
      }
    } else {
      message = `A workflow step requires your input at node "${nodeName}".`;
    }

    // Build inbox item metadata
    const inboxPayload: Record<string, unknown> = {
      source: 'human_task',
      workflow_id: context.workflow.id,
      workflow_name: context.workflow.name,
      execution_id: context.id,
      node_id: node.id,
      node_name: nodeName,
      pipeline_input: input,
    };

    // Add custom actions if configured
    if (config.actions && config.actions.length > 0) {
      inboxPayload.custom_actions = config.actions;
    }

    // Add response schema if configured
    if (config.responseSchema) {
      inboxPayload.response_schema = config.responseSchema;
    }

    // Create approval request (reuses the approval engine for pause/resume)
    const approval = await this.approvalEngine.createApproval({
      correlationId: context.correlationId,
      workflowId: context.workflow.id,
      workflowName: context.workflow.name,
      executionId: context.id,
      nodeId: node.id,
      trigger: {
        policyId: 'workflow',
        ruleId: node.id,
        condition: message,
      },
      approvers: normaliseAssignTo(config.assignTo),
      timeoutMs: config.timeout_ms,
      metadata: {
        type: 'human_task',
        title,
        message,
        nodeName,
        pipelineInput: input,
        kind: config.kind || 'task',
        priority: config.priority || 'normal',
        customActions: config.actions,
        responseSchema: config.responseSchema,
        returnNodes: config.returnNodes,
        // P8.F HITL-ORGID-PLUMB: prefer first-class context.orgId
        orgId: context.orgId
          || context.getVariables()?.orgId
          || (input as Record<string, unknown>)?.orgId
          || (config as unknown as Record<string, unknown>)?.orgId,
      },
    });

    // Emit human task requested envelope
    const taskEnv = factory.event(
      'ops.human_task.requested',
      context.correlationId,
      {
        nodeId: node.id,
        nodeName,
        approvalId: approval.id,
        assignTo: normaliseAssignTo(config.assignTo),
        title,
        message,
        actions: config.actions,
        hasResponseSchema: !!config.responseSchema,
        returnNodes: config.returnNodes,
        expiresAt: approval.expiresAt,
      }
    );
    emitted.push(taskEnv);

    return {
      success: true,
      output: {
        approvalId: approval.id,
        status: 'pending',
        title,
        assignTo: normaliseAssignTo(config.assignTo),
        expiresAt: approval.expiresAt,
      },
      envelopes: emitted,
      paused: true,
      pauseReason: `Waiting for human input: ${title}`,
      metadata: {
        approvalId: approval.id,
        pausedNodeId: node.id,
        humanTask: true,
        returnNodes: config.returnNodes,
      },
    };
  }

  validate(node: Node): { valid: boolean; errors?: string[] } {
    const config = node.config as unknown as HumanTaskConfig;
    const errors: string[] = [];

    if (config.returnNodes) {
      // Validate returnNodes values are valid node IDs or null
      for (const [action, target] of Object.entries(config.returnNodes)) {
        if (target !== null && typeof target !== 'string') {
          errors.push(`returnNodes.${action} must be a string (node ID) or null`);
        }
      }
    }

    if (config.actions) {
      for (let i = 0; i < config.actions.length; i++) {
        if (!config.actions[i].action || !config.actions[i].label) {
          errors.push(`actions[${i}] must have action and label fields`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

/**
 * Normalise the `actions` config into the canonical
 * `{ action, label, value?, style? }` shape. Tolerates four common
 * shorthands users / WEAVER produce:
 *
 *   ["Approve", "Dismiss"]                            → string-only labels
 *   [{ label: "Approve" }]                            → object missing `action`
 *   [{ action: "approve" }]                           → object missing `label`
 *   [{ action: "approve", label: "Approve" }]         → already canonical
 *
 * Returns undefined when input is missing/empty (validation step then
 * decides whether that's an error). Exported for tests.
 */
// Param typed as `unknown` because real config sees bare strings + partial
// objects despite the static `HumanTaskConfig['actions']` type. The whole
// point of this helper is to repair drift between declared type and runtime
// reality, so we widen the input contract here.
export function normaliseActions(
  actions: unknown
): HumanTaskAction[] | undefined {
  if (!Array.isArray(actions) || actions.length === 0) return undefined;
  const result: HumanTaskAction[] = [];
  for (const raw of actions as unknown[]) {
    if (typeof raw === 'string') {
      const text = raw.trim();
      if (text.length === 0) continue;
      result.push({
        action: text.toLowerCase().replace(/\s+/g, '_'),
        label: text,
      });
      continue;
    }
    if (raw && typeof raw === 'object') {
      const obj = raw as Partial<HumanTaskAction>;
      const labelRaw = typeof obj.label === 'string' ? obj.label.trim() : '';
      const actionRaw = typeof obj.action === 'string' ? obj.action.trim() : '';
      const label = labelRaw || actionRaw || '';
      const action = actionRaw || label.toLowerCase().replace(/\s+/g, '_');
      if (!action || !label) continue;
      result.push({
        action,
        label,
        ...(obj.value !== undefined ? { value: obj.value } : {}),
        ...(obj.style ? { style: obj.style } : {}),
      });
    }
  }
  return result.length > 0 ? result : undefined;
}
