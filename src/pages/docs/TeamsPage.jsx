import MarkdownPage from './MarkdownPage'

const content = `
## What are Teams?

Teams are the smallest organizational unit in QuoxCORE. They represent working groups of people who collaborate on specific tasks, projects, or domains.

**In simple terms:** A team is like a project group. Team members can share an inbox, have a dedicated AI assistant, and manage resources specific to their work.

### Team Features

| Feature | Description |
|---------|-------------|
| **Members** | Add users from your organization with specific team roles |
| **Inbox** | Shared inbox for approvals, tasks, and notifications |
| **AI Assistant** | Team-specific assistant that knows your domain |
| **Scope** | Resources scoped to the team for privacy |

### Team Roles

Teams have their own role system separate from organization roles:

| Role | Permissions |
|------|-------------|
| **Admin** | Manage team settings, members, and resources |
| **Member** | Full access to team resources, can complete inbox items |
| **Viewer** | Read-only access to team resources |

> **Note:** Only organization admins can delete teams. Team admins can manage members but cannot delete the team itself.

---

## Managing Teams

### Creating a Team

1. Navigate to **Teams** from the sidebar
2. Click **Create Team**
3. Enter a name and optional description
4. Optionally attach to a division or department scope
5. You become the team **admin**

### Adding Members

1. Go to your team's management page
2. Click **Add Member** in the Members section
3. Select a user from your organization
4. Choose a role (Admin, Member, or Viewer)

### Team Inbox

Each team can have its own inbox for:
- Approval requests routed to the team
- Tasks assigned to team members
- Alerts and notifications

---

## API Reference

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| \`GET\` | \`/api/orgs/:orgId/teams\` | List all teams |
| \`POST\` | \`/api/orgs/:orgId/teams\` | Create team |
| \`GET\` | \`/api/orgs/:orgId/teams/:teamId\` | Get team details |
| \`PATCH\` | \`/api/orgs/:orgId/teams/:teamId\` | Update team |
| \`DELETE\` | \`/api/orgs/:orgId/teams/:teamId\` | Delete team (org admin only) |
| \`POST\` | \`/api/orgs/:orgId/teams/:teamId/members\` | Add member |
| \`PATCH\` | \`/api/orgs/:orgId/teams/:teamId/members/:userId\` | Update member role |
| \`DELETE\` | \`/api/orgs/:orgId/teams/:teamId/members/:userId\` | Remove member |
| \`GET\` | \`/api/orgs/:orgId/my-teams\` | Get user's teams with roles |

### Create Team

\`\`\`bash
curl -X POST /api/orgs/<orgId>/teams \\
  -H "Authorization: Bearer <token>" \\
  -d '{"name": "API Team", "slug": "api-team", "description": "Backend API development"}'
\`\`\`

### Add Team Member

\`\`\`bash
curl -X POST /api/orgs/<orgId>/teams/<teamId>/members \\
  -H "Authorization: Bearer <token>" \\
  -d '{"user_id": "<userId>", "role": "member"}'
\`\`\`

### Get My Teams

\`\`\`bash
curl /api/orgs/<orgId>/my-teams \\
  -H "Authorization: Bearer <token>"
\`\`\`

Returns teams where the current user is a member, including their role in each team.

---

## Frontend Implementation

### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| \`TeamsView\` | \`/src/pages/views/TeamsView.jsx\` | Team listing |
| \`TeamManagementView\` | \`/src/pages/views/TeamManagementView.jsx\` | Team detail/settings |
| \`TeamCard\` | \`/src/components/org/TeamCard.jsx\` | Team card display |

### Routes

\`\`\`jsx
<Route path="/teams" element={<TeamsView />} />
<Route path="/teams/:teamId" element={<TeamManagementView />} />
\`\`\`

### Context

\`\`\`javascript
import { useWorkspace } from '../../contexts/WorkspaceContext'

const {
  getTeams,           // Fetch teams for org
  createTeam,         // Create new team
  updateTeam,         // Update team details
  deleteTeam,         // Delete team
  addTeamMember,      // Add member to team
  updateTeamMemberRole, // Change member role
  removeTeamMember    // Remove member from team
} = useWorkspace()
\`\`\`

---

## Database Schema

### Tables

\`\`\`sql
-- Teams
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  parent_team_id TEXT REFERENCES teams(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  attach_scope_id TEXT REFERENCES scopes(id),
  created_by TEXT REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Team memberships
CREATE TABLE team_memberships (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member', -- admin, member, viewer
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
\`\`\`

### Scope Integration

Teams automatically get a scope (depth=3) for resource isolation:

\`\`\`sql
INSERT INTO scopes (id, org_id, type, entity_id, parent_scope_id, depth)
VALUES ('<scope_id>', '<org_id>', 'team', '<team_id>', '<parent_scope>', 3);
\`\`\`

---

## Best Practices

### Team Structure

- **Keep teams focused** - Each team should have a clear purpose
- **Right-size membership** - Too many members can dilute accountability
- **Use descriptive names** - Make it clear what the team does
- **Assign team admins** - Ensure someone can manage day-to-day operations

### Team Inboxes

- **Route appropriately** - Use routing rules to direct items to the right team
- **Set escalation policies** - Define what happens when items aren't handled
- **Monitor queue depth** - Watch for backlogs that indicate staffing issues

---

*Last updated: 2026-01-22*
`

export default function TeamsPage() {
  return (
    <MarkdownPage
      content={content}
      title="Teams"
      lead="Teams are working groups within your organization. They have dedicated members, inboxes, and AI assistants for domain-specific collaboration."
    />
  )
}
