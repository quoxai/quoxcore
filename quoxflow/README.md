# Quoxflow

[![License: Quox Community Source](https://img.shields.io/badge/licence-Quox%20Community%20Source%201.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

**Auditable Workflow Engine with n8n Compatibility**

> *"Every decision traced. Every action proven."*

Quoxflow combines minimal workflow primitives with enterprise-grade auditability using AEE envelope chains and AOCL control layers.

## Features

- **32 Node Archetypes** - Replace 400+ n8n node types
- **n8n Import** - Convert existing n8n workflows
- **Envelope Audit Trail** - Every action emits traceable AEE envelopes
- **7-Layer Control Pipeline** - Ingress → Identity → Policy → Context → Execute → Verify → Assemble
- **Policy Engine** - Expression-based rules with allow/deny/require_approval actions
- **Approval Workflows** - Human-in-the-loop with timeout and authorization
- **Evidence Storage** - Archive HTTP responses, logs, and data snapshots

## Quick Start

```bash
npm install
npm run build
npm test

# Start API server
npm run server
```

See [.env.example](.env.example) for configuration options.

## API Endpoints

```
GET  /health                      Health check

# Workflows
POST /api/workflows               Create workflow
GET  /api/workflows               List workflows
POST /api/workflows/:id/execute   Execute workflow
POST /api/workflows/import-n8n    Import n8n workflow

# Audit
GET  /api/executions              List executions
GET  /api/envelopes               Query envelopes
GET  /api/envelopes/:id/chain     Get causality chain

# Policy
POST /api/policies                Create policy
POST /api/policies/:id/test       Test policy

# Approvals
GET  /api/approvals               List approvals
POST /api/approvals/:id/approve   Approve request
POST /api/approvals/:id/deny      Deny request

# Evidence
GET  /api/evidence                List evidence
GET  /api/evidence/:id/content    Download evidence
```

## Node Types

| Category | Types |
|----------|-------|
| Triggers | `trigger:webhook`, `trigger:schedule`, `trigger:event` |
| Control Flow | `flow:condition`, `flow:switch`, `flow:loop`, `flow:parallel`, `flow:merge` |
| Actions | `call` (HTTP), `data:transform`, `data:set`, `data:aggregate` |
| Error Handling | `error:try`, `error:catch`, `error:throw` |
| Utilities | `util:wait`, `util:log`, `util:subworkflow` |

## Envelope Structure

Every action emits an AEE envelope:

```typescript
{
  id: "01JKXYZ...",           // ULID
  type: "task",               // command | task | event | query
  intent: "quoxflow.node.call.complete",
  corr: "wf-abc-123",         // Correlation ID
  reply_to: "01JKXYW...",     // Causality chain
  payload: { ... },
  evidence_refs: ["01JKX..."] // Linked evidence
}
```

## Policy Example

```json
{
  "id": "high-value-approval",
  "name": "High Value Transactions",
  "rules": [{
    "id": "require-approval",
    "condition": "${input.amount > 10000}",
    "action": {
      "type": "require_approval",
      "approvers": ["manager", "finance"]
    }
  }]
}
```

## Architecture

Based on [AEE](https://github.com/quoxai/aee) and [AOCL](https://github.com/quoxai/aocl).

See [docs/DESIGN.md](docs/DESIGN.md) for the full technical specification.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[Quox Community Source Licence 1.0](LICENSE): free self-hosted operation and independent extensions; protected core cannot be modified or redistributed without separate written permission.
