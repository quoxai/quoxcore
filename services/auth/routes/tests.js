/**
 * Test Lab API Routes
 *
 * Provides endpoints for running Vitest tests from the frontend
 *
 * Security: This endpoint is disabled in production and requires admin authentication.
 */

import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/authorize.js';

const router = Router();

// Allowlist of valid test patterns - only these patterns can be passed to vitest
const ALLOWED_TEST_PATTERNS = [
    // Allow running all tests (no pattern)
    '',
    // Allow specific test directories
    'src/test',
    'src/test/',
    'tests',
    'tests/',
    // Allow specific test file patterns
    '**/*.test.js',
    '**/*.test.jsx',
    '**/*.test.ts',
    '**/*.test.tsx',
    '**/*.spec.js',
    '**/*.spec.jsx',
    '**/*.spec.ts',
    '**/*.spec.tsx',
    // Allow component-specific patterns
    'src/components/**/*.test.*',
    'src/services/**/*.test.*',
    'src/lib/**/*.test.*',
    'src/pages/**/*.test.*',
];

// Validate test pattern against allowlist
function isValidTestPattern(pattern) {
    if (!pattern || pattern === '') return true;

    // Check exact match
    if (ALLOWED_TEST_PATTERNS.includes(pattern)) return true;

    // Check if pattern matches allowed glob patterns (basic validation)
    // Pattern must only contain alphanumeric, dots, slashes, asterisks, and hyphens
    const safePatternRegex = /^[a-zA-Z0-9._/*-]+$/;
    if (!safePatternRegex.test(pattern)) return false;

    // Disallow path traversal
    if (pattern.includes('..')) return false;

    // Disallow absolute paths
    if (pattern.startsWith('/')) return false;

    // Must end with a test file extension pattern or be a directory
    const validEndings = ['.test.js', '.test.jsx', '.test.ts', '.test.tsx',
                          '.spec.js', '.spec.jsx', '.spec.ts', '.spec.tsx',
                          '/', '.*'];
    const hasValidEnding = validEndings.some(ending =>
        pattern.endsWith(ending) || pattern.includes('*.test.') || pattern.includes('*.spec.')
    );

    return hasValidEnding || pattern.match(/^src\/(test|components|services|lib|pages)/);
}

// Validate test name filter
function isValidTestName(testName) {
    if (!testName || testName === '') return true;

    // Test name must be alphanumeric with spaces, dots, and common punctuation
    // Max length 200 chars to prevent abuse
    if (testName.length > 200) return false;

    // Disallow shell metacharacters
    const dangerousChars = /[;&|`$(){}[\]<>\\!]/;
    if (dangerousChars.test(testName)) return false;

    return true;
}

// Store for test results and running state
let cachedResults = null;
let isRunning = false;
let currentProcess = null;

// Live output buffer for console streaming
let liveOutput = [];
let currentTestFile = '';
let testsCompleted = 0;
let testsTotal = 0;
let startTime = null;

// Project root (quox-dashboard)
const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

// Helper to add log entry
function addLog(type, message, details = null) {
    const entry = {
        time: new Date().toISOString(),
        type, // 'info', 'pass', 'fail', 'error', 'file', 'summary'
        message,
        details
    };
    liveOutput.push(entry);
    // Keep last 500 entries
    if (liveOutput.length > 500) {
        liveOutput = liveOutput.slice(-500);
    }
}

/**
 * POST /api/tests/run
 * Run tests with optional pattern filter
 *
 * Security:
 * - Requires authentication (admin role)
 * - Disabled in production environment
 * - Input validation against allowlist
 * - No shell execution (shell: false)
 */
router.post('/run', requireAuth, requireAdmin(), async (req, res) => {
    // Security: Disable test execution in production
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({
            error: 'forbidden',
            message: 'Test execution is disabled in production environment'
        });
    }

    if (isRunning) {
        return res.status(409).json({ error: 'Tests already running' });
    }

    try {
        const { pattern, testName } = req.body || {};

        // Security: Validate pattern against allowlist
        if (!isValidTestPattern(pattern)) {
            return res.status(400).json({
                error: 'invalid_pattern',
                message: 'Test pattern is not allowed. Use standard test file patterns like "src/test/**/*.test.js"'
            });
        }

        // Security: Validate test name filter
        if (!isValidTestName(testName)) {
            return res.status(400).json({
                error: 'invalid_test_name',
                message: 'Test name filter contains invalid characters or is too long'
            });
        }

        isRunning = true;

        // Reset live output
        liveOutput = [];
        currentTestFile = '';
        testsCompleted = 0;
        testsTotal = 0;
        startTime = Date.now();

        // Build vitest command - use dot for progress + json for results
        // dot reporter outputs . for pass, x for fail - gives live feedback
        const args = ['vitest', 'run', '--reporter=dot', '--reporter=json', '--no-color'];
        if (pattern) args.push(pattern);
        if (testName) args.push('-t', testName);

        const cmdStr = `npx ${args.join(' ')}`;
        addLog('info', `Starting test run...`);
        addLog('info', `Command: ${cmdStr}`);

        // Set a hard timeout for the process (5 minutes)
        const processTimeout = setTimeout(() => {
            if (currentProcess) {
                addLog('error', 'Test run timed out after 5 minutes');
                currentProcess.kill('SIGKILL');
            }
        }, 5 * 60 * 1000);

        console.log('[test-api] Running vitest with args:', args.join(' '));
        console.log('[test-api] CWD:', PROJECT_ROOT);

        // Security: shell: false prevents command injection via pattern/testName
        currentProcess = spawn('npx', args, {
            cwd: PROJECT_ROOT,
            env: { ...process.env, FORCE_COLOR: '0' },
            shell: false
        });

        let output = '';
        let errorOutput = '';

        currentProcess.stdout.on('data', (data) => {
            const chunk = data.toString();
            output += chunk;

            // Count dots for progress (. = pass, x = fail in dot reporter)
            const passes = (chunk.match(/\./g) || []).length;
            const fails = (chunk.match(/[x×]/g) || []).length;

            if (passes > 0 || fails > 0) {
                testsCompleted += passes + fails;

                // Log progress every 50 tests
                if (Math.floor(testsCompleted / 50) > Math.floor((testsCompleted - passes - fails) / 50)) {
                    addLog('info', `${testsCompleted} tests completed...`);
                }
            }

            // Check for file paths in output
            const lines = chunk.split('\n');
            for (const line of lines) {
                // Match test file being run
                const fileMatch = line.match(/([^\s]+\.test\.(js|jsx|ts|tsx))/);
                if (fileMatch && fileMatch[1] !== currentTestFile) {
                    currentTestFile = fileMatch[1];
                    addLog('file', currentTestFile);
                }
            }
        });

        currentProcess.stderr.on('data', (data) => {
            const chunk = data.toString();
            errorOutput += chunk;
            // Only log actual errors, filter out common noise
            if (chunk.includes('ExperimentalWarning') ||
                chunk.includes('--experimental') ||
                chunk.includes('act(...)') ||
                chunk.includes('was not wrapped in act')) {
                // Skip React testing noise
                return;
            }
            // Only log if it looks like a real error
            if (chunk.includes('Error') || chunk.includes('FAIL') || chunk.includes('error')) {
                addLog('error', chunk.trim().substring(0, 200));
            }
        });

        currentProcess.on('close', (code) => {
            clearTimeout(processTimeout);
            isRunning = false;
            currentProcess = null;
            currentTestFile = '';
            const duration = Date.now() - startTime;

            console.log('[test-api] Vitest exited with code:', code);

            // Try to parse JSON from output
            try {
                // Find JSON in output (vitest outputs JSON after some text)
                const jsonMatch = output.match(/\{[\s\S]*\}$/);
                if (jsonMatch) {
                    const results = JSON.parse(jsonMatch[0]);
                    results.lastRun = new Date().toISOString();
                    cachedResults = results;

                    // Count totals
                    const total = results.numTotalTests || 0;
                    const passed = results.numPassedTests || 0;
                    const failed = results.numFailedTests || 0;
                    testsTotal = total;

                    addLog('summary', `Completed: ${passed} passed, ${failed} failed of ${total} tests in ${(duration/1000).toFixed(1)}s`);
                    res.json(results);
                } else {
                    // No JSON found, return raw output
                    addLog('error', 'No JSON results found in output');
                    res.json({
                        success: code === 0,
                        output,
                        errorOutput,
                        lastRun: new Date().toISOString()
                    });
                }
            } catch (parseErr) {
                console.error('[test-api] Failed to parse vitest output:', parseErr);
                addLog('error', `Parse error: ${parseErr.message}`);
                res.json({
                    success: code === 0,
                    output,
                    errorOutput,
                    parseError: parseErr.message,
                    lastRun: new Date().toISOString()
                });
            }
        });

        currentProcess.on('error', (err) => {
            clearTimeout(processTimeout);
            isRunning = false;
            currentProcess = null;
            console.error('[test-api] Spawn error:', err);
            addLog('error', `Spawn error: ${err.message}`);
            res.status(500).json({ error: 'Failed to run tests', message: err.message });
        });

    } catch (e) {
        isRunning = false;
        res.status(400).json({ error: 'Invalid request', message: e.message });
    }
});

/**
 * GET /api/tests/results
 * Get cached test results
 *
 * Security:
 * - Requires authentication (admin role) - results can include internal file paths/logs
 * - Disabled in production environment
 */
router.get('/results', requireAuth, requireAdmin(), (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({
            error: 'forbidden',
            message: 'Test execution is disabled in production environment'
        });
    }

    if (cachedResults) {
        res.json(cachedResults);
    } else {
        res.status(404).json({ error: 'No cached results', message: 'Run tests first' });
    }
});

/**
 * GET /api/tests/status
 * Check if tests are currently running
 *
 * Security:
 * - Requires authentication (admin role)
 * - Disabled in production environment
 */
router.get('/status', requireAuth, requireAdmin(), (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({
            error: 'forbidden',
            message: 'Test execution is disabled in production environment'
        });
    }

    res.json({ running: isRunning });
});

/**
 * GET /api/tests/live
 * Get live output from running tests
 * Supports ?since=<timestamp> to get only new entries
 *
 * Security:
 * - Requires authentication (admin role) - live output can include internal file paths/logs
 * - Disabled in production environment
 */
router.get('/live', requireAuth, requireAdmin(), (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({
            error: 'forbidden',
            message: 'Test execution is disabled in production environment'
        });
    }

    const since = req.query.since;
    let entries = liveOutput;

    // Filter to entries after 'since' timestamp
    if (since) {
        entries = liveOutput.filter(e => new Date(e.time) > new Date(since));
    }

    res.json({
        running: isRunning,
        currentFile: currentTestFile,
        completed: testsCompleted,
        total: testsTotal,
        elapsed: startTime ? Date.now() - startTime : 0,
        entries
    });
});

/**
 * POST /api/tests/stop
 * Stop currently running tests
 *
 * Security:
 * - Requires authentication (admin role)
 * - Disabled in production environment
 */
router.post('/stop', requireAuth, requireAdmin(), (req, res) => {
    // Security: Disable in production
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({
            error: 'forbidden',
            message: 'Test execution is disabled in production environment'
        });
    }

    if (currentProcess) {
        currentProcess.kill('SIGTERM');
        isRunning = false;
        currentProcess = null;
        addLog('info', 'Tests stopped by user');
        res.json({ stopped: true });
    } else {
        res.json({ stopped: false, message: 'No tests running' });
    }
});

/**
 * POST /api/tests/reset
 * Reset stuck running state (safety valve)
 *
 * Security:
 * - Requires authentication (admin role)
 * - Disabled in production environment
 */
router.post('/reset', requireAuth, requireAdmin(), (req, res) => {
    // Security: Disable in production
    if (process.env.NODE_ENV === 'production') {
        return res.status(403).json({
            error: 'forbidden',
            message: 'Test execution is disabled in production environment'
        });
    }

    if (currentProcess) {
        try {
            currentProcess.kill('SIGKILL');
        } catch (e) {
            // Process might already be dead
        }
    }
    isRunning = false;
    currentProcess = null;
    currentTestFile = '';
    testsCompleted = 0;
    testsTotal = 0;
    startTime = null;
    addLog('info', 'Test state reset');
    res.json({ reset: true });
});

/**
 * Timeout safety - auto-reset if running too long (10 minutes)
 */
const MAX_RUN_TIME = 10 * 60 * 1000; // 10 minutes

setInterval(() => {
    if (isRunning && startTime && (Date.now() - startTime > MAX_RUN_TIME)) {
        console.log('[test-api] Auto-resetting stuck test run');
        if (currentProcess) {
            try {
                currentProcess.kill('SIGKILL');
            } catch (e) {}
        }
        isRunning = false;
        currentProcess = null;
        addLog('error', 'Test run timed out after 10 minutes - auto-reset');
    }
}, 30000); // Check every 30 seconds

export default router;
