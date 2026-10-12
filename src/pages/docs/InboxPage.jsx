import MarkdownPage from './MarkdownPage'

const content = `
## What is Human-in-the-Loop (HITL)?

Human-in-the-Loop is a pattern where automated systems pause and wait for human input before proceeding. This ensures critical decisions have human oversight.

**In simple terms:** When an AI agent or workflow needs approval, clarification, or a decision, it creates an "inbox item" and waits. A human reviews it, takes action, and the system continues.

### Why HITL Matters

| Benefit | Description |
|---------|-------------|
| **Safety** | Prevent automated systems from taking irreversible actions |
| **Compliance** | Ensure human approval for regulated processes |
| **Quality** | Add human judgment to AI-generated content |
| **Accountability** | Create audit trails of who approved what |

---

## The Inbox System

### What is an Inbox?

An inbox is a queue of items waiting for human attention. Inboxes can be:

| Type | Description |
|------|-------------|
| **Organization** | Items for the entire organization |
| **Division** | Items scoped to a division |
| **Department** | Items scoped to a department |
| **Team** | Items for a specific team |
| **User** | Personal inbox for individual user |

### Inbox Items

Items represent work waiting for human action:

| Type | Purpose | Example |
|------|---------|---------|
| \`approval\` | Binary approve/reject decision | "Deploy to production?" |
| \`question\` | Free-form response needed | "What timeout value?" |
| \`task\` | Work to be completed | "Review this PR" |
| \`alert\` | Informational notification | "Build completed" |
| \`review\` | Content review request | "Check AI response" |
| \`escalation\` | Escalated from another item | "Unhandled for 2 hours" |

### Item Lifecycle

\`\`\`
pending → in_progress → approved/rejected/resolved
                     ↘ escalated (on timeout)
                     ↘ expired (if not handled)
\`\`\`

| Status | Description |
|--------|-------------|
| \`pending\` | Awaiting action |
| \`in_progress\` | Being worked on |
| \`approved\` | Approved (for approval type) |
| \`rejected\` | Rejected (for approval type) |
| \`resolved\` | Completed |
| \`escalated\` | Moved to higher authority |
| \`expired\` | Timeout reached, no action taken |

---

## Routing Rules

Routing rules determine how items are assigned to inboxes and users.

### Rule Components

| Field | Description |
|-------|-------------|
| \`condition_type\` | Type of item to match |
| \`condition_scope_type\` | Scope to match (org, division, team) |
| \`action_type\` | What to do (assign_inbox, assign_user, escalate) |
| \`target_id\` | Where to route the item |
| \`priority\` | Rule ordering (higher = first) |

### Example Rules

**Route approvals to the Security team:**
\`\`\`json
{
  "name": "Security Approvals",
  "condition_type": "approval",
  "condition_scope_type": "org",
  "action_type": "assign_inbox",
  "target_id": "<security-team-inbox-id>",
  "priority": 100
}
\`\`\`

**Escalate after 2 hours:**
\`\`\`json
{
  "name": "Escalation Policy",
  "condition_type": "approval",
  "action_type": "escalate",
  "target_id": "<manager-inbox-id>",
  "escalation_timeout": 7200,
  "priority": 50
}
\`\`\`

---

## API Reference

### Inbox Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| \`POST\` | \`/api/orgs/:orgId/inboxes\` | Create inbox |
| \`GET\` | \`/api/orgs/:orgId/inboxes\` | List inboxes |
| \`GET\` | \`/api/orgs/:orgId/inboxes/:inboxId\` | Get inbox |
| \`PATCH\` | \`/api/orgs/:orgId/inboxes/:inboxId\` | Update inbox |
| \`DELETE\` | \`/api/orgs/:orgId/inboxes/:inboxId\` | Delete inbox |

### Item Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| \`POST\` | \`/api/orgs/:orgId/inbox-items\` | Create item |
| \`GET\` | \`/api/orgs/:orgId/inbox-items\` | List items (with filters) |
| \`GET\` | \`/api/orgs/:orgId/inbox-items/:itemId\` | Get item |
| \`PATCH\` | \`/api/orgs/:orgId/inbox-items/:itemId\` | Update item status |

### Routing Rule Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| \`POST\` | \`/api/orgs/:orgId/routing-rules\` | Create rule |
| \`GET\` | \`/api/orgs/:orgId/routing-rules\` | List rules |
| \`PATCH\` | \`/api/orgs/:orgId/routing-rules/:ruleId\` | Update rule |
| \`DELETE\` | \`/api/orgs/:orgId/routing-rules/:ruleId\` | Delete rule |

### Create Inbox Item

\`\`\`bash
curl -X POST /api/orgs/<orgId>/inbox-items \\
  -H "Authorization: Bearer <token>" \\
  -d '{
    "inbox_id": "<inbox_id>",
    "type": "approval",
    "title": "Deploy to production",
    "description": "Release v2.1.0 to production servers",
    "priority": "high",
    "metadata": {"version": "2.1.0", "commit": "abc123"}
  }'
\`\`\`

### Update Item Status

\`\`\`bash
curl -X PATCH /api/orgs/<orgId>/inbox-items/<itemId> \\
  -H "Authorization: Bearer <token>" \\
  -d '{"status": "approved", "resolution_note": "LGTM"}'
\`\`\`

---

## Frontend Implementation

### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| \`InboxView\` | \`/src/pages/views/InboxView.jsx\` | Main inbox UI |

### InboxView Features

- **Scope filtering** - Filter by org, division, or team
- **Status tabs** - Quick filter by item status
- **Priority badges** - Visual priority indicators
- **Item detail sidebar** - View and action items
- **Create/resolve/reopen** - Full item lifecycle

### Routes

\`\`\`jsx
<Route path="/inbox" element={<InboxView />} />
\`\`\`

---

## Database Schema

### Tables

\`\`\`sql
-- Inboxes
CREATE TABLE inboxes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  inbox_type TEXT NOT NULL, -- org, division, department, team, user
  owner_id TEXT NOT NULL,   -- ID of the owning entity
  name TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Inbox items
CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  inbox_id TEXT REFERENCES inboxes(id),
  scope_id TEXT REFERENCES scopes(id),
  type TEXT NOT NULL,       -- approval, question, task, alert, review, escalation
  status TEXT DEFAULT 'pending',
  priority TEXT DEFAULT 'medium',
  title TEXT NOT NULL,
  description TEXT,
  source_type TEXT,         -- agent, workflow, manual
  source_id TEXT,
  assignee_type TEXT,       -- user, team
  assignee_id TEXT,
  metadata_json TEXT,
  resolution_note TEXT,
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Routing rules
CREATE TABLE routing_rules (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  condition_type TEXT,       -- Item type to match
  condition_scope_type TEXT, -- Scope type to match
  condition_scope_id TEXT,
  action_type TEXT NOT NULL, -- assign_inbox, assign_user, escalate
  target_id TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  escalation_timeout INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
\`\`\`

---

## Integration with Workflows

### Workflow Wait States

Workflows can pause for human input:

\`\`\`javascript
// Create approval request and wait
const item = await createInboxItem({
  type: 'approval',
  title: 'Approve deployment',
  source_type: 'workflow',
  source_id: workflowRunId
});

// Workflow pauses here until item is resolved
await waitForResolution(item.id);

// Check result
if (item.status === 'approved') {
  // Continue with deployment
} else {
  // Handle rejection
}
\`\`\`

### n8n Integration (Planned)

HITL steps will map to n8n "Wait" nodes with webhook callbacks for seamless workflow integration.

---

## Best Practices

### Inbox Organization

- **Create focused inboxes** - Don't dump everything in one place
- **Use meaningful names** - "Production Approvals" not "Inbox 1"
- **Set up routing rules** - Automate item distribution
- **Monitor queue depth** - Watch for backlogs

### Item Management

- **Set appropriate priorities** - Reserve "critical" for truly urgent items
- **Add context** - Include enough detail to make decisions
- **Use expiration wisely** - Set deadlines for time-sensitive items
- **Document resolutions** - Add notes explaining decisions

### Escalation

- **Define escalation paths** - Know where items go when unhandled
- **Set reasonable timeouts** - Balance urgency with workload
- **Notify on escalation** - Alert the escalation target

---

*Last updated: 2026-01-22*
`

export default function InboxPage() {
  return (
    <MarkdownPage
      content={content}
      title="HITL & Inbox"
      lead="Human-in-the-Loop brings human oversight to automated systems. The inbox system manages approvals, tasks, and notifications that need human attention."
    />
  )
}
