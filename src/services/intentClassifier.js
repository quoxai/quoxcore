/**
 * Intent Classifier Interface
 *
 * Standardized interface for intent classification methods.
 * All classifiers (regex, semantic, LLM) implement this interface.
 */

/**
 * @typedef {Object} ClassificationResult
 * @property {string} intent - The classified intent name
 * @property {number} confidence - Confidence score (0.0 - 1.0)
 * @property {string} [layer] - Which classification layer produced this result
 * @property {Object} [metadata] - Additional metadata about the classification
 * @property {Array<AlternativeIntent>} [alternatives] - Other possible intents
 */

/**
 * @typedef {Object} AlternativeIntent
 * @property {string} intent - Alternative intent name
 * @property {number} confidence - Confidence for this alternative
 */

/**
 * @typedef {Object} IntentDefinition
 * @property {string} name - Intent identifier
 * @property {string} description - Human-readable description
 * @property {string[]} [examples] - Example utterances
 * @property {number} [threshold] - Custom confidence threshold for this intent
 * @property {string} [riskLevel] - 'low' | 'medium' | 'high' | 'critical'
 */

/**
 * Base class for intent classifiers
 * @abstract
 */
export class IntentClassifier {
  constructor(name, options = {}) {
    this.name = name
    this.options = options
    this.intents = new Map()
  }

  /**
   * Register an intent with this classifier
   * @param {IntentDefinition} intent
   */
  registerIntent(intent) {
    this.intents.set(intent.name, intent)
  }

  /**
   * Register multiple intents
   * @param {IntentDefinition[]} intents
   */
  registerIntents(intents) {
    for (const intent of intents) {
      this.registerIntent(intent)
    }
  }

  /**
   * Get all registered intents
   * @returns {IntentDefinition[]}
   */
  getIntents() {
    return Array.from(this.intents.values())
  }

  /**
   * Get a specific intent by name
   * @param {string} name
   * @returns {IntentDefinition|undefined}
   */
  getIntent(name) {
    return this.intents.get(name)
  }

  /**
   * Classify a query - MUST be implemented by subclasses
   * @abstract
   * @param {string} query - The user query to classify
   * @param {Object} [context] - Optional context (conversation history, user profile, etc.)
   * @returns {Promise<ClassificationResult>}
   */
  async classify(query, context = {}) {
    throw new Error('classify() must be implemented by subclass')
  }

  /**
   * Check if this classifier can handle a query (quick check without full classification)
   * @param {string} query
   * @returns {boolean}
   */
  canClassify(query) {
    return true
  }

  /**
   * Get classifier metadata
   * @returns {Object}
   */
  getMetadata() {
    return {
      name: this.name,
      type: this.constructor.name,
      intentCount: this.intents.size,
      intents: this.getIntents().map(i => i.name)
    }
  }
}

/**
 * Classification result with no match
 * @param {string} layer - Which layer produced this result
 * @returns {ClassificationResult}
 */
export function noMatch(layer = 'unknown') {
  return {
    intent: null,
    confidence: 0,
    layer,
    metadata: { matched: false }
  }
}

/**
 * Create a classification result
 * @param {string} intent
 * @param {number} confidence
 * @param {string} layer
 * @param {Object} [metadata]
 * @param {AlternativeIntent[]} [alternatives]
 * @returns {ClassificationResult}
 */
export function createResult(intent, confidence, layer, metadata = {}, alternatives = []) {
  return {
    intent,
    confidence: Math.max(0, Math.min(1, confidence)), // Clamp to 0-1
    layer,
    metadata: { ...metadata, matched: true },
    alternatives
  }
}

/**
 * Merge results from multiple classifiers
 * Takes the highest confidence result, but preserves alternatives
 * @param {ClassificationResult[]} results
 * @returns {ClassificationResult}
 */
export function mergeResults(results) {
  const validResults = results.filter(r => r && r.intent && r.confidence > 0)

  if (validResults.length === 0) {
    return noMatch('merged')
  }

  // Sort by confidence descending
  validResults.sort((a, b) => b.confidence - a.confidence)

  const best = validResults[0]

  // Collect alternatives from all results
  const alternatives = []
  for (const result of validResults.slice(1)) {
    alternatives.push({
      intent: result.intent,
      confidence: result.confidence
    })
  }

  // Add any alternatives from the best result
  if (best.alternatives) {
    alternatives.push(...best.alternatives)
  }

  // Dedupe and sort alternatives
  const seen = new Set([best.intent])
  const uniqueAlternatives = alternatives
    .filter(a => {
      if (seen.has(a.intent)) return false
      seen.add(a.intent)
      return true
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5) // Keep top 5 alternatives

  return {
    ...best,
    layer: 'merged',
    alternatives: uniqueAlternatives,
    metadata: {
      ...best.metadata,
      mergedFrom: validResults.map(r => r.layer)
    }
  }
}

/**
 * Calculate ambiguity score between top results
 * Higher score = more ambiguous (top results are close in confidence)
 * @param {ClassificationResult} result
 * @returns {number} 0-1 ambiguity score
 */
export function calculateAmbiguity(result) {
  if (!result || !result.alternatives || result.alternatives.length === 0) {
    return 0
  }

  const topConfidence = result.confidence
  const secondConfidence = result.alternatives[0]?.confidence || 0

  // Ambiguity is high when top two are close
  // If gap is 0, ambiguity is 1
  // If gap is 0.5+, ambiguity is 0
  const gap = topConfidence - secondConfidence
  return Math.max(0, 1 - (gap * 2))
}

/**
 * Determine if a result should be trusted based on confidence and ambiguity
 * @param {ClassificationResult} result
 * @param {Object} thresholds
 * @param {number} thresholds.confidence - Minimum confidence (default 0.7)
 * @param {number} thresholds.ambiguity - Maximum ambiguity (default 0.3)
 * @returns {{ trusted: boolean, reason: string }}
 */
export function shouldTrustResult(result, thresholds = {}) {
  const { confidence: minConfidence = 0.7, ambiguity: maxAmbiguity = 0.3 } = thresholds

  if (!result || !result.intent) {
    return { trusted: false, reason: 'no-match' }
  }

  if (result.confidence < minConfidence) {
    return { trusted: false, reason: 'low-confidence' }
  }

  const ambiguity = calculateAmbiguity(result)
  if (ambiguity > maxAmbiguity) {
    return { trusted: false, reason: 'ambiguous' }
  }

  return { trusted: true, reason: 'ok' }
}

export default {
  IntentClassifier,
  noMatch,
  createResult,
  mergeResults,
  calculateAmbiguity,
  shouldTrustResult
}
