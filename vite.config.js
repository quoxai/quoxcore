import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import frameDepsPlugin from './scripts/vite-plugin-frame-deps.mjs'
import { resolve } from 'path'
import fs from 'fs'
import { spawn } from 'child_process'

function buildManualChunks(id) {
  if (!id) return null

  if (id.includes('node_modules')) {
    if (
      id.includes('/react/') ||
      id.includes('/react-dom/') ||
      id.includes('/react-router-dom/') ||
      id.includes('/scheduler/') ||
      id.includes('/lucide-react/')
    ) {
      return 'framework'
    }

    if (
      id.includes('/three/') ||
      id.includes('/@react-three/') ||
      id.includes('/maath/') ||
      id.includes('/postprocessing/')
    ) {
      return 'three-stack'
    }

    if (
      id.includes('/@xterm/') ||
      id.includes('/xterm/')
    ) {
      return 'terminal-stack'
    }

    if (
      id.includes('/remotion/') ||
      id.includes('/@remotion/')
    ) {
      return 'video-stack'
    }

    if (id.includes('/jszip/')) {
      return 'zip-stack'
    }

    if (id.includes('/matrix-js-sdk/')) {
      return 'matrix-stack'
    }
  }

  if (
    id.includes('/src/components/opsdeck3d/') ||
    id.includes('/src/pages/views/CognitiveCore3DView') ||
    id.includes('/src/pages/views/ThreeDLabView') ||
    id.includes('/src/components/cognitive/')
  ) {
    return 'cognitive-3d'
  }

  if (
    id.includes('/src/components/volt/') ||
    id.includes('/src/lib/volt/')
  ) {
    return 'volt'
  }

  if (
    id.includes('/src/components/video-studio/') ||
    id.includes('/src/pages/views/VideoStudioView')
  ) {
    return 'video-studio'
  }

  return null
}

/**
 * Vite plugin for Test Lab API
 * Provides endpoints to run tests and get results
 */
function testLabPlugin() {
  let cachedResults = null
  let isRunning = false

  return {
    name: 'test-lab-api',
    configureServer(server) {
      // POST /test-api/run - Run tests
      server.middlewares.use('/test-api/run', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ error: 'Method not allowed' }))
          return
        }

        if (isRunning) {
          res.statusCode = 409
          res.end(JSON.stringify({ error: 'Tests already running' }))
          return
        }

        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
          try {
            const { pattern, testName } = JSON.parse(body || '{}')
            isRunning = true

            // SECURITY: Validate inputs to prevent command injection
            // Only allow safe characters in pattern and testName (alphanumeric, dots, slashes, dashes, underscores, stars)
            const safePattern = /^[a-zA-Z0-9._\-/*]+$/
            if (pattern && !safePattern.test(pattern)) {
              isRunning = false
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'Invalid test pattern - only alphanumeric, dots, slashes, dashes, underscores, and wildcards allowed' }))
              return
            }
            if (testName && !safePattern.test(testName)) {
              isRunning = false
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'Invalid test name - only alphanumeric, dots, slashes, dashes, underscores, and wildcards allowed' }))
              return
            }

            // Build vitest command
            const args = ['vitest', 'run', '--reporter=json']
            if (pattern) args.push(pattern)
            if (testName) args.push('-t', testName)

            console.log('[test-api] Running vitest with args:', args.join(' '))
            console.log('[test-api] CWD:', process.cwd())

            const vitest = spawn('npx', args, {
              cwd: process.cwd(),
              env: { ...process.env, FORCE_COLOR: '0' },
              shell: false  // SECURITY: Disabled shell to prevent command injection
            })

            let output = ''
            let errorOutput = ''

            vitest.stdout.on('data', data => { output += data.toString() })
            vitest.stderr.on('data', data => { errorOutput += data.toString() })

            vitest.on('close', (code) => {
              isRunning = false

              try {
                // Try to parse JSON output
                const jsonMatch = output.match(/\{[\s\S]*\}/)
                if (jsonMatch) {
                  cachedResults = JSON.parse(jsonMatch[0])
                  cachedResults.lastRun = new Date().toISOString()
                  res.setHeader('Content-Type', 'application/json')
                  res.end(JSON.stringify(cachedResults))
                } else {
                  // Return raw output if no JSON found
                  res.setHeader('Content-Type', 'application/json')
                  res.end(JSON.stringify({
                    error: 'Could not parse test output',
                    stdout: output,
                    stderr: errorOutput,
                    exitCode: code
                  }))
                }
              } catch (e) {
                res.statusCode = 500
                res.end(JSON.stringify({
                  error: 'Failed to parse test results',
                  message: e.message,
                  stdout: output.slice(0, 2000),
                  stderr: errorOutput.slice(0, 2000)
                }))
              }
            })

            vitest.on('error', (err) => {
              isRunning = false
              res.statusCode = 500
              res.end(JSON.stringify({ error: 'Failed to run tests', message: err.message }))
            })
          } catch (e) {
            isRunning = false
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'Invalid request', message: e.message }))
          }
        })
      })

      // GET /test-api/results - Get cached results
      server.middlewares.use('/test-api/results', (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.end(JSON.stringify({ error: 'Method not allowed' }))
          return
        }

        res.setHeader('Content-Type', 'application/json')
        if (cachedResults) {
          res.end(JSON.stringify(cachedResults))
        } else {
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'No cached results', message: 'Run tests first' }))
        }
      })

      // GET /test-api/status - Check if tests are running
      server.middlewares.use('/test-api/status', (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ running: isRunning }))
      })
    }
  }
}

// Read version from VERSION file at build time
function getQuoxCoreVersion() {
  try {
    return fs.readFileSync(resolve(__dirname, 'VERSION'), 'utf-8').trim()
  } catch {
    return '0.0.0'
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file based on mode
  const env = loadEnv(mode, process.cwd(), '')

  // Service URLs from environment (with sensible defaults)
  const AUTH_URL = env.AUTH_URL || 'http://localhost:3101'
  const MHA_COLLECTOR_URL = env.MHA_COLLECTOR_URL || 'http://localhost:9848'
  const MHA_AGENT_URL = env.MHA_AGENT_URL || 'http://localhost:9847'
  const QUOXFLOW_URL = env.QUOXFLOW_URL || 'http://localhost:3200'
  const TASKS_URL = env.TASKS_URL || env.TASKS_SERVICE_URL || `http://localhost:${env.TASKS_PORT || '3104'}`

  const quoxVersion = getQuoxCoreVersion()

  return {
    plugins: [react(), testLabPlugin(), frameDepsPlugin()],
    publicDir: 'public',
    define: {
      'import.meta.env.VITE_QUOXCORE_VERSION': JSON.stringify(quoxVersion)
    },
    server: {
      host: '0.0.0.0',
      port: parseInt(env.VITE_PORT || '3000'),
      // HTTPS is enabled only if certs exist (generate with: npm run generate-certs)
      https: fs.existsSync(resolve(__dirname, 'certs/key.pem'))
        ? {
            key: fs.readFileSync(resolve(__dirname, 'certs/key.pem')),
            cert: fs.readFileSync(resolve(__dirname, 'certs/cert.pem')),
          }
        : undefined,
      allowedHosts: ['quoxcore.local', 'quadcore.local', 'maestro.local', 'localhost'],
      proxy: {
        '/webhook/voice-status': {
          target: MHA_COLLECTOR_URL,
          changeOrigin: true,
          rewrite: () => '/voice/status'
        },
        '/webhook/speak': {
          target: MHA_COLLECTOR_URL,
          changeOrigin: true,
          rewrite: () => '/voice/speak'
        },
        '/webhook/transcribe': {
          target: MHA_COLLECTOR_URL,
          changeOrigin: true,
          rewrite: () => '/voice/transcribe'
        },
        '/api': {
          target: AUTH_URL,
          changeOrigin: true
        },
        '/uploads': {
          target: AUTH_URL,
          changeOrigin: true
        },
        '/collector': {
          target: MHA_COLLECTOR_URL,
          changeOrigin: true,
          ws: true,
          rewrite: (path) => path.replace(/^\/collector/, '')
        },
        '/mha-agent': {
          target: MHA_AGENT_URL,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/mha-agent/, '')
        },
        '/tasks': {
          target: TASKS_URL,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/tasks/, '')
        },
        // QuoxFlow - auditable workflow engine
        '/quoxflow': {
          target: QUOXFLOW_URL,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/quoxflow\//, '/')
        },
        // QuoxBastion API proxy - only intercept /bastion/api paths, not page navigation
        '/bastion/api': {
          target: env.BASTION_URL || 'http://localhost:9850',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/bastion/, '')
        },
        // File storage service proxy (fixes mixed content)
        '/files-api': {
          target: env.FILES_URL || 'http://127.0.0.1:3102',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/files-api/, '')
        },
        // =======================================================================
        // CoreComms proxies for external APIs (CORS bypass)
        // Security Hardened - Issue #38 SSRF Fix
        // - Authentication required (Authorization header)
        // - Method restrictions (GET/POST for Telegram, POST only for Slack)
        // - Request logging for audit
        // - Internal network restriction (dev server binds to localhost)
        // =======================================================================
        '/telegram-api': {
          target: 'https://api.telegram.org',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/telegram-api/, ''),
          secure: true,
          configure: (proxy, options) => {
            proxy.on('proxyReq', (proxyReq, req, res) => {
              // Security: Require authentication header
              if (!req.headers.authorization) {
                res.writeHead(401, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'Authentication required for proxy access' }))
                proxyReq.destroy()
                return
              }
              // Security: Only allow GET and POST methods
              if (!['GET', 'POST'].includes(req.method)) {
                res.writeHead(405, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'Method not allowed' }))
                proxyReq.destroy()
                return
              }
              // Audit logging
              console.log(`[PROXY AUDIT] Telegram API: ${req.method} ${req.url} from ${req.socket.remoteAddress}`)
            })
          }
        },
        // MATRIX-P4a: Matrix (Synapse) homeserver — matrix-js-sdk polls /sync
        // over plain HTTP, no WS proxy needed yet.
        '/matrix': {
          target: env.MATRIX_BASE_URL || 'http://127.0.0.1:8008',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/matrix/, '')
        },
        '/slack-webhook': {
          target: 'https://hooks.slack.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/slack-webhook/, ''),
          secure: true,
          configure: (proxy, options) => {
            proxy.on('proxyReq', (proxyReq, req, res) => {
              // Security: Require authentication header
              if (!req.headers.authorization) {
                res.writeHead(401, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'Authentication required for proxy access' }))
                proxyReq.destroy()
                return
              }
              // Security: Only allow POST method for webhooks
              if (req.method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'Only POST method allowed for webhooks' }))
                proxyReq.destroy()
                return
              }
              // Audit logging
              console.log(`[PROXY AUDIT] Slack Webhook: ${req.method} ${req.url} from ${req.socket.remoteAddress}`)
            })
          }
        }
      },
      fs: {
        allow: ['..']
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 700,
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html')
        },
        output: {
          manualChunks: buildManualChunks
        }
      }
    },
    assetsInclude: ['**/*.md']
  }
})
