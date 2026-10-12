/**
 * Expression Engine
 *
 * Evaluates ${...} expressions in workflow configurations.
 * Uses isolated-vm for true V8 isolate separation with memory and CPU limits.
 */

import ivm from 'isolated-vm';
import { ExpressionContext } from '../core/execution.js';

// Expression pattern: ${expression}
const EXPRESSION_PATTERN = /\$\{([^}]+)\}/g;

// Memory limit for the isolate (in MB)
const ISOLATE_MEMORY_LIMIT = 8;
// CPU time limit per expression (in ms)
const EXPRESSION_TIMEOUT = 1000;

/**
 * Create a fresh isolate with the configured memory limit.
 * Each evaluation gets its own isolate to ensure thread safety
 * and prevent state leaks between evaluations.
 */
function createIsolate(): ivm.Isolate {
  return new ivm.Isolate({ memoryLimit: ISOLATE_MEMORY_LIMIT });
}

/**
 * No-op kept for backward compatibility with tests.
 */
export function disposeIsolate(): void {
  // Isolates are now created per-evaluation and disposed automatically
}

// Inline JS to set up sandbox globals inside the isolate.
// This code runs inside the isolated V8 — no access to Node.js APIs.
const SANDBOX_SETUP_CODE = `
  globalThis.$ = {
    now: () => new Date().toISOString(),
    uuid: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }),
    base64Encode: (s) => {
      // UTF-8 safe base64 encoding (btoa only handles Latin-1)
      try { return btoa(unescape(encodeURIComponent(s))); }
      catch { return btoa(s); }
    },
    base64Decode: (s) => {
      try { return decodeURIComponent(escape(atob(s))); }
      catch { return atob(s); }
    },
    jsonPath: (obj, path) => {
      const parts = path.split('.');
      let current = obj;
      for (const part of parts) {
        if (current === null || current === undefined) return undefined;
        const arrMatch = /^(.+)\\[(\\d+)\\]$/.exec(part);
        if (arrMatch) {
          current = current[arrMatch[1]];
          if (Array.isArray(current)) current = current[parseInt(arrMatch[2], 10)];
          else return undefined;
        } else {
          current = current[part];
        }
      }
      return current;
    },
    isEmpty: (v) => v === null || v === undefined || v === '' ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === 'object' && v !== null && Object.keys(v).length === 0),
    first: (arr) => arr[0],
    last: (arr) => arr[arr.length - 1],
    keys: Object.keys,
    values: Object.values,
    entries: Object.entries,
  };
`;


/**
 * Make a value safe for ExternalCopy (strip undefined, functions, symbols)
 */
function toTransferable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

/**
 * Evaluate a single expression in context
 */
export function evaluateExpression(expression: string, context: ExpressionContext): unknown {
  const isolate = createIsolate();

  try {
    const ivmContext = isolate.createContextSync();
    const jail = ivmContext.global;

    // Pass context data as deep copies into the isolate.
    // For undefined input, we declare the variable via script so `input === undefined` works.
    if (context.input === undefined) {
      isolate.compileScriptSync('var input = undefined;').runSync(ivmContext);
    } else {
      jail.setSync('input', new ivm.ExternalCopy(toTransferable(context.input)).copyInto());
    }
    jail.setSync('nodes', new ivm.ExternalCopy(toTransferable(context.nodes)).copyInto());
    jail.setSync('vars', new ivm.ExternalCopy(toTransferable(context.vars)).copyInto());
    // Alias 'variables' to the same workflow variables object as 'vars'.
    // Shipped examples and user workflows are written against ${variables.x};
    // fleet #466: that name resolved to nothing and threw TRANSFORM_FAILED.
    jail.setSync('variables', new ivm.ExternalCopy(toTransferable(context.vars)).copyInto());
    jail.setSync('workflow', new ivm.ExternalCopy(toTransferable(context.workflow)).copyInto());
    jail.setSync('execution', new ivm.ExternalCopy(toTransferable(context.execution)).copyInto());
    jail.setSync('env', new ivm.ExternalCopy(toTransferable(context.env)).copyInto());
    // Loop context: populated when expression runs inside a loop body iteration.
    // Exposes loop.item and loop.index so config expressions can use ${loop.item.x}.
    if (context.loop !== undefined) {
      jail.setSync('loop', new ivm.ExternalCopy(toTransferable(context.loop)).copyInto());
    } else {
      isolate.compileScriptSync('var loop = undefined;').runSync(ivmContext);
    }
    // Also expose loop item vars at the top level: ${item} and ${index}
    // so legacy expressions like ${item.x} work without the loop. prefix.
    if (context.loop !== undefined) {
      jail.setSync('item', new ivm.ExternalCopy(toTransferable(context.loop.item)).copyInto());
      jail.setSync('index', new ivm.ExternalCopy(toTransferable(context.loop.index)).copyInto());
    } else {
      isolate.compileScriptSync('var item = undefined; var index = undefined;').runSync(ivmContext);
    }

    // Set up sandbox globals ($, etc.)
    isolate.compileScriptSync(SANDBOX_SETUP_CODE).runSync(ivmContext, { timeout: 500 });

    // Wrap expression to handle all return types cleanly.
    // We serialize the result as a tagged JSON string to avoid
    // isolated-vm's limitations with transferring complex objects.
    const wrappedExpr = `
      (() => {
        const __r = (${expression});
        const __t = typeof __r;
        if (__t === 'undefined') return '\\x00U';
        if (__r === null) return '\\x00N';
        if (__t === 'boolean') return '\\x00B' + (__r ? '1' : '0');
        if (__t === 'number') return '\\x00D' + String(__r);
        if (__t === 'string') return '\\x00S' + __r;
        return '\\x00J' + JSON.stringify(__r);
      })()
    `;

    const script = isolate.compileScriptSync(wrappedExpr);
    const raw = script.runSync(ivmContext, { timeout: EXPRESSION_TIMEOUT }) as string;

    // Decode the tagged result
    return decodeResult(raw);
  } catch (error) {
    throw new ExpressionError(
      `Expression evaluation failed: ${expression}`,
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    isolate.dispose();
  }
}

/**
 * Decode a tagged result string from the isolate
 */
function decodeResult(raw: string): unknown {
  if (typeof raw !== 'string' || raw.length < 2 || raw[0] !== '\x00') {
    return raw;
  }

  const tag = raw[1];
  const payload = raw.slice(2);

  switch (tag) {
    case 'U': return undefined;
    case 'N': return null;
    case 'B': return payload === '1';
    case 'D': return Number(payload);
    case 'S': return payload;
    case 'J': return JSON.parse(payload);
    default: return raw;
  }
}

/**
 * Interpolate a string with ${...} expressions
 */
export function interpolateString(template: string, context: ExpressionContext): string {
  return template.replace(EXPRESSION_PATTERN, (_match, expr) => {
    const result = evaluateExpression(expr.trim(), context);
    return result === undefined || result === null ? '' : String(result);
  });
}

/**
 * Process a value, evaluating expressions recursively
 */
export function processValue(value: unknown, context: ExpressionContext): unknown {
  if (typeof value === 'string') {
    // Check if it's a pure expression (entire string is one expression)
    const pureExprMatch = /^\$\{(.+)\}$/.exec(value);
    if (pureExprMatch) {
      // Return the actual value, not string
      return evaluateExpression(pureExprMatch[1].trim(), context);
    }

    // Check if it contains expressions
    if (value.includes('${')) {
      return interpolateString(value, context);
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => processValue(item, context));
  }

  if (value !== null && typeof value === 'object') {
    const processed: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      processed[key] = processValue(val, context);
    }
    return processed;
  }

  return value;
}

/**
 * Check if a string contains expressions
 */
export function hasExpressions(value: string): boolean {
  // Reset lastIndex since global regex maintains state
  EXPRESSION_PATTERN.lastIndex = 0;
  return EXPRESSION_PATTERN.test(value);
}

/**
 * Extract all expressions from a string
 */
export function extractExpressions(value: string): string[] {
  const expressions: string[] = [];
  let match;

  // Reset lastIndex since we're reusing the regex
  EXPRESSION_PATTERN.lastIndex = 0;

  while ((match = EXPRESSION_PATTERN.exec(value)) !== null) {
    expressions.push(match[1].trim());
  }

  return expressions;
}

/**
 * Validate that an expression is syntactically correct.
 * Uses isolated-vm's script compilation instead of new Function() (which is equivalent to eval).
 */
export function validateExpression(expression: string): { valid: boolean; error?: string } {
  const isolate = createIsolate();
  try {
    isolate.compileScriptSync(`(${expression})`);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    isolate.dispose();
  }
}

/**
 * Get value by dot-notation path
 */
function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }

    // Handle array index notation: items[0]
    const arrayMatch = /^(.+)\[(\d+)\]$/.exec(part);
    if (arrayMatch) {
      const [, prop, index] = arrayMatch;
      current = (current as Record<string, unknown>)[prop];
      if (Array.isArray(current)) {
        current = current[parseInt(index, 10)];
      } else {
        return undefined;
      }
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }

  return current;
}

/**
 * Expression evaluation error
 */
export class ExpressionError extends Error {
  public readonly details: string;

  constructor(message: string, details: string) {
    super(message);
    this.name = 'ExpressionError';
    this.details = details;
  }
}
