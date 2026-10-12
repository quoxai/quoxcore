/**
 * Test Agent Executor Registration
 *
 * Registers the three test-agent node types with the executor registry so that
 * an `agent:agentic` workflow node can invoke them through the standard
 * non-browser action dispatch path in AgenticExecutor.
 *
 * Node types registered:
 *   action:echo        — wraps tools.echo()
 *   action:arithmetic  — wraps tools.arithmetic()
 *   action:complete    — wraps tools.complete() (signals "done" to caller)
 *
 * The agentic executor maps action names to node types via mapActionToNodeType
 * (falls back to `action:<name>`), so all three are reachable without any
 * change to the executor itself.
 */

import { NodeExecutor, ExecutorResult, ExecutorRegistry } from '../../executors/executor.interface.js';
import { Node } from '../../core/workflow.js';
import { ExecutionContext } from '../../core/execution.js';
import { dispatchTool } from './tools.js';

class TestAgentToolExecutor implements NodeExecutor {
  readonly nodeTypes: string[];

  constructor(toolName: string) {
    this.nodeTypes = [`action:${toolName}`];
  }

  async execute(node: Node, input: unknown, _context: ExecutionContext): Promise<ExecutorResult> {
    const config = (node as any).config as Record<string, unknown> || {};
    const toolName = this.nodeTypes[0].replace('action:', '');
    try {
      const output = dispatchTool(toolName, config);
      return { success: true, output, envelopes: [] };
    } catch (err: any) {
      return {
        success: false,
        output: null,
        error: { code: 'TOOL_ERROR', message: err.message },
        envelopes: [],
      };
    }
  }
}

export const echoExecutor = new TestAgentToolExecutor('echo');
export const arithmeticExecutor = new TestAgentToolExecutor('arithmetic');
export const completeExecutor = new TestAgentToolExecutor('complete');

/**
 * Register all test-agent executors onto the provided registry.
 * Call this in test setup to make the agentic loop work with test-agent tools.
 */
export function registerTestAgent(registry: ExecutorRegistry): void {
  registry.register(echoExecutor);
  registry.register(arithmeticExecutor);
  registry.register(completeExecutor);
}
