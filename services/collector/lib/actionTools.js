// Action Tracker Tools for Agent Use
// These tools allow agents to manage the user's Action Tracker board

/**
 * Action tool definitions for Claude/OpenAI function calling
 */
const actionToolDefinitions = [
  {
    name: 'action_add',
    description: 'Add a new action item to the user\'s Action Tracker board. Creates it in TODO status. Use when the user says "add to my tracker", "create a task", "add an action item", or similar.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The action item title. Keep it clear and actionable.'
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'urgent'],
          description: 'Priority level. Default medium if not specified by user.'
        },
        category: {
          type: 'string',
          description: 'Category tag (e.g., "legal", "financial", "technical", "personal")'
        },
        dueDate: {
          type: 'string',
          description: 'Due date in YYYY-MM-DD format (optional). Use camelCase `dueDate` (the tool maps to REST `due_date`).'
        },
        description: {
          type: 'string',
          description: 'Optional longer description or notes'
        },
        scope_id: {
          type: 'string',
          description: 'Optional scope ID to assign item to a specific team/department/division'
        }
      },
      required: ['title']
    }
  },
  {
    name: 'action_list',
    description: 'List action items from the user\'s Action Tracker. Use when the user asks "what\'s on my board", "show my tasks", "what actions do I have", or similar.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['todo', 'doing', 'done', 'all'],
          description: 'Filter by status column. Default "all".'
        },
        limit: {
          type: 'integer',
          description: 'Maximum items to return (default 20, max 100)'
        },
        scope_id: {
          type: 'string',
          description: 'Filter items by scope (team/department/division)'
        }
      },
      required: []
    }
  },
  {
    name: 'action_move',
    description: 'Move an action item to a different status column (TODO, DOING, DONE). Use when the user says "mark X as done", "start working on X", "move X to doing", or similar.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The action item ID. Use action_list first to find the ID.'
        },
        status: {
          type: 'string',
          enum: ['todo', 'doing', 'done'],
          description: 'Target status column'
        }
      },
      required: ['id', 'status']
    }
  },
  {
    name: 'action_update',
    description: 'Update fields on an existing action item. Use when the user wants to change priority, due date, description, or other fields on an existing action.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The action item ID. Use action_list first to find the ID.'
        },
        title: {
          type: 'string',
          description: 'New title (optional)'
        },
        description: {
          type: 'string',
          description: 'New description (optional)'
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'urgent'],
          description: 'New priority (optional)'
        },
        category: {
          type: 'string',
          description: 'New category (optional)'
        },
        dueDate: {
          type: 'string',
          description: 'New due date in YYYY-MM-DD format (optional). Use camelCase `dueDate` (the tool maps to REST `due_date`).'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'action_delete',
    description: 'Permanently delete an action item. Use only when the user explicitly asks to remove/delete an action. Confirm before deleting.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The action item ID to delete'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'action_analyse',
    description: 'Analyse all open action items on the board. Returns grouped stats, overdue count, stale items, and suggestions for which tasks could be delegated to agents. Use when the user asks "analyse my board", "what needs attention", "give me insights", or similar.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'action_delegate',
    description: 'Delegate an action item to an agentic objective in OpsDeck. Creates an objective from the action item, auto-starts it, and moves the action to DOING. Use when the user says "delegate this", "hand off to agents", "let the team handle this", or similar.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The action item ID to delegate. Use action_list first to find the ID.'
        },
        team_id: {
          type: 'string',
          description: 'Optional team ID to assign the objective to (e.g., "security-team", "quoxcore"). If omitted, auto-selects based on keywords.'
        }
      },
      required: ['id']
    }
  }
];

/**
 * Convert to Claude's tool format
 */
function getClaudeTools() {
  return actionToolDefinitions.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  }));
}

/**
 * System prompt addition for action-aware agents
 */
const actionSystemPrompt = `
## Action Tracker Tools

You have access to the user's **Action Tracker** — a Kanban board for tracking tasks through TODO, DOING, and DONE columns.

### Available Tools

**action_add** - Create a new action item (starts in TODO)
- Use when user says "add to my tracker", "create a task", "add an action item"
- Include priority if mentioned, otherwise default to medium

**action_list** - View action items on the board
- Use when user asks "what's on my board", "show my tasks", "what actions do I have"
- Filter by status to show specific columns

**action_move** - Move an item between columns
- Use when user says "mark X as done", "start X", "move X to doing"
- Always list items first to get the correct ID

**action_update** - Change an item's fields
- Use when user wants to change priority, due date, category, etc.

**action_delete** - Remove an item permanently
- Confirm with user before deleting

**action_analyse** - Analyse all open items on the board
- Use proactively when user asks "what should I focus on", "analyse my board", "give me insights"
- Returns: overdue items, stale tasks, items that could be delegated to agents, grouped stats

**action_delegate** - Delegate an action item to an agentic objective
- Creates an objective in OpsDeck from the action item and auto-starts it
- Use when user says "delegate this", "hand off to agents", "let the team handle this"
- Always list items first to get the correct ID
- Moves the action item to DOING and links it to the objective

### Guidelines

1. **Always confirm** after adding — tell the user what was added and its status
2. **List before operating** — use action_list to find IDs before move/update/delete
3. **Include priority** if the user mentions urgency ("urgent", "high priority", "low priority")
4. **Don't duplicate** — search existing items before adding similar ones
5. **This is NOT the inbox** — the Action Tracker is for task tracking, not HITL approvals
6. **Delegate wisely** — suggest delegation for infrastructure/security/monitoring tasks, not personal or legal items
7. **Analyse proactively** — when asked for advice, use action_analyse to get data before giving recommendations
`;

/**
 * Check if a tool name is an action tool
 */
function isActionTool(toolName) {
  return ['action_add', 'action_list', 'action_move', 'action_update', 'action_delete', 'action_analyse', 'action_delegate'].includes(toolName);
}

module.exports = {
  actionToolDefinitions,
  getClaudeTools,
  actionSystemPrompt,
  isActionTool
};
