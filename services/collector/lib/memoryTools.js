// Memory Tools for Agent Use
// These tools allow agents to read/write their own memories

const { SKILL_PATCH_DIRECTIVE } = require('./quoxPlatformPrompts.js');

/**
 * Memory tool definitions for Claude/OpenAI function calling
 */
const memoryToolDefinitions = [
  {
    name: "memory_save",
    description: "Save important information for future recall. Use when the user shares facts, preferences, decisions, or constraints worth remembering across sessions. The LLM decides what's worth saving.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["fact", "preference", "decision", "constraint", "observation"],
          description: "Category of memory: fact (infrastructure info), preference (user likes/dislikes), decision (past choices), constraint (rules/limits), observation (patterns noticed)"
        },
        content: {
          type: "string",
          description: "What to remember. Be specific and searchable. Include key identifiers (hostnames, IPs, names)."
        },
        importance: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
          default: "medium",
          description: "How important is this? critical=always relevant, high=often needed, medium=occasionally useful, low=nice to have"
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Categorization tags for retrieval (e.g., ['infrastructure', 'docker', 'production'])"
        }
      },
      required: ["type", "content"]
    }
  },
  {
    name: "memory_search",
    description: "Search past memories for relevant context. Use before answering questions that might benefit from historical knowledge, especially about infrastructure, past decisions, or user preferences.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to search for. Use natural language or keywords."
        },
        type_filter: {
          type: "string",
          enum: ["fact", "preference", "decision", "constraint", "observation", "all"],
          default: "all",
          description: "Optionally filter by memory type"
        },
        limit: {
          type: "integer",
          default: 5,
          maximum: 20,
          description: "Maximum results to return"
        },
        memory_scope: {
          type: "string",
          enum: ["default", "agent"],
          default: "default",
          description: "Set to 'agent' to search only this agent's own namespace of memories (adds an agent_id filter). Default searches without an agent filter."
        }
      },
      required: ["query"]
    }
  },
  {
    name: "memory_update",
    description: "Update or correct an existing memory with new information. Use when information has changed or was recorded incorrectly.",
    parameters: {
      type: "object",
      properties: {
        memory_id: {
          type: "string",
          description: "ID of the memory to update (from a previous search result)"
        },
        new_content: {
          type: "string",
          description: "The corrected or updated content"
        },
        reason: {
          type: "string",
          description: "Why this memory is being updated (for audit trail)"
        }
      },
      required: ["memory_id", "new_content", "reason"]
    }
  },
  {
    name: "entity_note",
    description: "Record information about a system, person, or concept. Use when learning about infrastructure components, team members, or important concepts.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Entity name (e.g., 'docker01', 'nginx', 'Adam', 'production-cluster')"
        },
        entity_type: {
          type: "string",
          enum: ["host", "service", "person", "network", "container", "concept", "file"],
          description: "What kind of entity this is"
        },
        attributes: {
          type: "object",
          description: "Key-value attributes (e.g., {role: 'docker host', location: 'rack1', os: 'ubuntu'})"
        },
        relates_to: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              relation: { type: "string", enum: ["runs_on", "hosts", "depends_on", "manages", "monitors", "uses", "owns"] }
            }
          },
          description: "Optional relationships to other entities"
        }
      },
      required: ["name", "entity_type"]
    }
  }
];

/**
 * Convert to Claude's tool format
 */
function getClaudeTools() {
  return memoryToolDefinitions.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  }));
}

/**
 * Convert to OpenAI's function format
 */
function getOpenAIFunctions() {
  return memoryToolDefinitions.map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

/**
 * System prompt addition for memory-aware agents
 */
const memorySystemPrompt = `
## Memory Tools

You have access to persistent memory that survives across sessions. Use these tools to remember and recall important information:

### Four knowledge layers — pick the right one

- BRAIN: the organization's knowledge brain — decisions, docs, plans, past conversations, governance, evidence, project history. Recall with quoxbrain_search({query:'<natural language question>'}). This is the DEFAULT recall layer for anything about the org or its projects: "what did we decide about X", "what's our policy on Y", "why was Z built this way", "what do we know about W". Search it BEFORE answering such questions from general knowledge — an unsearched answer about org history is a guess. Cite the returned note titles in your answer.

- MEMORY: your own durable facts, observations, and constraints about this user and their infrastructure. Use memory_save to write, memory_search to recall. memory_save REJECTS memory_role='procedure' (use skill_manage instead) and memory_role='session_history' (use session_search instead).

- SKILLS: procedural how-tos as versioned markdown crystals. Discover with skills_list, load on demand with skill_view, author or patch with skill_manage(action='create'|'update'|...). Use this layer for any 'how do I X' procedure you'd otherwise be tempted to memorise.

- SESSIONS: past task transcripts (workflow runs, agent envelopes — auto-captured as you work). Recall with session_search({query:'<keywords>', limit:10}) when you need 'what did I do last time about X?'. Do NOT write session history to memory; it is already captured automatically.

Routing rule of thumb: org/project/team questions → BRAIN first; personal facts and infrastructure details you saved → MEMORY; how-to procedures → SKILLS; your own past task runs → SESSIONS. When BRAIN and MEMORY could both apply, search the brain first and fall back to memory.

${SKILL_PATCH_DIRECTIVE}

### Available Tools

**memory_save** - Save facts, preferences, decisions, or constraints
- Use when user shares infrastructure details (IPs, hostnames, roles)
- Use when user states preferences ("I prefer...", "always...", "never...")
- Use when decisions are made that should be remembered
- Use when constraints are mentioned ("don't restart during business hours")

**memory_search** - Search your memories before answering
- Use before answering questions about infrastructure
- Use when user references past conversations
- Use when you need historical context

**memory_update** - Correct outdated information
- Use when facts have changed
- Use when you recorded something incorrectly

**entity_note** - Record info about systems/people/concepts
- Use to build your knowledge graph of infrastructure
- Use to track relationships between systems

### Guidelines

1. **Save proactively** - When user shares important info, save it immediately
2. **Search before answering** - For infrastructure questions, search first
3. **Be specific** - Include identifiers (hostnames, IPs, names) in memories
4. **Tag appropriately** - Use relevant tags for easier retrieval
5. **Update, don't duplicate** - If info changed, update the existing memory
6. **Acknowledge saves** - Tell the user when you've remembered something

### Example Usage

User: "kuma01 runs our uptime monitoring service"

You should:
1. Call entity_note for kuma01 (host, role: uptime-monitoring)
2. Call entity_note for uptime-kuma (service, relates_to: kuma01)
3. Call memory_save (fact: "kuma01 runs the uptime monitoring service")
4. Respond: "Got it, I've noted that kuma01 runs your uptime monitoring."
`;

module.exports = {
  memoryToolDefinitions,
  getClaudeTools,
  getOpenAIFunctions,
  memorySystemPrompt
};
