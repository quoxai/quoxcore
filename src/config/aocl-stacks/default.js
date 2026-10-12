/**
 * Default AOCL Processing Stack
 *
 * Standard configuration for agent request processing.
 * Full pipeline with policy gate and response verification enabled.
 */

export const DEFAULT_STACK = {
  id: 'default',
  name: 'Default Processing Stack',
  description: 'Standard agent processing with routing, context, and execution',

  layers: {
    // L0: Event normalization - always required
    L0: {
      enabled: true,
      required: true,
      name: 'ingress.normalize',
      description: 'Parse and normalize incoming request'
    },

    // L1: Identity/permissions - future phase
    L1: {
      enabled: false,
      required: false,
      name: 'identity.scope',
      description: 'Verify identity and permissions'
    },

    // L2: Smart Router - pattern matching and classification
    L2: {
      enabled: true,
      required: false,
      name: 'route.smart',
      description: 'Classify intent and route to handler',
      config: {
        highConfidenceThreshold: 0.9,
        mediumConfidenceThreshold: 0.7,
        enableSemanticLayer: true
      }
    },

    // L3: Policy gate - safety checks
    L3: {
      enabled: true,
      required: false,
      name: 'policy.gate',
      description: 'Rate limiting, content safety, and scope authorization',
      config: {
        rateLimits: {
          queriesPerMinute: 30,
          queriesPerHour: 300
        },
        enforceScopes: true,
        contentSafety: true
      }
    },

    // L4: Intent decomposition - future phase
    L4: {
      enabled: false,
      required: false,
      name: 'plan.decompose',
      description: 'Break complex requests into subtasks'
    },

    // L5: Context retrieval - memory and RAG
    L5: {
      enabled: true,
      required: false,
      name: 'context.retrieve',
      description: 'Retrieve relevant context and memory',
      config: {
        enableMemory: true,
        enableQuoxContext: true,
        maxContextTokens: 4000
      }
    },

    // L6: Prompt shaping - future phase
    L6: {
      enabled: false,
      required: false,
      name: 'shape.rewrite',
      description: 'Restructure prompt for optimal results'
    },

    // L7: LLM/tool execution
    L7: {
      enabled: true,
      required: true,
      name: 'delegate.execute',
      description: 'Execute via Claude or tools',
      config: {
        defaultModel: 'claude',
        timeout: 60000,
        retries: 1
      }
    },

    // L8: Response verification
    L8: {
      enabled: true,
      required: false,
      name: 'verify.check',
      description: 'Validate response length, content safety, and consistency',
      config: {
        checkLength: true,
        checkSafety: true,
        checkConsistency: true,
        warnOnHallucination: true
      }
    },

    // L9: Response assembly
    L9: {
      enabled: true,
      required: true,
      name: 'assemble.respond',
      description: 'Build final response for user'
    },

    // L10: Audit writeback - always required
    L10: {
      enabled: true,
      required: true,
      name: 'audit.writeback',
      description: 'Persist trace to AEE storage'
    }
  },

  settings: {
    // Emit AOCL layer events to AEE
    emitEvents: true,

    // Show real-time layer visualization
    realTimeVisualization: true,

    // Maximum total processing time (ms)
    maxProcessingTime: 120000,

    // Fail fast on layer errors
    failFast: false,

    // Include layer timing in response metadata
    includeTimingMetadata: true
  }
}

export default DEFAULT_STACK
