/**
 * Test Runner Service
 *
 * Provides test discovery, metadata parsing, and execution capabilities
 * for the Test Lab feature. Works with Vitest test files.
 *
 * Includes AEE logging for test audit trail.
 *
 * @file testRunner.js
 */

import { createEvent, storeEnvelope, prefixedUlid } from '../lib/aee'

/**
 * Test categories mapping test files to logical groups
 */
export const TEST_CATEGORIES = {
  agents: {
    id: 'agents',
    name: 'Agents',
    description: 'Agent delegation, personalities, and manifests',
    icon: '🤖',
    color: '#a78bfa',
    files: ['agentDelegator.test.js', 'agentPersonality.test.js', 'agentRegistry.test.js', 'assistants.test.js'],
    aoclLayer: 3 // Delegation layer
  },
  memory: {
    id: 'memory',
    name: 'Memory',
    description: 'Memory lattice, persistence, and behavior',
    icon: '🧠',
    color: '#8b5cf6',
    files: ['memoryManager.test.js', 'memoryBehavior.test.js', 'memoryTierGating.test.js'],
    aoclLayer: 2 // Context layer
  },
  router: {
    id: 'router',
    name: 'Router',
    description: 'Query routing and semantic matching',
    icon: '🔀',
    color: '#10b981',
    files: ['quoxRouter.test.js', 'semanticRouter.test.js'],
    aoclLayer: 3 // Delegation layer
  },
  protocol: {
    id: 'protocol',
    name: 'Protocol',
    description: 'AEE envelopes and AOCL layers',
    icon: '📜',
    color: '#f59e0b',
    files: ['aee.test.js'],
    aoclLayer: 9 // Audit layer
  },
  frontend: {
    id: 'frontend',
    name: 'Frontend',
    description: 'UI components and views',
    icon: '🖥️',
    color: '#6366f1',
    files: ['homeView.test.jsx', 'settingsView.test.jsx', 'ui-components.test.jsx', 'keyboardShortcuts.test.jsx', 'voiceControls.test.jsx', 'responsive.test.jsx', 'routing.test.jsx'],
    aoclLayer: 8 // Response layer
  },
  plugins: {
    id: 'plugins',
    name: 'Plugins',
    description: 'Plugin loading and management',
    icon: '🔌',
    color: '#ec4899',
    files: ['plugins.test.jsx'],
    aoclLayer: 5 // Tool layer
  },
  workflows: {
    id: 'workflows',
    name: 'Workflows',
    description: 'Workflow execution and assistants',
    icon: '⚡',
    color: '#14b8a6',
    files: ['workflowAssistant.test.js'],
    aoclLayer: 6 // Workflow layer
  },
  integrations: {
    id: 'integrations',
    name: 'Integrations',
    description: 'Integration components and config',
    icon: '🔗',
    color: '#f97316',
    files: ['integrations.test.js', 'integration.test.jsx', 'integrationComponents.test.jsx'],
    aoclLayer: 5 // Tool layer
  },
  analysis: {
    id: 'analysis',
    name: 'Analysis',
    description: 'Confidence classification and analysis',
    icon: '📊',
    color: '#0ea5e9',
    files: ['confidenceClassification.test.js'],
    aoclLayer: 4 // Agent layer
  },
  aocl: {
    id: 'aocl',
    name: 'AOCL',
    description: 'Agent Orchestration Control Layers - 11-layer processing',
    icon: '🔷',
    color: '#3b82f6',
    files: ['aocl.test.js'],
    aoclLayer: 9 // All layers (meta)
  },
  compliance: {
    id: 'compliance',
    name: 'Compliance',
    description: 'Audit logging, SOC2, GDPR, FedRAMP, HIPAA compliance',
    icon: '📋',
    color: '#dc2626',
    files: ['auditCompliance.test.js'],
    aoclLayer: 9 // Audit layer
  },
  wsm: {
    id: 'wsm',
    name: 'Working Set Memory',
    description: 'Active context, entity tracking, open loops',
    icon: '💭',
    color: '#7c3aed',
    files: ['workingSetMemory.test.js'],
    aoclLayer: 2 // Context layer
  },
  capabilities: {
    id: 'capabilities',
    name: 'Capabilities',
    description: 'Capability discovery, indexing, and routing',
    icon: '🎯',
    color: '#059669',
    files: ['capabilityIndex.test.js'],
    aoclLayer: 3 // Delegation layer
  }
}

/**
 * AOCL layer definitions for flow visualization
 */
export const AOCL_LAYERS = [
  { id: 1, name: 'INPUT', description: 'User input reception', color: '#3b82f6' },
  { id: 2, name: 'CONTEXT', description: 'Memory and context loading', color: '#8b5cf6' },
  { id: 3, name: 'DELEGATION', description: 'Agent selection and routing', color: '#a78bfa' },
  { id: 4, name: 'AGENT', description: 'Agent persona and processing', color: '#c084fc' },
  { id: 5, name: 'TOOL', description: 'Tool and integration execution', color: '#f97316' },
  { id: 6, name: 'WORKFLOW', description: 'Workflow orchestration', color: '#14b8a6' },
  { id: 7, name: 'EXECUTION', description: 'Task execution', color: '#10b981' },
  { id: 8, name: 'RESPONSE', description: 'Response formatting', color: '#6366f1' },
  { id: 9, name: 'AUDIT', description: 'AEE logging and audit', color: '#f59e0b' }
]

/**
 * Test run status enum
 */
export const TestStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  PASSED: 'passed',
  FAILED: 'failed',
  SKIPPED: 'skipped'
}

/**
 * Get all test categories
 * @returns {Array} Array of category objects
 */
export function getCategories() {
  return Object.values(TEST_CATEGORIES)
}

/**
 * Get a specific category by ID
 * @param {string} categoryId - Category ID
 * @returns {Object|null} Category object or null
 */
export function getCategory(categoryId) {
  return TEST_CATEGORIES[categoryId] || null
}

/**
 * Get total test file count
 * @returns {number} Total number of test files
 */
export function getTotalTestFiles() {
  return Object.values(TEST_CATEGORIES).reduce((total, cat) => total + cat.files.length, 0)
}

/**
 * Map tests to AOCL layers
 * @param {Object} testResults - Test results by category
 * @returns {Array} AOCL layers with test counts
 */
export function mapTestsToLayers(testResults) {
  const layerMap = {}

  // Initialize layers
  for (const layer of AOCL_LAYERS) {
    layerMap[layer.id] = { ...layer, tests: 0, passed: 0, failed: 0 }
  }

  // Map category results to layers
  for (const [catId, results] of Object.entries(testResults)) {
    const category = TEST_CATEGORIES[catId]
    if (category && layerMap[category.aoclLayer]) {
      layerMap[category.aoclLayer].tests += results.total || 0
      layerMap[category.aoclLayer].passed += results.passed || 0
      layerMap[category.aoclLayer].failed += results.failed || 0
    }
  }

  return Object.values(layerMap)
}

/**
 * Parse Vitest JSON output into structured results
 * @param {Object} vitestOutput - Raw Vitest JSON output
 * @returns {Object} Structured test results
 */
export function parseVitestOutput(vitestOutput) {
  const results = {
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0
    },
    categories: {},
    suites: []
  }

  if (!vitestOutput || !vitestOutput.testResults) {
    return results
  }

  for (const file of vitestOutput.testResults) {
    const fileName = file.name.split('/').pop()
    const categoryId = findCategoryForFile(fileName)

    // Initialize category if needed
    if (categoryId && !results.categories[categoryId]) {
      results.categories[categoryId] = {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration: 0,
        suites: []
      }
    }

    const fileSuite = {
      name: fileName,
      status: file.status === 'passed' ? TestStatus.PASSED : TestStatus.FAILED,
      duration: file.duration || 0,
      tests: []
    }

    // Process assertions/tests
    if (file.assertionResults) {
      for (const test of file.assertionResults) {
        const testResult = {
          name: test.title,
          fullName: test.fullName || test.title,
          status: test.status === 'passed' ? TestStatus.PASSED :
                  test.status === 'failed' ? TestStatus.FAILED : TestStatus.SKIPPED,
          duration: test.duration || 0,
          ancestorTitles: test.ancestorTitles || [],
          failureMessages: test.failureMessages || []
        }

        fileSuite.tests.push(testResult)

        // Update counts
        results.summary.total++
        if (categoryId) results.categories[categoryId].total++

        if (testResult.status === TestStatus.PASSED) {
          results.summary.passed++
          if (categoryId) results.categories[categoryId].passed++
        } else if (testResult.status === TestStatus.FAILED) {
          results.summary.failed++
          if (categoryId) results.categories[categoryId].failed++
        } else {
          results.summary.skipped++
          if (categoryId) results.categories[categoryId].skipped++
        }
      }
    }

    results.suites.push(fileSuite)
    if (categoryId) {
      results.categories[categoryId].suites.push(fileSuite)
      results.categories[categoryId].duration += fileSuite.duration
    }

    results.summary.duration += fileSuite.duration
  }

  return results
}

/**
 * Find which category a test file belongs to
 * @param {string} fileName - Test file name
 * @returns {string|null} Category ID or null
 */
function findCategoryForFile(fileName) {
  for (const [catId, cat] of Object.entries(TEST_CATEGORIES)) {
    if (cat.files.includes(fileName)) {
      return catId
    }
  }
  return null
}

/**
 * Run tests via API endpoint
 * @param {Object} options - Run options
 * @param {string} options.category - Category to run (optional, runs all if not specified)
 * @param {string} options.file - Specific file to run (optional)
 * @param {string} options.testName - Specific test to run (optional)
 * @returns {Promise<Object>} Test results
 */
export async function runTests(options = {}) {
  const { category, file, testName } = options

  // Build the test pattern
  let pattern = 'src/test/'
  if (file) {
    pattern += file
  } else if (category && TEST_CATEGORIES[category]) {
    const files = TEST_CATEGORIES[category].files
    if (files.length === 1) {
      pattern += files[0]
    } else {
      pattern += `{${files.join(',')}}`
    }
  } else {
    pattern += '*.test.{js,jsx}'
  }

  try {
    // Call the test runner API endpoint
    const response = await fetch('/test-api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern, testName })
    })

    if (!response.ok) {
      throw new Error(`Test run failed: ${response.statusText}`)
    }

    const data = await response.json()
    return parseVitestOutput(data)
  } catch (error) {
    console.error('[TestRunner] Error running tests:', error)
    throw error
  }
}

/**
 * Get cached test results
 * @returns {Promise<Object|null>} Cached results or null
 */
export async function getCachedResults() {
  try {
    const response = await fetch('/test-api/results')
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

/**
 * Generate a mock test catalog for development
 * This provides sample data when the test API is not available
 * @returns {Object} Mock test results
 */
export function generateMockResults() {
  const categories = {}
  let totalTests = 0
  let totalPassed = 0

  for (const [catId, cat] of Object.entries(TEST_CATEGORIES)) {
    // Generate realistic test counts based on file count
    const testsPerFile = catId === 'agents' ? 70 : catId === 'memory' ? 50 : 15
    const total = cat.files.length * testsPerFile
    const passed = total - Math.floor(Math.random() * 3) // 0-2 failures

    categories[catId] = {
      total,
      passed,
      failed: total - passed,
      skipped: 0,
      duration: total * 5, // ~5ms per test
      suites: cat.files.map(file => ({
        name: file,
        status: TestStatus.PASSED,
        duration: testsPerFile * 5,
        tests: []
      }))
    }

    totalTests += total
    totalPassed += passed
  }

  return {
    summary: {
      total: totalTests,
      passed: totalPassed,
      failed: totalTests - totalPassed,
      skipped: 0,
      duration: totalTests * 5
    },
    categories,
    suites: Object.values(categories).flatMap(c => c.suites),
    lastRun: new Date().toISOString(),
    source: 'mock'
  }
}

/**
 * Format duration in human-readable form
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration
 */
export function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}

/**
 * Get status color for a test status
 * @param {string} status - Test status
 * @returns {string} CSS color
 */
export function getStatusColor(status) {
  switch (status) {
    case TestStatus.PASSED: return '#10b981'
    case TestStatus.FAILED: return '#ef4444'
    case TestStatus.RUNNING: return '#f59e0b'
    case TestStatus.SKIPPED: return '#6b7280'
    default: return '#6b7280'
  }
}

/**
 * Get status icon for a test status
 * @param {string} status - Test status
 * @returns {string} Status icon
 */
export function getStatusIcon(status) {
  switch (status) {
    case TestStatus.PASSED: return '✓'
    case TestStatus.FAILED: return '✗'
    case TestStatus.RUNNING: return '◌'
    case TestStatus.SKIPPED: return '○'
    default: return '○'
  }
}

// ============================================
// Intelligent Test Selection (TESTER Agent)
// ============================================

/**
 * Query patterns that map vague instructions to test categories
 * Each pattern has keywords, priority, and suggested approach
 */
export const INTELLIGENT_TEST_PATTERNS = {
  // High-level checks
  everything: {
    keywords: ['everything', 'all tests', 'full suite', 'complete', 'all working'],
    categories: ['agents', 'memory', 'router', 'protocol', 'frontend', 'plugins', 'workflows', 'integrations'],
    priority: 'comprehensive',
    description: 'Full test suite - comprehensive validation of all components'
  },
  smoke: {
    keywords: ['quick', 'smoke', 'sanity', 'basic', 'health check', 'fast'],
    categories: ['agents', 'router', 'protocol'],
    priority: 'smoke',
    description: 'Smoke test - critical path validation only'
  },

  // Domain-specific
  agents: {
    keywords: ['agent', 'delegation', 'personality', 'assistant', 'quox', 'sentinel', 'cipher', 'nova'],
    categories: ['agents'],
    priority: 'focused',
    description: 'Agent system - delegation routing, personalities, manifests'
  },
  memory: {
    keywords: ['memory', 'remember', 'context', 'learned', 'preference', 'lattice'],
    categories: ['memory'],
    priority: 'focused',
    description: 'Memory system - persistence, context, learned facts'
  },
  router: {
    keywords: ['router', 'routing', 'smart router', 'pattern', 'semantic'],
    categories: ['router'],
    priority: 'focused',
    description: 'Router system - query routing and pattern matching'
  },
  security: {
    keywords: ['security', 'auth', 'secure', 'permission', 'access', 'sentinel'],
    categories: ['agents', 'integrations'],
    priority: 'security',
    description: 'Security components - auth, permissions, WARDEN agent'
  },
  protocol: {
    keywords: ['aee', 'envelope', 'protocol', 'audit', 'aocl', 'layer'],
    categories: ['protocol'],
    priority: 'focused',
    description: 'Protocol system - AEE envelopes and AOCL layers'
  },
  frontend: {
    keywords: ['ui', 'frontend', 'component', 'view', 'interface', 'display'],
    categories: ['frontend'],
    priority: 'focused',
    description: 'Frontend components - UI, views, interactions'
  },
  workflow: {
    keywords: ['workflow', 'automation', 'flow', 'process'],
    categories: ['workflows'],
    priority: 'focused',
    description: 'Workflow system - automation and processes'
  },
  integration: {
    keywords: ['integration', 'connect', 'api', 'external', 'service'],
    categories: ['integrations'],
    priority: 'focused',
    description: 'Integrations - external services and APIs'
  },
  compliance: {
    keywords: ['compliance', 'audit', 'soc2', 'hipaa', 'gdpr', 'fedramp', 'enterprise', 'government', 'regulation'],
    categories: ['compliance', 'aocl'],
    priority: 'compliance',
    description: 'Compliance testing - audit trails, regulatory requirements'
  },
  aocl: {
    keywords: ['aocl', 'layer', 'orchestration', 'control layer', '11 layer', 'processing'],
    categories: ['aocl'],
    priority: 'focused',
    description: 'AOCL system - 11-layer orchestration and analytics'
  },
  context: {
    keywords: ['wsm', 'working set', 'context', 'focus', 'entity', 'open loop', 'active'],
    categories: ['wsm', 'memory'],
    priority: 'focused',
    description: 'Context tracking - WSM, entities, open loops'
  },
  capabilities: {
    keywords: ['capability', 'index', 'discovery', 'skill', 'tool routing'],
    categories: ['capabilities'],
    priority: 'focused',
    description: 'Capability system - discovery and routing'
  },
  enterprise: {
    keywords: ['enterprise', 'organization', 'org', 'division', 'team', 'hitl', 'approval', 'permission'],
    categories: ['compliance', 'aocl', 'capabilities'],
    priority: 'enterprise',
    description: 'Enterprise features - orgs, teams, HITL, permissions'
  }
}

/**
 * Test priority rankings (most important tests to run first)
 */
export const TEST_PRIORITIES = {
  critical: {
    files: ['agentDelegator.test.js', 'quoxRouter.test.js', 'aee.test.js', 'aocl.test.js', 'auditCompliance.test.js'],
    description: 'Core functionality - must pass for system to work'
  },
  high: {
    files: ['agentPersonality.test.js', 'memoryManager.test.js', 'agentRegistry.test.js', 'workingSetMemory.test.js', 'capabilityIndex.test.js'],
    description: 'Important functionality - affects user experience'
  },
  medium: {
    files: ['memoryBehavior.test.js', 'semanticRouter.test.js', 'assistants.test.js'],
    description: 'Supporting functionality - nice to have working'
  },
  low: {
    files: ['responsive.test.jsx', 'keyboardShortcuts.test.jsx', 'voiceControls.test.jsx'],
    description: 'Edge features - can be deferred'
  }
}

/**
 * Analyze a vague query and determine which tests to run
 * This is the "intelligent" part that TESTER agent uses
 *
 * @param {string} query - Natural language query like "check if agents work"
 * @returns {Object} Test selection with categories, files, and reasoning
 */
export function analyzeTestQuery(query) {
  const q = query.toLowerCase()
  const matchedPatterns = []
  const selectedCategories = new Set()
  const selectedFiles = []

  // Score each pattern
  for (const [patternId, pattern] of Object.entries(INTELLIGENT_TEST_PATTERNS)) {
    let score = 0
    const matchedKeywords = []

    for (const keyword of pattern.keywords) {
      if (q.includes(keyword)) {
        score += 10
        matchedKeywords.push(keyword)
      }
    }

    // Partial word matches
    for (const keyword of pattern.keywords) {
      const words = keyword.split(' ')
      for (const word of words) {
        if (word.length > 3 && q.includes(word)) {
          score += 3
        }
      }
    }

    if (score > 0) {
      matchedPatterns.push({
        id: patternId,
        score,
        matchedKeywords,
        categories: pattern.categories,
        priority: pattern.priority,
        description: pattern.description
      })
    }
  }

  // Sort by score
  matchedPatterns.sort((a, b) => b.score - a.score)

  // Build category list from top matches
  for (const pattern of matchedPatterns.slice(0, 3)) {
    for (const cat of pattern.categories) {
      selectedCategories.add(cat)
    }
  }

  // If nothing matched, default to smoke test
  if (selectedCategories.size === 0) {
    selectedCategories.add('agents')
    selectedCategories.add('router')
    selectedCategories.add('protocol')
    matchedPatterns.push({
      id: 'default-smoke',
      score: 0,
      matchedKeywords: [],
      categories: ['agents', 'router', 'protocol'],
      priority: 'smoke',
      description: 'Default smoke test - no specific pattern matched'
    })
  }

  // Build file list from categories
  for (const catId of selectedCategories) {
    const cat = TEST_CATEGORIES[catId]
    if (cat) {
      selectedFiles.push(...cat.files)
    }
  }

  // Determine priority level
  const priorityLevels = matchedPatterns.map(p => p.priority).filter(Boolean)
  const priority = priorityLevels[0] || 'smoke'

  // Build reasoning explanation
  const reasoning = matchedPatterns.length > 0
    ? `Matched patterns: ${matchedPatterns.map(p => p.id).join(', ')}. ` +
      `Testing ${selectedCategories.size} categories with ${selectedFiles.length} test files.`
    : 'No specific pattern matched. Running default smoke test.'

  return {
    query,
    matchedPatterns,
    categories: Array.from(selectedCategories),
    files: [...new Set(selectedFiles)],
    priority,
    reasoning,
    estimatedTests: selectedFiles.reduce((sum, f) => {
      // Rough estimate based on file type
      if (f.includes('agent')) return sum + 70
      if (f.includes('memory')) return sum + 50
      return sum + 15
    }, 0)
  }
}

/**
 * Get test recommendations for a specific component or issue
 * @param {string} component - Component name or issue description
 * @returns {Object} Recommended tests with reasoning
 */
export function getTestRecommendations(component) {
  const recommendations = []

  // Check if component matches a category
  for (const [catId, cat] of Object.entries(TEST_CATEGORIES)) {
    if (component.toLowerCase().includes(catId) ||
        cat.name.toLowerCase().includes(component.toLowerCase()) ||
        cat.description.toLowerCase().includes(component.toLowerCase())) {
      recommendations.push({
        category: catId,
        files: cat.files,
        reason: `Direct match for ${cat.name} component`
      })
    }
  }

  // Check priority files
  for (const [level, priority] of Object.entries(TEST_PRIORITIES)) {
    for (const file of priority.files) {
      if (file.toLowerCase().includes(component.toLowerCase())) {
        recommendations.push({
          file,
          priority: level,
          reason: priority.description
        })
      }
    }
  }

  return {
    component,
    recommendations,
    suggestedPattern: recommendations.length > 0
      ? `src/test/{${recommendations.flatMap(r => r.files || [r.file]).join(',')}}`
      : 'src/test/*.test.{js,jsx}'
  }
}

/**
 * Get a quick summary of test health for TESTER agent responses
 * @param {Object} results - Test results object
 * @returns {string} Human-readable summary
 */
export function getTestHealthSummary(results) {
  if (!results || !results.summary) {
    return 'No test results available. Run tests to see system health.'
  }

  const { total, passed, failed, skipped } = results.summary
  const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : 0

  let status = 'healthy'
  let emoji = '✅'

  if (failed > 0) {
    const failRate = (failed / total) * 100
    if (failRate > 10) {
      status = 'critical'
      emoji = '🚨'
    } else if (failRate > 5) {
      status = 'degraded'
      emoji = '⚠️'
    } else {
      status = 'mostly healthy'
      emoji = '⚡'
    }
  }

  // Find worst category
  let worstCategory = null
  let worstFailRate = 0
  if (results.categories) {
    for (const [catId, cat] of Object.entries(results.categories)) {
      if (cat.total > 0) {
        const catFailRate = cat.failed / cat.total
        if (catFailRate > worstFailRate) {
          worstFailRate = catFailRate
          worstCategory = TEST_CATEGORIES[catId]?.name || catId
        }
      }
    }
  }

  let summary = `${emoji} System is ${status}. ${passed}/${total} tests passing (${passRate}%).`

  if (failed > 0 && worstCategory) {
    summary += ` ${worstCategory} needs attention (${Math.round(worstFailRate * 100)}% failing).`
  }

  if (skipped > 0) {
    summary += ` ${skipped} tests skipped.`
  }

  return summary
}

// ============================================
// AEE Test Logging (Audit Trail)
// ============================================

/**
 * Intent definitions for test events
 */
export const TEST_INTENTS = {
  RUN_STARTED: 'quox.testing.run.started',
  RUN_COMPLETED: 'quox.testing.run.completed',
  RUN_FAILED: 'quox.testing.run.failed',
  CATEGORY_TESTED: 'quox.testing.category.tested',
  SUITE_TESTED: 'quox.testing.suite.tested',
  ANALYSIS_REQUESTED: 'quox.testing.analysis.requested'
}

/**
 * Create a unique correlation ID for a test run
 * @returns {string} Test run correlation ID
 */
export function createTestRunId() {
  return prefixedUlid('TEST')
}

/**
 * Log a test run started event
 * @param {Object} options - Test run options
 * @returns {Promise<Object>} Created envelope
 */
export async function logTestRunStarted(options = {}) {
  const { query, pattern, categories, priority, runId } = options

  const envelope = createEvent(
    'agent.tester',
    TEST_INTENTS.RUN_STARTED,
    {
      query: query || null,
      pattern: pattern || 'src/test/*.test.{js,jsx}',
      categories: categories || [],
      priority: priority || 'unknown',
      timestamp: new Date().toISOString()
    },
    runId
  )

  try {
    await storeEnvelope(envelope)
  } catch (e) {
    console.warn('[TestRunner] Failed to log test start:', e)
  }

  return envelope
}

/**
 * Log a test run completed event
 * @param {Object} options - Test run results
 * @returns {Promise<Object>} Created envelope
 */
export async function logTestRunCompleted(options = {}) {
  const { runId, results, duration, query } = options

  const summary = results?.summary || { total: 0, passed: 0, failed: 0 }
  const status = summary.failed > 0 ? 'failed' : 'passed'

  // Extract failed tests for audit trail
  const failures = []
  if (results?.suites) {
    for (const suite of results.suites) {
      if (suite.tests) {
        for (const test of suite.tests) {
          if (test.status === 'failed' || test.status === TestStatus.FAILED) {
            failures.push({
              suite: suite.name,
              test: test.name,
              message: test.failureMessages?.[0]?.substring(0, 200) || null
            })
          }
        }
      }
    }
  }

  // Build category summary (only include categories with tests)
  const categoryResults = Object.entries(results?.categories || {})
    .filter(([_, cat]) => cat.total > 0)
    .map(([id, cat]) => ({
      id,
      total: cat.total,
      passed: cat.passed,
      failed: cat.failed
    }))

  const envelope = createEvent(
    'agent.tester',
    TEST_INTENTS.RUN_COMPLETED,
    {
      status,
      query: query || null,
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      skipped: summary.skipped || 0,
      duration: duration || summary.duration || 0,
      passRate: summary.total > 0 ? ((summary.passed / summary.total) * 100).toFixed(1) : 0,
      categories: categoryResults,
      // Include up to 20 failures for audit (keep payload reasonable)
      failures: failures.slice(0, 20),
      failureCount: failures.length,
      timestamp: new Date().toISOString()
    },
    runId
  )

  try {
    await storeEnvelope(envelope)
  } catch (e) {
    console.warn('[TestRunner] Failed to log test completion:', e)
  }

  return envelope
}

/**
 * Log a test run error
 * @param {Object} options - Error details
 * @returns {Promise<Object>} Created envelope
 */
export async function logTestRunError(options = {}) {
  const { runId, error, query, pattern } = options

  const envelope = createEvent(
    'agent.tester',
    TEST_INTENTS.RUN_FAILED,
    {
      query: query || null,
      pattern: pattern || null,
      error: error?.message || String(error),
      timestamp: new Date().toISOString()
    },
    runId
  )

  try {
    await storeEnvelope(envelope)
  } catch (e) {
    console.warn('[TestRunner] Failed to log test error:', e)
  }

  return envelope
}

/**
 * Log a test analysis request (when TESTER agent analyzes a query)
 * @param {Object} analysis - Analysis result from analyzeTestQuery
 * @returns {Promise<Object>} Created envelope
 */
export async function logTestAnalysis(analysis) {
  const envelope = createEvent(
    'agent.tester',
    TEST_INTENTS.ANALYSIS_REQUESTED,
    {
      query: analysis.query,
      matchedPatterns: analysis.matchedPatterns.map(p => p.id),
      categories: analysis.categories,
      priority: analysis.priority,
      estimatedTests: analysis.estimatedTests,
      reasoning: analysis.reasoning,
      timestamp: new Date().toISOString()
    }
  )

  try {
    await storeEnvelope(envelope)
  } catch (e) {
    console.warn('[TestRunner] Failed to log test analysis:', e)
  }

  return envelope
}

/**
 * Run tests with full AEE logging
 * Wrapper around runTests that adds audit trail
 * @param {Object} options - Test options
 * @returns {Promise<Object>} Test results with runId
 */
export async function runTestsWithLogging(options = {}) {
  const { query } = options
  const runId = createTestRunId()
  const startTime = Date.now()

  // Analyze query if provided
  let analysis = null
  if (query) {
    analysis = analyzeTestQuery(query)
    await logTestAnalysis(analysis)

    // Use analysis to set categories if not specified
    if (!options.category && analysis.categories.length > 0) {
      options.categories = analysis.categories
    }
  }

  // Log start
  await logTestRunStarted({
    query,
    pattern: options.pattern,
    categories: analysis?.categories || [],
    priority: analysis?.priority || 'manual',
    runId
  })

  try {
    // Run the tests
    const results = await runTests(options)
    const duration = Date.now() - startTime

    // Log completion
    await logTestRunCompleted({ runId, results, duration, query })

    return {
      ...results,
      runId,
      analysis
    }
  } catch (error) {
    // Log error
    await logTestRunError({ runId, error, query, pattern: options.pattern })
    throw error
  }
}
