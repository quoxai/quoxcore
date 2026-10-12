/**
 * Test Agent Tools — lightweight, LLM-free action set for agentic loop red-teaming.
 *
 * Three tools:
 *   echo       — returns the input string unchanged
 *   arithmetic — performs a basic math operation on two numbers
 *   complete   — signals the objective is done (used as the "done" sentinel)
 *
 * These tools are intentionally trivial: no I/O, no network, deterministic.
 * They serve as a harness to exercise the observe-think-act loop in tests
 * without dragging in screencap, LLM, or any external dependency.
 */

export interface EchoInput {
  input: string;
}

export interface EchoOutput {
  output: string;
}

export interface ArithmeticInput {
  op: '+' | '-' | '*' | '/';
  a: number;
  b: number;
}

export interface ArithmeticOutput {
  result: number;
}

export interface CompleteInput {
  reason: string;
}

export interface CompleteOutput {
  done: true;
  reason: string;
}

/**
 * echo — pass-through. Returns the input string as output.
 */
export function echo(input: EchoInput): EchoOutput {
  return { output: input.input };
}

/**
 * arithmetic — perform op(a, b).
 * Division by zero returns Infinity (matches JS behaviour).
 */
export function arithmetic(input: ArithmeticInput): ArithmeticOutput {
  const { op, a, b } = input;
  let result: number;
  switch (op) {
    case '+': result = a + b; break;
    case '-': result = a - b; break;
    case '*': result = a * b; break;
    case '/': result = b !== 0 ? a / b : Infinity; break;
    default: throw new Error(`Unknown op: ${op}`);
  }
  return { result };
}

/**
 * complete — signals the agent is done. The agentic loop treats
 * action === "done" as the termination sentinel; this function is
 * called by the test executor to validate the params are sensible.
 */
export function complete(input: CompleteInput): CompleteOutput {
  if (!input.reason || input.reason.trim().length === 0) {
    throw new Error('complete requires a non-empty reason');
  }
  return { done: true, reason: input.reason };
}

/**
 * Dispatch a test-agent tool call by name.
 * Returns the tool output or throws if the tool is unknown.
 */
export function dispatchTool(
  toolName: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  switch (toolName) {
    case 'echo':
      return echo(params as unknown as EchoInput) as unknown as Record<string, unknown>;
    case 'arithmetic':
      return arithmetic(params as unknown as ArithmeticInput) as unknown as Record<string, unknown>;
    case 'complete':
      return complete(params as unknown as CompleteInput) as unknown as Record<string, unknown>;
    default:
      throw new Error(`Unknown test-agent tool: ${toolName}`);
  }
}
