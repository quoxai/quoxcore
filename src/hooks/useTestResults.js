/**
 * useTestResults - Hook for managing test results in Test Lab
 *
 * Provides state management for test discovery, execution, and results display.
 * Supports running all tests, by category, or individual tests.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  getCategories,
  getCategory,
  mapTestsToLayers,
  generateMockResults,
  TestStatus,
  AOCL_LAYERS,
  logTestRunStarted,
  logTestRunCompleted,
  logTestRunError,
  createTestRunId
} from '../services/testRunner'

// Poll interval for checking test status (while running)
const STATUS_POLL_INTERVAL = 500
const LIVE_POLL_INTERVAL = 300

/**
 * Hook to manage test results and execution
 * @param {Object} options
 * @param {boolean} options.useMockData - EXPLICIT local-dev opt-in only.
 *   Defaults to false (TRUST-PROOF P4, FND_01M2Y1G0BM): the Test Lab is a
 *   trust surface and must never fabricate pass/fail evidence. When there is
 *   no real data the hook leaves results null and the view shows an honest
 *   empty state; mock counts (Math.random, source:'mock') are available only
 *   when a local developer passes useMockData:true deliberately.
 * @returns {Object} Test results state and actions
 */
export function useTestResults({ useMockData = false } = {}) {
  // State
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [selectedCategory, setSelectedCategory] = useState(null)
  const [selectedSuite, setSelectedSuite] = useState(null)
  const [runningItem, setRunningItem] = useState(null) // { type: 'all' | 'category' | 'suite', id?: string }

  // Live output state
  const [liveOutput, setLiveOutput] = useState([])
  const [liveProgress, setLiveProgress] = useState({ completed: 0, total: 0, elapsed: 0, currentFile: '' })

  // Refs
  const statusPollRef = useRef(null)
  const livePollRef = useRef(null)
  const abortControllerRef = useRef(null)
  const lastLiveTimestamp = useRef(null)
  const currentRunIdRef = useRef(null)
  const runStartTimeRef = useRef(null)
  const finalResultsRef = useRef(null)
  const runErrorRef = useRef(null)

  // Get all categories
  const categories = getCategories()

  // Computed: AOCL layers with test counts
  const aoclLayers = results?.categories
    ? mapTestsToLayers(results.categories)
    : AOCL_LAYERS.map(l => ({ ...l, tests: 0, passed: 0, failed: 0 }))

  // Computed: Summary stats
  const summary = results?.summary || { total: 0, passed: 0, failed: 0, skipped: 0, duration: 0 }

  // Computed: Overall status
  const overallStatus = running ? TestStatus.RUNNING :
    summary.failed > 0 ? TestStatus.FAILED :
    summary.total > 0 ? TestStatus.PASSED : TestStatus.IDLE

  /**
   * Fetch cached results from API
   */
  const fetchCachedResults = useCallback(async () => {
    try {
      const response = await fetch('/api/tests/results')
      if (response.ok) {
        const data = await response.json()
        // Parse Vitest format if needed (raw API returns testResults array)
        let parsedData = data
        if (data.testResults && !data.categories) {
          parsedData = parseVitestResults(data)
          // Preserve lastRun from original data
          if (data.lastRun) {
            parsedData.lastRun = data.lastRun
          }
        }
        setResults(parsedData)
        setError(null)
        return parsedData
      }
    } catch (err) {
      console.warn('[useTestResults] No cached results:', err.message)
    }

    // Use mock data if enabled and no cached results
    if (useMockData) {
      const mockData = generateMockResults()
      setResults(mockData)
      return mockData
    }

    return null
  }, [useMockData])

  /**
   * Check if tests are currently running
   */
  const checkRunningStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/tests/status')
      if (response.ok) {
        const data = await response.json()
        return data.running
      }
    } catch {
      return false
    }
    return false
  }, [])

  /**
   * Fetch live output from running tests
   */
  const fetchLiveOutput = useCallback(async () => {
    try {
      const url = lastLiveTimestamp.current
        ? `/api/tests/live?since=${encodeURIComponent(lastLiveTimestamp.current)}`
        : '/api/tests/live'

      const response = await fetch(url)
      if (response.ok) {
        const data = await response.json()

        // Update progress
        setLiveProgress({
          completed: data.completed || 0,
          total: data.total || 0,
          elapsed: data.elapsed || 0,
          currentFile: data.currentFile || ''
        })

        // Append new entries
        if (data.entries && data.entries.length > 0) {
          setLiveOutput(prev => {
            const newEntries = [...prev, ...data.entries]
            // Keep last 500 entries
            return newEntries.slice(-500)
          })
          // Update last timestamp
          lastLiveTimestamp.current = data.entries[data.entries.length - 1].time
        }

        return data.running
      }
    } catch (err) {
      console.warn('[useTestResults] Failed to fetch live output:', err.message)
    }
    return false
  }, [])

  /**
   * Run tests with given options
   */
  const runTests = useCallback(async (options = {}) => {
    const { category, file, testName } = options

    // Create unique run ID for AEE logging
    const runId = createTestRunId()
    currentRunIdRef.current = runId
    runStartTimeRef.current = Date.now()

    // Set running state
    setRunning(true)
    setError(null)

    // Clear live output for new run
    setLiveOutput([])
    setLiveProgress({ completed: 0, total: 0, elapsed: 0, currentFile: '' })
    lastLiveTimestamp.current = null

    // Log test run started to AEE (Activity log)
    try {
      await logTestRunStarted({
        runId,
        pattern: file || category || 'all',
        categories: category ? [category] : [],
        priority: 'manual'
      })
    } catch (e) {
      console.warn('[useTestResults] Failed to log test start:', e)
    }

    // Start live output polling
    if (livePollRef.current) {
      clearInterval(livePollRef.current)
    }
    livePollRef.current = setInterval(fetchLiveOutput, LIVE_POLL_INTERVAL)

    if (category) {
      setRunningItem({ type: 'category', id: category })
    } else if (file) {
      setRunningItem({ type: 'suite', id: file })
    } else {
      setRunningItem({ type: 'all' })
    }

    // Build pattern for vitest
    // Note: vitest filter is a regex, not a glob
    // For "run all", pass no pattern to use vitest's default config
    let pattern = null
    if (file) {
      // Single file: just the filename as filter
      pattern = file.replace(/\./g, '\\.') // Escape dots for regex
    } else if (category) {
      const cat = getCategory(category)
      if (cat && cat.files.length > 0) {
        // Build regex pattern to match any of the category's files
        const filePatterns = cat.files.map(f => f.replace(/\./g, '\\.'))
        pattern = `(${filePatterns.join('|')})`
      }
    }
    // For "run all" (no category, no file): pattern stays null

    // Abort previous request if any
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    abortControllerRef.current = new AbortController()

    try {
      const response = await fetch('/api/tests/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern, testName }),
        signal: abortControllerRef.current.signal
      })

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        throw new Error(errData.error || `Test run failed: ${response.statusText}`)
      }

      const data = await response.json()

      // Parse and store results
      let parsedResults = null
      if (data.testResults) {
        // Vitest JSON format - needs parsing
        parsedResults = parseVitestResults(data)
        setResults(parsedResults)
      } else if (data.summary) {
        // Already in our format
        parsedResults = data
        setResults(data)
      } else if (data.error) {
        // Error response with partial data
        setError(data.error)
        if (data.stdout) {
          console.log('[Test Output]', data.stdout)
        }
      }

      // Store parsed results for logging in finally block
      if (parsedResults) {
        finalResultsRef.current = parsedResults
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('[useTestResults] Test run aborted')
        runErrorRef.current = 'aborted'
      } else {
        console.error('[useTestResults] Error running tests:', err)
        setError(err.message)
        runErrorRef.current = err

        // Fall back to mock data if enabled
        if (useMockData) {
          setResults(generateMockResults())
        }
      }
    } finally {
      setRunning(false)
      setRunningItem(null)
      abortControllerRef.current = null

      // Stop live polling
      if (livePollRef.current) {
        clearInterval(livePollRef.current)
        livePollRef.current = null
      }

      // Fetch final live output
      await fetchLiveOutput()

      // Log to AEE Activity log
      if (currentRunIdRef.current) {
        try {
          const duration = runStartTimeRef.current ? Date.now() - runStartTimeRef.current : 0

          if (runErrorRef.current && runErrorRef.current !== 'aborted') {
            // Log error
            await logTestRunError({
              runId: currentRunIdRef.current,
              error: runErrorRef.current,
              pattern: file || category || 'all'
            })
          } else if (runErrorRef.current !== 'aborted') {
            // Log completion (use parsed results or estimate from progress)
            const resultsToLog = finalResultsRef.current || {
              summary: {
                total: liveProgress.completed || 0,
                passed: liveProgress.completed || 0,
                failed: 0,
                duration
              }
            }
            await logTestRunCompleted({
              runId: currentRunIdRef.current,
              results: resultsToLog,
              duration
            })
          }
        } catch (e) {
          console.warn('[useTestResults] Failed to log to AEE:', e)
        }
      }

      // Reset run tracking
      currentRunIdRef.current = null
      runStartTimeRef.current = null
      finalResultsRef.current = null
      runErrorRef.current = null
      runStartTimeRef.current = null
    }
  }, [useMockData, fetchLiveOutput])

  /**
   * Run all tests
   */
  const runAll = useCallback(() => runTests(), [runTests])

  /**
   * Run tests for a specific category
   */
  const runCategory = useCallback((categoryId) => runTests({ category: categoryId }), [runTests])

  /**
   * Run a specific test file
   */
  const runSuite = useCallback((fileName) => runTests({ file: fileName }), [runTests])

  /**
   * Run a specific test by name
   */
  const runTest = useCallback((fileName, testName) => runTests({ file: fileName, testName }), [runTests])

  /**
   * Cancel running tests (frontend abort only)
   */
  const cancelRun = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
  }, [])

  /**
   * Stop running tests on the server
   */
  const stopTests = useCallback(async () => {
    try {
      const response = await fetch('/api/tests/stop', { method: 'POST' })
      if (response.ok) {
        // Also abort frontend request
        if (abortControllerRef.current) {
          abortControllerRef.current.abort()
        }

        // Stop live polling
        if (livePollRef.current) {
          clearInterval(livePollRef.current)
          livePollRef.current = null
        }

        // Fetch final output
        await fetchLiveOutput()

        setRunning(false)
        setRunningItem(null)
        return true
      }
    } catch (err) {
      console.error('[useTestResults] Failed to stop tests:', err)
    }
    return false
  }, [fetchLiveOutput])

  /**
   * Get results for a specific category
   */
  const getCategoryResults = useCallback((categoryId) => {
    return results?.categories?.[categoryId] || null
  }, [results])

  /**
   * Select a category to drill down
   */
  const selectCategory = useCallback((categoryId) => {
    setSelectedCategory(categoryId)
    setSelectedSuite(null)
  }, [])

  /**
   * Select a test suite to view details
   */
  const selectSuite = useCallback((suiteName) => {
    setSelectedSuite(suiteName)
  }, [])

  /**
   * Clear selection (go back)
   */
  const clearSelection = useCallback(() => {
    if (selectedSuite) {
      setSelectedSuite(null)
    } else {
      setSelectedCategory(null)
    }
  }, [selectedSuite])

  /**
   * Check if a specific item is running
   */
  const isItemRunning = useCallback((type, id) => {
    if (!runningItem) return false
    if (runningItem.type === 'all') return true
    if (runningItem.type === type && runningItem.id === id) return true
    return false
  }, [runningItem])

  // Initial load
  useEffect(() => {
    const init = async () => {
      setLoading(true)

      // Check if tests are running
      const isRunning = await checkRunningStatus()
      setRunning(isRunning)

      // If tests are running, resume live polling and fetch existing output
      if (isRunning) {
        // Fetch existing live output (don't use 'since' to get full buffer)
        lastLiveTimestamp.current = null
        await fetchLiveOutput()

        // Start live polling
        if (livePollRef.current) {
          clearInterval(livePollRef.current)
        }
        livePollRef.current = setInterval(fetchLiveOutput, LIVE_POLL_INTERVAL)

        // Set running item indicator
        setRunningItem({ type: 'all' })
      }

      // Fetch cached results
      await fetchCachedResults()

      setLoading(false)
    }

    init()
  }, [fetchCachedResults, checkRunningStatus, fetchLiveOutput])

  // Cleanup
  useEffect(() => {
    return () => {
      if (statusPollRef.current) {
        clearInterval(statusPollRef.current)
      }
      if (livePollRef.current) {
        clearInterval(livePollRef.current)
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [])

  // Clear live output
  const clearLiveOutput = useCallback(() => {
    setLiveOutput([])
    setLiveProgress({ completed: 0, total: 0, elapsed: 0, currentFile: '' })
    lastLiveTimestamp.current = null
  }, [])

  return {
    // State
    results,
    loading,
    running,
    error,
    selectedCategory,
    selectedSuite,

    // Live output
    liveOutput,
    liveProgress,

    // Computed
    categories,
    aoclLayers,
    summary,
    overallStatus,

    // Actions
    runAll,
    runCategory,
    runSuite,
    runTest,
    cancelRun,
    stopTests,
    refetch: fetchCachedResults,
    clearLiveOutput,

    // Selection
    selectCategory,
    selectSuite,
    clearSelection,
    getCategoryResults,
    isItemRunning
  }
}

/**
 * Parse raw Vitest JSON output into our result format
 */
function parseVitestResults(vitestOutput) {
  const TEST_CATEGORIES = {
    agents: ['agentDelegator.test.js', 'agentPersonality.test.js', 'agentRegistry.test.js', 'assistants.test.js'],
    memory: ['memoryManager.test.js', 'memoryBehavior.test.js', 'memoryTierGating.test.js'],
    router: ['quoxRouter.test.js', 'semanticRouter.test.js'],
    protocol: ['aee.test.js'],
    frontend: ['homeView.test.jsx', 'settingsView.test.jsx', 'ui-components.test.jsx', 'keyboardShortcuts.test.jsx', 'voiceControls.test.jsx', 'responsive.test.jsx', 'routing.test.jsx'],
    plugins: ['plugins.test.jsx'],
    workflows: ['workflowAssistant.test.js'],
    integrations: ['integrations.test.js', 'integration.test.jsx', 'integrationComponents.test.jsx'],
    analysis: ['confidenceClassification.test.js']
  }

  const results = {
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, duration: 0 },
    categories: {},
    suites: [],
    lastRun: new Date().toISOString()
  }

  // Initialize categories
  for (const catId of Object.keys(TEST_CATEGORIES)) {
    results.categories[catId] = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      suites: []
    }
  }

  if (!vitestOutput?.testResults) return results

  for (const file of vitestOutput.testResults) {
    const fileName = file.name?.split('/').pop() || 'unknown'

    // Find category
    let catId = null
    for (const [cid, files] of Object.entries(TEST_CATEGORIES)) {
      if (files.includes(fileName)) {
        catId = cid
        break
      }
    }

    const suite = {
      name: fileName,
      status: file.status === 'passed' ? TestStatus.PASSED : TestStatus.FAILED,
      duration: file.duration || 0,
      tests: []
    }

    // Process tests
    for (const test of (file.assertionResults || [])) {
      const testResult = {
        name: test.title,
        fullName: test.fullName || test.title,
        status: test.status === 'passed' ? TestStatus.PASSED :
                test.status === 'failed' ? TestStatus.FAILED : TestStatus.SKIPPED,
        duration: test.duration || 0,
        ancestorTitles: test.ancestorTitles || [],
        failureMessages: test.failureMessages || []
      }

      suite.tests.push(testResult)
      results.summary.total++
      if (catId) results.categories[catId].total++

      if (testResult.status === TestStatus.PASSED) {
        results.summary.passed++
        if (catId) results.categories[catId].passed++
      } else if (testResult.status === TestStatus.FAILED) {
        results.summary.failed++
        if (catId) results.categories[catId].failed++
      } else {
        results.summary.skipped++
        if (catId) results.categories[catId].skipped++
      }
    }

    results.suites.push(suite)
    results.summary.duration += suite.duration

    if (catId) {
      results.categories[catId].suites.push(suite)
      results.categories[catId].duration += suite.duration
    }
  }

  return results
}

export default useTestResults
