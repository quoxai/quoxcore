/**
 * workflowSchema.js
 *
 * MIRROR OF src/hooks/useWorkflowBuilder.js NODE_ARCHETYPES and NODE_CATEGORIES
 * — keep in sync when the frontend adds or removes node types.
 *
 * Purpose: gives the collector (Node.js CJS runtime) access to node-type
 * metadata without importing the frontend JSX module.
 */

// MIRROR OF src/hooks/useWorkflowBuilder.js NODE_ARCHETYPES — keep in sync.
const NODE_ARCHETYPES_MIRROR = {
  'trigger:webhook':  { label: 'Webhook',      category: 'trigger',  description: 'Start a workflow when an HTTP request hits a configured path.',            defaultConfig: { method: 'POST', path: '/webhook', authentication: 'none' } },
  'trigger:schedule': { label: 'Schedule',     category: 'trigger',  description: 'Start a workflow on a cron schedule.',                                     defaultConfig: { cron: '0 * * * *', timezone: 'UTC', enabled: true } },
  'trigger:event':    { label: 'Event',        category: 'trigger',  description: 'Start a workflow when a named event fires from another source.',            defaultConfig: { event: '', source: '', filter: '' } },
  'flow:condition':   { label: 'Condition',    category: 'logic',    description: 'Branch the workflow based on a boolean expression.',                        defaultConfig: { expression: '', trueLabel: 'Yes', falseLabel: 'No' } },
  'flow:switch':      { label: 'Switch',       category: 'logic',    description: 'Route to multiple branches based on a field value.',                        defaultConfig: { field: '', cases: '' } },
  'flow:loop':        { label: 'Loop',         category: 'logic',    description: 'Iterate over a collection, running downstream nodes for each item.',        defaultConfig: { collection: '', maxIterations: 100 } },
  'flow:parallel':    { label: 'Parallel',     category: 'logic',    description: 'Fan out to multiple branches and run them concurrently.',                   defaultConfig: { maxConcurrency: 3 } },
  'flow:merge':       { label: 'Merge',        category: 'logic',    description: 'Wait for upstream parallel branches to complete, then continue.',           defaultConfig: { strategy: 'wait_all' } },
  'call':             { label: 'HTTP Call',    category: 'action',   description: 'Make an outbound HTTP/HTTPS request to any URL.',                          defaultConfig: { url: '', method: 'GET', timeout: 30000 } },
  'data:transform':   { label: 'Transform',   category: 'data',     description: 'Reshape or compute data using a JavaScript-like expression.',               defaultConfig: { expression: '', outputField: 'result' } },
  'data:set':         { label: 'Set Data',    category: 'data',     description: 'Write a literal value to a named field in the workflow data.',              defaultConfig: { field: '', value: '' } },
  'data:aggregate':   { label: 'Aggregate',   category: 'data',     description: 'Collect, count, sum, or otherwise reduce items from an upstream loop.',     defaultConfig: { operation: 'collect', field: '' } },
  'error:try':        { label: 'Try',         category: 'error',    description: 'Wrap downstream nodes in an error-catching scope.',                         defaultConfig: { retries: 0, retryDelay: 1000 } },
  'error:catch':      { label: 'Catch',       category: 'error',    description: 'Handle errors thrown inside a Try scope.',                                  defaultConfig: { errorTypes: '' } },
  'error:throw':      { label: 'Throw',       category: 'error',    description: 'Emit a named error to be caught by an upstream Catch node.',                defaultConfig: { message: '', code: '' } },
  'util:wait':        { label: 'Wait',        category: 'utility',  description: 'Pause workflow execution for a specified number of milliseconds.',          defaultConfig: { duration: 1000 } },
  'util:log':         { label: 'Log',         category: 'utility',  description: 'Emit a log entry (info / warn / error) during execution.',                  defaultConfig: { message: '', level: 'info' } },
  'util:subworkflow': { label: 'Subworkflow', category: 'utility',  description: 'Call another workflow by ID and optionally pass data into it.',             defaultConfig: { workflowId: '', passData: true } },
  'agent:agentic':    { label: 'Agentic Loop',category: 'action',   description: 'Run an agentic loop — the named agent iterates with tools until done.',     defaultConfig: { goal: '', maxIterations: 10, tools: [] } },
};

// MIRROR OF src/hooks/useWorkflowBuilder.js NODE_CATEGORIES — keep in sync.
const NODE_CATEGORIES_MIRROR = [
  { id: 'trigger', label: 'Triggers', types: ['trigger:webhook', 'trigger:schedule', 'trigger:event'] },
  { id: 'logic',   label: 'Logic',    types: ['flow:condition', 'flow:switch', 'flow:loop', 'flow:parallel', 'flow:merge'] },
  { id: 'action',  label: 'Actions',  types: ['call', 'agent:agentic'] },
  { id: 'data',    label: 'Data',     types: ['data:transform', 'data:set', 'data:aggregate'] },
  { id: 'error',   label: 'Errors',   types: ['error:try', 'error:catch', 'error:throw'] },
  { id: 'utility', label: 'Utility',  types: ['util:wait', 'util:log', 'util:subworkflow'] },
];

module.exports = { NODE_ARCHETYPES_MIRROR, NODE_CATEGORIES_MIRROR };
