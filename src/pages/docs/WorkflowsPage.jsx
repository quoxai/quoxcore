/**
 * WorkflowsPage - Comprehensive Workflow Documentation
 *
 * A beginner-friendly guide to understanding and creating workflows in QuoxCORE.
 * Covers concepts, visual examples, step-by-step tutorials, and common patterns.
 */

import { useEffect } from 'react'
import { useOutletContext, Link } from 'react-router-dom'

export default function WorkflowsPage() {
  const { setHeadings } = useOutletContext()

  useEffect(() => {
    setHeadings([
      { id: 'what-are-workflows', text: 'What are Workflows?', level: 2 },
      { id: 'why-workflows-matter', text: 'Why Workflows Matter', level: 2 },
      { id: 'anatomy-of-workflow', text: 'Anatomy of a Workflow', level: 2 },
      { id: 'triggers', text: 'Triggers', level: 3 },
      { id: 'nodes-and-actions', text: 'Nodes and Actions', level: 3 },
      { id: 'outputs', text: 'Outputs', level: 3 },
      { id: 'your-first-workflow', text: 'Your First Workflow', level: 2 },
      { id: 'step-1-describe', text: 'Step 1: Describe Your Goal', level: 3 },
      { id: 'step-2-review', text: 'Step 2: Review the Plan', level: 3 },
      { id: 'step-3-configure', text: 'Step 3: Configure Connections', level: 3 },
      { id: 'step-4-test', text: 'Step 4: Test and Deploy', level: 3 },
      { id: 'workflow-patterns', text: 'Common Workflow Patterns', level: 2 },
      { id: 'pattern-monitoring', text: 'Monitoring & Alerting', level: 3 },
      { id: 'pattern-sync', text: 'Data Synchronization', level: 3 },
      { id: 'pattern-approval', text: 'Approval Workflows', level: 3 },
      { id: 'pattern-ai', text: 'AI-Powered Automation', level: 3 },
      { id: 'workflow-library', text: 'Workflow Library', level: 2 },
      { id: 'n8n-integration', text: 'n8n Integration', level: 2 },
      { id: 'best-practices', text: 'Best Practices', level: 2 },
    ])
  }, [setHeadings])

  return (
    <section className="docs-section">
      <h1>Workflows</h1>
      <p className="docs-lead">
        Workflows are the heart of QuoxCORE's automation - sequences of actions that run automatically
        when triggered. Describe what you want in plain English, and QuoxCORE builds it for you.
      </p>

      {/* Stats Row */}
      <div className="docs-stats">
        <div className="docs-stat">
          <div className="docs-stat-value">1,340+</div>
          <div className="docs-stat-label">Ready-to-use templates</div>
        </div>
        <div className="docs-stat">
          <div className="docs-stat-value">500+</div>
          <div className="docs-stat-label">Integrations available</div>
        </div>
        <div className="docs-stat">
          <div className="docs-stat-value">3</div>
          <div className="docs-stat-label">Ways to create workflows</div>
        </div>
      </div>

      {/* What are Workflows */}
      <h2 id="what-are-workflows">What are Workflows?</h2>
      <p>
        Think of a workflow as a recipe for automation. Just like a recipe has steps that happen
        in order (preheat oven, mix ingredients, bake for 30 minutes), a workflow has steps that
        run automatically when something triggers them.
      </p>

      <div className="docs-callout">
        <div className="docs-callout-icon">i</div>
        <div className="docs-callout-content">
          <strong>In Simple Terms</strong>
          <p>
            A workflow is an "if this, then that" for your infrastructure. When X happens,
            automatically do Y. No coding required.
          </p>
        </div>
      </div>

      {/* Visual: Simple Workflow Concept */}
      <div className="docs-diagram-box">
        <pre>{`
  TRIGGER              ACTIONS                 OUTPUT
  -------              -------                 ------

    [Clock]              [Check]                [Alert]
       |                    |                      |
  Every 5 min  --->  Check server CPU  --->  Send Telegram
                     If CPU > 90%            message to admin

         "When this happens"  -->  "Do these things"  -->  "With this result"
        `}</pre>
      </div>

      <h3>Real-World Examples</h3>
      <div className="docs-grid docs-grid-2">
        <div className="docs-card">
          <div className="docs-card-icon" style={{ background: 'rgba(16, 185, 129, 0.15)', color: '#10b981' }}>M</div>
          <h4>Server Monitoring</h4>
          <p>
            "Check all Docker hosts every 5 minutes. If any disk is over 90% full,
            send me a Telegram alert."
          </p>
        </div>
        <div className="docs-card">
          <div className="docs-card-icon" style={{ background: 'rgba(99, 102, 241, 0.15)', color: '#6366f1' }}>S</div>
          <h4>Data Sync</h4>
          <p>
            "When a new row is added to Google Sheets, create a ticket in Jira
            and notify the team on Slack."
          </p>
        </div>
        <div className="docs-card">
          <div className="docs-card-icon" style={{ background: 'rgba(236, 72, 153, 0.15)', color: '#ec4899' }}>A</div>
          <h4>AI Assistant</h4>
          <p>
            "When someone emails support@, use AI to categorize the request
            and draft a response for review."
          </p>
        </div>
        <div className="docs-card">
          <div className="docs-card-icon" style={{ background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b' }}>D</div>
          <h4>Deployment Pipeline</h4>
          <p>
            "When code is pushed to main, run tests, build the container,
            and ask for approval before deploying."
          </p>
        </div>
      </div>

      {/* Why Workflows Matter */}
      <h2 id="why-workflows-matter">Why Workflows Matter</h2>
      <p>
        Manual tasks are error-prone, time-consuming, and often forgotten. Workflows solve these problems:
      </p>

      <table className="docs-table">
        <thead>
          <tr>
            <th>Problem</th>
            <th>Manual Approach</th>
            <th>With Workflows</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Monitoring</strong></td>
            <td>Remember to check servers periodically</td>
            <td>Automatic checks every X minutes</td>
          </tr>
          <tr>
            <td><strong>Notifications</strong></td>
            <td>Notice issues by chance</td>
            <td>Instant alerts when problems occur</td>
          </tr>
          <tr>
            <td><strong>Data Entry</strong></td>
            <td>Copy-paste between systems</td>
            <td>Automatic sync in real-time</td>
          </tr>
          <tr>
            <td><strong>Approvals</strong></td>
            <td>Chase people via email</td>
            <td>Structured approval queues</td>
          </tr>
          <tr>
            <td><strong>Responses</strong></td>
            <td>Human handles every request</td>
            <td>AI drafts, human approves</td>
          </tr>
        </tbody>
      </table>

      {/* Anatomy of a Workflow */}
      <h2 id="anatomy-of-workflow">Anatomy of a Workflow</h2>
      <p>
        Every workflow has three essential parts: a trigger that starts it, nodes that do the work,
        and outputs that deliver results.
      </p>

      <div className="docs-diagram-box">
        <pre>{`
  WORKFLOW STRUCTURE
  ==================

  +-------------+     +-------------+     +-------------+     +-------------+
  |   TRIGGER   | --> |   NODE 1    | --> |   NODE 2    | --> |   OUTPUT    |
  |             |     |             |     |             |     |             |
  | - Schedule  |     | - HTTP GET  |     | - If/Then   |     | - Telegram  |
  | - Webhook   |     | - Database  |     | - Transform |     | - Email     |
  | - Event     |     | - AI Agent  |     | - Filter    |     | - Slack     |
  +-------------+     +-------------+     +-------------+     +-------------+
        |                   |                   |                   |
        v                   v                   v                   v
     "When?"           "Get data"          "Process"            "Notify"
        `}</pre>
      </div>

      <h3 id="triggers">Triggers</h3>
      <p>
        A trigger defines <em>when</em> your workflow runs. QuoxCORE supports several trigger types:
      </p>

      <div className="docs-grid docs-grid-3">
        <div className="docs-card">
          <h4>Schedule</h4>
          <p>Run at specific times or intervals. "Every 5 minutes", "Daily at 9am", "Every Monday".</p>
          <div className="docs-code-inline">
            <pre>{"trigger: schedule\ninterval: 5 minutes"}</pre>
          </div>
        </div>
        <div className="docs-card">
          <h4>Webhook</h4>
          <p>Run when an external service sends data. Perfect for integrations and events.</p>
          <div className="docs-code-inline">
            <pre>{"trigger: webhook\npath: /my-endpoint"}</pre>
          </div>
        </div>
        <div className="docs-card">
          <h4>Manual</h4>
          <p>Run on-demand when you click a button or send a command.</p>
          <div className="docs-code-inline">
            <pre>{"trigger: manual\n# Run via dashboard"}</pre>
          </div>
        </div>
      </div>

      <h3 id="nodes-and-actions">Nodes and Actions</h3>
      <p>
        Nodes are the individual steps in your workflow. Each node does one thing and passes
        its result to the next node.
      </p>

      <table className="docs-table">
        <thead>
          <tr>
            <th>Node Type</th>
            <th>Purpose</th>
            <th>Example</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>HTTP Request</strong></td>
            <td>Call APIs, fetch data</td>
            <td>Get server metrics from Prometheus</td>
          </tr>
          <tr>
            <td><strong>If/Then</strong></td>
            <td>Conditional branching</td>
            <td>If CPU &gt; 90%, take alert path</td>
          </tr>
          <tr>
            <td><strong>Code</strong></td>
            <td>Custom JavaScript/Python</td>
            <td>Transform data, calculate values</td>
          </tr>
          <tr>
            <td><strong>AI Agent</strong></td>
            <td>Use LLM for analysis</td>
            <td>Analyze logs for anomalies</td>
          </tr>
          <tr>
            <td><strong>Database</strong></td>
            <td>Query or update data</td>
            <td>Store results in Postgres</td>
          </tr>
          <tr>
            <td><strong>Wait</strong></td>
            <td>Pause for approval</td>
            <td>Wait for human confirmation</td>
          </tr>
        </tbody>
      </table>

      <h3 id="outputs">Outputs</h3>
      <p>
        Outputs deliver results - notifications, data storage, or triggering other systems.
      </p>

      <div className="docs-grid docs-grid-2">
        <div className="docs-card docs-card-horizontal">
          <div className="docs-card-icon" style={{ background: 'rgba(6, 182, 212, 0.15)', color: '#06b6d4' }}>N</div>
          <div>
            <h4>Notifications</h4>
            <p>Telegram, Slack, Discord, Email, SMS (Twilio)</p>
          </div>
        </div>
        <div className="docs-card docs-card-horizontal">
          <div className="docs-card-icon" style={{ background: 'rgba(139, 92, 246, 0.15)', color: '#8b5cf6' }}>D</div>
          <div>
            <h4>Data Storage</h4>
            <p>Google Sheets, Airtable, Databases, Files</p>
          </div>
        </div>
        <div className="docs-card docs-card-horizontal">
          <div className="docs-card-icon" style={{ background: 'rgba(34, 197, 94, 0.15)', color: '#22c55e' }}>A</div>
          <div>
            <h4>Actions</h4>
            <p>Create tickets, update records, trigger deployments</p>
          </div>
        </div>
        <div className="docs-card docs-card-horizontal">
          <div className="docs-card-icon" style={{ background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444' }}>I</div>
          <div>
            <h4>Inbox</h4>
            <p>Create approval requests in QuoxCORE's inbox system</p>
          </div>
        </div>
      </div>

      {/* Your First Workflow */}
      <h2 id="your-first-workflow">Your First Workflow</h2>
      <p>
        Let's create a simple monitoring workflow step by step. We'll build:
        "Check if my website is up every 5 minutes, and alert me on Telegram if it's down."
      </p>

      <div className="docs-phases-detailed">
        <div className="docs-phase-detailed">
          <div className="docs-phase-header">
            <div className="docs-phase-num">1</div>
            <h3 id="step-1-describe">Describe Your Goal</h3>
          </div>
          <div className="docs-phase-body">
            <p>
              Open the <Link to="/workflow-builder" className="docs-link">Workflow Builder</Link> and
              describe what you want in plain English:
            </p>
            <div className="docs-code">
              <div className="docs-code-header">Natural Language Input</div>
              <pre>{`Check if https://mysite.com is responding every 5 minutes.
If the site is down or returns an error, send me a Telegram
message with the status code and error details.`}</pre>
            </div>
            <p>
              QuoxCORE's AI understands your intent and generates a workflow plan. No need to know
              the technical details - just describe the outcome you want.
            </p>
          </div>
        </div>

        <div className="docs-phase-detailed">
          <div className="docs-phase-header">
            <div className="docs-phase-num">2</div>
            <h3 id="step-2-review">Review the Plan</h3>
          </div>
          <div className="docs-phase-body">
            <p>
              QuoxCORE shows you the workflow it will create. Review the steps and make adjustments:
            </p>
            <div className="docs-diagram-box">
              <pre>{`
  GENERATED WORKFLOW PLAN
  =======================

  [Schedule Trigger]  -->  [HTTP Request]  -->  [If/Then]  -->  [Telegram]
       Every 5 min         GET mysite.com       Check status      Send alert

  Configuration:
  - URL: https://mysite.com
  - Expected status: 200
  - Timeout: 10 seconds
  - Alert destination: Your Telegram
              `}</pre>
            </div>
            <p>
              You can modify thresholds, add steps, or change notification channels before proceeding.
            </p>
          </div>
        </div>

        <div className="docs-phase-detailed">
          <div className="docs-phase-header">
            <div className="docs-phase-num">3</div>
            <h3 id="step-3-configure">Configure Connections</h3>
          </div>
          <div className="docs-phase-body">
            <p>
              Connect the services your workflow needs. For this example, you'll need to set up
              your Telegram bot credentials:
            </p>
            <div className="docs-code">
              <div className="docs-code-header">Credential Configuration</div>
              <pre>{`{
  "telegram": {
    "bot_token": "your-telegram-bot-token",
    "chat_id": "your-chat-id"
  }
}`}</pre>
            </div>
            <div className="docs-callout docs-callout-important">
              <div className="docs-callout-icon">!</div>
              <div className="docs-callout-content">
                <strong>Credentials are Secure</strong>
                <p>
                  Credentials are stored encrypted and never exposed in workflow definitions.
                  You only need to set them up once per integration.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="docs-phase-detailed">
          <div className="docs-phase-header">
            <div className="docs-phase-num">4</div>
            <h3 id="step-4-test">Test and Deploy</h3>
          </div>
          <div className="docs-phase-body">
            <p>
              Before going live, test your workflow:
            </p>
            <ol>
              <li><strong>Manual Test:</strong> Click "Test Run" to execute once and see results</li>
              <li><strong>Check Output:</strong> Verify the HTTP request succeeded and data looks correct</li>
              <li><strong>Simulate Failure:</strong> Test with an invalid URL to ensure alerts work</li>
              <li><strong>Deploy:</strong> Enable the schedule trigger to run automatically</li>
            </ol>
            <div className="docs-code">
              <div className="docs-code-header">Test Output</div>
              <pre>{`Test Run: SUCCESS
-----------------
Trigger: Manual
HTTP Request: GET https://mysite.com
  Status: 200 OK
  Response Time: 142ms
If/Then: Condition FALSE (site is UP)
  -> Alert path skipped

Workflow completed in 156ms`}</pre>
            </div>
          </div>
        </div>
      </div>

      {/* Common Workflow Patterns */}
      <h2 id="workflow-patterns">Common Workflow Patterns</h2>
      <p>
        Here are battle-tested patterns for common automation scenarios. Use these as starting
        points for your own workflows.
      </p>

      <h3 id="pattern-monitoring">Monitoring & Alerting</h3>
      <div className="docs-feature">
        <div className="docs-feature-header">
          <div className="docs-feature-icon" style={{ background: 'rgba(16, 185, 129, 0.15)', color: '#10b981' }}>M</div>
          <h4>Server Health Monitor</h4>
        </div>
        <p>
          Monitor CPU, memory, and disk across your fleet. Alert on thresholds.
        </p>
        <div className="docs-code">
          <div className="docs-code-header">Recipe Configuration</div>
          <pre>{`{
  "name": "Server Health Monitor",
  "trigger": { "type": "schedule", "interval": "5 minutes" },
  "hosts": ["docker01", "docker02", "docker03"],
  "thresholds": {
    "cpu": 90,
    "memory": 85,
    "disk": 90
  },
  "alerts": ["telegram", "inbox"]
}`}</pre>
        </div>
        <p>
          <strong>Use cases:</strong> Infrastructure monitoring, capacity planning, SLA compliance
        </p>
      </div>

      <h3 id="pattern-sync">Data Synchronization</h3>
      <div className="docs-feature">
        <div className="docs-feature-header">
          <div className="docs-feature-icon" style={{ background: 'rgba(99, 102, 241, 0.15)', color: '#6366f1' }}>S</div>
          <h4>Bidirectional Sync</h4>
        </div>
        <p>
          Keep data in sync between two systems. Detect changes and propagate updates.
        </p>
        <div className="docs-diagram-box">
          <pre>{`
  System A                  QuoxCORE                   System B
  --------                  -------                   --------
     |                         |                         |
     |--- Changed record ----->|                         |
     |                         |--- Transform data ----->|
     |                         |<-- Confirm update ------|
     |                         |                         |
     |<------------------------|--- Update log -------->|
          `}</pre>
        </div>
        <p>
          <strong>Use cases:</strong> CRM sync, inventory management, cross-platform updates
        </p>
      </div>

      <h3 id="pattern-approval">Approval Workflows</h3>
      <div className="docs-feature">
        <div className="docs-feature-header">
          <div className="docs-feature-icon" style={{ background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b' }}>A</div>
          <h4>Human-in-the-Loop</h4>
        </div>
        <p>
          Pause workflows for human approval before proceeding with sensitive actions.
        </p>
        <div className="docs-code">
          <div className="docs-code-header">Approval Node</div>
          <pre>{`{
  "node": "approval",
  "config": {
    "title": "Approve Production Deployment",
    "description": "Deploy version {{version}} to production?",
    "inbox": "ops-team",
    "timeout": "2 hours",
    "escalate_to": "manager-inbox",
    "require_comment": true
  }
}`}</pre>
        </div>
        <p>
          <strong>Use cases:</strong> Deployment gates, expense approvals, content review
        </p>
      </div>

      <h3 id="pattern-ai">AI-Powered Automation</h3>
      <div className="docs-feature">
        <div className="docs-feature-header">
          <div className="docs-feature-icon" style={{ background: 'rgba(236, 72, 153, 0.15)', color: '#ec4899' }}>AI</div>
          <h4>Intelligent Processing</h4>
        </div>
        <p>
          Use AI to analyze, categorize, summarize, or generate content as part of your workflows.
        </p>
        <div className="docs-code">
          <div className="docs-code-header">AI Analysis Node</div>
          <pre>{`{
  "node": "ai-agent",
  "config": {
    "model": "claude-3-sonnet",
    "prompt": "Analyze this support ticket and return:
               1. Category (bug, feature, question, complaint)
               2. Priority (low, medium, high, urgent)
               3. Suggested response draft",
    "input": "{{ticket.body}}",
    "output_format": "json"
  }
}`}</pre>
        </div>
        <p>
          <strong>Use cases:</strong> Email triage, log analysis, content generation, anomaly detection
        </p>
      </div>

      {/* Workflow Library */}
      <h2 id="workflow-library">Workflow Library</h2>
      <p>
        Don't start from scratch! QuoxCORE includes 1,340+ pre-built workflow templates that you
        can use as-is or customize for your needs.
      </p>

      <div className="docs-grid docs-grid-3">
        <div className="docs-card">
          <h4>AI & LLM</h4>
          <p className="docs-stat-value" style={{ fontSize: '24px', marginBottom: '8px' }}>115</p>
          <p>AI assistants, RAG pipelines, content generation</p>
        </div>
        <div className="docs-card">
          <h4>Communication</h4>
          <p className="docs-stat-value" style={{ fontSize: '24px', marginBottom: '8px' }}>61</p>
          <p>Slack, Email, Discord, Telegram, WhatsApp</p>
        </div>
        <div className="docs-card">
          <h4>Productivity</h4>
          <p className="docs-stat-value" style={{ fontSize: '24px', marginBottom: '8px' }}>24</p>
          <p>Google Sheets, Notion, task management</p>
        </div>
        <div className="docs-card">
          <h4>Data Processing</h4>
          <p className="docs-stat-value" style={{ fontSize: '24px', marginBottom: '8px' }}>19</p>
          <p>ETL, transformation, PDF processing</p>
        </div>
        <div className="docs-card">
          <h4>Integration</h4>
          <p className="docs-stat-value" style={{ fontSize: '24px', marginBottom: '8px' }}>11</p>
          <p>API connectors, webhooks, sync</p>
        </div>
        <div className="docs-card">
          <h4>And More...</h4>
          <p className="docs-stat-value" style={{ fontSize: '24px', marginBottom: '8px' }}>1,100+</p>
          <p>Automation, monitoring, DevOps</p>
        </div>
      </div>

      <div className="docs-callout">
        <div className="docs-callout-icon">i</div>
        <div className="docs-callout-content">
          <strong>Browse the Full Library</strong>
          <p>
            Search by integration, category, or keyword. Preview workflows, view diagrams,
            and deploy with one click.
          </p>
        </div>
      </div>

      <p>
        <Link to="/workflow-library" className="docs-link">Browse the Workflow Library</Link> |{' '}
        <Link to="/workflow-builder" className="docs-link">Build a Custom Workflow</Link>
      </p>

      {/* n8n Integration */}
      <h2 id="n8n-integration">n8n Integration</h2>
      <p>
        Under the hood, QuoxCORE uses <a href="https://n8n.io" target="_blank" rel="noopener noreferrer" className="docs-link">n8n</a> as
        its workflow execution engine. This gives you access to:
      </p>

      <ul>
        <li><strong>500+ Native Integrations:</strong> Connect to popular services without writing code</li>
        <li><strong>Custom Code Nodes:</strong> Write JavaScript or Python when needed</li>
        <li><strong>Webhook Triggers:</strong> Receive data from any external service</li>
        <li><strong>Scheduled Execution:</strong> Cron-based scheduling with timezone support</li>
        <li><strong>Error Handling:</strong> Automatic retries, fallbacks, and error notifications</li>
        <li><strong>Execution History:</strong> Full logs for debugging and auditing</li>
      </ul>

      <div className="docs-callout docs-callout-important">
        <div className="docs-callout-icon">!</div>
        <div className="docs-callout-content">
          <strong>Natural Language Interface</strong>
          <p>
            While n8n provides the power, QuoxCORE adds natural language creation. You don't need
            to learn n8n's visual editor - just describe what you want and QuoxCORE builds it.
          </p>
        </div>
      </div>

      <h3>Direct n8n Access</h3>
      <p>
        For complex workflows, you can access the n8n visual editor directly:
      </p>
      <div className="docs-code">
        <div className="docs-code-header">n8n Dashboard</div>
        <pre>{`URL: http://your-quox-host:5678
User: admin
Note: Workflows created in n8n are automatically indexed by QuoxCORE`}</pre>
      </div>

      {/* Best Practices */}
      <h2 id="best-practices">Best Practices</h2>

      <div className="docs-feature-list">
        <div className="docs-feature">
          <h4>Start Simple, Then Expand</h4>
          <p>
            Begin with a minimal workflow that solves one problem. Once it's working reliably,
            add more features. A complex workflow that fails is worse than a simple one that works.
          </p>
        </div>

        <div className="docs-feature">
          <h4>Test Before Deploying</h4>
          <p>
            Always run manual tests before enabling scheduled triggers. Test both success and
            failure paths. Use the workflow history to debug issues.
          </p>
        </div>

        <div className="docs-feature">
          <h4>Use Human-in-the-Loop for Risky Actions</h4>
          <p>
            Any action that modifies production systems, sends external communications, or
            involves money should have an approval step. Better safe than sorry.
          </p>
        </div>

        <div className="docs-feature">
          <h4>Monitor Your Workflows</h4>
          <p>
            Set up alerts for workflow failures. Check execution history regularly.
            A workflow that silently fails is worse than no workflow at all.
          </p>
        </div>

        <div className="docs-feature">
          <h4>Document Your Workflows</h4>
          <p>
            Give workflows descriptive names. Add comments explaining why, not just what.
            Future you (or your teammates) will thank you.
          </p>
        </div>
      </div>

      {/* Next Steps */}
      <div className="docs-callout">
        <div className="docs-callout-icon">i</div>
        <div className="docs-callout-content">
          <strong>Ready to Build?</strong>
          <p>
            Start with the <Link to="/workflow-library">Workflow Library</Link> to find a template,
            or jump into the <Link to="/workflow-builder">Workflow Builder</Link> to create something new.
          </p>
        </div>
      </div>

      <p style={{ marginTop: '2rem', color: 'rgba(255, 255, 255, 0.5)', fontSize: '0.875rem' }}>
        <em>
          See also: <Link to="/docs/inbox">HITL & Inbox</Link> for approval workflows |{' '}
          <Link to="/docs/agents">AI Agents</Link> for agent-powered automation |{' '}
          <Link to="/docs/architecture">Architecture</Link> for system overview
        </em>
      </p>
    </section>
  )
}
