import MarkdownPage from './MarkdownPage'
import content from '../../../docs/ARCHITECTURE.md?raw'

// Comprehensive architecture content with 30,000 foot view first
const architectureContent = `
## The 30,000 Foot View

**QuoxCORE** (Multi-Agent Executive System for Tactical Resource Orchestration) is an AI-powered infrastructure command center. Think of it as your personal ops team that never sleeps - you speak naturally, and it handles the technical details.

### What Problem Does QuoxCORE Solve?

Managing 50+ servers, containers, and services is complex. Traditional approaches require:
- Memorizing dozens of CLI commands
- SSH-ing into multiple machines
- Manually tracking what is running where
- Maintaining runbooks and documentation

QuoxCORE replaces this with a single conversational interface. You say *"check disk space on all docker hosts"* and it happens - no memorization, no manual SSH sessions.

### The Core Idea

\`\`\`
┌─────────────────────────────────────────────────────────────────────┐
│                         YOU (Natural Language)                       │
│                    "restart nginx on docker01"                       │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      QuoxCORE DASHBOARD (React)                       │
│                    Command Center + HAL Interface                    │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│               ORCHESTRATION LAYER (Collector + QuoxFlow)              │
│         Smart Router + Claude AI + Memory + Agent Hierarchy          │
└─────────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      INFRASTRUCTURE LAYER                            │
│              Bastion Host + QuoxAgent Agents + Your Servers                │
└─────────────────────────────────────────────────────────────────────┘
\`\`\`

---

## System Components

QuoxCORE is composed of four main layers, each with a specific responsibility.

### Layer 1: Frontend (What You See)

The **Dashboard** is a React web application with a HAL-9000 inspired interface. It provides:

| Component | Purpose |
|-----------|---------|
| **Command Center** | Primary interface with chat, monitoring, and management views |
| **HAL Interface** | Voice-enabled assistant with animated eye visualization |
| **Memory UI** | View and manage what QuoxCORE remembers about you |
| **Agent Views** | Monitor specialized AI agents and their activities |
| **Workflow Builder** | Create and deploy automation workflows |

**Why React?** Fast, component-based development with excellent tooling. The modular design means new features can be added without touching existing code.

### Layer 2: Orchestration (The Brain)

This is where the magic happens. The orchestration layer includes:

| Component | What It Does | Why It Matters |
|-----------|--------------|----------------|
| **Collector + QuoxFlow** | Native service orchestration and workflow engine | Direct integration, fast execution |
| **Claude AI** | Understands your intent, plans actions | Natural language understanding |
| **Smart Router** | Pattern-matches common requests | Faster responses, reduced API costs |
| **Memory System** | Remembers context, preferences, history | Continuity across conversations |
| **Agent Hierarchy** | Specialized agents for different domains | Right expertise for each task |

**Why native collector + QuoxFlow?** Self-hosted, fast, and extensible. The collector handles chat/voice/fleet APIs natively, while QuoxFlow provides a TypeScript workflow engine. Your data stays on your infrastructure.

### Layer 3: Execution (The Hands)

Commands need to reach your servers. This layer handles secure execution:

| Component | Purpose |
|-----------|---------|
| **Bastion Host** | Single secure gateway to all infrastructure |
| **QuoxAgent Agents** | Lightweight agents running on each managed host |
| **SSH Connections** | Encrypted command execution |

**Why a Bastion?** Security. Your servers are not exposed directly. All access flows through a single, hardened entry point with full audit logging.

### Layer 4: Infrastructure (Your Servers)

The actual hosts, VMs, containers, and services you are managing:

| Category | Examples |
|----------|----------|
| **Hypervisors** | Proxmox nodes running VMs and containers |
| **Docker Hosts** | Containers running applications |
| **Monitoring** | Grafana, Prometheus, Uptime Kuma |
| **Storage** | NAS, TrueNAS systems |
| **Network** | pfSense, Pi-hole DNS |

---

## How Data Flows

Understanding how your request travels through the system helps you troubleshoot and extend QuoxCORE.

### Request Flow: Text Commands

\`\`\`
1. You type: "check disk space on docker01"
                    │
                    ▼
2. Dashboard sends to collector (/collector/chat)
                    │
                    ▼
3. Smart Router checks: Is this a known pattern?
         │                        │
         │ YES                    │ NO
         ▼                        ▼
4a. Direct execution      4b. Send to Claude with context
    (faster, no AI cost)      - System prompt + self-knowledge
         │                    - Memory context (WSM + semantic)
         │                    - Agent-specific capabilities
         │                        │
         └────────────┬───────────┘
                      │
                      ▼
5. Execute command via QuoxAgent agent or SSH
                      │
                      ▼
6. Response flows back through same path
                      │
                      ▼
7. Dashboard displays formatted result
\`\`\`

### Request Flow: Voice Commands

\`\`\`
1. You speak into microphone
                    │
                    ▼
2. Audio sent to /collector/webhook/transcribe
                    │
                    ▼
3. Whisper AI converts speech to text
                    │
                    ▼
4. Processed as text command (see above)
                    │
                    ▼
5. Response sent to /collector/webhook/speak
                    │
                    ▼
6. ElevenLabs converts text to speech
                    │
                    ▼
7. Audio plays through speakers
\`\`\`

### Memory Flow

\`\`\`
Every Conversation
        │
        ├──▶ Episodic Memory (full logs, by date)
        │
        ├──▶ Semantic Memory (extracted facts, preferences)
        │
        ├──▶ Entity Memory (hosts, services, relationships)
        │
        └──▶ Working Set Memory (active context, open loops)

On Next Request
        │
        ├──◀ WSM provides current focus, recent entities
        │
        ├──◀ Semantic provides relevant learned facts
        │
        └──◀ Hybrid search ranks and retrieves context
\`\`\`

---

## Technology Choices

Every technology choice has a reason. Here is why QuoxCORE uses what it uses.

### Frontend Stack

| Technology | Why |
|------------|-----|
| **React 19** | Component architecture, strong ecosystem, fast rendering |
| **Vite** | Lightning-fast dev server and builds (10x faster than Webpack) |
| **React Router** | Clean URL-based navigation |
| **CSS (custom)** | Full control over HAL-9000 aesthetic, no framework bloat |

### Backend Stack

| Technology | Why |
|------------|-----|
| **Collector** | Native Express service for chat, voice, and fleet APIs |
| **QuoxFlow** | TypeScript workflow engine with registered workflows |
| **Docker** | Consistent deployment, easy updates, isolation |
| **Claude API** | Best-in-class reasoning for infrastructure commands |
| **Qdrant** | Vector database for semantic memory search |

### Execution Stack

| Technology | Why |
|------------|-----|
| **QuoxAgent (Go)** | Lightweight binary, compiles to single executable, low overhead |
| **SSH** | Industry standard for secure remote execution |
| **Bastion pattern** | Security best practice for infrastructure access |

### Why These Choices?

1. **Self-hosted first** - Your data stays on your infrastructure
2. **Extensible** - Each component can be replaced or extended
3. **Observable** - Full logging and audit trails throughout
4. **Performant** - Smart Router bypasses AI for common patterns (cheaper, faster)

---

## Agent Architecture

QuoxCORE uses a hierarchical agent system where specialized agents handle different domains.

### Agent Hierarchy

\`\`\`
Level 0: ORCHESTRATOR
         QuoxCORE (full access, coordinates all agents)
              │
              ├────────────────┬────────────────┐
              ▼                ▼                ▼
Level 1: MANAGERS
         WARDEN          DAEDALUS            (others)
         (Security)    (Infrastructure)
              │                │
              ▼                ▼
Level 2: SPECIALISTS
         CIPHER           VAULT           SCHOLAR
         (Network)       (Storage)       (Analytics)
              │
              ▼
Level 3: WORKERS (task-specific agents)

Level 4: OBSERVERS (read-only monitoring)
\`\`\`

### Agent Domains

| Agent | Domain | Key Capabilities |
|-------|--------|------------------|
| **QuoxCORE** | Orchestration | Full access, delegation, coordination |
| **WARDEN** | Security | Threat detection, access control, auditing |
| **DAEDALUS** | Infrastructure | Host management, deployments, scaling |
| **CIPHER** | Network | Network ops, connectivity, troubleshooting |
| **VAULT** | Storage | Backup operations, storage management |
| **SCHOLAR** | Analytics | Pattern detection, anomaly detection |
| **ARCHIVIST** | Memory | Knowledge management, memory extraction |

### Why Hierarchy?

1. **Separation of concerns** - Each agent is expert in its domain
2. **Security boundaries** - Agents only access what they need
3. **Escalation paths** - Complex issues route to appropriate experts
4. **Parallel processing** - Multiple agents can work simultaneously

---

## Integration Points

QuoxCORE is designed to integrate with your existing tools.

### Inbound (Things Talking to QuoxCORE)

| Integration | Mechanism | Use Case |
|-------------|-----------|----------|
| Web Browser | React app on port 80 | Primary user interface |
| API Clients | Collector REST API | Programmatic access |
| Voice Input | Whisper transcription | Hands-free operation |
| Slack/Telegram | QuoxFlow connectors | Chat-based commands |

### Outbound (QuoxCORE Talking to Things)

| Integration | Mechanism | Use Case |
|-------------|-----------|----------|
| Linux Hosts | SSH via bastion | Command execution |
| Docker Hosts | QuoxAgent agent API | Container management |
| Proxmox | API (via collector) | VM and LXC control |
| Monitoring | Prometheus/Grafana | Metrics and dashboards |
| Notifications | ElevenLabs, Slack | Alerts and responses |

### Extending QuoxCORE

New integrations follow this pattern:

1. **Add collector endpoint or QuoxFlow workflow** for the new service
2. **Register capability** in the agent that owns the domain
3. **Add Smart Router pattern** for common operations (optional)
4. **Update memory** to track new entity types

---

## Security Model

Security is not an afterthought - it is built into every layer.

### Defense in Depth

| Layer | Protection |
|-------|------------|
| **Network** | Bastion host, no direct server exposure |
| **Authentication** | SSH keys (no passwords in transit) |
| **Authorization** | Agent permissions, memory domain boundaries |
| **Audit** | AEE protocol logs every action with full envelope trail |
| **Execution** | Safety levels (GREEN/BLUE/AMBER/RED) with approval gates |

### Safety Levels

| Level | Description | Approval Required? |
|-------|-------------|-------------------|
| **GREEN** | Safe, read-only operations | No |
| **BLUE** | Low-risk, logged operations | No |
| **AMBER** | Caution, potentially impactful | Yes |
| **RED** | Critical, system-affecting | Explicit authorization |

### What QuoxCORE Never Does

- Store passwords in memory (credentials use SSH keys)
- Execute commands without audit trail
- Bypass safety gates for destructive operations
- Expose internal services directly to internet

---

## Key Terms Glossary

| Term | Plain English Explanation |
|------|---------------------------|
| **AEE Protocol** | A messaging format that ensures every action is logged and traceable |
| **Bastion Host** | A secure gateway server - the single front door to your infrastructure |
| **Context Injection** | Giving Claude relevant information before it answers your question |
| **QuoxAgent** | QuoxCORE Helper Agent - lightweight software running on each managed server |
| **Collector** | Native Express service that handles chat, voice, and fleet API endpoints |
| **QuoxFlow** | TypeScript workflow engine for automation and orchestration |
| **Smart Router** | Pattern matching that handles common requests without calling AI |
| **SSH** | Secure Shell - encrypted protocol for running commands on remote servers |
| **WSM** | Working Set Memory - the active context QuoxCORE maintains about your current work |
| **Webhook** | A URL endpoint that triggers an action when called |

---

## For Technical Readers

The sections above give the conceptual overview. Below is the detailed technical reference from the architecture documentation.

---

`;

export default function ArchitecturePage() {
  return (
    <MarkdownPage
      content={architectureContent + content}
      title="System Architecture"
      lead="QuoxCORE is an AI-powered command center for infrastructure management. This guide explains how all the pieces fit together - from high-level concepts to technical implementation details."
    />
  )
}
