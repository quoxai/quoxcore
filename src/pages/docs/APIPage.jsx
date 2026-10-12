import { useEffect, useState } from 'react'
import { useOutletContext, Link } from 'react-router-dom'

/**
 * API Reference Page
 *
 * Comprehensive API documentation for QuoxCORE's webhooks, REST endpoints,
 * and service clients. Includes authentication, examples, and error handling.
 */

// Reusable code block component with copy functionality
function CodeBlock({ language, title, children }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(children)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="docs-code">
      <div className="docs-code-header">
        <span>{title || language}</span>
        <button
          onClick={handleCopy}
          style={{
            background: 'transparent',
            border: 'none',
            color: copied ? '#4ade80' : 'var(--text-dim)',
            cursor: 'pointer',
            fontSize: '12px',
            padding: '4px 8px',
            marginLeft: 'auto'
          }}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre><code>{children}</code></pre>
    </div>
  )
}

// Endpoint card component
function EndpointCard({ method, path, description, auth, riskLevel, children }) {
  const methodColors = {
    GET: '#4ade80',
    POST: '#60a5fa',
    PUT: '#fbbf24',
    DELETE: '#ef4444',
    WS: '#a855f7'
  }

  return (
    <div className="docs-card" style={{ marginBottom: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <span style={{
          display: 'inline-block',
          padding: '4px 10px',
          borderRadius: '4px',
          fontSize: '11px',
          fontWeight: '700',
          letterSpacing: '0.5px',
          background: `${methodColors[method]}20`,
          color: methodColors[method],
          fontFamily: 'monospace'
        }}>
          {method}
        </span>
        <code style={{
          fontSize: '14px',
          fontFamily: "'SF Mono', 'Fira Code', monospace",
          color: 'var(--text)'
        }}>
          {path}
        </code>
        {auth && (
          <span style={{
            fontSize: '11px',
            padding: '3px 8px',
            background: 'rgba(251, 191, 36, 0.15)',
            color: '#fbbf24',
            borderRadius: '4px',
            fontWeight: '600'
          }}>
            Auth Required
          </span>
        )}
        {riskLevel && (
          <span style={{
            fontSize: '11px',
            padding: '3px 8px',
            background: riskLevel === 'high' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(251, 191, 36, 0.15)',
            color: riskLevel === 'high' ? '#ef4444' : '#fbbf24',
            borderRadius: '4px',
            fontWeight: '600'
          }}>
            {riskLevel.toUpperCase()} RISK
          </span>
        )}
      </div>
      <p style={{ margin: '0 0 16px', color: 'var(--text-dim)' }}>{description}</p>
      {children}
    </div>
  )
}

export default function APIPage() {
  const { setHeadings } = useOutletContext()

  useEffect(() => {
    setHeadings([
      { id: 'quick-start', text: 'Quick Start', level: 2 },
      { id: 'authentication', text: 'Authentication', level: 2 },
      { id: 'api-keys', text: 'API Key Setup', level: 3 },
      { id: 'request-format', text: 'Request Format', level: 3 },
      { id: 'collector-endpoints', text: 'Collector Endpoints', level: 2 },
      { id: 'chat-endpoint', text: 'Chat Endpoint', level: 3 },
      { id: 'tts-endpoint', text: 'Text-to-Speech', level: 3 },
      { id: 'stt-endpoint', text: 'Speech-to-Text', level: 3 },
      { id: 'quoxagent-collector', text: 'QuoxAgent Collector API', level: 2 },
      { id: 'quoxagent-agent', text: 'QuoxAgent Agent API', level: 2 },
      { id: 'aee-protocol', text: 'AEE Protocol', level: 2 },
      { id: 'websocket-api', text: 'WebSocket API', level: 2 },
      { id: 'plugin-api', text: 'Plugin API', level: 2 },
      { id: 'error-codes', text: 'Error Codes', level: 2 },
      { id: 'rate-limits', text: 'Rate Limits', level: 2 },
    ])
  }, [setHeadings])

  return (
    <div className="docs-content">
      {/* Header */}
      <div className="docs-page-header">
        <h1>API Reference</h1>
        <p className="docs-lead">
          QuoxCORE exposes REST endpoints via the collector service for integration with external tools,
          automation systems, and custom applications.
        </p>
      </div>

      {/* Quick Start */}
      <section>
        <h2 id="quick-start">Quick Start</h2>
        <p>
          Make your first API call to QuoxCORE. This example sends a chat message and receives
          QuoxCORE's response.
        </p>

        <div className="docs-callout docs-callout-info">
          <div className="docs-callout-icon">!</div>
          <div className="docs-callout-content">
            <strong>Base URL</strong>
            <p>
              All collector endpoints use <code>http://YOUR_HOST:9848</code> as the base URL.
              Replace with your actual collector service address.
            </p>
          </div>
        </div>

        <h3>Your First API Call</h3>
        <CodeBlock language="bash" title="cURL">
{`# Send a message to QuoxCORE
curl -X POST http://localhost:9848/collector/chat \\
  -H "Content-Type: application/json" \\
  -d '{
    "message": "What is the fleet status?",
    "sessionId": "my-session-123"
  }'`}
        </CodeBlock>

        <h4>Response</h4>
        <CodeBlock language="json" title="Response">
{`{
  "success": true,
  "response": "Fleet Status Report:\\n\\n- Total Agents: 12\\n- Online: 11\\n- Offline: 1 (kuma02)\\n\\nAll systems operational.",
  "sessionId": "my-session-123",
  "tokens": {
    "input": 156,
    "output": 89
  }
}`}
        </CodeBlock>

        <h3>Quick Examples</h3>
        <div className="docs-grid docs-grid-2">
          <div className="docs-card">
            <h4>JavaScript / Fetch</h4>
            <CodeBlock language="javascript">
{`const response = await fetch('/collector/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: 'List all hosts',
    sessionId: 'session-001'
  })
});
const data = await response.json();
console.log(data.response);`}
            </CodeBlock>
          </div>
          <div className="docs-card">
            <h4>Python</h4>
            <CodeBlock language="python">
{`import requests

response = requests.post(
    'http://localhost:9848/collector/chat',
    json={
        'message': 'List all hosts',
        'sessionId': 'session-001'
    }
)
print(response.json()['response'])`}
            </CodeBlock>
          </div>
        </div>
      </section>

      {/* Authentication */}
      <section>
        <h2 id="authentication">Authentication</h2>
        <p>
          QuoxCORE supports multiple authentication methods depending on the endpoint type.
          Most internal APIs do not require authentication, while external integrations
          use API keys or JWT tokens.
        </p>

        <h3 id="api-keys">API Key Setup</h3>
        <p>
          External API keys are configured in the collector environment. Edit <code>services/collector/.env</code>:
        </p>
        <CodeBlock language="bash" title="Environment Variables">
{`# Required for AI
ANTHROPIC_API_KEY=...      # Claude API

# Required for voice features
OPENAI_API_KEY=sk-...      # Whisper STT
ELEVENLABS_API_KEY=...     # TTS synthesis

# Optional integrations
QDRANT_API_KEY=...         # Vector memory (if remote)

# After changes, restart the collector:
docker compose restart collector`}
        </CodeBlock>

        <h3 id="request-format">Request Format</h3>
        <p>All API requests should use JSON format with the following headers:</p>
        <CodeBlock language="http" title="Required Headers">
{`Content-Type: application/json
Accept: application/json

# For authenticated endpoints (future):
Authorization: Bearer <your-jwt-token>
X-API-Key: <your-api-key>`}
        </CodeBlock>

        <div className="docs-callout docs-callout-important">
          <div className="docs-callout-icon">!</div>
          <div className="docs-callout-content">
            <strong>Security Note</strong>
            <p>
              The dashboard currently has no authentication. All endpoints are accessible
              within your network. See the <Link to="/docs/auth-service">Auth Service</Link> docs
              for the upcoming authentication system.
            </p>
          </div>
        </div>
      </section>

      {/* Collector Endpoints */}
      <section>
        <h2 id="collector-endpoints">Collector Endpoints</h2>
        <p>
          The primary integration layer uses the collector service. These endpoints
          process requests through Claude and other services natively.
        </p>

        <table className="docs-table">
          <thead>
            <tr>
              <th>Method</th>
              <th>Endpoint</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code style={{ color: '#4ade80' }}>POST</code></td>
              <td><code>/collector/chat</code></td>
              <td>Send message to QuoxCORE</td>
            </tr>
            <tr>
              <td><code style={{ color: '#60a5fa' }}>POST</code></td>
              <td><code>/collector/webhook/speak</code></td>
              <td>Text-to-speech synthesis</td>
            </tr>
            <tr>
              <td><code style={{ color: '#60a5fa' }}>POST</code></td>
              <td><code>/collector/webhook/transcribe</code></td>
              <td>Speech-to-text transcription</td>
            </tr>
            <tr>
              <td><code style={{ color: '#60a5fa' }}>POST</code></td>
              <td><code>/collector/webhook/quick-action</code></td>
              <td>Infrastructure quick actions</td>
            </tr>
          </tbody>
        </table>

        <h3 id="chat-endpoint">Chat Endpoint</h3>
        <EndpointCard
          method="POST"
          path="/collector/chat"
          description="Send a message to QuoxCORE through the collector chat pipeline. Supports context injection, memory retrieval, and multi-turn conversations."
        >
          <h4>Request Body</h4>
          <CodeBlock language="json">
{`{
  "message": "string (required) - The user's message",
  "sessionId": "string (optional) - Session ID for conversation continuity",
  "assistant": "string (optional) - Target assistant (quox, sentinel, nova, etc.)",
  "context": {
    "includeMemory": true,    // Include relevant memories
    "includeWSM": true,       // Include working set memory
    "maxTokens": 4096         // Max response tokens
  }
}`}
          </CodeBlock>
          <h4>Response</h4>
          <CodeBlock language="json">
{`{
  "success": true,
  "response": "string - Claude's response text",
  "sessionId": "string - Session ID for follow-up",
  "assistant": "quox",
  "tokens": {
    "input": 156,
    "output": 89,
    "total": 245
  },
  "routed": false,           // true if handled by Smart Router
  "routerPattern": null,     // Pattern name if routed
  "memories": [              // Relevant memories used
    { "type": "episodic", "content": "...", "score": 0.85 }
  ]
}`}
          </CodeBlock>
        </EndpointCard>

        <h3 id="tts-endpoint">Text-to-Speech</h3>
        <EndpointCard
          method="POST"
          path="/collector/webhook/speak"
          description="Convert text to speech using ElevenLabs. Returns audio data in the specified format."
          auth
        >
          <h4>Request Body</h4>
          <CodeBlock language="json">
{`{
  "text": "string (required) - Text to synthesize",
  "voice": "string (optional) - Voice ID (default: Rachel)",
  "voiceMode": "string (optional) - JARVIS | Cyberpunk | HAL",
  "format": "string (optional) - mp3 | wav | ogg (default: mp3)"
}`}
          </CodeBlock>
          <h4>Response</h4>
          <CodeBlock language="json">
{`{
  "success": true,
  "audio": "base64-encoded-audio-data",
  "format": "mp3",
  "duration": 3.2,
  "voice": "Rachel"
}`}
          </CodeBlock>
        </EndpointCard>

        <h3 id="stt-endpoint">Speech-to-Text</h3>
        <EndpointCard
          method="POST"
          path="/collector/webhook/transcribe"
          description="Transcribe audio to text using OpenAI Whisper. Supports multiple audio formats."
          auth
        >
          <h4>Request Body</h4>
          <CodeBlock language="json">
{`{
  "audio": "base64-encoded-audio (required)",
  "format": "string - mp3 | wav | webm | m4a",
  "language": "string (optional) - ISO language code (default: en)"
}`}
          </CodeBlock>
          <h4>Response</h4>
          <CodeBlock language="json">
{`{
  "success": true,
  "text": "The transcribed text content",
  "language": "en",
  "confidence": 0.95,
  "duration": 5.2
}`}
          </CodeBlock>
        </EndpointCard>
      </section>

      {/* QuoxAgent Collector API */}
      <section>
        <h2 id="quoxagent-collector">QuoxAgent Collector API</h2>
        <p>
          The QuoxAgent Collector runs on the QuoxCORE host (port <code>9848</code>) and aggregates
          data from all QuoxAgent agents across your infrastructure.
        </p>

        <table className="docs-table">
          <thead>
            <tr>
              <th>Method</th>
              <th>Endpoint</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code style={{ color: '#4ade80' }}>GET</code></td>
              <td><code>/api/v1/agents</code></td>
              <td>List all registered agents</td>
            </tr>
            <tr>
              <td><code style={{ color: '#4ade80' }}>GET</code></td>
              <td><code>/api/v1/agents/:id</code></td>
              <td>Get single agent details</td>
            </tr>
            <tr>
              <td><code style={{ color: '#4ade80' }}>GET</code></td>
              <td><code>/api/v1/fleet/summary</code></td>
              <td>Fleet summary statistics</td>
            </tr>
            <tr>
              <td><code style={{ color: '#4ade80' }}>GET</code></td>
              <td><code>/api/v1/check/:hostId</code></td>
              <td>Check if host has QuoxAgent installed</td>
            </tr>
            <tr>
              <td><code style={{ color: '#60a5fa' }}>POST</code></td>
              <td><code>/api/v1/heartbeat</code></td>
              <td>Receive agent heartbeat</td>
            </tr>
            <tr>
              <td><code style={{ color: '#4ade80' }}>GET</code></td>
              <td><code>/health</code></td>
              <td>Collector health check</td>
            </tr>
            <tr>
              <td><code style={{ color: '#4ade80' }}>GET</code></td>
              <td><code>/metrics</code></td>
              <td>Prometheus metrics</td>
            </tr>
            <tr>
              <td><code style={{ color: '#4ade80' }}>GET</code></td>
              <td><code>/install</code></td>
              <td>Serve install script</td>
            </tr>
          </tbody>
        </table>

        <EndpointCard
          method="GET"
          path="/api/v1/agents"
          description="Returns a list of all registered QuoxAgent agents with their current status and metadata."
        >
          <h4>Example Response</h4>
          <CodeBlock language="json">
{`{
  "agents": [
    {
      "id": "docker01",
      "hostname": "docker01.local",
      "ip": "10.0.0.101",
      "status": "online",
      "version": "1.2.0",
      "lastSeen": "2025-01-25T10:30:00Z",
      "uptime": 864000,
      "os": "ubuntu-22.04",
      "resources": {
        "cpu": 23.5,
        "memory": 68.2,
        "disk": 45.0
      }
    }
  ],
  "total": 12,
  "online": 11,
  "offline": 1
}`}
          </CodeBlock>
        </EndpointCard>

        <EndpointCard
          method="GET"
          path="/api/v1/fleet/summary"
          description="Returns aggregate statistics for the entire QuoxAgent fleet."
        >
          <h4>Example Response</h4>
          <CodeBlock language="json">
{`{
  "total": 12,
  "online": 11,
  "offline": 1,
  "byStatus": {
    "healthy": 10,
    "warning": 1,
    "critical": 0
  },
  "byOs": {
    "ubuntu-22.04": 8,
    "debian-12": 3,
    "rocky-9": 1
  },
  "avgCpu": 34.2,
  "avgMemory": 52.8,
  "lastUpdated": "2025-01-25T10:30:00Z"
}`}
          </CodeBlock>
        </EndpointCard>
      </section>

      {/* QuoxAgent Agent API */}
      <section>
        <h2 id="quoxagent-agent">QuoxAgent Agent API</h2>
        <p>
          Each QuoxAgent agent exposes a local API on port <code>9847</code>. These endpoints
          are accessible from the host where the agent is running.
        </p>

        <table className="docs-table">
          <thead>
            <tr>
              <th>Method</th>
              <th>Endpoint</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code style={{ color: '#4ade80' }}>GET</code></td>
              <td><code>/health</code></td>
              <td>Agent health check</td>
            </tr>
            <tr>
              <td><code style={{ color: '#4ade80' }}>GET</code></td>
              <td><code>/api/v1/jobs</code></td>
              <td>List pending/completed jobs</td>
            </tr>
            <tr>
              <td><code style={{ color: '#60a5fa' }}>POST</code></td>
              <td><code>/api/v1/jobs</code></td>
              <td>Submit a new job</td>
            </tr>
            <tr>
              <td><code style={{ color: '#4ade80' }}>GET</code></td>
              <td><code>/api/v1/sessions</code></td>
              <td>List Claude sessions</td>
            </tr>
            <tr>
              <td><code style={{ color: '#4ade80' }}>GET</code></td>
              <td><code>/metrics</code></td>
              <td>Prometheus metrics</td>
            </tr>
          </tbody>
        </table>

        <EndpointCard
          method="POST"
          path="/api/v1/jobs"
          description="Submit a job to the QuoxAgent agent. Jobs are executed in order and results are stored."
          riskLevel="medium"
        >
          <h4>Request Body</h4>
          <CodeBlock language="json">
{`{
  "type": "shell | script | file",
  "command": "string - Command to execute",
  "timeout": 300,          // Timeout in seconds
  "workdir": "/tmp",       // Working directory
  "env": {                 // Environment variables
    "KEY": "value"
  }
}`}
          </CodeBlock>
          <h4>Response</h4>
          <CodeBlock language="json">
{`{
  "jobId": "job-abc123",
  "status": "queued",
  "createdAt": "2025-01-25T10:30:00Z",
  "estimatedStart": "2025-01-25T10:30:05Z"
}`}
          </CodeBlock>
        </EndpointCard>
      </section>

      {/* AEE Protocol */}
      <section>
        <h2 id="aee-protocol">AEE Protocol</h2>
        <p>
          The Agent Envelope Exchange (AEE) protocol provides structured message passing
          between agents with full audit trails. Envelopes are stored on the collector.
        </p>

        <table className="docs-table">
          <thead>
            <tr>
              <th>Method</th>
              <th>Endpoint</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code style={{ color: '#60a5fa' }}>POST</code></td>
              <td><code>/aee/store</code></td>
              <td>Store single envelope</td>
            </tr>
            <tr>
              <td><code style={{ color: '#60a5fa' }}>POST</code></td>
              <td><code>/aee/sync</code></td>
              <td>Batch sync from browser</td>
            </tr>
            <tr>
              <td><code style={{ color: '#4ade80' }}>GET</code></td>
              <td><code>/aee/:id</code></td>
              <td>Get envelope by ID</td>
            </tr>
            <tr>
              <td><code style={{ color: '#4ade80' }}>GET</code></td>
              <td><code>/aee/conversation/:corr</code></td>
              <td>Get full conversation</td>
            </tr>
            <tr>
              <td><code style={{ color: '#4ade80' }}>GET</code></td>
              <td><code>/aee/conversations</code></td>
              <td>List all conversations</td>
            </tr>
            <tr>
              <td><code style={{ color: '#4ade80' }}>GET</code></td>
              <td><code>/aee/query</code></td>
              <td>Query with filters</td>
            </tr>
            <tr>
              <td><code style={{ color: '#4ade80' }}>GET</code></td>
              <td><code>/aee/stats</code></td>
              <td>AEE statistics</td>
            </tr>
          </tbody>
        </table>

        <h3>Envelope Structure</h3>
        <p>Every AEE envelope follows this structure:</p>
        <CodeBlock language="json" title="AEE Envelope">
{`{
  "v": "1",                        // Protocol version
  "id": "01JFX...",                // ULID - unique identifier
  "ts": "2025-01-25T10:30:00Z",    // ISO timestamp
  "type": "task | result | event | error | stream",
  "from": "human.adam",            // Sender address
  "to": "agent.cipher",            // Recipient address
  "intent": "quox.chat.query",  // Action intent
  "corr": "CONV_01JFX...",         // Conversation correlation ID
  "reply_to": "01JFX..." | null,   // Parent message ID
  "payload": {
    "text": "Your message here",
    // Additional data fields
  }
}`}
        </CodeBlock>
      </section>

      {/* WebSocket API */}
      <section>
        <h2 id="websocket-api">WebSocket API</h2>
        <p>
          Real-time updates are delivered via WebSocket connections. The Universal Agent
          Monitor (UAM) provides live agent session tracking.
        </p>

        <EndpointCard
          method="WS"
          path="/ws/agents/events"
          description="Real-time stream of agent session events. Connect to receive live updates as agents work."
        >
          <h4>Query Parameters</h4>
          <table className="docs-table" style={{ marginBottom: '16px' }}>
            <thead>
              <tr>
                <th>Parameter</th>
                <th>Type</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>agent_type</code></td>
                <td>string</td>
                <td>Filter: cli, api, local, custom (comma-separated)</td>
              </tr>
              <tr>
                <td><code>host_id</code></td>
                <td>string</td>
                <td>Filter by host ID (comma-separated)</td>
              </tr>
              <tr>
                <td><code>session_id</code></td>
                <td>string</td>
                <td>Filter by session ID (comma-separated)</td>
              </tr>
            </tbody>
          </table>

          <h4>Event Types</h4>
          <div className="docs-grid docs-grid-2">
            <div>
              <p><strong>Session Events</strong></p>
              <ul style={{ marginTop: '8px' }}>
                <li><code>session.start</code> - New session started</li>
                <li><code>session.end</code> - Session completed</li>
                <li><code>session.status</code> - Status change</li>
              </ul>
            </div>
            <div>
              <p><strong>Activity Events</strong></p>
              <ul style={{ marginTop: '8px' }}>
                <li><code>activity.message</code> - User/agent message</li>
                <li><code>activity.thinking</code> - Agent reasoning</li>
                <li><code>activity.tool_call</code> - Tool invocation</li>
                <li><code>activity.tool_result</code> - Tool response</li>
              </ul>
            </div>
          </div>

          <h4>Connection Example</h4>
          <CodeBlock language="javascript">
{`const ws = new WebSocket('ws://localhost:9848/ws/agents/events');

ws.onopen = () => {
  console.log('Connected to UAM');

  // Update filters dynamically
  ws.send(JSON.stringify({
    agent_types: ['cli'],
    host_ids: ['docker01', 'docker02']
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Event:', data.type, data.payload);
};`}
          </CodeBlock>
        </EndpointCard>
      </section>

      {/* Plugin API */}
      <section>
        <h2 id="plugin-api">Plugin API</h2>
        <p>
          The Plugin API provides license and plugin management functionality from the
          browser client.
        </p>

        <CodeBlock language="javascript" title="Plugin Client Usage">
{`import {
  getLicenseStatus,
  activateLicense,
  getPlugins,
  enablePlugin,
  disablePlugin
} from './services/pluginClient'

// Check license status
const license = await getLicenseStatus()
// { valid: true, tier: 'professional', expiresAt: '2026-01-25' }

// Get all plugins
const { plugins } = await getPlugins()
// [{ id: 'soc', name: 'Security Ops', enabled: true, tier: 'professional' }]

// Enable/disable plugins (requires appropriate license)
await enablePlugin('soc')
await disablePlugin('soc')

// Activate a license key (issued at quox.ai; binds this instance's seat)
await activateLicense(licenseKeyJSON)`}
        </CodeBlock>
      </section>

      {/* Error Codes */}
      <section>
        <h2 id="error-codes">Error Codes</h2>
        <p>
          All QuoxCORE APIs return consistent error responses. Use the error code to
          determine the appropriate action.
        </p>

        <table className="docs-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>HTTP Status</th>
              <th>Description</th>
              <th>Resolution</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>INVALID_REQUEST</code></td>
              <td>400</td>
              <td>Malformed request body</td>
              <td>Check JSON syntax and required fields</td>
            </tr>
            <tr>
              <td><code>MISSING_FIELD</code></td>
              <td>400</td>
              <td>Required field missing</td>
              <td>Include all required fields</td>
            </tr>
            <tr>
              <td><code>UNAUTHORIZED</code></td>
              <td>401</td>
              <td>Invalid or missing auth</td>
              <td>Provide valid API key or token</td>
            </tr>
            <tr>
              <td><code>FORBIDDEN</code></td>
              <td>403</td>
              <td>Permission denied</td>
              <td>Check user permissions</td>
            </tr>
            <tr>
              <td><code>NOT_FOUND</code></td>
              <td>404</td>
              <td>Resource not found</td>
              <td>Verify endpoint path and IDs</td>
            </tr>
            <tr>
              <td><code>RATE_LIMITED</code></td>
              <td>429</td>
              <td>Too many requests</td>
              <td>Wait and retry with backoff</td>
            </tr>
            <tr>
              <td><code>AGENT_OFFLINE</code></td>
              <td>503</td>
              <td>Target agent unavailable</td>
              <td>Check agent status, retry later</td>
            </tr>
            <tr>
              <td><code>LLM_ERROR</code></td>
              <td>502</td>
              <td>Claude API error</td>
              <td>Check API key, retry</td>
            </tr>
            <tr>
              <td><code>TIMEOUT</code></td>
              <td>504</td>
              <td>Request timed out</td>
              <td>Reduce request complexity, retry</td>
            </tr>
          </tbody>
        </table>

        <h3>Error Response Format</h3>
        <CodeBlock language="json">
{`{
  "success": false,
  "error": {
    "code": "MISSING_FIELD",
    "message": "Required field 'message' is missing",
    "field": "message",
    "docs": "/docs/api#chat-endpoint"
  },
  "requestId": "req-abc123"
}`}
        </CodeBlock>
      </section>

      {/* Rate Limits */}
      <section>
        <h2 id="rate-limits">Rate Limits</h2>
        <p>
          API endpoints are rate limited to ensure fair usage and system stability.
        </p>

        <table className="docs-table">
          <thead>
            <tr>
              <th>Endpoint Category</th>
              <th>Limit</th>
              <th>Window</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Chat endpoints</td>
              <td>60 requests</td>
              <td>per minute</td>
            </tr>
            <tr>
              <td>Voice endpoints</td>
              <td>30 requests</td>
              <td>per minute</td>
            </tr>
            <tr>
              <td>QuoxAgent read operations</td>
              <td>120 requests</td>
              <td>per minute</td>
            </tr>
            <tr>
              <td>QuoxAgent write operations</td>
              <td>30 requests</td>
              <td>per minute</td>
            </tr>
            <tr>
              <td>WebSocket connections</td>
              <td>10 connections</td>
              <td>per client</td>
            </tr>
          </tbody>
        </table>

        <div className="docs-callout">
          <div className="docs-callout-icon">i</div>
          <div className="docs-callout-content">
            <strong>Rate Limit Headers</strong>
            <p>
              Responses include <code>X-RateLimit-Limit</code>, <code>X-RateLimit-Remaining</code>,
              and <code>X-RateLimit-Reset</code> headers to track your usage.
            </p>
          </div>
        </div>
      </section>

      {/* Footer Navigation */}
      <div className="docs-page-footer">
        <div className="docs-footer-nav">
          <Link to="/docs/quoxagent" className="docs-footer-link docs-footer-prev">
            <span className="docs-footer-label">Previous</span>
            <span className="docs-footer-title">QuoxAgent Agent</span>
          </Link>
          <Link to="/docs/development" className="docs-footer-link docs-footer-next">
            <span className="docs-footer-label">Next</span>
            <span className="docs-footer-title">Development</span>
          </Link>
        </div>
      </div>
    </div>
  )
}
