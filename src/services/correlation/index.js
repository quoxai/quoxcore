/**
 * Correlation Services Index
 *
 * Exports multi-agent correlation functionality.
 * Part of AOCL Compliance Suite (Enterprise)
 */

export {
  findCorrelatedTraces,
  getCorrelationTree,
  getAgentHandoffs,
  aggregateCorrelationStats,
  hasMultiAgentTraces,
  getSavedCorrelations,
  clearCorrelationCache
} from './correlationEngine'
