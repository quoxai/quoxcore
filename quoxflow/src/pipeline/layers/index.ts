/**
 * Control Layer Interfaces
 *
 * AOCL (Agent Orchestration Control Layers) — aligned with QuoxCORE L0-L10:
 *   IngressLayer  = L0 ingress.normalize
 *   IdentityLayer = L1 identity.scope
 *   PolicyLayer   = L3 policy.gate
 *   ContextLayer  = L5 context.retrieve
 *   (Execute)     = L7 delegate.execute (implicit, handled by pipeline)
 *   VerifyLayer   = L8 verify.check
 *   AssembleLayer = L9 assemble.respond
 *
 * L2 (route.smart), L4 (plan.decompose), L6 (shape.rewrite), L10 (audit.writeback)
 * are QuoxCORE-specific layers not needed in workflow execution.
 */

import { Envelope } from '../../core/envelope.js';
import { ExecutionContext } from '../../core/execution.js';

/**
 * Result returned by each control layer
 */
export interface LayerResult {
  proceed: boolean;          // Continue to next layer?
  data: unknown;             // Data to pass to next layer
  reason?: string;           // Reason if not proceeding
  envelopes: Envelope[];     // Envelopes documenting this layer's decisions
  metadata?: Record<string, unknown>;
}

/**
 * Base interface for all control layers
 */
export interface ControlLayer {
  process(data: unknown, context: ExecutionContext): Promise<LayerResult>;
}

/**
 * Ingress Layer - Request normalization and initial validation
 *
 * Responsibilities:
 * - Normalize incoming request format
 * - Basic validation (schema, size limits)
 * - Rate limiting checks
 * - Request logging
 */
export interface IngressLayer extends ControlLayer {
  process(data: unknown, context: ExecutionContext): Promise<LayerResult>;
}

/**
 * Identity Layer - Authentication and identification
 *
 * Responsibilities:
 * - Verify authentication tokens
 * - Extract identity claims
 * - Check identity is active/valid
 * - Document who is making the request
 */
export interface IdentityLayer extends ControlLayer {
  process(data: unknown, context: ExecutionContext): Promise<LayerResult>;
}

/**
 * Policy Layer - Authorization and policy evaluation
 *
 * Responsibilities:
 * - Evaluate access policies
 * - Check permissions
 * - Enforce business rules
 * - Document policy decisions (including bypasses)
 */
export interface PolicyLayer extends ControlLayer {
  process(data: unknown, context: ExecutionContext): Promise<LayerResult>;
}

/**
 * Context Layer - Environment and resource loading
 *
 * Responsibilities:
 * - Load workflow variables
 * - Fetch credentials (from secure store)
 * - Load external context needed for execution
 * - Cache commonly accessed resources
 */
export interface ContextLayer extends ControlLayer {
  process(data: unknown, context: ExecutionContext): Promise<LayerResult>;
}

/**
 * Verify Layer - Output validation
 *
 * Responsibilities:
 * - Validate execution outputs
 * - Check data quality
 * - Verify business constraints
 * - Ensure outputs meet requirements
 */
export interface VerifyLayer extends ControlLayer {
  process(data: unknown, context: ExecutionContext): Promise<LayerResult>;
}

/**
 * Assemble Layer - Response construction
 *
 * Responsibilities:
 * - Format final response
 * - Apply output transformations
 * - Add metadata/headers
 * - Prepare audit summary
 */
export interface AssembleLayer extends ControlLayer {
  process(data: unknown, context: ExecutionContext): Promise<LayerResult>;
}

// Re-export for convenience
export type { Envelope } from '../../core/envelope.js';
export type { ExecutionContext } from '../../core/execution.js';
