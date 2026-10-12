import MarkdownPage from './MarkdownPage'
import content from '../../../docs/PHASE_B_COMPLETE.md?raw'

// Beginner-friendly intro
const beginnerIntro = `
## What is the Workspace?

The Workspace is your enterprise command center within QuoxCORE. It organizes everything into a clear hierarchy and lets you manage AI tools, workflows, and assistants with proper access controls.

**In simple terms:** Think of the Workspace like a company building. The company (Organization) has floors (Divisions), departments on each floor, and teams within departments. The Workspace helps you organize who can see and use what.

### Why Do You Need a Workspace?

As your AI infrastructure grows, you need structure:

- **Organization** - Keep tools and assistants organized by team/department
- **Access Control** - Share the right things with the right people
- **Asset Management** - Track all your AI tools, workflows, and assistants in one place
- **Scope-based Views** - See only what's relevant to your current context

### Key Concepts Explained

| Term | What It Means |
|------|---------------|
| **Organization** | Your company or top-level group |
| **Division** | Major unit within an org (like "Engineering" or "Operations") |
| **Department** | Sub-unit within a division (like "Backend Team" or "DevOps") |
| **Team** | Working group of people |
| **Scope** | A "lens" that filters what you see based on where you are in the hierarchy |
| **Share Policy** | Rules for who can see an asset (private, team-only, org-wide, etc.) |

### What Can You Manage?

| Asset Type | What It Is |
|------------|------------|
| **Tools** | Individual capabilities agents can use (MCP servers, APIs, scripts) |
| **Workflows** | Multi-step automations that chain tools together |
| **Assistants** | AI personas with specific knowledge and capabilities |
| **Tags** | Labels to categorize and find assets easily |

### The Scope System

The scope system is like a filter for your view:

1. **Select a scope** from the dropdown (org, division, department, or team)
2. **See relevant assets** - only items visible at that scope level appear
3. **Navigate the hierarchy** - use breadcrumbs to move up and down

> **Example:** If you're in the "DevOps Team" scope, you'll see tools shared with your team, your department, your division, and org-wide tools. You won't see tools that are private to other teams.

### Share Policies

Control who sees your assets:

| Policy | Who Can See |
|--------|-------------|
| **Private** | Only you (the creator) |
| **Team** | Your team members |
| **Department** | Everyone in your department |
| **Division** | Everyone in your division |
| **Org-Wide** | Everyone in the organization |
| **Explicit** | Specific users/teams you choose |

---

`;

export default function WorkspacePage() {
  return (
    <MarkdownPage
      content={beginnerIntro + content}
      title="Workspace Documentation"
      lead="The Workspace provides organization hierarchy, asset management, and scoped access control for your enterprise AI infrastructure."
    />
  )
}
