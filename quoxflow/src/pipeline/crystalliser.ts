/**
 * Crystalliser — QE2 Phase 5
 *
 * Analyses execution history and converts proven agentic workflows
 * into deterministic ones (no LLM calls, just tool execution).
 *
 * "Objectives discover. Workflows execute."
 *
 * When an agentic workflow succeeds N times with consistent structure
 * and high success rate, it can be "crystallised" into a deterministic
 * workflow that runs at 100x lower cost with full auditability.
 *
 * If the crystallised workflow later starts failing, it can "revert"
 * to dynamic (agentic) mode for re-discovery.
 */

export interface ExecutionRecord {
  id: string;
  success: boolean;
  nodeTypes: string[];
  nodeCount: number;
  durationMs: number;
  actionLog: Array<{ action: string; params: Record<string, unknown> }>;
}

export interface AnalysisResult {
  ready: boolean;
  reason?: string;
  confidence: number;
  executionCount: number;
  successRate: number;
}

export interface Variable {
  name: string;
  values: unknown[];
  defaultValue?: unknown;
}

export interface CrystallisationCandidate {
  workflowId: string;
  workflowName: string;
  confidence: number;
  executionCount: number;
  successRate: number;
  canonicalActions: Array<{ action: string; params: Record<string, unknown> }>;
  variables: Variable[];
}

const MIN_EXECUTIONS = 3;
const MIN_SUCCESS_RATE = 0.8;

/**
 * Analyse execution history to determine if a workflow is ready for crystallisation.
 */
export function analyseExecutionHistory(executions: ExecutionRecord[]): AnalysisResult {
  const count = executions.length;
  const successCount = executions.filter(e => e.success).length;
  const successRate = count > 0 ? successCount / count : 0;

  if (count < MIN_EXECUTIONS) {
    return {
      ready: false,
      reason: `Insufficient executions (${count}/${MIN_EXECUTIONS} required)`,
      confidence: 0,
      executionCount: count,
      successRate,
    };
  }

  if (successRate < MIN_SUCCESS_RATE) {
    return {
      ready: false,
      reason: `Low success rate (${(successRate * 100).toFixed(0)}% < ${MIN_SUCCESS_RATE * 100}% required)`,
      confidence: 0,
      executionCount: count,
      successRate,
    };
  }

  // Check structural consistency — do successful executions follow the same action pattern?
  const successfulExecs = executions.filter(e => e.success);
  const actionSignatures = successfulExecs.map(e =>
    e.actionLog.map(a => a.action).join(',')
  );
  const uniqueSignatures = new Set(actionSignatures);

  if (uniqueSignatures.size > 1) {
    return {
      ready: false,
      reason: `Inconsistent action structure across runs (${uniqueSignatures.size} different patterns)`,
      confidence: 0,
      executionCount: count,
      successRate,
    };
  }

  // Calculate confidence: higher with more executions and higher success rate
  const executionBonus = Math.min(count / 10, 1) * 0.3; // up to 0.3 for 10+ executions
  const successBonus = successRate * 0.5; // up to 0.5 for 100% success
  const consistencyBonus = uniqueSignatures.size === 1 ? 0.2 : 0; // 0.2 for perfect consistency
  const confidence = Math.min(executionBonus + successBonus + consistencyBonus, 1.0);

  return {
    ready: true,
    confidence,
    executionCount: count,
    successRate,
  };
}

/**
 * Extract parameters that vary between executions (these become template variables).
 */
export function extractVariables(executions: ExecutionRecord[]): Variable[] {
  const successfulExecs = executions.filter(e => e.success && e.actionLog.length > 0);
  if (successfulExecs.length < 2) return [];

  const variables: Variable[] = [];

  // Compare params across executions for each action position
  const firstLog = successfulExecs[0].actionLog;

  for (let actionIdx = 0; actionIdx < firstLog.length; actionIdx++) {
    const params = firstLog[actionIdx].params;

    for (const [key, firstValue] of Object.entries(params)) {
      const valuesAcrossRuns: unknown[] = [];

      for (const exec of successfulExecs) {
        const action = exec.actionLog[actionIdx];
        if (action) {
          valuesAcrossRuns.push(action.params[key]);
        }
      }

      // Check if values vary
      const uniqueValues = new Set(valuesAcrossRuns.map(v => JSON.stringify(v)));
      if (uniqueValues.size > 1) {
        variables.push({
          name: `${firstLog[actionIdx].action}_${actionIdx}_${key}`,
          values: [...new Set(valuesAcrossRuns.map(v => typeof v === 'string' ? v : JSON.stringify(v)))],
          defaultValue: firstValue,
        });
      }
    }
  }

  return variables;
}

/**
 * Map an agentic action name to a deterministic QuoxFlow node type.
 */
function actionToNodeType(action: string): string {
  const mapping: Record<string, string> = {
    ssh_exec: 'action:call',
    http_call: 'action:call',
    navigate: 'browser:navigate',
    screenshot: 'browser:screenshot',
    extract: 'browser:extract',
    fill_form: 'browser:fill_form',
    click: 'browser:navigate',
  };
  return mapping[action] || 'action:call';
}

/**
 * Crystallise a candidate into a deterministic QuoxFlow workflow.
 * No LLM calls. No agentic loop. Just tool execution in sequence.
 */
export function crystallise(candidate: CrystallisationCandidate): {
  id: string;
  name: string;
  version: string;
  nodes: Array<{ id: string; type: string; name: string; config: Record<string, unknown> }>;
  edges: Array<{ source: string; target: string }>;
  tags: string[];
  metadata: Record<string, unknown>;
} {
  const nodes: Array<{ id: string; type: string; name: string; config: Record<string, unknown> }> = [];
  const edges: Array<{ source: string; target: string }> = [];

  // Trigger
  nodes.push({
    id: 'trigger',
    type: 'trigger:webhook',
    name: 'Start',
    config: { path: `/crystallised/${candidate.workflowId}`, method: 'POST' },
  });

  // Convert each canonical action to a deterministic node
  for (let i = 0; i < candidate.canonicalActions.length; i++) {
    const action = candidate.canonicalActions[i];
    const nodeId = `step-${i}`;

    nodes.push({
      id: nodeId,
      type: actionToNodeType(action.action),
      name: `Step ${i + 1}: ${action.action}`,
      config: { ...action.params },
    });

    // Sequential edges
    if (i === 0) {
      edges.push({ source: 'trigger', target: nodeId });
    } else {
      edges.push({ source: `step-${i - 1}`, target: nodeId });
    }
  }

  return {
    id: `crystallised-${candidate.workflowId}-${Date.now()}`,
    name: `${candidate.workflowName} (crystallised)`,
    version: '1.0.0',
    nodes,
    edges,
    tags: ['crystallised', 'deterministic'],
    metadata: {
      sourceWorkflowId: candidate.workflowId,
      crystallisedAt: new Date().toISOString(),
      confidence: candidate.confidence,
      executionCount: candidate.executionCount,
      successRate: candidate.successRate,
      variables: candidate.variables,
    },
  };
}

/**
 * P9.4: Analyse an in-flight Crystal draft (not execution history) to determine
 * if it meets the confidence threshold for task-time promotion.
 *
 * Uses structural consistency of the recorded actionLog as a proxy for
 * confidence (same algorithm as analyseExecutionHistory, but for a single run).
 * Ignores LLM-self-reported confidence — recomputes it structurally.
 *
 * Sentinel-4 Fix2: also checks consecutiveSuccess against the threshold.
 * Both confidence AND consecutiveSuccess must meet their respective thresholds
 * for the draft to be promoted.
 */
export function analyseDraft(draft: {
  name: string;
  actionPattern: string;
  confidence: number;
  refineCount: number;
  /** Sentinel-4 Fix2: number of consecutive successful matching runs */
  consecutiveSuccess?: number;
}, actionLog: Array<{ action: string; success: boolean }>, threshold: { confidence: number; consecutive_success: number }): {
  ready: boolean;
  reason?: string;
  recomputedConfidence: number;
  /** Sentinel-4 Fix2: current consecutiveSuccess count, for diagnostic logging */
  consecutiveSuccess: number;
} {
  const consecutiveSuccess = draft.consecutiveSuccess ?? 0;

  if (!draft.actionPattern || draft.actionPattern.trim() === '') {
    return { ready: false, reason: 'No action pattern recorded', recomputedConfidence: 0, consecutiveSuccess };
  }

  // AGH-1.fix-3: filter meta-actions (done / propose_crystal / refine_crystal)
  // from successRate. Rejected propose_crystal attempts and the engine_nudge'd
  // done attempts pollute the actionLog with success:false entries, depressing
  // the recomputed confidence below threshold even when the underlying tool
  // calls all succeeded. Sentinel runs hit 1.00 (no propose-spam); BEACON
  // runs hovered 0.70-0.77 because of propose-spam from the LLM. The Crystal's
  // promotability should be measured against REAL tool execution, not against
  // the LLM's bookkeeping noise around when to propose.
  const META_ACTIONS = new Set(['done', 'propose_crystal', 'refine_crystal']);
  const realActions = actionLog.filter(a => !META_ACTIONS.has(a.action));
  const successfulActions = realActions.filter(a => a.success);
  const successRate = realActions.length > 0 ? successfulActions.length / realActions.length : 0;

  // Structural consistency bonus: penalise drafts that required many refinements
  const refinePenalty = draft.refineCount * 0.05;
  const recomputedConfidence = Math.max(0, Math.min(1, successRate * 0.7 + (1 - refinePenalty) * 0.3));

  if (recomputedConfidence < threshold.confidence) {
    return {
      ready: false,
      reason: `Recomputed confidence ${recomputedConfidence.toFixed(2)} < threshold ${threshold.confidence}`,
      recomputedConfidence,
      consecutiveSuccess,
    };
  }

  // Sentinel-4 Fix2: require consecutiveSuccess threshold BEFORE promoting
  if (consecutiveSuccess < threshold.consecutive_success) {
    return {
      ready: false,
      reason: `consecutive_success ${consecutiveSuccess} < threshold ${threshold.consecutive_success}`,
      recomputedConfidence,
      consecutiveSuccess,
    };
  }

  return { ready: true, recomputedConfidence, consecutiveSuccess };
}

/**
 * Determine if a crystallised workflow should revert to dynamic (agentic) mode.
 * This happens when recent execution failure rate exceeds the threshold.
 */
export function shouldRevertToDynamic(
  recentResults: Array<{ success: boolean }>,
  options: { failureThreshold?: number } = {}
): boolean {
  const threshold = options.failureThreshold ?? 0.4;
  if (recentResults.length === 0) return false;

  const failureCount = recentResults.filter(r => !r.success).length;
  const failureRate = failureCount / recentResults.length;

  return failureRate > threshold;
}
