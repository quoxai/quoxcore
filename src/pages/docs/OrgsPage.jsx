import MarkdownPage from './MarkdownPage'

const content = `
## What are Organizations?

Organizations are the top-level containers for everything in QuoxCORE. Think of an organization as a company, department, or project team that groups related users and resources together.

**In simple terms:** An organization is like a folder that contains your teams, assistants, workflows, and inboxes. Everyone in the organization can share and collaborate on these resources.

### Organization Hierarchy

QuoxCORE uses a 4-level hierarchy to organize your workspace:

\`\`\`
Organization (depth=0)
└── Division (depth=1)
    └── Department (depth=2)
        └── Team (depth=3)
\`\`\`

| Level | Purpose | Example |
|-------|---------|---------|
| **Organization** | Top-level container | "Acme Corp" |
| **Division** | Major business unit | "Engineering", "Operations" |
| **Department** | Functional group | "Frontend", "Backend", "DevOps" |
| **Team** | Working group | "API Team", "Security Team" |

### Scopes

Every level in the hierarchy has an associated **scope**. Scopes determine:

- What resources are visible at that level
- Who can access those resources
- What permissions apply

Scopes inherit permissions from their parent. If you have access to an organization, you have access to all divisions, departments, and teams within it (based on your role).

---

## Managing Organizations

### Creating an Organization

1. Navigate to **Organizations** from the sidebar
2. Click **Create Organization**
3. Enter a name and optional description
4. You become the **owner** with full administrative rights

### Organization Roles

| Role | Permissions |
|------|-------------|
| **Owner** | Full control, can delete org, transfer ownership |
| **Admin** | Manage members, settings, audit logs |
| **Builder** | Create assistants, agents, tools, workflows |
| **Runner** | Execute workflows, use assistants |
| **Viewer** | Read-only access |

### Inviting Members

1. Go to your organization's management page
2. Click **Invite Member**
3. Enter the email address and select a role
4. The user receives an invitation email with a link to join

---

## API Reference

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| \`GET\` | \`/api/orgs\` | List user's organizations |
| \`POST\` | \`/api/orgs\` | Create new organization |
| \`GET\` | \`/api/orgs/:orgId\` | Get organization details |
| \`PATCH\` | \`/api/orgs/:orgId\` | Update organization |
| \`DELETE\` | \`/api/orgs/:orgId\` | Delete organization |
| \`GET\` | \`/api/orgs/:orgId/members\` | List members |
| \`POST\` | \`/api/orgs/:orgId/members\` | Invite member |
| \`PATCH\` | \`/api/orgs/:orgId/members/:userId\` | Update member role |
| \`DELETE\` | \`/api/orgs/:orgId/members/:userId\` | Remove member |

### Create Organization

\`\`\`bash
curl -X POST /api/orgs \\
  -H "Authorization: Bearer <token>" \\
  -d '{"name": "My Organization", "slug": "my-org"}'
\`\`\`

### Invite Member

\`\`\`bash
curl -X POST /api/orgs/<orgId>/members \\
  -H "Authorization: Bearer <token>" \\
  -d '{"email": "user@example.com", "role": "builder"}'
\`\`\`

---

## Frontend Implementation

### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| \`OrgsView\` | \`/src/pages/views/OrgsView.jsx\` | Organization listing |
| \`OrgManagementView\` | \`/src/pages/views/OrgManagementView.jsx\` | Org detail/settings |
| \`OrgCard\` | \`/src/components/org/OrgCard.jsx\` | Organization card display |
| \`MembersList\` | \`/src/components/org/MembersList.jsx\` | Member management |

### Context

The \`WorkspaceContext\` manages organization state:

\`\`\`javascript
import { useWorkspace } from '../../contexts/WorkspaceContext'

function MyComponent() {
  const { currentOrg, myOrgs, isOrgAdmin } = useWorkspace()

  // currentOrg - The active organization
  // myOrgs - List of organizations user belongs to
  // isOrgAdmin - Whether user is admin of current org
}
\`\`\`

---

## Database Schema

### Tables

\`\`\`sql
-- Organizations
CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  logo_url TEXT,
  plan TEXT DEFAULT 'free',
  mfa_policy TEXT DEFAULT 'optional',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Organization memberships
CREATE TABLE org_memberships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'viewer',
  status TEXT DEFAULT 'active',
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Scopes for permission inheritance
CREATE TABLE scopes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  type TEXT NOT NULL, -- 'org', 'division', 'department', 'team'
  entity_id TEXT NOT NULL,
  parent_scope_id TEXT REFERENCES scopes(id),
  depth INTEGER NOT NULL DEFAULT 0
);
\`\`\`

---

*Last updated: 2026-01-22*
`

export default function OrgsPage() {
  return (
    <MarkdownPage
      content={content}
      title="Organizations"
      lead="Organizations are the top-level containers in QuoxCORE, grouping users, teams, and resources together with proper access control and scope management."
    />
  )
}
