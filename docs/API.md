# QuoxCORE API Reference

This document covers the core webhooks, endpoints, and API integrations. It is not exhaustive; newer surfaces are summarised below and tracked in the STATUS_AND_LIMITS ledgers.

> **Shipped 2026-07 (not yet tabled below):**
> - **LLM failover:** `GET /chat/status` on the collector exposes `degraded` / `fallback_hint` for the failover chain (plan primary, then policy fallback, then system default); CLI `quox llm status`. Failover is visible in evidence (`execution.failover`, `quox.llm.failover` audit hops).
> - **Agentic team rooms:** auth `POST /api/internal/matrix/provision-node` / `POST /api/internal/matrix/deprovision-node` (service key), tasks `POST /api/internal/teams/backfill-matrix`, on-demand `POST /api/teams/:teamId/provision-room`; CLI `quox team provision-room <teamId>`. See `STATUS_AND_LIMITS_COMMS.md`.
> - **QuoxChat Pro:** handoff provisioning and operator relay (`/quoxchat/internal/operator-message`), transcript email (`/quoxchat/transcript/email`), poll and visitor upload, all licence-gated (402 fail-closed) on the paid public paths. See `STATUS_AND_LIMITS_QUOXCHAT.md`.

## n8n Webhooks

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/webhook/chat` | POST | Send message to Claude |
| `/webhook/speak` | POST | Text-to-speech (ElevenLabs) |
| `/webhook/transcribe` | POST | Speech-to-text (Whisper) |
| `/webhook/quick-action` | POST | Infrastructure actions |

---

## QuoxAgent Collector API (port 9848)

The QuoxAgent Collector runs on the Quox host and aggregates data from all QuoxAgent agents.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/heartbeat` | POST | Receive agent heartbeat |
| `/api/v1/agents` | GET | List all agents |
| `/api/v1/agents/:id` | GET | Get single agent |
| `/api/v1/fleet/summary` | GET | Fleet summary stats |
| `/api/v1/check/:hostId` | GET | Check if host has QuoxAgent |
| `/install` | GET | Serve install script |
| `/download/quoxagent-linux-amd64` | GET | Download binary |
| `/health` | GET | Collector health |
| `/metrics` | GET | Prometheus metrics |
| `/ws` | WS | Real-time updates |
| `/ws/agents/events` | WS | Agent event stream (UAM) |
| `/api/v1/agents/sessions` | GET | List all agent sessions |

---

## QuoxAgent Agent API (port 9847)

Each QuoxAgent agent exposes a local API on the host it runs on.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Agent health check |
| `/api/v1/jobs` | GET/POST | List/submit jobs |
| `/api/v1/sessions` | GET | Claude sessions |
| `/metrics` | GET | Prometheus metrics |

---

## AEE (Agent Envelope Exchange) Server Endpoints

The AEE protocol uses the collector on port 9848 for envelope storage and retrieval.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/aee/store` | POST | Store single envelope |
| `/aee/sync` | POST | Batch sync from browser |
| `/aee/:id` | GET | Get envelope by ID |
| `/aee/conversation/:corr` | GET | Get full conversation by correlation ID |
| `/aee/conversations` | GET | List all conversations |
| `/aee/query` | GET | Query with filters |
| `/aee/stats` | GET | Get AEE statistics |

---

## UAM WebSocket API

The Universal Agent Monitor provides real-time agent session updates.

### Endpoint

```
GET /ws/agents/events
```

### Query Parameter Filters

| Parameter | Description |
|-----------|-------------|
| `agent_type` | cli, api, local, custom (comma-separated) |
| `host_id` | Filter by host (comma-separated) |
| `session_id` | Filter by session (comma-separated) |
| `event_type` | Filter by event type (comma-separated) |

### Dynamic Filter Update

Clients can update filters by sending JSON:

```json
{"agent_types": ["cli"], "host_ids": ["docker01"]}
```

### Event Types

| Event | Description |
|-------|-------------|
| `session.start` | New agent session started |
| `session.end` | Session completed |
| `session.status` | Status change (running, idle, waiting) |
| `activity.message` | User or agent message |
| `activity.thinking` | Agent reasoning phase |
| `activity.tool_call` | Tool invocation |
| `activity.tool_result` | Tool response |
| `activity.file_change` | File modification |
| `activity.code_exec` | Code execution |
| `metrics.tokens` | Token usage update |
| `metrics.cost` | Cost tracking |

---

## Plugin/License API

Plugin and license management endpoints.

### From pluginClient.js

```javascript
import {
  getLicenseStatus,
  activateLicense,
  getPlugins,
  enablePlugin,
  disablePlugin,
  requestTrialLicense
} from './services/pluginClient'

// Get license status
const license = await getLicenseStatus()

// Activate with a license key (JSON format)
const result = await activateLicense(licenseKeyJSON)

// Get all plugins with their status
const { plugins } = await getPlugins()

// Enable/disable plugins (requires license)
await enablePlugin('soc')
await disablePlugin('soc')

// Request a 30-day trial
const trial = await requestTrialLicense('Customer Name')
```

---

## Enterprise Entity Model API

The Enterprise Entity Model API provides full CRUD operations for agents, tool assignments, and entity management within organizations.

### Agent Management API

All agent endpoints require authentication and organization membership.

| Endpoint | Method | Purpose | Required Role |
|----------|--------|---------|---------------|
| `/api/orgs/:orgId/agents` | GET | List all agents in org | member |
| `/api/orgs/:orgId/agents` | POST | Create new agent | builder |
| `/api/orgs/:orgId/agents/:agentId` | GET | Get agent with full details | member |
| `/api/orgs/:orgId/agents/:agentId` | PATCH | Update agent | builder |
| `/api/orgs/:orgId/agents/:agentId` | DELETE | Retire agent (soft delete) | builder |
| `/api/orgs/:orgId/agents/tree` | GET | Get agent hierarchy tree | member |

#### Query Parameters for GET /agents

| Parameter | Default | Description |
|-----------|---------|-------------|
| `includeRetired` | false | Include retired agents |
| `includeTools` | false | Include tool counts and limit status |

#### Create/Update Agent Body

```json
{
  "agent_id": "security_analyst",
  "name": "Security Analyst",
  "description": "Analyzes security events and threats",
  "icon": "🔐",
  "level": 2,
  "parent_agent_id": null,
  "manager_assistant_id": null,
  "home_scope_id": null,
  "domains": ["security", "monitoring"],
  "capabilities": ["execute_commands", "read_files", "audit_logging"],
  "system_prompt_additions": "Additional context for this agent..."
}
```

#### Agent Levels

| Level | Role | Description |
|-------|------|-------------|
| 0 | Orchestrator | Top-level coordinator (QuoxCORE) |
| 1 | Manager | Domain managers (SENTINEL, NOVA) |
| 2 | Specialist | Task specialists (CIPHER, VAULT) |
| 3 | Worker | Task execution agents |
| 4 | Observer | Monitoring and logging only |

### Tool Assignment API

Agents are the ONLY entities that can access tools. Tools must be explicitly assigned.

| Endpoint | Method | Purpose | Required Role |
|----------|--------|---------|---------------|
| `/api/orgs/:orgId/agents/:agentId/tools` | GET | List agent's tool assignments | member |
| `/api/orgs/:orgId/agents/:agentId/tools` | POST | Assign tool to agent | builder |
| `/api/orgs/:orgId/agents/:agentId/tools/:assignmentId` | PATCH | Update assignment | builder |
| `/api/orgs/:orgId/agents/:agentId/tools/:assignmentId` | DELETE | Revoke tool assignment | builder |

#### Tool Limits

The system enforces tool limits per agent to encourage focused, specialized agents:

| Threshold | Count | Behavior |
|-----------|-------|----------|
| Warning | 5+ | UI warning displayed |
| Soft Limit | 8+ | Strong warning, suggest splitting |
| Hard Limit | 15 | Cannot add more tools |

#### Assign Tool Body

```json
{
  "tool_installation_id": "uuid-of-installed-tool",
  "access_mode": "full",
  "scope_id": null,
  "max_daily_invocations": 100,
  "allowed_operations": ["read", "execute"]
}
```

#### Access Modes

| Mode | Description |
|------|-------------|
| `full` | Complete access to all tool operations |
| `read_only` | Can only read/query, not modify |
| `with_approval` | Requires HITL approval for each use |

### Required Capabilities (RBAC)

| Capability | Description | Roles |
|------------|-------------|-------|
| `AGENTS_MANAGE` | Create, update, delete agents | owner, admin, builder |
| `TOOLS_ASSIGN` | Assign tools to agents | owner, admin, builder |
| `AGENTS_VIEW` | View agent details | all members |

### AOCL Layer Tracking

All agent operations emit audit events with AOCL layer tracking:

```json
{
  "action": "directory.agent.tool_assign",
  "metadata": {
    "agent_id": "security_analyst",
    "tool_id": "ssh_exec",
    "aocl_layers": ["L6_POLICY", "L7_SEMANTIC", "L8_DECISION", "L9_EXECUTION"]
  }
}
```

---

## Dashboard Service Clients

### QuoxAgent Client

`src/services/quoxagentClient.js` - QuoxAgent API client

```javascript
import { getAgents, getFleetSummary, checkHost } from './quoxagentClient'

const agents = await getAgents()
const summary = await getFleetSummary()
const hasAgent = await checkHost('docker01')
```

### Proxmox Client

`src/services/proxmoxClient.js` - Proxmox API client

Note: Direct Proxmox API calls are blocked by CORS. Use n8n proxy instead.

### Memory Manager

`src/services/memoryManager.js` - Memory system API

See [MEMORY_SYSTEM.md](./MEMORY_SYSTEM.md) for full API documentation.

### Entity Registry

`src/services/entityRegistry.js` - Assistant manifest API

See [AGENTS.md](./AGENTS.md) for full API documentation.

---

## API Key Configuration

Edit `/opt/n8n/.env`:

```env
OPENAI_API_KEY=sk-...      # For Whisper STT
ELEVENLABS_API_KEY=...     # For TTS
```

Then restart: `docker compose restart n8n`
