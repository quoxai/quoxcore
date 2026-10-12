import MarkdownPage from './MarkdownPage'
import content from '../../../docs/AGENTS.md?raw'

// Beginner-friendly intro content prepended to the technical docs
const beginnerIntro = `
## What Are AI Agents?

Imagine you run a busy restaurant. You would not ask the head chef to also seat guests, wash dishes, and manage reservations. Instead, you have specialists: a host, line cooks, a sous chef, and a manager who coordinates everyone. That is exactly how QuoxCORE works.

**Agents are AI specialists.** Each one is trained for a specific job, so when you ask a question, you get an expert response - not a generalist guessing.

---

## Why This Matters

A single AI trying to handle everything - security, networking, servers, data analysis - would be like asking one person to run every department of a company. It might work, but not well.

With specialized agents:

- **Deeper expertise** - CIPHER lives and breathes networking. WARDEN knows security inside out.
- **Faster answers** - The right agent gets your question immediately, no context-switching.
- **Smarter collaboration** - Agents can consult each other. CIPHER might ask DAEDALUS to check server resources while investigating a network issue.
- **Clear accountability** - You always know who handled what.

---

## Meet Your Team

Think of this as your IT department org chart. QuoxCORE is the manager, and the specialists report in.

### The Conductor

| | |
|---|---|
| **QuoxCORE** | *"I coordinate the orchestra"* |

QuoxCORE is your main point of contact. When you ask anything, QuoxCORE figures out which specialist should handle it and orchestrates the response. You never need to pick an agent yourself.

**Example:** "Why is my app slow?" - QuoxCORE might involve CIPHER (is it network latency?), DAEDALUS (is the server overloaded?), and SCHOLAR (any unusual patterns?).

---

### The Specialists

#### WARDEN - Security Operations

| | |
|---|---|
| **Domain** | Security, threats, access control |
| **Personality** | Vigilant, thorough, slightly paranoid (in a good way) |

WARDEN watches over your infrastructure like a hawk. Security scans, intrusion detection, access audits - if it involves keeping bad actors out, WARDEN handles it.

**Things WARDEN can help with:**
- "Run a security audit on the production servers"
- "Check for failed SSH login attempts on gw-01"
- "Review firewall rules for the web tier"
- "Are there any suspicious processes running on docker03?"

---

#### DAEDALUS - Infrastructure Management

| | |
|---|---|
| **Domain** | Servers, VMs, containers, system resources |
| **Personality** | Methodical, reliable, resource-conscious |

DAEDALUS knows your servers intimately - CPU, memory, disk, containers, everything. When something is running hot or a VM needs attention, DAEDALUS is your go-to.

**Things DAEDALUS can help with:**
- "What is the disk usage across all Docker hosts?"
- "Restart the nginx container on docker01"
- "Show me memory trends for the past week"
- "Spin up a new VM for testing"

---

#### CIPHER - Network Operations

| | |
|---|---|
| **Domain** | Networking, connectivity, DNS, routing |
| **Personality** | Analytical, patient, loves a good traceroute |

CIPHER speaks packets and protocols. Whether it is a routing issue, DNS mystery, or connectivity problem, CIPHER will trace it down.

**Things CIPHER can help with:**
- "Why cannot kuma01 reach the database server?"
- "Check if port 443 is open on the load balancer"
- "What is the network latency between regions?"
- "Show me the route to the external API endpoint"

---

#### SCHOLAR - Data & Analytics

| | |
|---|---|
| **Domain** | Patterns, anomalies, trends, insights |
| **Personality** | Curious, data-driven, sees the big picture |

SCHOLAR finds the signal in the noise. Unusual spikes, emerging patterns, correlation between events - SCHOLAR spots what humans might miss.

**Things SCHOLAR can help with:**
- "Are there any anomalies in today's metrics?"
- "What caused the spike in errors yesterday at 3pm?"
- "Show me request patterns over the past month"
- "Correlate CPU usage with response times"

---

#### PRISM - General Assistant

| | |
|---|---|
| **Domain** | Everything else, general help, quick answers |
| **Personality** | Friendly, versatile, always ready |

PRISM is your Swiss Army knife. Not everything fits neatly into security or networking - Prism handles the in-between questions and general tasks.

**Things PRISM can help with:**
- "What time zone is the monitoring server in?"
- "Summarize what happened in the last incident"
- "Help me draft a maintenance window notice"
- "What is the command to check SSL certificate expiry?"

---

#### ARCHIVIST - Knowledge Management

| | |
|---|---|
| **Domain** | Documentation, learnings, conversation history |
| **Personality** | Organized, detail-oriented, never forgets |

ARCHIVIST is the institutional memory. Every conversation, every solution, every learned fact - ARCHIVIST catalogs it so knowledge is never lost.

**Things ARCHIVIST can help with:**
- "What did we decide about the backup schedule last month?"
- "Save this solution for future reference"
- "Find all conversations about the Redis cluster"
- "What do we know about docker02's quirks?"

---

#### COREY - Core Systems Specialist

| | |
|---|---|
| **Domain** | QuoxCORE internals, system health, topology, cognitive implants |
| **Personality** | Introspective, precise, system-aware |

COREY knows QuoxCORE inside and out. Memory lattice status, plugin health, system topology, cognitive implants - if you want to understand what is happening under the hood, COREY is your guide.

**Things COREY can help with:**
- "What is the current health of the Quox core?"
- "Show me the system topology"
- "Check the status of all cognitive implants"
- "What plugins are currently active?"
- "Inspect the memory lattice"

---

## How Agent Delegation Works

When you send a message to QuoxCORE, the **agent delegation system** automatically determines which specialist should handle your query:

1. **Scoring** - Every agent is scored against your query based on:
   - Keyword matches (e.g., "security" → WARDEN)
   - Capability alignment (e.g., network tools → CIPHER)
   - Explicit mentions (e.g., "ask COREY" → COREY)

2. **Selection** - The highest-scoring agent (above a minimum threshold) gets the query

3. **Context Injection** - The selected agent receives its full identity, personality, and rules

4. **Response** - The agent responds in character with its domain expertise

**Example scoring:**

\`\`\`text
Query: "Check for security vulnerabilities on docker01"

WARDEN: 45 points (security + vulnerabilities = strong match)
DAEDALUS:     12 points (docker01 is infrastructure)
CIPHER:    5 points (some network relevance)
COREY:     3 points (minimal match)

Winner: WARDEN with score 45
\`\`\`

> **Try it yourself:** Visit the Agent Family Tree view to test delegation routing and see how different queries score against each agent.

---

## How Agents Work Together

Here is a real example of agent collaboration:

**You ask:** *"docker01 seems slow - can you investigate?"*

1. **QuoxCORE** receives your request and routes to the best agent based on scoring
2. **DAEDALUS** checks system resources - CPU at 92%, memory fine, disk I/O elevated
3. **CIPHER** tests network connectivity - latency normal, no packet loss
4. **SCHOLAR** pulls recent metrics - spots a correlation with a new container deployment
5. **COREY** checks core system health - memory lattice functioning normally
6. **QuoxCORE** synthesizes everything: "docker01 is CPU-bound due to the new logging container consuming excessive resources"

All of this happens behind the scenes. You just asked one question and got a comprehensive answer.

---

## Just Talk to QuoxCORE

Here is the beautiful part: **you do not need to think about any of this.**

Just ask your question naturally:

\`\`\`text
"Is anything wrong with the production servers?"
"Help me troubleshoot this network timeout"
"What happened at 2am that triggered all these alerts?"
\`\`\`

QuoxCORE automatically routes your request to the right specialists. Think of it like calling a company's main number - you describe what you need, and you get transferred to the right department.

> **Pro tip:** You *can* talk to specific agents directly if you prefer (useful for power users), but it is never required.

---

## Agent Hierarchy at a Glance

\`\`\`text
                         QuoxCORE
                       (Orchestrator)
                            |
          +--------+--------+--------+--------+
          |        |        |        |        |
      WARDEN     DAEDALUS CIPHER   PRISM    COREY
      (Security) (Infra)  (Network)(General)(Core)
          |        |        |        |        |
          +--------+--------+--------+--------+
                            |
          +--------+--------+--------+--------+
          |        |        |        |        |
       SCHOLAR HYPERION METRICS  VIGIL   ARCHIVIST
      (Analytics)(VMs)  (Metrics)(Uptime)(Knowledge)
\`\`\`

- **Level 0:** QuoxCORE - Full access, orchestrates everything
- **Level 1:** WARDEN, DAEDALUS, CIPHER, PRISM, COREY - Domain managers
- **Level 2:** SCHOLAR, HYPERION, METRICS, VIGIL, ARCHIVIST, and more - Specialists focused on their domains

QuoxCORE manages **13 specialized agents** across security, infrastructure, networking, analytics, and more.

---

## Ready to Try?

Head to the Command Center and just start talking. Ask about your servers, investigate an issue, or request a system overview. The agents are ready to help.

---

`;

export default function AgentsPage() {
  return (
    <MarkdownPage
      content={beginnerIntro + content}
      title="AI Agents"
      lead="Meet your infrastructure team. QuoxCORE coordinates a group of specialized AI agents - each an expert in their domain - working together to help you manage, monitor, and troubleshoot your systems."
    />
  )
}
