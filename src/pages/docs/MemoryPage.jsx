import { useEffect } from 'react'
import { useOutletContext, Link } from 'react-router-dom'

/**
 * Memory System Documentation Page
 *
 * Comprehensive, beginner-friendly documentation for QuoxCORE's Memory System.
 * Explains all memory types with analogies, visual diagrams, and practical examples.
 */
export default function MemoryPage() {
  const { setHeadings } = useOutletContext()

  useEffect(() => {
    setHeadings([
      { id: 'why-memory-matters', text: 'Why Memory Matters', level: 2 },
      { id: 'memory-types', text: 'Memory Types', level: 2 },
      { id: 'episodic-memory', text: 'Episodic Memory', level: 3 },
      { id: 'semantic-memory', text: 'Semantic Memory', level: 3 },
      { id: 'entity-memory', text: 'Entity Memory', level: 3 },
      { id: 'working-set-memory', text: 'Working Set Memory', level: 3 },
      { id: 'how-memory-works', text: 'How Memory Works', level: 2 },
      { id: 'memory-flow', text: 'Memory Flow', level: 3 },
      { id: 'hybrid-search', text: 'Hybrid Search', level: 3 },
      { id: 'using-memory', text: 'Using Memory', level: 2 },
      { id: 'natural-language', text: 'Natural Language Commands', level: 3 },
      { id: 'api-reference', text: 'API Reference', level: 3 },
      { id: 'advanced-features', text: 'Advanced Features', level: 2 },
      { id: 'provenance-tracking', text: 'Provenance Tracking', level: 3 },
      { id: 'conflict-detection', text: 'Conflict Detection', level: 3 },
      { id: 'style-learning', text: 'Style Learning', level: 3 },
      { id: 'enterprise', text: 'Enterprise & Compliance', level: 2 },
    ])
  }, [setHeadings])

  return (
    <div className="docs-content">
      {/* Header */}
      <div className="docs-page-header">
        <h1>Memory System</h1>
        <p className="docs-lead">
          Give your AI a brain. QuoxCORE remembers your conversations, learns your preferences,
          and builds knowledge about your infrastructure - so every interaction gets smarter.
        </p>
      </div>

      {/* The Brain Analogy Introduction */}
      <section>
        <h2 id="why-memory-matters">Why Memory Matters</h2>

        <p>
          Imagine having an assistant who forgets everything the moment you leave the room.
          Every conversation starts from scratch. You repeat your preferences. You re-explain
          your infrastructure. You remind them of decisions you made together yesterday.
        </p>

        <p>
          <strong>That is AI without memory.</strong> And it is frustrating.
        </p>

        <p>
          QuoxCORE's memory system changes everything. Like giving your AI a proper brain, it
          enables QuoxCORE to:
        </p>

        <div className="docs-feature-list">
          <div className="docs-feature" style={{ '--feature-color': '#22c55e' }}>
            <div className="docs-feature-header">
              <div className="docs-feature-icon" style={{ background: 'rgba(34, 197, 94, 0.15)', color: '#22c55e' }}>R</div>
              <h3>Remember Your Preferences</h3>
            </div>
            <p>
              Tell QuoxCORE once that you prefer concise answers, and it will adapt. Mention that
              you use Vim, and it will tailor code examples. Your preferences persist across
              sessions, browsers, and even time.
            </p>
          </div>

          <div className="docs-feature" style={{ '--feature-color': '#3b82f6' }}>
            <div className="docs-feature-header">
              <div className="docs-feature-icon" style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6' }}>K</div>
              <h3>Know Your Infrastructure</h3>
            </div>
            <p>
              Your servers, services, containers, and their relationships are stored as first-class
              knowledge. Ask about "the Docker host" and QuoxCORE knows you mean docker01 at
              10.0.0.101.
            </p>
          </div>

          <div className="docs-feature" style={{ '--feature-color': '#f59e0b' }}>
            <div className="docs-feature-header">
              <div className="docs-feature-icon" style={{ background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b' }}>T</div>
              <h3>Track Your Context</h3>
            </div>
            <p>
              Working on nginx configuration? QuoxCORE keeps that context active. Come back tomorrow
              and ask "where were we?" - it remembers your open tasks, recent decisions, and
              unfinished threads.
            </p>
          </div>

          <div className="docs-feature" style={{ '--feature-color': '#ef4444' }}>
            <div className="docs-feature-header">
              <div className="docs-feature-icon" style={{ background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444' }}>L</div>
              <h3>Learn From Mistakes</h3>
            </div>
            <p>
              If a command caused problems before, QuoxCORE remembers. It learns constraints like
              "never restart nginx during business hours" and proactively warns you when you are
              about to repeat a past mistake.
            </p>
          </div>
        </div>

        <div className="docs-callout docs-callout-info">
          <div className="docs-callout-icon">i</div>
          <div className="docs-callout-content">
            <strong>Think of it like this:</strong>
            <p>
              A traditional chatbot is like talking to someone with amnesia. QuoxCORE's memory
              system is like having a dedicated assistant who takes notes, remembers everything,
              and uses that knowledge to help you better every day.
            </p>
          </div>
        </div>
      </section>

      {/* Memory Types */}
      <section>
        <h2 id="memory-types">Memory Types</h2>
        <p>
          QuoxCORE uses four distinct memory systems that work together, each serving a different
          purpose - just like how your own brain has different types of memory.
        </p>

        {/* Visual diagram */}
        <div className="docs-code-block">
          <pre>{`
    +------------------+     +-------------------+     +------------------+
    |    EPISODIC      |     |     SEMANTIC      |     |      ENTITY      |
    |    (Diary)       |     |    (Knowledge)    |     |   (Relationships)|
    +------------------+     +-------------------+     +------------------+
    |                  |     |                   |     |                  |
    | "Yesterday we    |     | "Adam prefers     |     | docker01         |
    |  fixed nginx"    |     |  concise answers" |     |  - IP: .101      |
    |                  |     |                   |     |  - Services: 5   |
    | "Last week we    |     | "Use Caddy for    |     |  - Related to:   |
    |  set up QuoxAgent"     |     |  SSL certificates"|     |    proxmox01     |
    |                  |     |                   |     |                  |
    +------------------+     +-------------------+     +------------------+
              \\                      |                       /
               \\                     |                      /
                \\                    v                     /
                 +----------------------------------------+
                 |        WORKING SET MEMORY (WSM)        |
                 |           (Active Context)             |
                 +----------------------------------------+
                 |                                        |
                 |  Current Task: Fix nginx config        |
                 |  Recent Entities: docker01, nginx      |
                 |  Open Loop: Finish SSL setup           |
                 |                                        |
                 +----------------------------------------+
`}</pre>
        </div>

        {/* Memory Type Cards */}
        <div className="docs-memory-types">
          <div className="docs-memory-type-card" style={{ '--mem-color': '#22c55e' }}>
            <div className="docs-memory-type-header">
              <div className="docs-memory-type-icon">E</div>
              <h3 id="episodic-memory">Episodic Memory</h3>
            </div>
            <p className="docs-memory-type-desc">Your Conversation Diary</p>
            <p className="docs-memory-type-details">
              Every conversation is stored with timestamps, like a detailed diary. This lets
              QuoxCORE recall specific past discussions: "Remember when we troubleshot the
              firewall issue last Tuesday?"
            </p>
          </div>

          <div className="docs-memory-type-card" style={{ '--mem-color': '#3b82f6' }}>
            <div className="docs-memory-type-header">
              <div className="docs-memory-type-icon">S</div>
              <h3 id="semantic-memory">Semantic Memory</h3>
            </div>
            <p className="docs-memory-type-desc">Facts and Preferences</p>
            <p className="docs-memory-type-details">
              Distilled knowledge extracted from conversations: your preferences, learned facts,
              past decisions, and constraints. This is the "wisdom" that persists across sessions.
            </p>
          </div>

          <div className="docs-memory-type-card" style={{ '--mem-color': '#f59e0b' }}>
            <div className="docs-memory-type-header">
              <div className="docs-memory-type-icon">N</div>
              <h3 id="entity-memory">Entity Memory</h3>
            </div>
            <p className="docs-memory-type-desc">Your Infrastructure Map</p>
            <p className="docs-memory-type-details">
              Structured knowledge about specific things: hosts, services, IPs, containers, and
              their relationships. Think of it as QuoxCORE's mental model of your infrastructure.
            </p>
          </div>

          <div className="docs-memory-type-card" style={{ '--mem-color': '#ef4444' }}>
            <div className="docs-memory-type-header">
              <div className="docs-memory-type-icon">W</div>
              <h3 id="working-set-memory">Working Set Memory</h3>
            </div>
            <p className="docs-memory-type-desc">Active Context (Your "RAM")</p>
            <p className="docs-memory-type-details">
              What QuoxCORE is actively thinking about right now: current tasks, recent entities,
              open loops, and session context. This is what makes QuoxCORE feel present and aware.
            </p>
          </div>
        </div>

        <div className="docs-callout docs-callout-important">
          <div className="docs-callout-icon">!</div>
          <div className="docs-callout-content">
            <strong>Pro Tip: The "remember" Command</strong>
            <p>
              Want to make sure something sticks? Just say "remember that..." and QuoxCORE will
              store it with high priority. For example: "Remember that we decided to use Caddy
              instead of nginx for automatic HTTPS."
            </p>
          </div>
        </div>
      </section>

      {/* How Memory Works */}
      <section>
        <h2 id="how-memory-works">How Memory Works</h2>
        <p>
          Understanding how QuoxCORE processes and retrieves memories helps you work with it
          more effectively. Here is what happens behind the scenes.
        </p>

        <h3 id="memory-flow">Memory Flow</h3>
        <p>
          When you tell QuoxCORE something, it goes through a multi-stage process to decide
          what to remember and how:
        </p>

        <div className="docs-code-block">
          <pre>{`User Input: "I prefer detailed explanations, and docker01 is our main container host"
                                         |
                                         v
                        +----------------------------------+
                        |     1. EXTRACT CANDIDATES        |
                        |     Find potentially memorable   |
                        |     facts, preferences, entities |
                        +----------------------------------+
                                         |
              +--------------------------+--------------------------+
              |                          |                          |
              v                          v                          v
    +------------------+      +------------------+      +------------------+
    |   PREFERENCE     |      |      FACT        |      |     ENTITY       |
    | "detailed        |      | "docker01 is     |      | docker01         |
    |  explanations"   |      |  main host"      |      | type: host       |
    +------------------+      +------------------+      | role: main       |
                                                        +------------------+
                                         |
                                         v
                        +----------------------------------+
                        |     2. SCORE IMPORTANCE          |
                        |     How important is this?       |
                        +----------------------------------+
                                         |
              +--------------------------+--------------------------+
              |                          |                          |
   High (>0.7)                 Medium                      Low
   Store in learned items      Store in episodic           Short-term only
   + vector index              + vector index
`}</pre>
        </div>

        <h3 id="hybrid-search">Hybrid Search</h3>
        <p>
          When QuoxCORE needs to recall relevant memories, it uses a powerful <strong>hybrid
          search</strong> that combines two approaches:
        </p>

        <table className="docs-table">
          <thead>
            <tr>
              <th>Method</th>
              <th>What It Does</th>
              <th>Good At</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Vector Search</strong></td>
              <td>Finds semantically similar memories using AI embeddings</td>
              <td>Understanding meaning: "container host" matches "Docker server"</td>
            </tr>
            <tr>
              <td><strong>Keyword Search (BM25)</strong></td>
              <td>Traditional text matching with term frequency</td>
              <td>Exact matches: "docker01" finds memories mentioning "docker01"</td>
            </tr>
            <tr>
              <td><strong>RRF Fusion</strong></td>
              <td>Combines both results using Reciprocal Rank Fusion</td>
              <td>Best of both worlds: semantic understanding + precision</td>
            </tr>
          </tbody>
        </table>

        <div className="docs-callout docs-callout-info">
          <div className="docs-callout-icon">i</div>
          <div className="docs-callout-content">
            <strong>Note: Why Hybrid Search Matters</strong>
            <p>
              Pure vector search might miss exact technical terms. Pure keyword search misses
              semantic connections. Hybrid search ensures that when you ask about "the main
              Docker host", QuoxCORE finds memories about "docker01" even if those exact words
              were not used.
            </p>
          </div>
        </div>
      </section>

      {/* Using Memory */}
      <section>
        <h2 id="using-memory">Using Memory</h2>
        <p>
          QuoxCORE's memory works automatically, but knowing how to interact with it gives you
          more control and better results.
        </p>

        <h3 id="natural-language">Natural Language Commands</h3>
        <p>
          You can manage memories using plain English. Here are the most useful commands:
        </p>

        <table className="docs-table">
          <thead>
            <tr>
              <th>What You Say</th>
              <th>What Happens</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>"Remember that..."</code></td>
              <td>Stores information with high priority. Use for important facts you want preserved.</td>
            </tr>
            <tr>
              <td><code>"What do you know about..."</code></td>
              <td>Searches memories for relevant information about a topic.</td>
            </tr>
            <tr>
              <td><code>"Forget about..."</code></td>
              <td>Removes memories related to a topic (useful for outdated info).</td>
            </tr>
            <tr>
              <td><code>"What were we working on?"</code></td>
              <td>Shows your current context: active tasks, recent entities, open loops.</td>
            </tr>
            <tr>
              <td><code>"I prefer..."</code></td>
              <td>Automatically stored as a preference that affects future responses.</td>
            </tr>
          </tbody>
        </table>

        <div className="docs-callout docs-callout-important">
          <div className="docs-callout-icon">!</div>
          <div className="docs-callout-content">
            <strong>Pro Tip: Be Specific with Entities</strong>
            <p>
              When mentioning infrastructure, be explicit the first time: "docker01 is our
              container host at 10.0.0.101". After that, QuoxCORE will recognize "docker01"
              or even "the Docker host" in future conversations.
            </p>
          </div>
        </div>

        <h3 id="api-reference">API Reference</h3>
        <p>
          For developers integrating with QuoxCORE's memory system:
        </p>

        <div className="docs-code-block">
          <div className="docs-code-header">javascript</div>
          <pre>{`import { getMemoryManager } from './services/memoryManager'

const mm = getMemoryManager()

// Store a preference
mm.setPreference('communication', 'verbosity', 'detailed')

// Store a learned fact
mm.addLearnedItem('fact', {
  content: 'We use Caddy for automatic HTTPS',
  confidence: 0.9,
  source: 'user_stated'
})

// Store an entity
mm.storeEntity({
  type: 'host',
  name: 'docker01',
  ip: '10.0.0.101',
  tags: ['container', 'production']
})

// Search memories
const results = await mm.hybridSearch('Docker configuration')
// Returns: [{ content, score, type, timestamp }, ...]

// Get all preferences
const prefs = mm.getAllPreferences()

// Get entities by type
const hosts = mm.getAllEntities().filter(e => e.type === 'host')`}</pre>
        </div>

        <h4>Working Set Memory API</h4>
        <p>
          The Working Set Memory (WSM) tracks your active context:
        </p>

        <div className="docs-code-block">
          <div className="docs-code-header">javascript</div>
          <pre>{`import {
  setCurrentFocus,
  touchEntity,
  addOpenLoop,
  resolveOpenLoop,
  generateWSMContext
} from './services/workingSetMemory'

// Set what you're working on
setCurrentFocus({
  task: 'Fix nginx reverse proxy',
  project: 'QuoxCORE',
  goal: 'Route dashboard through nginx'
})

// Track entity interactions
touchEntity({ type: 'host', id: 'docker01', name: 'docker01' })

// Add an unfinished task (open loop)
const loop = addOpenLoop({
  type: 'task',
  description: 'Finish SSL configuration',
  priority: 'high',
  relatedEntities: ['nginx', 'docker01']
})

// Later, mark it complete
resolveOpenLoop(loop.id, {
  outcome: 'completed',
  notes: 'SSL configured with Let\\'s Encrypt'
})

// Generate context for prompts (used internally)
const { context, estimatedTokens } = generateWSMContext({ maxTokens: 800 })`}</pre>
        </div>
      </section>

      {/* Advanced Features */}
      <section>
        <h2 id="advanced-features">Advanced Features</h2>
        <p>
          QuoxCORE's memory system includes sophisticated features that make it reliable and
          trustworthy for enterprise use.
        </p>

        <h3 id="provenance-tracking">Provenance Tracking</h3>
        <p>
          Every memory has a complete audit trail. QuoxCORE knows where information came from,
          when it was created, and whether it has been modified:
        </p>

        <div className="docs-code-block">
          <div className="docs-code-header">javascript</div>
          <pre>{`// Every memory includes provenance:
{
  content: "Adam prefers concise explanations",
  provenance: {
    source: 'user_stated',        // How we learned this
    createdBy: 'human.adam',      // Who told us
    createdAt: '2024-01-15T...',  // When
    modifiedBy: null,             // Any changes?
    supersedes: null,             // Does this replace something?
    supersededBy: null            // Was this replaced?
  }
}`}</pre>
        </div>

        <p>
          Trust levels vary by source:
        </p>

        <table className="docs-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Trust Score</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>tool_output</code></td>
              <td><span className="docs-badge docs-badge-success">1.0</span></td>
              <td>Verified by system - highest trust</td>
            </tr>
            <tr>
              <td><code>explicit_command</code></td>
              <td><span className="docs-badge docs-badge-success">0.95</span></td>
              <td>User said "remember this"</td>
            </tr>
            <tr>
              <td><code>user_stated</code></td>
              <td><span className="docs-badge docs-badge-warning">0.85</span></td>
              <td>User mentioned in conversation</td>
            </tr>
            <tr>
              <td><code>model_inference</code></td>
              <td><span className="docs-badge docs-badge-danger">0.6</span></td>
              <td>Claude inferred from context</td>
            </tr>
          </tbody>
        </table>

        <h3 id="conflict-detection">Conflict Detection</h3>
        <p>
          QuoxCORE automatically detects when new information contradicts existing memories:
        </p>

        <div className="docs-code-block">
          <div className="docs-code-header">text</div>
          <pre>{`Existing Memory: "We use nginx for the reverse proxy"
New Information: "We decided to switch to Caddy"

         -> CONFLICT DETECTED

Resolution: New information supersedes old memory
Old memory marked as "supersededBy: [new-memory-id]"
New memory linked with "supersedes: [old-memory-id]"`}</pre>
        </div>

        <div className="docs-callout docs-callout-info">
          <div className="docs-callout-icon">i</div>
          <div className="docs-callout-content">
            <strong>Note: Two-Stage Commit</strong>
            <p>
              For sensitive information (infrastructure changes, high-confidence facts), QuoxCORE
              uses a two-stage commit process. The memory is buffered first, and only committed
              after validation or explicit confirmation.
            </p>
          </div>
        </div>

        <h3 id="style-learning">Style Learning</h3>
        <p>
          Beyond facts, QuoxCORE learns <em>how</em> you communicate and adapts its responses
          to match your style:
        </p>

        <table className="docs-table">
          <thead>
            <tr>
              <th>Dimension</th>
              <th>Range</th>
              <th>What It Means</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Formality</td>
              <td>Casual to Formal</td>
              <td>"yo check this" vs "Please review the following"</td>
            </tr>
            <tr>
              <td>Verbosity</td>
              <td>Concise to Detailed</td>
              <td>Bullet points vs comprehensive explanations</td>
            </tr>
            <tr>
              <td>Technicality</td>
              <td>Simple to Technical</td>
              <td>High-level concepts vs deep implementation details</td>
            </tr>
            <tr>
              <td>Directness</td>
              <td>Indirect to Direct</td>
              <td>"Maybe consider..." vs "Do this:"</td>
            </tr>
          </tbody>
        </table>

        <div className="docs-callout docs-callout-important">
          <div className="docs-callout-icon">!</div>
          <div className="docs-callout-content">
            <strong>Pro Tip: Import Your ChatGPT History</strong>
            <p>
              Already have a conversation history with ChatGPT? QuoxCORE can import it! Export
              your data from ChatGPT, then use the ChatGPT Importer to bootstrap QuoxCORE's
              memory with your existing preferences, facts, and communication style.
            </p>
          </div>
        </div>
      </section>

      {/* Memory Storage */}
      <section>
        <h2 id="memory-storage">Memory Storage</h2>
        <p>
          All memories are stored locally on your system for privacy and control:
        </p>

        <div className="docs-code-block">
          <div className="docs-code-header">text</div>
          <pre>{`~/quox-memory/
├── profile/                 # User profile data
│   ├── identity.json        # Name, preferences
│   └── style.json           # Communication style profile
├── episodic/               # Conversation logs by date
│   ├── 2024-01-15.json
│   └── 2024-01-16.json
├── semantic/               # Learned facts and preferences
│   ├── facts.json
│   ├── preferences.json
│   ├── decisions.json
│   └── constraints.json
└── projects/               # Project-specific memory
    └── quox/
        └── context.json`}</pre>
        </div>

        <div className="docs-callout docs-callout-warning">
          <div className="docs-callout-icon">!</div>
          <div className="docs-callout-content">
            <strong>Privacy Note</strong>
            <p>
              Your memories are stored locally and never sent to external servers except when
              generating embeddings for search (using OpenAI's embedding API). The actual
              memory content stays on your machine.
            </p>
          </div>
        </div>
      </section>

      {/* Quick Reference */}
      <section>
        <h2 id="quick-reference">Quick Reference</h2>
        <p>
          A summary of the most important concepts:
        </p>

        <table className="docs-table">
          <thead>
            <tr>
              <th>Concept</th>
              <th>Analogy</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Episodic Memory</strong></td>
              <td>Diary</td>
              <td>Recall specific past conversations</td>
            </tr>
            <tr>
              <td><strong>Semantic Memory</strong></td>
              <td>Knowledge base</td>
              <td>Store learned facts and preferences</td>
            </tr>
            <tr>
              <td><strong>Entity Memory</strong></td>
              <td>Address book</td>
              <td>Map your infrastructure and relationships</td>
            </tr>
            <tr>
              <td><strong>Working Set Memory</strong></td>
              <td>RAM / Active thought</td>
              <td>Track current context and open tasks</td>
            </tr>
            <tr>
              <td><strong>Hybrid Search</strong></td>
              <td>Smart librarian</td>
              <td>Find relevant memories using meaning + keywords</td>
            </tr>
            <tr>
              <td><strong>Provenance</strong></td>
              <td>Audit trail</td>
              <td>Know where information came from</td>
            </tr>
            <tr>
              <td><strong>Style Engine</strong></td>
              <td>Personality mirror</td>
              <td>Adapt responses to your communication style</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* Enterprise Memory & Compliance */}
      <section>
        <h2 id="enterprise">Enterprise Memory & Compliance</h2>
        <p>
          QuoxCORE's memory system provides the foundation for enterprise-grade audit trails
          and compliance. When combined with AOCL (Agent Orchestration Control Layers), you
          get complete transparency into every AI decision.
        </p>

        <div className="docs-premium-cards">
          <div className="docs-premium-card" style={{ '--premium-color': '#3b82f6' }}>
            <div className="docs-premium-header">
              <div className="docs-premium-badge">ENTERPRISE</div>
              <h3>AOCL Compliance Suite</h3>
            </div>
            <p>
              Export complete memory and decision audit trails in compliance-ready formats.
              SOC2, HIPAA, GDPR, and ISO 27001 evidence bundles with full provenance tracking.
            </p>
            <ul className="docs-premium-features">
              <li>Full memory provenance in compliance reports</li>
              <li>Trace replay to debug AI decisions</li>
              <li>Multi-agent correlation across workflows</li>
              <li>Scheduled compliance job automation</li>
            </ul>
            <div className="docs-premium-footer">
              <span className="docs-premium-price">$499/year</span>
              <Link to="/compliance-suite" className="docs-premium-btn">Learn More</Link>
            </div>
          </div>

          <div className="docs-premium-card" style={{ '--premium-color': '#8b5cf6' }}>
            <div className="docs-premium-header">
              <div className="docs-premium-badge">FREE</div>
              <h3>AOCL Developer Kit</h3>
            </div>
            <p>
              Build custom memory layers and processing plugins. Test memory retrieval
              in isolation with the Layer Playground. Extend QuoxCORE's memory system.
            </p>
            <ul className="docs-premium-features">
              <li>Custom memory enhancement layers</li>
              <li>Layer Playground for isolated testing</li>
              <li>Memory SDK & CLI tools</li>
              <li>Plugin marketplace access</li>
            </ul>
            <div className="docs-premium-footer">
              <span className="docs-premium-price">Included</span>
              <Link to="/developer-kit" className="docs-premium-btn">Learn More</Link>
            </div>
          </div>
        </div>

        <div className="docs-callout docs-callout-info">
          <div className="docs-callout-icon">i</div>
          <div className="docs-callout-content">
            <strong>Free with QuoxCORE</strong>
            <p>
              All memory features documented on this page are included free with QuoxCORE.
              The Developer Kit is also included free; the Compliance Suite adds enterprise
              compliance exports.
              <Link to="/pricing" style={{ marginLeft: '0.5rem' }}>View pricing</Link>
            </p>
          </div>
        </div>
      </section>

      {/* Footer Links */}
      <div className="docs-page-footer">
        <div className="docs-footer-nav">
          <Link to="/docs/smart-router" className="docs-footer-link docs-footer-prev">
            <span className="docs-footer-label">Previous</span>
            <span className="docs-footer-title">Smart Router</span>
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
