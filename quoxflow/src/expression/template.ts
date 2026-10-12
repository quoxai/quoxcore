/**
 * Template Interpolation Helper
 *
 * Wraps interpolateString with two compatibility shims that human-friendly
 * workflow templates rely on:
 *
 *   1. Handlebars-style markers: `{{X}}` → `${X}` (rewritten before eval).
 *      WEAVER pre-prompt-update + most user copy-paste workflows use this
 *      syntax; without the shim they render the literal `{{X}}` in inbox
 *      bodies.
 *
 *   2. Node-id shorthand: `${nodeId.field}` → `${nodes.nodeId.output.field}`
 *      whenever `nodeId` matches a real workflow node ID or name. The
 *      engine only exposes `nodes.<id>.output.<field>` as the canonical
 *      path, but humans (and LLM authors) write the bare form. Reserved
 *      bindings (input/nodes/vars/workflow/execution/env/$) are passed
 *      through untouched.
 *
 * Errors during evaluation are caught and the ORIGINAL string is returned,
 * so the human receiving the inbox card sees what didn't resolve rather
 * than getting a silent empty body.
 *
 * Used by message/title interpolation in human-task and notification-deliver
 * executors. Keep both in sync by routing through this helper.
 */
import { interpolateString } from './engine.js';
import type { ExecutionContext } from '../core/execution.js';
import type { ExpressionContext } from '../core/execution.js';

const RESERVED = new Set(['input', 'nodes', 'vars', 'workflow', 'execution', 'env', '$']);

export type TemplateInterpolator = (value: string | undefined) => string | undefined;

export function createTemplateInterpolator(
  context: ExecutionContext,
  exprContext: ExpressionContext,
): TemplateInterpolator {
  const nodeRefSet = new Set<string>();
  for (const n of context.workflow.nodes) {
    if (!RESERVED.has(n.id)) nodeRefSet.add(n.id);
    if (n.name && n.name !== n.id && !RESERVED.has(n.name)) nodeRefSet.add(n.name);
  }
  const rewriteNodeRefs = (s: string): string =>
    s.replace(/\$\{(\s*)([A-Za-z_$][\w$]*)(\s*\.\s*)([^}]+)\}/g, (m, sp, head, _dot, rest) => {
      return nodeRefSet.has(head)
        ? `\${${sp}nodes.${head}.output.${rest.trim()}}`
        : m;
    });

  return (value: string | undefined): string | undefined => {
    if (typeof value !== 'string' || value.length === 0) return value;
    let adapted = value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, '${$1}');
    adapted = rewriteNodeRefs(adapted);
    try {
      return interpolateString(adapted, exprContext);
    } catch {
      return value;
    }
  };
}
