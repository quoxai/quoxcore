import { useEffect } from 'react'
import { useOutletContext, Link } from 'react-router-dom'

/**
 * Smart Router Documentation Page
 *
 * Comprehensive documentation for QuoxCORE's Smart Router system -
 * the confidence-based query classification and routing engine.
 */
export default function SmartRouterPage() {
  const { setHeadings } = useOutletContext()

  useEffect(() => {
    setHeadings([
      { id: 'overview', text: 'Overview', level: 2 },
      { id: 'why-smart-router', text: 'Why Smart Router?', level: 2 },
      { id: 'architecture', text: 'Architecture', level: 2 },
      { id: 'layer-1-regex', text: 'Layer 1: Regex Classification', level: 3 },
      { id: 'layer-2-semantic', text: 'Layer 2: Semantic Classification', level: 3 },
      { id: 'confidence-scoring', text: 'Confidence Scoring', level: 2 },
      { id: 'risk-levels', text: 'Risk Levels', level: 3 },
      { id: 'thresholds', text: 'Confidence Thresholds', level: 3 },
      { id: 'features', text: 'Key Features', level: 2 },
      { id: 'clarification', text: 'Clarifying Questions', level: 3 },
      { id: 'escalation', text: 'User Escalation', level: 3 },
      { id: 'telemetry', text: 'Telemetry & Analytics', level: 3 },
      { id: 'supported-intents', text: 'Supported Intents', level: 2 },
      { id: 'how-it-works', text: 'How It Works', level: 2 },
      { id: 'configuration', text: 'Configuration', level: 2 },
      { id: 'api-reference', text: 'API Reference', level: 2 },
    ])
  }, [setHeadings])

  return (
    <div className="docs-content">
      {/* Header */}
      <div className="docs-page-header">
        <h1>Smart Router</h1>
        <p className="docs-lead">
          QuoxCORE's intelligent query classification engine. Routes common queries instantly
          without LLM calls, saving tokens and reducing latency by 10-100x.
        </p>
      </div>

      {/* Overview */}
      <section>
        <h2 id="overview">Overview</h2>
        <p>
          The Smart Router is QuoxCORE's first line of defense for handling user queries. Instead of
          sending every message to Claude (which costs tokens and takes 2-5 seconds), the Smart Router
          identifies common patterns and responds instantly with pre-computed answers.
        </p>

        <div className="docs-callout docs-callout-info">
          <strong>Performance Impact:</strong> The Smart Router handles 60-80% of common queries
          with response times under 50ms, compared to 2-5 seconds for full LLM calls.
        </div>

        <h3>Key Benefits</h3>
        <ul>
          <li><strong>Token Savings:</strong> Bypass the LLM for predictable queries (saves 100-500 tokens per query)</li>
          <li><strong>Latency Reduction:</strong> Instant responses vs. 2-5 second LLM calls</li>
          <li><strong>Offline Capability:</strong> Core commands work even when LLM is unavailable</li>
          <li><strong>Consistent Responses:</strong> Same query = same response (deterministic)</li>
          <li><strong>User Escalation:</strong> Every response includes "Ask Claude" for complex follow-ups</li>
        </ul>
      </section>

      {/* Why Smart Router */}
      <section>
        <h2 id="why-smart-router">Why Smart Router?</h2>
        <p>
          Most AI chatbots send every message to the LLM, even simple commands like "list hosts"
          or "fleet status". This is wasteful and slow. The Smart Router recognizes these patterns
          and handles them directly.
        </p>

        <h3>The Conservative Routing Principle</h3>
        <div className="docs-callout docs-callout-warning">
          <strong>When in doubt, don't route.</strong> A missed optimization is better than a wrong response.
          The router prioritizes precision over recall - it's acceptable to send some routable queries
          to Claude, but NOT acceptable to route queries incorrectly.
        </div>

        <h3>When Smart Router Routes</h3>
        <ul>
          <li>Highly predictable commands: "quoxagent status", "list hosts", "show agents"</li>
          <li>Static information: "what is quox", "what can you do"</li>
          <li>Simple lookups: "tell me about docker01"</li>
          <li>High-frequency operations: Queries that occur 100+ times per day</li>
        </ul>

        <h3>When Smart Router Passes to Claude</h3>
        <ul>
          <li>Complex questions requiring reasoning</li>
          <li>Ambiguous or context-dependent queries</li>
          <li>Anything with nuance or multiple interpretations</li>
          <li>Queries where confidence is below threshold</li>
        </ul>
      </section>

      {/* Architecture */}
      <section>
        <h2 id="architecture">Architecture</h2>
        <p>
          The Smart Router uses a two-layer cascading classification system. Each layer
          produces a confidence score, and results are merged to find the best match.
        </p>

        <div className="docs-code-block">
          <pre>{`User Query
    │
    ▼
┌─────────────────────────────────────────────┐
│  Layer 1: Regex Classification               │
│  - Pattern matching against 18 intents       │
│  - Fast: <1ms                                │
│  - High precision for exact commands         │
└─────────────────────────────────────────────┘
    │
    ├── HIGH confidence (>0.9) → Execute Handler
    │
    ▼
┌─────────────────────────────────────────────┐
│  Layer 2: Semantic Classification            │
│  - Embedding-based similarity matching       │
│  - 130+ example utterances                   │
│  - Handles paraphrases and variations        │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│  Merge Results                               │
│  - Pick highest confidence across layers     │
│  - Check for ambiguity                       │
│  - Apply risk-based thresholds               │
└─────────────────────────────────────────────┘
    │
    ├── HIGH confidence → Execute Handler
    ├── MEDIUM + Ambiguous → Clarifying Question
    └── LOW confidence → Pass to Claude`}</pre>
        </div>

        <h3 id="layer-1-regex">Layer 1: Regex Classification</h3>
        <p>
          The first layer uses regex pattern matching for speed. Each pattern is analyzed for:
        </p>
        <ul>
          <li><strong>Anchoring:</strong> Patterns that start with ^ or end with $ are more specific</li>
          <li><strong>Word Boundaries:</strong> \b markers increase specificity</li>
          <li><strong>Match Coverage:</strong> How much of the query was matched</li>
          <li><strong>Conversational Penalties:</strong> "Can you...", "Please..." reduce confidence</li>
          <li><strong>Common Word Detection:</strong> Matching "the", "a", "my" as hostnames = low confidence</li>
        </ul>

        <h3 id="layer-2-semantic">Layer 2: Semantic Classification</h3>
        <p>
          When regex confidence is uncertain, the semantic layer provides paraphrase understanding:
        </p>
        <ul>
          <li><strong>130+ Example Utterances:</strong> 5-15 examples per intent</li>
          <li><strong>Embedding-Based Matching:</strong> Uses OpenAI text-embedding-3-small or fallback</li>
          <li><strong>Cosine Similarity:</strong> Finds most similar examples to the query</li>
          <li><strong>Aggregation:</strong> Scores are aggregated by intent, not just best match</li>
        </ul>

        <div className="docs-callout docs-callout-info">
          <strong>Fallback Embeddings:</strong> When no OpenAI API key is configured, the semantic
          layer uses hash-based sparse vectors. This works for exact matches but doesn't capture
          full semantic similarity.
        </div>
      </section>

      {/* Confidence Scoring */}
      <section>
        <h2 id="confidence-scoring">Confidence Scoring</h2>
        <p>
          Every classification produces a confidence score between 0 and 1. Higher scores
          mean more certainty about the intent.
        </p>

        <h3 id="risk-levels">Risk Levels</h3>
        <p>
          Different intents have different risk levels, which determine the confidence
          threshold required for routing:
        </p>

        <table className="docs-table">
          <thead>
            <tr>
              <th>Risk Level</th>
              <th>Threshold</th>
              <th>Examples</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><span className="docs-badge docs-badge-success">LOW</span></td>
              <td>0.50</td>
              <td>greeting, help_query, what_is_quox, capabilities</td>
            </tr>
            <tr>
              <td><span className="docs-badge docs-badge-warning">MEDIUM</span></td>
              <td>0.65</td>
              <td>fleet_status, list_agents, list_hosts, health_check, memory_search</td>
            </tr>
            <tr>
              <td><span className="docs-badge docs-badge-danger">HIGH</span></td>
              <td>0.85</td>
              <td>install_quoxagent (actions that modify state)</td>
            </tr>
            <tr>
              <td><span className="docs-badge docs-badge-error">CRITICAL</span></td>
              <td>0.95</td>
              <td>Destructive operations (future)</td>
            </tr>
          </tbody>
        </table>

        <h3 id="thresholds">Confidence Thresholds</h3>
        <p>
          The router uses multiple thresholds to make routing decisions:
        </p>
        <ul>
          <li><strong>High Confidence (0.9+):</strong> Route immediately, skip ambiguity check</li>
          <li><strong>Intent Threshold:</strong> Varies by risk level (0.5 - 0.85)</li>
          <li><strong>Minimum Confidence (0.4):</strong> Below this, always pass to Claude</li>
          <li><strong>Ambiguity Threshold (0.3):</strong> Max allowed gap between top intents</li>
        </ul>
      </section>

      {/* Features */}
      <section>
        <h2 id="features">Key Features</h2>

        <h3 id="clarification">Clarifying Questions</h3>
        <p>
          When the router is uncertain between multiple intents, it asks clarifying questions
          instead of guessing:
        </p>
        <div className="docs-code-block">
          <pre>{`User: "status"

Router: "I want to make sure I understand. Are you trying to:

1. Check QuoxAgent fleet status
2. Get router statistics
3. Something else (let Claude help)

Click an option or rephrase your query for better results."`}</pre>
        </div>

        <h3 id="escalation">User Escalation</h3>
        <p>
          Every routed response includes an "Ask Claude" button. This allows users to
          escalate to the full LLM when the router's response isn't sufficient.
        </p>
        <p>
          Escalations are tracked for analytics - high escalation rates on a pattern
          indicate the handler needs improvement.
        </p>

        <h3 id="telemetry">Telemetry & Analytics</h3>
        <p>
          The router tracks detailed metrics for optimization:
        </p>
        <ul>
          <li><strong>Bypass Rate:</strong> Percentage of queries handled without LLM</li>
          <li><strong>Reformulation Rate:</strong> Users quickly rephrasing (indicates bad response)</li>
          <li><strong>Escalation Rate:</strong> Users clicking "Ask Claude"</li>
          <li><strong>Per-Pattern Stats:</strong> Usage, escalations, reformulations per pattern</li>
        </ul>
        <p>
          Access stats with: <code>router stats</code>
        </p>
      </section>

      {/* Supported Intents */}
      <section>
        <h2 id="supported-intents">Supported Intents</h2>
        <p>
          The Smart Router currently supports 18 intents across different categories:
        </p>

        <h3>Infrastructure Commands</h3>
        <table className="docs-table">
          <thead>
            <tr>
              <th>Intent</th>
              <th>Example Queries</th>
              <th>Risk</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>install_quoxagent</code></td>
              <td>"install quoxagent on docker01", "deploy quoxagent on kuma01"</td>
              <td>HIGH</td>
            </tr>
            <tr>
              <td><code>fleet_status</code></td>
              <td>"quoxagent status", "fleet status", "agent status"</td>
              <td>MEDIUM</td>
            </tr>
            <tr>
              <td><code>health_check</code></td>
              <td>"check docker01", "health check on kuma01"</td>
              <td>MEDIUM</td>
            </tr>
            <tr>
              <td><code>list_hosts</code></td>
              <td>"list hosts", "show all hosts"</td>
              <td>MEDIUM</td>
            </tr>
            <tr>
              <td><code>list_agents</code></td>
              <td>"list agents", "show quoxagent agents"</td>
              <td>MEDIUM</td>
            </tr>
            <tr>
              <td><code>host_details</code></td>
              <td>"tell me about docker01", "info on proxmox01"</td>
              <td>MEDIUM</td>
            </tr>
          </tbody>
        </table>

        <h3>Information Queries</h3>
        <table className="docs-table">
          <thead>
            <tr>
              <th>Intent</th>
              <th>Example Queries</th>
              <th>Risk</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>what_is_quox</code></td>
              <td>"what is quox", "what are you"</td>
              <td>LOW</td>
            </tr>
            <tr>
              <td><code>who_are_you</code></td>
              <td>"who are you"</td>
              <td>LOW</td>
            </tr>
            <tr>
              <td><code>capabilities</code></td>
              <td>"what can you do", "your capabilities"</td>
              <td>LOW</td>
            </tr>
            <tr>
              <td><code>list_assistants</code></td>
              <td>"list assistants", "what assistants are available"</td>
              <td>MEDIUM</td>
            </tr>
            <tr>
              <td><code>agent_info</code></td>
              <td>"what can WARDEN do", "tell me about DAEDALUS"</td>
              <td>MEDIUM</td>
            </tr>
          </tbody>
        </table>

        <h3>Memory & Preferences</h3>
        <table className="docs-table">
          <thead>
            <tr>
              <th>Intent</th>
              <th>Example Queries</th>
              <th>Risk</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>memory_search</code></td>
              <td>"what do you know about docker", "search memory for nginx"</td>
              <td>MEDIUM</td>
            </tr>
            <tr>
              <td><code>preference_get</code></td>
              <td>"what's my preference for verbosity"</td>
              <td>MEDIUM</td>
            </tr>
            <tr>
              <td><code>preference_list</code></td>
              <td>"list preferences", "my settings"</td>
              <td>MEDIUM</td>
            </tr>
          </tbody>
        </table>

        <h3>Utility</h3>
        <table className="docs-table">
          <thead>
            <tr>
              <th>Intent</th>
              <th>Example Queries</th>
              <th>Risk</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>greeting</code></td>
              <td>"hello", "hi", "good morning"</td>
              <td>LOW</td>
            </tr>
            <tr>
              <td><code>help_query</code></td>
              <td>"help", "commands"</td>
              <td>LOW</td>
            </tr>
            <tr>
              <td><code>time_query</code></td>
              <td>"what time is it", "current time"</td>
              <td>LOW</td>
            </tr>
            <tr>
              <td><code>router_stats</code></td>
              <td>"router stats", "bypass stats"</td>
              <td>MEDIUM</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* How It Works */}
      <section>
        <h2 id="how-it-works">How It Works</h2>
        <p>
          Here's the complete flow when a user sends a message:
        </p>

        <ol className="docs-steps">
          <li>
            <strong>Query Received:</strong> User sends "how's the fleet looking"
          </li>
          <li>
            <strong>Layer 1 - Regex:</strong> Patterns are tested. No exact match found.
            Confidence: 0.0
          </li>
          <li>
            <strong>Layer 2 - Semantic:</strong> Query is embedded and compared to
            130+ examples. Top match: "fleet_status" with 0.72 confidence.
          </li>
          <li>
            <strong>Merge Results:</strong> Semantic result wins (higher confidence).
          </li>
          <li>
            <strong>Threshold Check:</strong> 0.72 &gt; 0.65 (fleet_status threshold). Trusted.
          </li>
          <li>
            <strong>Ambiguity Check:</strong> No close alternatives. Proceed.
          </li>
          <li>
            <strong>Execute Handler:</strong> fleet_status handler runs, returns status.
          </li>
          <li>
            <strong>Add Escalation:</strong> Response includes "Ask Claude" button.
          </li>
          <li>
            <strong>Log Telemetry:</strong> Match recorded for analytics.
          </li>
        </ol>
      </section>

      {/* Configuration */}
      <section>
        <h2 id="configuration">Configuration</h2>
        <p>
          The router configuration is in <code>src/services/routerConfig.js</code>:
        </p>

        <div className="docs-code-block">
          <pre>{`// Router operating modes
ROUTER_MODES = {
  STANDARD: 'standard',     // Regex + Semantic, conservative routing
  ENHANCED: 'enhanced',     // Future: Add LLM classifier layer
  CONSERVATIVE: 'conservative'  // Higher thresholds, skip when uncertain
}

// Default configuration
DEFAULT_ROUTER_CONFIG = {
  mode: 'standard',

  thresholds: {
    confidence: 0.65,        // Default threshold
    ambiguity: 0.3,          // Max gap between top intents
    highConfidence: 0.9,     // Skip ambiguity check
    minimumConfidence: 0.4   // Below this, always pass to Claude
  },

  // Per-intent overrides
  intentThresholds: {
    greeting: 0.5,           // Low risk
    install_quoxagent: 0.85,       // High risk - requires high confidence
    // ...
  },

  clarification: {
    enabled: true,
    minConfidence: 0.4,
    maxConfidence: 0.7,
    maxOptions: 3
  }
}`}</pre>
        </div>
      </section>

      {/* API Reference */}
      <section>
        <h2 id="api-reference">API Reference</h2>

        <h3>routeQuery(query, context)</h3>
        <p>Main entry point for routing a user query.</p>
        <div className="docs-code-block">
          <pre>{`import { routeQuery } from './services/quoxRouter.js'

const result = await routeQuery('quoxagent status', { currentAssistant: 'quox' })

// Result:
{
  handled: true,
  response: "Fleet Status Report...",
  type: 'status',
  pattern: 'fleet_status',
  confidence: 0.95,
  layer: 'regex',
  canEscalate: true,
  escalateQuery: 'quoxagent status'
}`}</pre>
        </div>

        <h3>canRouteQuery(query)</h3>
        <p>Quick synchronous check if a query might be routable.</p>
        <div className="docs-code-block">
          <pre>{`import { canRouteQuery } from './services/quoxRouter.js'

const check = canRouteQuery('list hosts')
// { canRoute: true, pattern: 'list_hosts', description: 'List all known hosts' }`}</pre>
        </div>

        <h3>getPatterns()</h3>
        <p>Get all registered patterns for debugging.</p>
        <div className="docs-code-block">
          <pre>{`import { getPatterns } from './services/quoxRouter.js'

const patterns = getPatterns()
// [{ name: 'install_quoxagent', pattern: '/.../', description: '...' }, ...]`}</pre>
        </div>

        <h3>Telemetry</h3>
        <p>Export the logEscalation function for tracking user escalations:</p>
        <div className="docs-code-block">
          <pre>{`import { logEscalation } from './services/quoxRouter.js'

// When user clicks "Ask Claude" button
logEscalation(originalQuery, patternName)`}</pre>
        </div>
      </section>

      {/* Footer Links */}
      <div className="docs-page-footer">
        <div className="docs-footer-nav">
          <Link to="/docs/agents" className="docs-footer-link docs-footer-prev">
            <span className="docs-footer-label">Previous</span>
            <span className="docs-footer-title">AI Agents</span>
          </Link>
          <Link to="/docs/memory" className="docs-footer-link docs-footer-next">
            <span className="docs-footer-label">Next</span>
            <span className="docs-footer-title">Memory System</span>
          </Link>
        </div>
      </div>
    </div>
  )
}
