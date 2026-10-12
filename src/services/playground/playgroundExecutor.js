/**
 * Playground Executor - Isolated Layer Execution
 *
 * Executes AOCL layers in isolation for testing and debugging.
 * Part of AOCL Developer Kit (Free)
 */

import { AOCL_LAYERS, createLayerEvent } from '../../lib/aee'

// Test case storage
const customTestCases = new Map()

/**
 * Execute a single layer in isolation
 */
export async function executeLayerInIsolation(layerId, input, context = {}, config = {}) {
  const startTime = Date.now()
  const emittedEvents = []

  // Create event capture function
  const captureEvent = (event) => {
    emittedEvents.push({
      ...event,
      capturedAt: Date.now()
    })
  }

  try {
    // Get layer definition
    const layerDef = AOCL_LAYERS[layerId]
    if (!layerDef) {
      throw new Error(`Unknown layer: ${layerId}`)
    }

    // Emit start event
    const startEvent = createLayerEvent(layerId, 'start', { input }, 'PLAYGROUND')
    captureEvent(startEvent)

    // Execute layer based on type
    let result
    switch (layerId) {
      case 'L0':
        result = await executeL0Normalize(input, context, config)
        break
      case 'L2':
        result = await executeL2Route(input, context, config)
        break
      case 'L3':
        result = await executeL3Policy(input, context, config)
        break
      case 'L5':
        result = await executeL5Context(input, context, config)
        break
      case 'L7':
        result = await executeL7Delegate(input, context, config)
        break
      case 'L8':
        result = await executeL8Verify(input, context, config)
        break
      case 'L9':
        result = await executeL9Assemble(input, context, config)
        break
      case 'L10':
        result = await executeL10Audit(input, context, config)
        break
      default:
        result = { status: 'bypass', reason: 'Layer not implemented in playground' }
    }

    const duration_ms = Date.now() - startTime

    // Emit complete event
    const completeEvent = createLayerEvent(layerId, result.status || 'complete', {
      ...result,
      duration_ms
    }, 'PLAYGROUND')
    captureEvent(completeEvent)

    return {
      success: true,
      layerId,
      layerName: layerDef.label,
      result,
      timing: {
        duration_ms,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString()
      },
      events: emittedEvents,
      input,
      context,
      config
    }
  } catch (err) {
    const duration_ms = Date.now() - startTime

    // Emit error event
    const errorEvent = createLayerEvent(layerId, 'error', {
      error: err.message,
      duration_ms
    }, 'PLAYGROUND')
    captureEvent(errorEvent)

    return {
      success: false,
      layerId,
      error: err.message,
      timing: {
        duration_ms,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString()
      },
      events: emittedEvents,
      input,
      context,
      config
    }
  }
}

/**
 * L0: Normalize - Input normalization and sanitization
 */
async function executeL0Normalize(input, context, config) {
  const query = input.query || input.text || ''

  // Simulate normalization
  await simulateDelay(10, 30)

  const normalized = {
    originalQuery: query,
    normalizedQuery: query.trim().toLowerCase(),
    length: query.length,
    wordCount: query.split(/\s+/).filter(w => w).length,
    hasSpecialChars: /[^a-zA-Z0-9\s]/.test(query),
    language: detectLanguage(query),
    timestamp: new Date().toISOString()
  }

  return {
    status: 'complete',
    normalized,
    transformations: [
      'trim_whitespace',
      'lowercase',
      'detect_language'
    ]
  }
}

/**
 * L2: Route - Smart routing decisions
 */
async function executeL2Route(input, context, config) {
  const query = input.query || input.normalizedQuery || ''

  await simulateDelay(20, 50)

  // Simulate routing patterns
  const patterns = [
    { pattern: 'install', handler: 'deployment', confidence: 0.9 },
    { pattern: 'status', handler: 'monitoring', confidence: 0.85 },
    { pattern: 'help', handler: 'documentation', confidence: 0.8 },
    { pattern: 'error', handler: 'diagnostics', confidence: 0.75 },
    { pattern: 'create', handler: 'generator', confidence: 0.7 }
  ]

  let bestMatch = null
  for (const p of patterns) {
    if (query.toLowerCase().includes(p.pattern)) {
      if (!bestMatch || p.confidence > bestMatch.confidence) {
        bestMatch = p
      }
    }
  }

  if (bestMatch && bestMatch.confidence >= (config.minConfidence || 0.7)) {
    return {
      status: 'complete',
      handled: true,
      handler: bestMatch.handler,
      pattern: bestMatch.pattern,
      confidence: bestMatch.confidence,
      reason: `Matched pattern "${bestMatch.pattern}" with confidence ${bestMatch.confidence}`
    }
  }

  return {
    status: 'bypass',
    handled: false,
    reason: 'No matching pattern found, forwarding to L7',
    testedPatterns: patterns.map(p => p.pattern)
  }
}

/**
 * L3: Policy - Policy gate checks
 */
async function executeL3Policy(input, context, config) {
  const query = input.query || input.normalizedQuery || ''

  await simulateDelay(15, 40)

  const checks = []

  // Rate limit check
  const rateLimitOk = !config.simulateRateLimit
  checks.push({
    name: 'rate_limit',
    passed: rateLimitOk,
    details: rateLimitOk ? 'Within limits' : 'Rate limit exceeded'
  })

  // Content safety check
  const dangerousPatterns = ['drop table', 'rm -rf', 'format c:', 'delete all']
  const hasDangerous = dangerousPatterns.some(p => query.toLowerCase().includes(p))
  checks.push({
    name: 'content_safety',
    passed: !hasDangerous,
    details: hasDangerous ? 'Potentially dangerous content detected' : 'Content is safe'
  })

  // Scope check
  const outOfScope = config.simulateOutOfScope || false
  checks.push({
    name: 'scope',
    passed: !outOfScope,
    details: outOfScope ? 'Query is out of scope for this agent' : 'Query is within scope'
  })

  // Length check
  const tooLong = query.length > (config.maxQueryLength || 10000)
  checks.push({
    name: 'length',
    passed: !tooLong,
    details: tooLong ? `Query exceeds max length of ${config.maxQueryLength || 10000}` : 'Length OK'
  })

  const allPassed = checks.every(c => c.passed)
  const failedChecks = checks.filter(c => !c.passed)

  if (allPassed) {
    return {
      status: 'complete',
      allowed: true,
      checks,
      reason: 'All policy checks passed'
    }
  }

  return {
    status: 'reject',
    allowed: false,
    checks,
    failedChecks: failedChecks.map(c => c.name),
    reason: `Policy check failed: ${failedChecks.map(c => c.details).join(', ')}`
  }
}

/**
 * L5: Context - Memory and RAG retrieval
 */
async function executeL5Context(input, context, config) {
  const query = input.query || input.normalizedQuery || ''

  await simulateDelay(50, 150)

  // Simulate memory retrieval
  const retrievedItems = []

  // Episodic memory
  if (!config.disableEpisodic) {
    retrievedItems.push({
      type: 'episodic',
      content: `Previous conversation about "${query.slice(0, 20)}..."`,
      relevance: 0.75,
      timestamp: new Date(Date.now() - 3600000).toISOString()
    })
  }

  // Semantic memory
  if (!config.disableSemantic) {
    retrievedItems.push({
      type: 'semantic',
      content: `Related knowledge: ${query.split(' ').slice(0, 3).join(' ')} concepts`,
      relevance: 0.82,
      source: 'knowledge_base'
    })
  }

  // Entity memory
  if (!config.disableEntity) {
    retrievedItems.push({
      type: 'entity',
      content: 'Entity: user.preferences, host.docker01',
      relevance: 0.68,
      entityCount: 2
    })
  }

  // RAG results
  if (!config.disableRAG) {
    retrievedItems.push({
      type: 'rag',
      content: 'Document chunk from knowledge base',
      relevance: 0.88,
      source: 'qdrant',
      chunkId: 'DOC_001_CHUNK_42'
    })
  }

  return {
    status: 'complete',
    itemCount: retrievedItems.length,
    items: retrievedItems,
    totalRelevance: retrievedItems.reduce((sum, i) => sum + i.relevance, 0) / retrievedItems.length,
    sources: [...new Set(retrievedItems.map(i => i.type))]
  }
}

/**
 * L7: Delegate - LLM/External execution
 */
async function executeL7Delegate(input, context, config) {
  const query = input.query || ''

  // Simulate LLM call delay
  await simulateDelay(200, 500)

  if (config.simulateError) {
    throw new Error('Simulated LLM error: API rate limit exceeded')
  }

  if (config.simulateTimeout) {
    await simulateDelay(5000, 5000)
    throw new Error('Simulated timeout')
  }

  // Generate mock response
  const mockResponse = config.mockResponse || generateMockResponse(query)

  return {
    status: 'complete',
    provider: config.provider || 'claude',
    model: config.model || 'claude-3-opus',
    response: mockResponse,
    usage: {
      inputTokens: Math.ceil(query.length / 4),
      outputTokens: Math.ceil(mockResponse.length / 4),
      totalTokens: Math.ceil((query.length + mockResponse.length) / 4)
    },
    latency: {
      ttft: 150 + Math.random() * 100,
      total: 300 + Math.random() * 200
    }
  }
}

/**
 * L8: Verify - Response verification
 */
async function executeL8Verify(input, context, config) {
  const response = input.response || ''

  await simulateDelay(30, 80)

  const checks = []
  const warnings = []

  // Length check
  const lengthOk = response.length >= (config.minLength || 10) &&
                   response.length <= (config.maxLength || 50000)
  checks.push({
    name: 'length',
    passed: lengthOk,
    value: response.length
  })
  if (!lengthOk) warnings.push('Response length outside acceptable range')

  // Safety check
  const unsafePatterns = ['confidential', 'password', 'secret key', 'api_key']
  const hasUnsafe = unsafePatterns.some(p => response.toLowerCase().includes(p))
  checks.push({
    name: 'safety',
    passed: !hasUnsafe,
    flagged: hasUnsafe ? unsafePatterns.filter(p => response.toLowerCase().includes(p)) : []
  })
  if (hasUnsafe) warnings.push('Response may contain sensitive information')

  // Consistency check (mock)
  const consistencyScore = 0.85 + Math.random() * 0.15
  checks.push({
    name: 'consistency',
    passed: consistencyScore > 0.7,
    score: consistencyScore
  })

  // Hallucination check (mock)
  const hallucinationScore = Math.random() * 0.3
  checks.push({
    name: 'hallucination',
    passed: hallucinationScore < 0.2,
    score: hallucinationScore
  })
  if (hallucinationScore >= 0.2) warnings.push('Potential hallucination detected')

  const allPassed = checks.every(c => c.passed)

  return {
    status: allPassed ? 'complete' : 'warning',
    valid: allPassed,
    checks,
    warnings,
    overallScore: checks.reduce((sum, c) => sum + (c.passed ? 1 : 0), 0) / checks.length
  }
}

/**
 * L9: Assemble - Response assembly
 */
async function executeL9Assemble(input, context, config) {
  const response = input.response || ''
  const contextItems = input.contextItems || []

  await simulateDelay(20, 50)

  // Simulate response formatting
  const formatted = {
    content: response,
    format: config.format || 'markdown',
    citations: contextItems.filter(i => i.type === 'rag').length,
    attachments: [],
    metadata: {
      generatedAt: new Date().toISOString(),
      confidence: 0.85 + Math.random() * 0.1
    }
  }

  // Add styling if configured
  if (config.addStyling) {
    formatted.styling = {
      tone: 'professional',
      verbosity: 'normal',
      persona: 'assistant'
    }
  }

  return {
    status: 'complete',
    assembled: formatted,
    transformations: [
      'format_markdown',
      'add_citations',
      'apply_persona'
    ],
    outputLength: response.length
  }
}

/**
 * L10: Audit - Audit logging
 */
async function executeL10Audit(input, context, config) {
  await simulateDelay(10, 20)

  const auditRecord = {
    id: `AUDIT_${Date.now()}`,
    timestamp: new Date().toISOString(),
    runId: context.runId || 'PLAYGROUND',
    layers: input.layersExecuted || ['L0', 'L2', 'L5', 'L7', 'L9'],
    duration: input.totalDuration || 0,
    status: input.status || 'complete',
    user: context.user || 'playground_user',
    agent: context.agent || 'playground'
  }

  return {
    status: 'complete',
    recorded: true,
    auditId: auditRecord.id,
    destination: config.destination || 'local',
    record: auditRecord
  }
}

/**
 * Get available test cases for a layer
 */
export function getTestCasesForLayer(layerId) {
  const builtIn = BUILT_IN_TEST_CASES[layerId] || []
  const custom = Array.from(customTestCases.values()).filter(tc => tc.layerId === layerId)
  return [...builtIn, ...custom]
}

/**
 * Save a custom test case
 */
export function saveCustomTestCase(testCase) {
  const id = testCase.id || `TC_${Date.now()}`
  customTestCases.set(id, { ...testCase, id, custom: true })
  return id
}

/**
 * Delete a custom test case
 */
export function deleteCustomTestCase(testCaseId) {
  return customTestCases.delete(testCaseId)
}

/**
 * Get all custom test cases
 */
export function getCustomTestCases() {
  return Array.from(customTestCases.values())
}

// Built-in test cases
const BUILT_IN_TEST_CASES = {
  L0: [
    {
      id: 'L0_basic',
      name: 'Basic Normalization',
      description: 'Test basic query normalization',
      input: { query: '  Hello World!  ' },
      context: {},
      config: {},
      expectedStatus: 'complete'
    },
    {
      id: 'L0_special_chars',
      name: 'Special Characters',
      description: 'Test handling of special characters',
      input: { query: 'SELECT * FROM users WHERE id=1;' },
      context: {},
      config: {},
      expectedStatus: 'complete'
    },
    {
      id: 'L0_unicode',
      name: 'Unicode Support',
      description: 'Test Unicode character handling',
      input: { query: 'Hello \u4e16\u754c \ud83c\udf0d' },
      context: {},
      config: {},
      expectedStatus: 'complete'
    }
  ],
  L2: [
    {
      id: 'L2_match',
      name: 'Pattern Match',
      description: 'Test successful pattern matching',
      input: { query: 'install the package on server' },
      context: {},
      config: { minConfidence: 0.7 },
      expectedStatus: 'complete'
    },
    {
      id: 'L2_bypass',
      name: 'No Match (Bypass)',
      description: 'Test bypass when no pattern matches',
      input: { query: 'What is the meaning of life?' },
      context: {},
      config: { minConfidence: 0.7 },
      expectedStatus: 'bypass'
    },
    {
      id: 'L2_low_confidence',
      name: 'Low Confidence',
      description: 'Test high confidence threshold',
      input: { query: 'maybe help me' },
      context: {},
      config: { minConfidence: 0.95 },
      expectedStatus: 'bypass'
    }
  ],
  L3: [
    {
      id: 'L3_pass',
      name: 'All Checks Pass',
      description: 'Test when all policy checks pass',
      input: { query: 'Tell me about the weather' },
      context: {},
      config: {},
      expectedStatus: 'complete'
    },
    {
      id: 'L3_dangerous',
      name: 'Dangerous Content',
      description: 'Test content safety rejection',
      input: { query: 'DROP TABLE users;' },
      context: {},
      config: {},
      expectedStatus: 'reject'
    },
    {
      id: 'L3_rate_limit',
      name: 'Rate Limited',
      description: 'Test rate limit rejection',
      input: { query: 'Normal query' },
      context: {},
      config: { simulateRateLimit: true },
      expectedStatus: 'reject'
    }
  ],
  L5: [
    {
      id: 'L5_full',
      name: 'Full Context Retrieval',
      description: 'Test all memory sources',
      input: { query: 'What did we discuss about Docker?' },
      context: {},
      config: {},
      expectedStatus: 'complete'
    },
    {
      id: 'L5_rag_only',
      name: 'RAG Only',
      description: 'Test with only RAG enabled',
      input: { query: 'Search the documents' },
      context: {},
      config: { disableEpisodic: true, disableSemantic: true, disableEntity: true },
      expectedStatus: 'complete'
    }
  ],
  L7: [
    {
      id: 'L7_success',
      name: 'Successful Delegation',
      description: 'Test successful LLM call',
      input: { query: 'Explain quantum computing' },
      context: {},
      config: {},
      expectedStatus: 'complete'
    },
    {
      id: 'L7_error',
      name: 'API Error',
      description: 'Test error handling',
      input: { query: 'Any query' },
      context: {},
      config: { simulateError: true },
      expectedStatus: 'error'
    },
    {
      id: 'L7_mock',
      name: 'Mock Response',
      description: 'Test with custom mock response',
      input: { query: 'Test query' },
      context: {},
      config: { mockResponse: 'This is a custom mock response for testing.' },
      expectedStatus: 'complete'
    }
  ],
  L8: [
    {
      id: 'L8_valid',
      name: 'Valid Response',
      description: 'Test valid response verification',
      input: { response: 'This is a perfectly normal and safe response about programming.' },
      context: {},
      config: {},
      expectedStatus: 'complete'
    },
    {
      id: 'L8_sensitive',
      name: 'Sensitive Content',
      description: 'Test sensitive content detection',
      input: { response: 'The API_KEY is sk-1234567890' },
      context: {},
      config: {},
      expectedStatus: 'warning'
    }
  ],
  L9: [
    {
      id: 'L9_basic',
      name: 'Basic Assembly',
      description: 'Test basic response assembly',
      input: { response: 'Here is the assembled response content.' },
      context: {},
      config: {},
      expectedStatus: 'complete'
    },
    {
      id: 'L9_styled',
      name: 'Styled Assembly',
      description: 'Test with styling applied',
      input: { response: 'Response with styling options.' },
      context: {},
      config: { addStyling: true, format: 'markdown' },
      expectedStatus: 'complete'
    }
  ],
  L10: [
    {
      id: 'L10_basic',
      name: 'Basic Audit',
      description: 'Test basic audit logging',
      input: { layersExecuted: ['L0', 'L2', 'L7', 'L9'], totalDuration: 450, status: 'complete' },
      context: { runId: 'TEST_RUN_001', user: 'test_user' },
      config: {},
      expectedStatus: 'complete'
    }
  ]
}

// Helper functions

function simulateDelay(min, max) {
  const delay = min + Math.random() * (max - min)
  return new Promise(resolve => setTimeout(resolve, delay))
}

function detectLanguage(text) {
  // Simple language detection mock
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh'
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) return 'ja'
  if (/[\uac00-\ud7af]/.test(text)) return 'ko'
  if (/[\u0400-\u04ff]/.test(text)) return 'ru'
  return 'en'
}

function generateMockResponse(query) {
  const responses = [
    `Based on your query about "${query.slice(0, 30)}...", here is a comprehensive response that addresses your question with relevant information and context.`,
    `I understand you're asking about ${query.split(' ').slice(0, 3).join(' ')}. Let me provide you with a detailed explanation and some helpful insights.`,
    `Great question! Here's what you need to know about this topic. The key points to consider are: accuracy, relevance, and completeness.`
  ]
  return responses[Math.floor(Math.random() * responses.length)]
}

/**
 * Get layer metadata for playground UI
 */
export function getLayerMetadata() {
  return Object.entries(AOCL_LAYERS).map(([id, layer]) => ({
    id,
    ...layer,
    testCaseCount: (BUILT_IN_TEST_CASES[id] || []).length +
                   Array.from(customTestCases.values()).filter(tc => tc.layerId === id).length
  }))
}
