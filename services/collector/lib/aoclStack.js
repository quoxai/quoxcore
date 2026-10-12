/**
 * AOCL-FULL-8 — production stack builder + config loader.
 *
 * buildChatStack(deps) wires every L0-L10 module into a single stack
 * definition compatible with runPipeline. This is the single integration
 * point: server.js calls runPipeline(ctx, buildChatStack(deps)) instead
 * of the legacy inline-pipeline code path.
 *
 * Dependencies are passed as a flat object so callers don't need to know
 * which layer consumes which provider:
 *
 *   buildChatStack({
 *     // L4
 *     shouldOrchestrate, createObjective,
 *     // L5
 *     fetchMemory, fetchWorkingSet, fetchRAG, maxMemoryItems,
 *     // L6
 *     quoxContext, memoryContext, adaptStyle, styleProfile,
 *     getAssistantPersona, budgetTokens,
 *     // L7
 *     dispatch,
 *     // L9
 *     redact, toneAdapter, voiceMaxChars,
 *     // Misc
 *     profile, budgets,
 *   })
 *
 * Profiles tune which layers fire:
 *   default     — all 11 canonical layers
 *   minimal     — drops L3/L4/L5/L6/L8 for low-latency chat
 *   policy-only — L0/L1/L2/L3/L10 for policy pre-checks without dispatch
 *
 * loadStackConfig(path) reads a JSON file so stack tuning doesn't require
 * a redeploy. Returns null on missing / malformed so callers fall back to
 * safe defaults.
 */

const fs = require('fs');

const { runL0 } = require('./l0IngressNormalizer.js');
const { runL1 } = require('./l1Identity.js');
const { runL2 } = require('./l2SmartRouter.js');
const { runL3 } = require('./l3PolicyGate.js');
const { runL4 } = require('./l4Planner.js');
const { runL5 } = require('./l5ContextRetriever.js');
const { runL6 } = require('./l6ShapeRewriter.js');
const { runL7 } = require('./l7Delegate.js');
const { runL8 } = require('./l8VerifyCheck.js');
const { runL9 } = require('./l9Assembler.js');
const { runL10 } = require('./l10AuditWriteback.js');

const DEFAULT_STACK_PROFILE = 'default';

const PROFILES = {
  default:       ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10'],
  minimal:       ['L0', 'L1', 'L2',                                'L7',       'L9', 'L10'],
  'policy-only': ['L0', 'L1', 'L2', 'L3',                                            'L10'],
};

/**
 * Build a stack definition with all selected canonical AOCL layers.
 * Each layer's `run` closure captures the relevant injected dependencies.
 */
function buildChatStack(deps = {}) {
  const profile = deps.profile || DEFAULT_STACK_PROFILE;
  const selectedIds = PROFILES[profile] || PROFILES[DEFAULT_STACK_PROFILE];
  const budgets = deps.budgets || {};

  const layerMap = {
    L0: { id: 'L0', run: (ctx) => runL0(ctx) },
    L1: {
      id: 'L1',
      run: (ctx) => runL1(ctx, { enforceIdentity: deps.enforceIdentity }),
    },
    L2: { id: 'L2', run: (ctx) => runL2(ctx) },
    L3: {
      id: 'L3',
      run: (ctx) => runL3(ctx, {
        voltDb: deps.voltDb,
        evaluateCompliance: deps.evaluateCompliance,
        evaluateSafety: deps.evaluateSafety,
      }),
    },
    L8: {
      id: 'L8',
      run: (ctx) => runL8(ctx, {
        verify: deps.verify,
        mode: deps.l8Mode,
        hasRAG: deps.hasRAG,
      }),
    },
    L4: {
      id: 'L4',
      run: (ctx) => runL4(ctx, {
        shouldOrchestrate: deps.shouldOrchestrate,
        createObjective: deps.createObjective,
      }),
    },
    L5: {
      id: 'L5',
      run: (ctx) => runL5(ctx, {
        fetchMemory: deps.fetchMemory,
        fetchWorkingSet: deps.fetchWorkingSet,
        fetchRAG: deps.fetchRAG,
        maxItems: deps.maxMemoryItems,
      }),
    },
    L6: {
      id: 'L6',
      run: (ctx) => runL6(ctx, {
        quoxContext: deps.quoxContext,
        memoryContext: deps.memoryContext,
        adaptStyle: deps.adaptStyle,
        styleProfile: deps.styleProfile,
        getAssistantPersona: deps.getAssistantPersona,
        budgetTokens: deps.budgetTokens,
      }),
    },
    L7: {
      id: 'L7',
      run: (ctx) => runL7(ctx, { dispatch: deps.dispatch }),
    },
    L9: {
      id: 'L9',
      run: (ctx) => runL9(ctx, {
        redact: deps.redact,
        toneAdapter: deps.toneAdapter,
        voiceMaxChars: deps.voiceMaxChars,
      }),
    },
    L10: {
      id: 'L10',
      run: (ctx) => runL10(ctx, {
        pipelineResult: { layersRun: [], layersBypassed: [] },
      }),
    },
  };

  const layers = selectedIds.map(id => layerMap[id]).filter(Boolean);

  return {
    profile,
    layers,
    budgets,
  };
}

/**
 * Load a stack config JSON from disk. Returns null on any failure so the
 * caller can fall back to hard-coded defaults.
 */
function loadStackConfig(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[aoclStack] Failed to load ${filePath}: ${err?.message || err}`);
    return null;
  }
}

module.exports = {
  buildChatStack,
  loadStackConfig,
  DEFAULT_STACK_PROFILE,
  PROFILES,
};
