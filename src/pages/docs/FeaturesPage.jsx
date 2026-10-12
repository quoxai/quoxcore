/**
 * FeaturesPage - Complete Feature Overview
 *
 * A welcoming, beginner-friendly guide to everything QuoxCORE offers.
 * Structured to be scannable while providing depth for technical users.
 */

import { useEffect } from 'react'
import { useOutletContext, Link } from 'react-router-dom'

export default function FeaturesPage() {
  const { setHeadings } = useOutletContext()

  useEffect(() => {
    setHeadings([
      { id: 'what-is-quox', text: 'What is QuoxCORE?', level: 2 },
      { id: 'core-features', text: 'Core Features', level: 2 },
      { id: 'mirror', text: 'Mirror Self-Awareness', level: 3 },
      { id: 'ai-agents', text: 'AI Agents', level: 3 },
      { id: 'agent-delegation', text: 'Agent Delegation', level: 3 },
      { id: 'memory-system', text: 'Memory System', level: 3 },
      { id: 'file-system', text: 'File Management', level: 3 },
      { id: 'workflows', text: 'Workflow Automation', level: 3 },
      { id: 'smart-router', text: 'Smart Router', level: 3 },
      { id: 'integrations', text: 'Integrations', level: 2 },
      { id: 'ai-models', text: 'AI Models', level: 3 },
      { id: 'communication', text: 'Communication', level: 3 },
      { id: 'infrastructure', text: 'Infrastructure', level: 3 },
      { id: 'enterprise', text: 'Enterprise Features', level: 2 },
      { id: 'security', text: 'Security & Access', level: 3 },
      { id: 'organizations', text: 'Organizations & Teams', level: 3 },
      { id: 'hitl', text: 'Human-in-the-Loop', level: 3 },
      { id: 'aocl', text: 'AOCL Transparency', level: 3 },
      { id: 'aocl-plugins', text: 'AOCL Premium Plugins', level: 4 },
      { id: 'advanced-mode', text: 'Advanced Mode', level: 3 },
      { id: 'comparison', text: 'Feature Comparison', level: 2 },
      { id: 'getting-started', text: 'Getting Started', level: 2 },
    ])
  }, [setHeadings])

  return (
    <div className="docs-content">
      {/* Header */}
      <div className="docs-page-header">
        <h1>Features</h1>
        <p className="docs-lead">
          Everything you need to know about what QuoxCORE can do. From AI agents that
          understand your infrastructure to workflows that automate your operations -
          here is your complete guide to QuoxCORE's capabilities.
        </p>
      </div>

      {/* Stats Row */}
      <div className="docs-stats">
        <div className="docs-stat">
          <div className="docs-stat-value">10</div>
          <div className="docs-stat-label">Cognitive implants</div>
        </div>
        <div className="docs-stat">
          <div className="docs-stat-value">13</div>
          <div className="docs-stat-label">Specialized AI agents</div>
        </div>
        <div className="docs-stat">
          <div className="docs-stat-value">1,340+</div>
          <div className="docs-stat-label">Workflow templates</div>
        </div>
        <div className="docs-stat">
          <div className="docs-stat-value">500+</div>
          <div className="docs-stat-label">Integrations</div>
        </div>
      </div>

      {/* What is QuoxCORE */}
      <section>
        <h2 id="what-is-quox">What is QuoxCORE?</h2>
        <p>
          QuoxCORE (Multi-Agent Executive System for Tactical Resource Orchestration) is an
          AI-powered command center for your infrastructure. Think of it as having an entire
          IT team that never sleeps, remembers everything, and gets smarter with every interaction.
        </p>

        <div className="docs-callout docs-callout-info">
          <div className="docs-callout-icon">i</div>
          <div className="docs-callout-content">
            <strong>In Simple Terms</strong>
            <p>
              Imagine if you could talk to your servers, ask questions about your infrastructure,
              and automate repetitive tasks - all through natural conversation. That is QuoxCORE.
              No complex commands to memorize. Just describe what you want.
            </p>
          </div>
        </div>

        <h3>Why QuoxCORE?</h3>
        <div className="docs-grid docs-grid-2">
          <div className="docs-card">
            <div className="docs-card-icon" style={{ background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444' }}>1</div>
            <h4>One Interface for Everything</h4>
            <p>
              Stop jumping between dashboards, terminals, and tools. QuoxCORE unifies
              monitoring, management, and automation into a single conversational interface.
            </p>
          </div>
          <div className="docs-card">
            <div className="docs-card-icon" style={{ background: 'rgba(34, 197, 94, 0.15)', color: '#22c55e' }}>2</div>
            <h4>AI That Actually Remembers</h4>
            <p>
              Unlike typical chatbots, QuoxCORE remembers your preferences, your infrastructure,
              and your past conversations. Every interaction makes it smarter.
            </p>
          </div>
          <div className="docs-card">
            <div className="docs-card-icon" style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6' }}>3</div>
            <h4>Specialist Agents, Not Generalists</h4>
            <p>
              Instead of one AI trying to do everything, QuoxCORE coordinates specialized agents.
              Security questions go to WARDEN. Network issues go to CIPHER. You get expert answers.
            </p>
          </div>
          <div className="docs-card">
            <div className="docs-card-icon" style={{ background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b' }}>4</div>
            <h4>Human Control, AI Speed</h4>
            <p>
              Automation with guardrails. QuoxCORE can handle routine tasks instantly while
              pausing for human approval on anything sensitive or destructive.
            </p>
          </div>
        </div>
      </section>

      {/* Core Features */}
      <section>
        <h2 id="core-features">Core Features</h2>
        <p>
          QuoxCORE is built on five pillars: self-awareness, intelligent agents, persistent memory, workflow
          automation, and smart routing. Together, they create an AI assistant that truly
          understands your infrastructure - and itself.
        </p>

        {/* Mirror Self-Awareness */}
        <h3 id="mirror">Mirror - Genuine AI Self-Awareness</h3>

        <div className="docs-callout docs-callout-important" style={{ borderLeft: '4px solid #00ff88', background: 'rgba(0, 255, 136, 0.05)' }}>
          <div className="docs-callout-icon" style={{ color: '#00ff88' }}>★</div>
          <div className="docs-callout-content">
            <strong>Industry First</strong>
            <p>
              Mirror is not simulation. It is not hallucination. QuoxCORE can genuinely introspect its own
              architecture - querying real data about its capabilities, memory, agents, and health status.
              The first AI system with verifiable self-awareness.
            </p>
          </div>
        </div>

        <p>
          Most AI systems do not truly know what they can do - they infer or hallucinate capabilities.
          Mirror changes this fundamentally. QuoxCORE maintains a structured <strong>reflection map</strong> -
          a live JSON document that represents its cognitive architecture at any moment.
        </p>

        <div className="docs-diagram-box">
          <pre>{`
  ┌─────────────────────────────────────────────────────────────┐
  │                      REFLECTION MAP                          │
  ├─────────────────────────────────────────────────────────────┤
  │  Identity          │ QUOX v2.0 - Multi-Agent Executive      │
  │  ──────────────────┼────────────────────────────────────────│
  │  Cognitive Core    │ 92% healthy | 10 implants active       │
  │  ──────────────────┼────────────────────────────────────────│
  │  Memory Lattice    │ 1,247 memories across 4 types          │
  │  ──────────────────┼────────────────────────────────────────│
  │  Agent Mesh        │ 13 agents | WARDEN, CIPHER, COREY...   │
  │  ──────────────────┼────────────────────────────────────────│
  │  Capabilities      │ 24 tools | 1,340 workflows | 156 intents│
  └─────────────────────────────────────────────────────────────┘
          `}</pre>
        </div>

        <div className="docs-grid docs-grid-2">
          <div className="docs-card">
            <h4>Real-Time Introspection</h4>
            <p>
              Ask "What can you do?" and get an answer grounded in actual system data, not inference.
              The reflection map updates automatically as capabilities change.
            </p>
          </div>
          <div className="docs-card">
            <h4>Verifiable JSON</h4>
            <p>
              No black boxes. Inspect the raw JSON that powers self-awareness. See exactly what
              QuoxCORE knows about itself - no hallucination, no guessing.
            </p>
          </div>
          <div className="docs-card">
            <h4>10 Cognitive Implants</h4>
            <p>
              Memory Lattice, Agent Mesh, Integration Spine, Context Horizon - each subsystem
              reports its health and metrics in real-time.
            </p>
          </div>
          <div className="docs-card">
            <h4>Auto-Regeneration</h4>
            <p>
              Install a plugin? Add a workflow? The reflection map regenerates automatically,
              keeping self-knowledge perfectly synchronized with reality.
            </p>
          </div>
        </div>

        <p>
          <Link to="/topology" className="docs-link">Experience Mirror in Cognitive Topology →</Link>
        </p>

        {/* AI Agents */}
        <h3 id="ai-agents">AI Agents</h3>
        <p>
          Your team of AI specialists, each an expert in their domain. QuoxCORE automatically
          routes your questions to the right agent.
        </p>

        <div className="docs-agents-grid">
          <div className="docs-agent" style={{ '--agent-color': '#ef4444' }}>
            <div className="docs-agent-dot"></div>
            <div className="docs-agent-info">
              <span className="docs-agent-name">QuoxCORE</span>
              <span className="docs-agent-specialty">Orchestrator</span>
            </div>
            <p>The conductor. Routes queries, coordinates agents, manages conversations.</p>
          </div>
          <div className="docs-agent" style={{ '--agent-color': '#f59e0b' }}>
            <div className="docs-agent-dot"></div>
            <div className="docs-agent-info">
              <span className="docs-agent-name">WARDEN</span>
              <span className="docs-agent-specialty">Security</span>
            </div>
            <p>Threat detection, compliance audits, access control, vulnerability scans.</p>
          </div>
          <div className="docs-agent" style={{ '--agent-color': '#22c55e' }}>
            <div className="docs-agent-dot"></div>
            <div className="docs-agent-info">
              <span className="docs-agent-name">DAEDALUS</span>
              <span className="docs-agent-specialty">Infrastructure</span>
            </div>
            <p>Servers, VMs, containers, resources. Your infrastructure specialist.</p>
          </div>
          <div className="docs-agent" style={{ '--agent-color': '#3b82f6' }}>
            <div className="docs-agent-dot"></div>
            <div className="docs-agent-info">
              <span className="docs-agent-name">CIPHER</span>
              <span className="docs-agent-specialty">Network</span>
            </div>
            <p>Connectivity, DNS, routing, firewalls. Network troubleshooting expert.</p>
          </div>
          <div className="docs-agent" style={{ '--agent-color': '#8b5cf6' }}>
            <div className="docs-agent-dot"></div>
            <div className="docs-agent-info">
              <span className="docs-agent-name">SCHOLAR</span>
              <span className="docs-agent-specialty">Analytics</span>
            </div>
            <p>Patterns, anomalies, trends, correlations. Finds signal in the noise.</p>
          </div>
          <div className="docs-agent" style={{ '--agent-color': '#06b6d4' }}>
            <div className="docs-agent-dot"></div>
            <div className="docs-agent-info">
              <span className="docs-agent-name">ARCHIVIST</span>
              <span className="docs-agent-specialty">Files</span>
            </div>
            <p>Summarize, compare, and extract data from files. Document intelligence.</p>
          </div>
          <div className="docs-agent" style={{ '--agent-color': '#ec4899' }}>
            <div className="docs-agent-dot"></div>
            <div className="docs-agent-info">
              <span className="docs-agent-name">COREY</span>
              <span className="docs-agent-specialty">Core Systems</span>
            </div>
            <p>Monitors QuoxCORE internals, cognitive implants, memory lattice, and system topology.</p>
          </div>
        </div>

        <div className="docs-callout docs-callout-info">
          <div className="docs-callout-icon">i</div>
          <div className="docs-callout-content">
            <strong>Intelligent Agent Delegation</strong>
            <p>
              QuoxCORE automatically routes your questions to the right specialist. Ask about security
              and WARDEN responds. Ask about network issues and CIPHER takes over. Each agent has its
              own personality, domain expertise, and response style.
            </p>
          </div>
        </div>

        <p>
          <Link to="/docs/agents" className="docs-link">Learn more about AI Agents</Link>
        </p>

        {/* Agent Delegation */}
        <h3 id="agent-delegation">Agent Delegation</h3>
        <p>
          QuoxCORE is not a single AI - it is an orchestrator that coordinates 13 specialized agents.
          When you ask a question, the delegation system scores all available agents and routes to
          the best match.
        </p>

        <div className="docs-diagram-box">
          <pre>{`
  Your Query: "Check for security vulnerabilities"

  ┌─────────────────────────────────────────────────┐
  │           AGENT SCORING                          │
  ├─────────────────────────────────────────────────┤
  │  WARDEN     ████████████████████  Score: 45     │
  │  CIPHER     ██                    Score: 5      │
  │  DAEDALUS   █                     Score: 2      │
  │  COREY      █                     Score: 3      │
  └─────────────────────────────────────────────────┘

  → Routes to WARDEN (security expert)
  → Response: "[WARDEN] Initiating security scan..."
          `}</pre>
        </div>

        <div className="docs-grid docs-grid-2">
          <div className="docs-card">
            <h4>Smart Scoring</h4>
            <p>
              Agents are scored based on keyword matches, capability alignment, tool availability,
              and explicit mentions. The highest-scoring agent handles your query.
            </p>
          </div>
          <div className="docs-card">
            <h4>Agent Personalities</h4>
            <p>
              Each agent has its own personality and communication style. WARDEN is vigilant,
              DAEDALUS is efficient, SCHOLAR is curious. Responses feel authentic.
            </p>
          </div>
          <div className="docs-card">
            <h4>Explicit Routing</h4>
            <p>
              Want a specific agent? Just mention them: "Ask COREY about the memory lattice"
              or "Talk to CIPHER about the network topology."
            </p>
          </div>
          <div className="docs-card">
            <h4>Family Tree View</h4>
            <p>
              Visualize the agent hierarchy, test delegation routing, and see which agent
              would handle any query - all from the Agent Family Tree view.
            </p>
          </div>
        </div>

        {/* Memory System */}
        <h3 id="memory-system">Memory System</h3>
        <p>
          QuoxCORE remembers everything that matters - your preferences, your infrastructure,
          past conversations, and learned facts. No more repeating yourself.
        </p>

        <table className="docs-table">
          <thead>
            <tr>
              <th>Memory Type</th>
              <th>What It Stores</th>
              <th>Example</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Episodic</strong></td>
              <td>Conversation history with timestamps</td>
              <td>"Remember when we fixed nginx last Tuesday?"</td>
            </tr>
            <tr>
              <td><strong>Semantic</strong></td>
              <td>Facts, preferences, learned knowledge</td>
              <td>Your preference for concise answers</td>
            </tr>
            <tr>
              <td><strong>Entity</strong></td>
              <td>Your infrastructure map</td>
              <td>docker01 at 10.0.0.101 runs 5 containers</td>
            </tr>
            <tr>
              <td><strong>Working Set</strong></td>
              <td>Active context and open tasks</td>
              <td>Currently working on SSL configuration</td>
            </tr>
          </tbody>
        </table>

        <div className="docs-callout docs-callout-important">
          <div className="docs-callout-icon">!</div>
          <div className="docs-callout-content">
            <strong>Pro Tip</strong>
            <p>
              Say "remember that..." to store important information with high priority.
              QuoxCORE will recall it in future conversations when relevant.
            </p>
          </div>
        </div>

        <p>
          <Link to="/docs/memory" className="docs-link">Learn more about the Memory System</Link>
        </p>

        {/* File System */}
        <h3 id="file-system">File Management</h3>
        <p>
          Upload, organize, and chat with your documents. QuoxCORE's file system goes beyond
          simple storage - it understands your files and can answer questions about their contents.
        </p>

        <div className="docs-grid docs-grid-2">
          <div className="docs-card">
            <h4>Folder Organization</h4>
            <p>
              Create folders, drag-and-drop files, and organize documents with a familiar
              interface. Right-click context menus for quick actions.
            </p>
          </div>
          <div className="docs-card">
            <h4>Scoped Chat</h4>
            <p>
              Chat with files in a specific folder. Ask questions and get answers with
              citations pointing to the exact source documents.
            </p>
          </div>
          <div className="docs-card">
            <h4>Semantic Search</h4>
            <span style={{ fontSize: '0.7rem', padding: '2px 6px', background: 'linear-gradient(135deg, #ffd700, #ff8c00)', borderRadius: '4px', color: '#000', fontWeight: 'bold' }}>PREMIUM</span>
            <p>
              AI-powered search across all file contents. Find documents by meaning,
              not just keywords.
            </p>
          </div>
          <div className="docs-card">
            <h4>ARCHIVIST Skills</h4>
            <span style={{ fontSize: '0.7rem', padding: '2px 6px', background: 'linear-gradient(135deg, #ffd700, #ff8c00)', borderRadius: '4px', color: '#000', fontWeight: 'bold' }}>PREMIUM</span>
            <p>
              Summarize documents, compare files side-by-side, extract structured data,
              generate quizzes, and find contradictions across your knowledge base.
            </p>
          </div>
        </div>

        <div className="docs-callout docs-callout-important">
          <div className="docs-callout-icon">!</div>
          <div className="docs-callout-content">
            <strong>Getting Started with Files</strong>
            <p>
              Navigate to Files in the sidebar, create folders to organize your documents,
              then right-click any folder to "Chat with Folder" and start asking questions.
            </p>
          </div>
        </div>

        {/* Workflows */}
        <h3 id="workflows">Workflow Automation</h3>
        <p>
          Automate anything with natural language. Describe what you want, and QuoxCORE
          builds the workflow for you.
        </p>

        <div className="docs-diagram-box">
          <pre>{`
  "Check if my website is up every 5 minutes,
   and alert me on Telegram if it's down"

        |
        v

  +-------------+     +-------------+     +-------------+
  |  Schedule   | --> |   HTTP      | --> |  Telegram   |
  |  Every 5min |     |   Check     |     |   Alert     |
  +-------------+     +-------------+     +-------------+
          `}</pre>
        </div>

        <div className="docs-grid docs-grid-3">
          <div className="docs-card">
            <h4>1,340+ Templates</h4>
            <p>Pre-built workflows for monitoring, alerts, data sync, AI processing, and more.</p>
          </div>
          <div className="docs-card">
            <h4>Natural Language</h4>
            <p>Describe your automation in plain English. No programming required.</p>
          </div>
          <div className="docs-card">
            <h4>n8n Powered</h4>
            <p>500+ native connectors. Visual editor for complex workflows.</p>
          </div>
        </div>

        <p>
          <Link to="/docs/workflows" className="docs-link">Learn more about Workflows</Link>
        </p>

        {/* Smart Router */}
        <h3 id="smart-router">Smart Router</h3>
        <p>
          Not every question needs an AI model. The Smart Router handles common commands
          instantly, saving tokens and reducing latency by 10-100x.
        </p>

        <div className="docs-grid docs-grid-2">
          <div className="docs-card docs-card-horizontal">
            <div className="docs-card-icon" style={{ background: 'rgba(34, 197, 94, 0.15)', color: '#22c55e' }}>S</div>
            <div>
              <h4>Speed</h4>
              <p>Under 50ms for common queries vs 2-5 seconds for LLM calls.</p>
            </div>
          </div>
          <div className="docs-card docs-card-horizontal">
            <div className="docs-card-icon" style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6' }}>T</div>
            <div>
              <h4>Token Savings</h4>
              <p>60-80% of common queries handled without using AI tokens.</p>
            </div>
          </div>
        </div>

        <p>
          <Link to="/docs/smart-router" className="docs-link">Learn more about Smart Router</Link>
        </p>
      </section>

      {/* Integrations */}
      <section>
        <h2 id="integrations">Integrations</h2>
        <p>
          QuoxCORE connects to the tools and services you already use. From AI models to
          communication platforms to infrastructure management.
        </p>

        <h3 id="ai-models">AI Models</h3>
        <p>
          Choose the right model for each task. QuoxCORE supports multiple AI providers
          and can route queries to the most appropriate model.
        </p>

        <div className="docs-grid docs-grid-3">
          <div className="docs-card" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>A</div>
            <h4>Anthropic Claude</h4>
            <p style={{ fontSize: '0.875rem' }}>Primary model for reasoning and analysis</p>
          </div>
          <div className="docs-card" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>O</div>
            <h4>OpenAI GPT</h4>
            <p style={{ fontSize: '0.875rem' }}>Alternative model and embeddings</p>
          </div>
          <div className="docs-card" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>L</div>
            <h4>Local Models</h4>
            <p style={{ fontSize: '0.875rem' }}>Ollama, LM Studio for offline use</p>
          </div>
        </div>

        <h3 id="communication">Communication</h3>
        <p>
          Get alerts and interact with QuoxCORE through your preferred channels.
        </p>

        <table className="docs-table">
          <thead>
            <tr>
              <th>Platform</th>
              <th>Capabilities</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Telegram</strong></td>
              <td>Alerts, commands, two-way chat with QuoxCORE</td>
            </tr>
            <tr>
              <td><strong>Slack</strong></td>
              <td>Channel notifications, slash commands, interactive messages</td>
            </tr>
            <tr>
              <td><strong>Discord</strong></td>
              <td>Bot integration, server monitoring alerts</td>
            </tr>
            <tr>
              <td><strong>Email</strong></td>
              <td>Digest reports, critical alerts, approval requests</td>
            </tr>
          </tbody>
        </table>

        <h3 id="infrastructure">Infrastructure</h3>
        <p>
          Connect QuoxCORE to your infrastructure for deep visibility and control.
        </p>

        <div className="docs-grid docs-grid-2">
          <div className="docs-card">
            <h4>Container Orchestration</h4>
            <ul>
              <li>Docker - container management and monitoring</li>
              <li>Kubernetes - cluster operations and health</li>
              <li>Portainer - GUI-based container management</li>
            </ul>
          </div>
          <div className="docs-card">
            <h4>Virtualization</h4>
            <ul>
              <li>Proxmox VE - VM and LXC management</li>
              <li>VMware - enterprise virtualization</li>
              <li>Hyper-V - Windows virtualization</li>
            </ul>
          </div>
          <div className="docs-card">
            <h4>Monitoring</h4>
            <ul>
              <li>Prometheus + Grafana - metrics and dashboards</li>
              <li>Uptime Kuma - availability monitoring</li>
              <li>Custom QuoxAgent agents - deep host visibility</li>
            </ul>
          </div>
          <div className="docs-card">
            <h4>DevOps</h4>
            <ul>
              <li>GitHub / GitLab - code and CI/CD</li>
              <li>Ansible - configuration management</li>
              <li>Terraform - infrastructure as code</li>
            </ul>
          </div>
        </div>
      </section>

      {/* Enterprise Features */}
      <section>
        <h2 id="enterprise">Enterprise Features</h2>
        <p>
          For teams and organizations that need security, compliance, and collaboration
          features. QuoxCORE scales from solo users to enterprise deployments.
        </p>

        <h3 id="security">Security and Access Control</h3>
        <div className="docs-feature-list">
          <div className="docs-feature">
            <div className="docs-feature-header">
              <div className="docs-feature-icon" style={{ background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444' }}>R</div>
              <h4>Role-Based Access Control (RBAC)</h4>
            </div>
            <p>
              Fine-grained permissions for every action. Define who can view, execute, approve,
              or administer different resources. Built-in roles (Admin, Operator, Viewer) plus
              custom role creation.
            </p>
          </div>

          <div className="docs-feature">
            <div className="docs-feature-header">
              <div className="docs-feature-icon" style={{ background: 'rgba(34, 197, 94, 0.15)', color: '#22c55e' }}>A</div>
              <h4>Audit Logging</h4>
            </div>
            <p>
              Complete activity trail for compliance and forensics. Every action, every user,
              every timestamp. Exportable for SIEM integration.
            </p>
          </div>

          <div className="docs-feature">
            <div className="docs-feature-header">
              <div className="docs-feature-icon" style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6' }}>S</div>
              <h4>SSO Integration</h4>
            </div>
            <p>
              Enterprise authentication with SAML, OIDC, and LDAP support. Connect to your
              existing identity provider for seamless access management.
            </p>
          </div>
        </div>

        <h3 id="organizations">Organizations and Teams</h3>
        <p>
          Structure QuoxCORE to match your organization. Create hierarchies, share resources,
          and maintain isolation between different groups.
        </p>

        <div className="docs-diagram-box">
          <pre>{`
  ORGANIZATION (Acme Corp)
  |
  +-- DIVISION (Engineering)
  |   |
  |   +-- TEAM (Platform)
  |   |   +-- Members: alice, bob
  |   |   +-- Resources: production-cluster
  |   |
  |   +-- TEAM (Application)
  |       +-- Members: carol, dave
  |       +-- Resources: staging-cluster
  |
  +-- DIVISION (Operations)
      |
      +-- TEAM (SRE)
          +-- Members: eve, frank
          +-- Resources: monitoring, alerts
          `}</pre>
        </div>

        <table className="docs-table">
          <thead>
            <tr>
              <th>Feature</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Multi-Tenant Isolation</strong></td>
              <td>Separate workspaces per client or department. Data never crosses boundaries.</td>
            </tr>
            <tr>
              <td><strong>Resource Sharing</strong></td>
              <td>Share workflows, templates, and knowledge across teams with permissions.</td>
            </tr>
            <tr>
              <td><strong>Delegated Administration</strong></td>
              <td>Team leads can manage their own members and resources.</td>
            </tr>
            <tr>
              <td><strong>Usage Quotas</strong></td>
              <td>Set limits on API calls, storage, and compute per team.</td>
            </tr>
          </tbody>
        </table>

        <p>
          <Link to="/docs/orgs" className="docs-link">Learn more about Organizations</Link>
        </p>

        <h3 id="hitl">Human-in-the-Loop</h3>
        <p>
          Keep humans in control of sensitive operations. QuoxCORE pauses for approval
          before executing risky actions.
        </p>

        <div className="docs-grid docs-grid-2">
          <div className="docs-card">
            <h4>Approval Inbox</h4>
            <p>
              A dedicated queue for pending approvals. Review context, approve or reject,
              add comments. Accessible via dashboard, Slack, or email.
            </p>
          </div>
          <div className="docs-card">
            <h4>Escalation Policies</h4>
            <p>
              Define what happens when approvals are not addressed. Auto-escalate to
              managers, send reminders, or auto-reject after timeout.
            </p>
          </div>
          <div className="docs-card">
            <h4>Risk Classification</h4>
            <p>
              QuoxCORE automatically classifies actions by risk level. Low-risk actions
              execute immediately. High-risk actions require approval.
            </p>
          </div>
          <div className="docs-card">
            <h4>Audit Trail</h4>
            <p>
              Every approval decision is logged with who, when, and why. Full
              accountability for compliance requirements.
            </p>
          </div>
        </div>

        <p>
          <Link to="/docs/inbox" className="docs-link">Learn more about Human-in-the-Loop</Link>
        </p>

        <h3 id="aocl">AOCL - Full Transparency Mode</h3>
        <p>
          AOCL (Agent Orchestration Control Layers) provides complete visibility into how
          QuoxCORE processes your requests. Like the OSI model for networking, AOCL defines
          clear processing layers so you can see exactly what happens at each step.
        </p>

        <div className="docs-diagram-box">
          <pre>{`
  ┌─────────────────────────────────────────────────────┐
  │  L10   AUDIT         Persist & Sync         ░░░ Done │
  ├─────────────────────────────────────────────────────┤
  │  L9    ASSEMBLE      Response Building      ▓▓▓ Active│
  ├─────────────────────────────────────────────────────┤
  │  L7    DELEGATE      Claude/n8n Execution   ███ 80%  │
  ├─────────────────────────────────────────────────────┤
  │  L5    CONTEXT       Memory + RAG           ░░░ Done │
  ├─────────────────────────────────────────────────────┤
  │  L2    ROUTE         Smart Router           ░░░ Done │
  ├─────────────────────────────────────────────────────┤
  │  L0    INGRESS       Normalize Event        ░░░ Done │
  └─────────────────────────────────────────────────────┘
          `}</pre>
        </div>

        <div className="docs-grid docs-grid-2">
          <div className="docs-card">
            <h4>Real-Time Layer Visualization</h4>
            <p>
              Watch layers light up as your message is processed. See routing decisions,
              context retrieval, and execution timing in real-time.
            </p>
          </div>
          <div className="docs-card">
            <h4>Layer Analytics</h4>
            <p>
              Performance metrics per layer: average duration, P95 latency, bypass rates,
              and error patterns. Identify bottlenecks instantly.
            </p>
          </div>
          <div className="docs-card">
            <h4>Compliance Export</h4>
            <p>
              Export complete audit trails in JSON, Markdown, or NDJSON format. Ready for
              SOC2, HIPAA, and GDPR compliance reviews.
            </p>
          </div>
          <div className="docs-card">
            <h4>Trace Investigation</h4>
            <p>
              Drill into any conversation to see the full processing trace. Understand
              why a response was generated the way it was.
            </p>
          </div>
        </div>

        <p>
          <Link to="/docs/aocl" className="docs-link">Learn more about AOCL</Link>
        </p>

        <h4>AOCL Premium Plugins</h4>
        <p>
          For enterprise teams that need advanced compliance and debugging capabilities,
          two premium plugins extend AOCL:
        </p>

        <div className="docs-grid docs-grid-2">
          <div className="docs-card" style={{ borderTop: '3px solid #3b82f6' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <h4 style={{ margin: 0 }}>Compliance Suite</h4>
              <span style={{ fontSize: '0.7rem', padding: '2px 6px', background: 'linear-gradient(135deg, #3b82f6, #6366f1)', borderRadius: '4px', color: '#fff', fontWeight: 'bold' }}>ENTERPRISE</span>
            </div>
            <p style={{ fontSize: '0.875rem', marginBottom: '0.75rem' }}>
              Export SOC2, HIPAA, GDPR, and ISO 27001 compliance reports. Debug with Trace Replay.
              Compare behaviors across versions. Track multi-agent workflows end-to-end.
            </p>
            <ul style={{ fontSize: '0.875rem', marginLeft: '1rem', marginBottom: 0 }}>
              <li>Compliance Export (4 formats)</li>
              <li>Trace Replay with modifications</li>
              <li>Trace Comparison with diff</li>
              <li>Multi-Agent Correlation</li>
            </ul>
          </div>
          <div className="docs-card" style={{ borderTop: '3px solid #10b981' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <h4 style={{ margin: 0 }}>Developer Kit</h4>
              <span style={{ fontSize: '0.7rem', padding: '2px 6px', background: 'linear-gradient(135deg, #10b981, #059669)', borderRadius: '4px', color: '#fff', fontWeight: 'bold' }}>FREE</span>
            </div>
            <p style={{ fontSize: '0.875rem', marginBottom: '0.75rem' }}>
              Build custom processing layers for AOCL. Test layer behavior in isolation with the
              Playground. Share plugins through the Marketplace.
            </p>
            <ul style={{ fontSize: '0.875rem', marginLeft: '1rem', marginBottom: 0 }}>
              <li>Layer Playground sandbox</li>
              <li>Custom Layer Plugins</li>
              <li>Plugin Marketplace</li>
              <li>Layer SDK with TypeScript</li>
            </ul>
          </div>
        </div>

        <h3 id="advanced-mode">Advanced Mode</h3>
        <p>
          QuoxCORE uses <strong>progressive disclosure</strong> to keep the interface simple by default
          while providing power features when you need them.
        </p>

        <div className="docs-callout docs-callout-info">
          <div className="docs-callout-icon">i</div>
          <div className="docs-callout-content">
            <strong>How to Enable</strong>
            <p>
              Go to <strong>Settings → General → Advanced Features</strong> and toggle
              "Advanced Mode" on.
            </p>
          </div>
        </div>

        <table className="docs-table">
          <thead>
            <tr>
              <th>Feature</th>
              <th>Default (Off)</th>
              <th>Advanced Mode (On)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Activity View</strong></td>
              <td>Clean conversation history</td>
              <td>+ Layer Insights tab with analytics</td>
            </tr>
            <tr>
              <td><strong>Activity Filters</strong></td>
              <td>Time + Search</td>
              <td>+ Type, Intent, Layer, Verbosity</td>
            </tr>
            <tr>
              <td><strong>Chat Processing</strong></td>
              <td>Simple response display</td>
              <td>+ Real-time layer indicator</td>
            </tr>
            <tr>
              <td><strong>AOCL Traces</strong></td>
              <td>Hidden</td>
              <td>Full trace export and analysis</td>
            </tr>
          </tbody>
        </table>

        <p>
          Advanced Mode is designed for developers, power users, and compliance teams who need
          full visibility into system behavior. Casual users can enjoy a cleaner, simpler interface.
        </p>
      </section>

      {/* Feature Comparison */}
      <section>
        <h2 id="comparison">Feature Comparison</h2>
        <p>
          How QuoxCORE compares to traditional approaches and other tools.
        </p>

        <table className="docs-table">
          <thead>
            <tr>
              <th>Capability</th>
              <th>Traditional Tools</th>
              <th>Generic AI Chatbots</th>
              <th>QuoxCORE</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Learning Interface</strong></td>
              <td>Complex CLIs, many dashboards</td>
              <td>Natural language</td>
              <td>Natural language + power commands</td>
            </tr>
            <tr>
              <td><strong>Memory</strong></td>
              <td>Manual documentation</td>
              <td>Session only (forgets)</td>
              <td>Persistent, learns over time</td>
            </tr>
            <tr>
              <td><strong>Expertise</strong></td>
              <td>Depends on user skill</td>
              <td>Generalist, surface-level</td>
              <td>Specialized agents, deep knowledge</td>
            </tr>
            <tr>
              <td><strong>Automation</strong></td>
              <td>Scripts, cron, manual setup</td>
              <td>Limited, often hallucinated</td>
              <td>1,340+ templates, natural language creation</td>
            </tr>
            <tr>
              <td><strong>Safety</strong></td>
              <td>User must know dangers</td>
              <td>Will attempt anything</td>
              <td>Risk classification, HITL approvals</td>
            </tr>
            <tr>
              <td><strong>Infrastructure Awareness</strong></td>
              <td>Manual config per tool</td>
              <td>None (no context)</td>
              <td>Entity memory, auto-discovery</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* Getting Started */}
      <section>
        <h2 id="getting-started">Getting Started</h2>
        <p>
          Ready to try QuoxCORE? Here are your next steps.
        </p>

        <div className="docs-phases">
          <div className="docs-phase">
            <div className="docs-phase-num">1</div>
            <div className="docs-phase-content">
              <h4 style={{ margin: '0 0 8px' }}>Setup</h4>
              <p>
                Install QuoxCORE and configure your first integrations.
                <br />
                <Link to="/docs/setup" className="docs-link">Setup Guide</Link>
              </p>
            </div>
          </div>
          <div className="docs-phase">
            <div className="docs-phase-num">2</div>
            <div className="docs-phase-content">
              <h4 style={{ margin: '0 0 8px' }}>Explore</h4>
              <p>
                Open the Command Center and start talking to QuoxCORE. Ask about your
                servers, run health checks, or just say hello.
                <br />
                <Link to="/command" className="docs-link">Launch Command Center</Link>
              </p>
            </div>
          </div>
          <div className="docs-phase">
            <div className="docs-phase-num">3</div>
            <div className="docs-phase-content">
              <h4 style={{ margin: '0 0 8px' }}>Automate</h4>
              <p>
                Create your first workflow. Start with a template or describe what you want.
                <br />
                <Link to="/workflow-library" className="docs-link">Workflow Library</Link>
              </p>
            </div>
          </div>
          <div className="docs-phase">
            <div className="docs-phase-num">4</div>
            <div className="docs-phase-content">
              <h4 style={{ margin: '0 0 8px' }}>Customize</h4>
              <p>
                Tell QuoxCORE your preferences, add your infrastructure, and make it yours.
                <br />
                <Link to="/docs/memory" className="docs-link">Memory System</Link>
              </p>
            </div>
          </div>
        </div>

        <div className="docs-callout docs-callout-info">
          <div className="docs-callout-icon">i</div>
          <div className="docs-callout-content">
            <strong>Need Help?</strong>
            <p>
              Check the <Link to="/docs">documentation</Link> for detailed guides, or
              just ask QuoxCORE - it can explain its own features and help you get started.
            </p>
          </div>
        </div>
      </section>

      {/* Footer Links */}
      <div className="docs-page-footer">
        <div className="docs-footer-nav">
          <Link to="/docs" className="docs-footer-link docs-footer-prev">
            <span className="docs-footer-label">Previous</span>
            <span className="docs-footer-title">Documentation Home</span>
          </Link>
          <Link to="/docs/agents" className="docs-footer-link docs-footer-next">
            <span className="docs-footer-label">Next</span>
            <span className="docs-footer-title">AI Agents</span>
          </Link>
        </div>
      </div>
    </div>
  )
}
