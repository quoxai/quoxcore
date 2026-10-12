/**
 * n8n Workflow Converter
 *
 * Converts n8n workflow JSON to Quoxflow format.
 */

import { ulid } from 'ulid';
import {
  N8nWorkflow,
  N8nNode,
  ImportResult,
  ImportWarning,
  ImportError,
  NodeMappingInfo,
  getQuoxflowType,
  isTriggerNode,
} from './types.js';
import { convertObject, convertString } from './expression-converter.js';
import { N8N_CONNECTORS } from './connectors/index.js';
import { AiCluster, resolveAiCluster, hasNoMainConnections } from './agent-resolver.js';
import { Workflow, Node, Edge, NodeType } from '../core/workflow.js';

/** n8n LangChain node types composed by buildAgentInvokeConfig() / buildAssistantInvokeConfig() — see agent-resolver.ts. */
const LANGCHAIN_AGENT_TYPE = '@n8n/n8n-nodes-langchain.agent';
const LANGCHAIN_CHAIN_LLM_TYPE = '@n8n/n8n-nodes-langchain.chainLlm';

export interface ConvertOptions {
  /** Generate new IDs for nodes (default: true) */
  generateIds?: boolean;
  /** Prefix for generated IDs */
  idPrefix?: string;
  /** Include position data from n8n */
  includePositions?: boolean;
  /** Convert disabled nodes */
  includeDisabled?: boolean;
  /** Add audit annotations */
  addAuditAnnotations?: boolean;
}

const DEFAULT_OPTIONS: ConvertOptions = {
  generateIds: true,
  idPrefix: '',
  includePositions: true,
  includeDisabled: true,
  addAuditAnnotations: true,
};

/**
 * Convert an n8n workflow to Quoxflow format
 */
export function convertWorkflow(
  n8nWorkflow: N8nWorkflow,
  options: ConvertOptions = {}
): ImportResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const warnings: ImportWarning[] = [];
  const errors: ImportError[] = [];
  const nodeMapping: NodeMappingInfo[] = [];

  // Map n8n node names to Quoxflow IDs
  const nodeIdMap = new Map<string, string>();

  // AI cluster resolution (LangChain Agent/Chain nodes) — see agent-resolver.ts.
  // Built once so buildAgentInvokeConfig()/buildAssistantInvokeConfig() can look
  // up each Agent/Chain node's attached model/memory/tools without re-scanning
  // `connections` per node, and so provider nodes (Chat Model, Memory) that are
  // folded into a composed node can be dropped from the final node list below
  // rather than surviving as orphaned, un-runnable standalone nodes.
  const nodesByName = new Map<string, N8nNode>(n8nWorkflow.nodes.map(n => [n.name, n]));
  const absorbedProviderNames = new Set<string>();

  for (const n8nNode of n8nWorkflow.nodes) {
    if (n8nNode.type !== LANGCHAIN_AGENT_TYPE && n8nNode.type !== LANGCHAIN_CHAIN_LLM_TYPE) continue;
    const cluster = resolveAiCluster(n8nNode.name, n8nWorkflow.connections, nodesByName);
    // Only the languageModel/memory providers are folded away — tools are
    // explicitly out of scope for composition (see buildAgentInvokeConfig)
    // and are left as standalone nodes so their (currently unmapped) type
    // shows up honestly rather than silently vanishing.
    for (const member of [cluster.languageModel, cluster.memory]) {
      if (member && hasNoMainConnections(member.nodeName, n8nWorkflow.connections)) {
        absorbedProviderNames.add(member.nodeName);
      }
    }
  }

  // Convert nodes
  const nodes: Node[] = [];

  for (const n8nNode of n8nWorkflow.nodes) {
    try {
      const aiCluster = (n8nNode.type === LANGCHAIN_AGENT_TYPE || n8nNode.type === LANGCHAIN_CHAIN_LLM_TYPE)
        ? resolveAiCluster(n8nNode.name, n8nWorkflow.connections, nodesByName)
        : undefined;
      const { node, mapping, nodeWarnings } = convertNode(n8nNode, opts, nodeIdMap, aiCluster);

      if (node) {
        nodes.push(node);
        nodeMapping.push(mapping);
        warnings.push(...nodeWarnings);
      }
    } catch (err) {
      errors.push({
        nodeId: n8nNode.id,
        nodeName: n8nNode.name,
        message: `Failed to convert node: ${err instanceof Error ? err.message : err}`,
        fatal: false,
      });
    }
  }

  // Drop absorbed ai-cluster provider nodes (Chat Model / Memory) from the
  // output — they were folded into the Agent/Chain node(s) they feed above
  // and have no `main` connections of their own, so keeping them around
  // would only add orphaned, non-executable "call" placeholder nodes.
  let filteredNodes = nodes;
  let filteredMapping = nodeMapping;
  if (absorbedProviderNames.size > 0) {
    const absorbedIds = new Set(
      nodeMapping.filter(m => absorbedProviderNames.has(m.n8nName)).map(m => m.quoxflowId)
    );
    filteredNodes = nodes.filter(n => !absorbedIds.has(n.id));
    filteredMapping = nodeMapping.filter(m => !absorbedIds.has(m.quoxflowId));
  }

  // Convert connections to edges
  const edges: Edge[] = [];
  for (const [sourceName, connections] of Object.entries(n8nWorkflow.connections)) {
    const sourceId = nodeIdMap.get(sourceName);
    if (!sourceId) {
      warnings.push({
        nodeId: '',
        nodeName: sourceName,
        message: `Connection source "${sourceName}" not found in nodes`,
      });
      continue;
    }

    if (connections.main) {
      for (let outputIndex = 0; outputIndex < connections.main.length; outputIndex++) {
        const outputs = connections.main[outputIndex];
        if (!outputs) continue;

        for (const conn of outputs) {
          const targetId = nodeIdMap.get(conn.node);
          if (!targetId) {
            warnings.push({
              nodeId: sourceId,
              nodeName: sourceName,
              message: `Connection target "${conn.node}" not found`,
            });
            continue;
          }

          edges.push({
            id: `${sourceId}-${targetId}-${outputIndex}`,
            source: sourceId,
            target: targetId,
            sourceHandle: outputIndex > 0 ? `output-${outputIndex}` : undefined,
          });
        }
      }
    }
  }

  // Resolve condition/switch placeholders using edges
  resolveControlFlowOutputs(filteredNodes, edges);

  // Build the workflow
  const workflowName = n8nWorkflow.name || `Imported Workflow ${ulid().slice(-8)}`;
  const workflow: Workflow = {
    id: sanitizeId(workflowName) || `imported-${ulid().slice(-8).toLowerCase()}`,
    name: workflowName,
    description: `Imported from n8n workflow`,
    nodes: filteredNodes,
    edges,
    settings: {
      timezone: n8nWorkflow.settings?.timezone,
      errorBehavior: 'stop',
      saveEvidence: opts.addAuditAnnotations,
    },
    metadata: {
      importedFrom: 'n8n',
      importedAt: new Date().toISOString(),
      originalNodeCount: n8nWorkflow.nodes.length,
      warningCount: warnings.length,
    },
  };

  return {
    success: errors.filter(e => e.fatal).length === 0,
    workflow,
    warnings,
    errors,
    nodeMapping: filteredMapping,
  };
}

/**
 * Convert a single n8n node to Quoxflow format
 */
function convertNode(
  n8nNode: N8nNode,
  opts: ConvertOptions,
  nodeIdMap: Map<string, string>,
  aiCluster?: AiCluster
): { node: Node | null; mapping: NodeMappingInfo; nodeWarnings: ImportWarning[] } {
  const nodeWarnings: ImportWarning[] = [];
  const { type: quoxflowType, category } = getQuoxflowType(n8nNode.type);

  // Generate or use existing ID
  const nodeId = opts.generateIds
    ? `${opts.idPrefix}${sanitizeId(n8nNode.name)}-${ulid().slice(-6).toLowerCase()}`
    : n8nNode.id || sanitizeId(n8nNode.name);

  nodeIdMap.set(n8nNode.name, nodeId);

  // Convert parameters with expressions
  const { result: convertedParams, warnings: exprWarnings, count: exprCount } =
    convertObject(n8nNode.parameters);

  for (const warning of exprWarnings) {
    nodeWarnings.push({
      nodeId,
      nodeName: n8nNode.name,
      message: warning,
    });
  }

  // Extract credential requirements
  const credentialsRequired = n8nNode.credentials
    ? Object.keys(n8nNode.credentials)
    : [];

  if (credentialsRequired.length > 0) {
    nodeWarnings.push({
      nodeId,
      nodeName: n8nNode.name,
      message: `Requires credentials: ${credentialsRequired.join(', ')}`,
      suggestion: 'Configure credentials in Quoxflow settings',
    });
  }

  // Build the Quoxflow node based on type
  const composerWarnings: string[] = [];
  const config = buildNodeConfig(quoxflowType, n8nNode, convertedParams as Record<string, unknown>, aiCluster, composerWarnings);

  for (const message of composerWarnings) {
    nodeWarnings.push({ nodeId, nodeName: n8nNode.name, message });
  }

  const node = {
    id: nodeId,
    type: quoxflowType,
    name: n8nNode.name,
    config,
    disabled: n8nNode.disabled,
    position: opts.includePositions && n8nNode.position
      ? { x: n8nNode.position[0], y: n8nNode.position[1] }
      : undefined,
  } as Node;

  const mapping: NodeMappingInfo = {
    n8nName: n8nNode.name,
    n8nType: n8nNode.type,
    quoxflowId: nodeId,
    quoxflowType,
    expressionsConverted: exprCount,
    credentialsRequired,
    notes: n8nNode.notes,
  };

  return { node, mapping, nodeWarnings };
}

/**
 * Build node-specific config based on Quoxflow type
 */
function buildNodeConfig(
  quoxflowType: string,
  n8nNode: N8nNode,
  params: Record<string, unknown>,
  aiCluster?: AiCluster,
  composerWarnings?: string[]
): Record<string, unknown> {
  switch (quoxflowType) {
    case 'trigger:webhook':
      return buildWebhookConfig(n8nNode, params);
    case 'trigger:schedule':
      return buildScheduleConfig(n8nNode, params);
    case 'call':
      return buildCallConfig(n8nNode, params);
    case 'flow:condition':
      if (n8nNode.type === 'n8n-nodes-base.filter') {
        return buildFilterConfig(n8nNode, params);
      }
      return buildConditionConfig(n8nNode, params);
    case 'flow:switch':
      return buildSwitchConfig(n8nNode, params);
    case 'data:transform':
      return buildTransformConfig(n8nNode, params);
    case 'data:aggregate':
      return buildAggregateConfig(n8nNode, params);
    case 'data:set':
      return buildSetConfig(n8nNode, params);
    case 'util:wait':
      return buildWaitConfig(n8nNode, params);
    case 'error:throw':
      return buildThrowConfig(n8nNode, params);
    case 'util:log':
      return { level: 'info', message: (params.message as string) || n8nNode.name };
    case 'respondToWebhook':
      return buildRespondWebhookConfig(n8nNode, params);
    case 'agent:invoke':
      return buildAgentInvokeConfig(n8nNode, params, aiCluster, composerWarnings ?? []);
    case 'assistant:invoke':
      return buildAssistantInvokeConfig(n8nNode, params, aiCluster, composerWarnings ?? []);
    default:
      // Generic pass-through of parameters
      return {
        _originalType: n8nNode.type,
        _originalParams: params,
        expression: 'input', // Pass through
      };
  }
}

function buildRespondWebhookConfig(_n8nNode: N8nNode, params: Record<string, unknown>) {
  // n8n's respondToWebhook node shape:
  //   respondWith: 'json' | 'text' | 'noData' | 'binary' | 'redirect' | 'allIncomingItems'
  //   responseBody: string (raw text, or JSON string for 'json' mode; may contain ={{ }} expressions
  //                 already normalised to ${...} by convertObject())
  //   options.responseCode: number
  //   options.responseHeaders.entries: Array<{ name: string; value: string }>
  const options = (params.options as Record<string, unknown>) || {};
  const statusCode = (options.responseCode as number) ?? 200;

  const headerEntries = ((options.responseHeaders as { entries?: Array<{ name: string; value: string }> } | undefined)?.entries) || [];
  const headers = headerEntries.reduce<Record<string, string>>((acc, entry) => {
    if (entry?.name) acc[entry.name] = entry.value;
    return acc;
  }, {});

  const respondWith = (params.respondWith as string) || 'json';
  const body = respondWith === 'noData' ? undefined : (params.responseBody ?? {});

  return {
    statusCode,
    body,
    headers,
  };
}

function buildWebhookConfig(n8nNode: N8nNode, params: Record<string, unknown>) {
  return {
    path: params.path as string || `/${sanitizeId(n8nNode.name)}`,
    method: (params.httpMethod as string)?.toUpperCase() || 'POST',
    auth: params.authentication ? {
      type: params.authentication as string,
    } : undefined,
  };
}

function buildScheduleConfig(n8nNode: N8nNode, params: Record<string, unknown>) {
  // Convert n8n trigger rule to cron
  const rule = params.rule as { interval?: Array<{ field: string; minutesInterval?: number }> };
  let cron = '* * * * *'; // Default: every minute

  if (rule?.interval?.[0]) {
    const interval = rule.interval[0];
    if (interval.minutesInterval) {
      cron = `*/${interval.minutesInterval} * * * *`;
    }
  }

  return {
    cron,
    timezone: params.timezone as string,
  };
}

function buildCallConfig(n8nNode: N8nNode, params: Record<string, unknown>) {
  // Handle HTTP Request node
  if (n8nNode.type === 'n8n-nodes-base.httpRequest') {
    return {
      url: params.url as string || '',
      method: (params.method as string)?.toUpperCase() || 'GET',
      headers: params.headerParameters as Record<string, string>,
      body: params.body,
      timeout: (params.timeout as number) || 30000,
      evidence: true,
    };
  }

  // Handle known vendor integrations via the connector registry —
  // see src/n8n/connectors/index.ts. A connector returns null when it
  // doesn't recognise this node's specific resource/operation, in
  // which case we fall through to the generic placeholder below.
  const connector = N8N_CONNECTORS[n8nNode.type];
  if (connector) {
    const config = connector(n8nNode, params);
    if (config) {
      return { evidence: true, ...config };
    }
  }

  // Handle integration nodes - convert to HTTP call
  // Most n8n integrations are HTTP-based
  return {
    url: '${vars.integrationEndpoint}', // Placeholder
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: params,
    evidence: true,
    _originalType: n8nNode.type,
    _note: `Converted from n8n ${n8nNode.type}. Configure actual endpoint.`,
  };
}

function buildConditionConfig(n8nNode: N8nNode, params: Record<string, unknown>) {
  // Convert n8n IF node conditions
  const conditions = params.conditions as {
    boolean?: Array<{ value1: unknown; operation: string; value2: unknown }>;
  };

  let expression = 'true';

  if (conditions?.boolean?.[0]) {
    const cond = conditions.boolean[0];
    const v1 = typeof cond.value1 === 'string' && cond.value1.includes('${')
      ? cond.value1.replace(/^\$\{/, '').replace(/\}$/, '')
      : JSON.stringify(cond.value1);
    const v2 = typeof cond.value2 === 'string' && cond.value2.includes('${')
      ? cond.value2.replace(/^\$\{/, '').replace(/\}$/, '')
      : JSON.stringify(cond.value2);

    switch (cond.operation) {
      case 'equal':
        expression = `${v1} === ${v2}`;
        break;
      case 'notEqual':
        expression = `${v1} !== ${v2}`;
        break;
      case 'larger':
        expression = `${v1} > ${v2}`;
        break;
      case 'largerEqual':
        expression = `${v1} >= ${v2}`;
        break;
      case 'smaller':
        expression = `${v1} < ${v2}`;
        break;
      case 'smallerEqual':
        expression = `${v1} <= ${v2}`;
        break;
      case 'contains':
        expression = `String(${v1}).includes(${v2})`;
        break;
      case 'notContains':
        expression = `!String(${v1}).includes(${v2})`;
        break;
      case 'startsWith':
        expression = `String(${v1}).startsWith(${v2})`;
        break;
      case 'endsWith':
        expression = `String(${v1}).endsWith(${v2})`;
        break;
      case 'isEmpty':
        expression = `$.isEmpty(${v1})`;
        break;
      case 'isNotEmpty':
        expression = `!$.isEmpty(${v1})`;
        break;
      default:
        expression = `${v1} === ${v2}`;
    }
  }

  return {
    expression,
    outputs: {
      true: '_PLACEHOLDER_TRUE_',  // Will be set by edge conversion
      false: '_PLACEHOLDER_FALSE_',
    },
  };
}

function buildSwitchConfig(n8nNode: N8nNode, params: Record<string, unknown>) {
  const rules = params.rules as Array<{ value: unknown; output: number }> || [];

  return {
    expression: (params.value1 as string) || 'input.value',
    cases: rules.map((rule, i) => ({
      value: rule.value,
      target: `_PLACEHOLDER_CASE_${i}_`,
    })),
    default: params.fallbackOutput !== undefined ? '_PLACEHOLDER_DEFAULT_' : undefined,
  };
}

function buildTransformConfig(n8nNode: N8nNode, params: Record<string, unknown>) {
  // Handle Split Out node
  if (n8nNode.type === 'n8n-nodes-base.splitOut') {
    const field = (params.fieldToSplitOut as string) || 'data';
    return { expression: `input.flatMap(item => Array.isArray(item.${field}) ? item.${field} : [item.${field}])` };
  }

  // Handle Code node
  if (n8nNode.type === 'n8n-nodes-base.code') {
    const jsCode = params.jsCode as string || 'return items;';
    // Simplify: just pass through if it's the default
    if (jsCode.includes('return items') || jsCode.includes('return $input')) {
      return { expression: 'input' };
    }
    return {
      expression: `(function() { ${jsCode.replace(/\$input\.all\(\)/g, 'input').replace(/items/g, 'input')} })()`,
      _note: 'Converted from n8n Code node. May need manual adjustment.',
    };
  }

  // Handle Function node
  if (n8nNode.type === 'n8n-nodes-base.function') {
    return {
      expression: (params.functionCode as string) || 'input',
      _note: 'Converted from n8n Function node',
    };
  }

  // Handle Set node (simple case)
  if (n8nNode.type === 'n8n-nodes-base.set') {
    return buildSetConfig(n8nNode, params);
  }

  // Default: pass through
  return {
    expression: 'input',
    _originalParams: params,
  };
}

function buildSetConfig(n8nNode: N8nNode, params: Record<string, unknown>) {
  const values = params.values as {
    string?: Array<{ name: string; value: string }>;
    number?: Array<{ name: string; value: number }>;
    boolean?: Array<{ name: string; value: boolean }>;
  };

  const setValues: Record<string, unknown> = {};

  if (values?.string) {
    for (const item of values.string) {
      setValues[item.name] = item.value;
    }
  }
  if (values?.number) {
    for (const item of values.number) {
      setValues[item.name] = item.value;
    }
  }
  if (values?.boolean) {
    for (const item of values.boolean) {
      setValues[item.name] = item.value;
    }
  }

  // If keepOnlySet is false, merge with input
  const keepOnlySet = params.keepOnlySet as boolean;

  return {
    expression: keepOnlySet
      ? `(${JSON.stringify(setValues)})`
      : `({ ...input, ...${JSON.stringify(setValues)} })`,
  };
}

function buildWaitConfig(n8nNode: N8nNode, params: Record<string, unknown>) {
  const amount = params.amount as number || 1;
  const unit = params.unit as string || 'seconds';

  let duration = amount * 1000; // Default to seconds
  if (unit === 'minutes') duration = amount * 60 * 1000;
  if (unit === 'hours') duration = amount * 60 * 60 * 1000;

  return { duration };
}

function buildThrowConfig(n8nNode: N8nNode, params: Record<string, unknown>) {
  return {
    type: 'WORKFLOW_ERROR',
    message: (params.errorMessage as string) || 'Error triggered by workflow',
  };
}

function buildFilterConfig(n8nNode: N8nNode, params: Record<string, unknown>) {
  // n8n filter v2 uses conditions.conditions array
  const conditions = params.conditions as {
    combinator?: string;
    conditions?: Array<{ leftValue?: unknown; operator?: { type: string; operation: string }; rightValue?: unknown }>;
  };

  let expression = 'true';

  if (conditions?.conditions?.[0]) {
    const cond = conditions.conditions[0];
    const left = typeof cond.leftValue === 'string' && cond.leftValue.includes('${')
      ? cond.leftValue.replace(/^\$\{/, '').replace(/\}$/, '')
      : JSON.stringify(cond.leftValue);
    const right = typeof cond.rightValue === 'string' && cond.rightValue.includes('${')
      ? cond.rightValue.replace(/^\$\{/, '').replace(/\}$/, '')
      : JSON.stringify(cond.rightValue);

    const op = cond.operator?.operation || 'equals';
    switch (op) {
      case 'equals': expression = `${left} === ${right}`; break;
      case 'notEquals': expression = `${left} !== ${right}`; break;
      case 'gt': expression = `${left} > ${right}`; break;
      case 'gte': expression = `${left} >= ${right}`; break;
      case 'lt': expression = `${left} < ${right}`; break;
      case 'lte': expression = `${left} <= ${right}`; break;
      case 'contains': expression = `String(${left}).includes(${right})`; break;
      case 'notContains': expression = `!String(${left}).includes(${right})`; break;
      case 'startsWith': expression = `String(${left}).startsWith(${right})`; break;
      case 'endsWith': expression = `String(${left}).endsWith(${right})`; break;
      case 'exists': expression = `${left} !== undefined && ${left} !== null`; break;
      case 'notExists': expression = `${left} === undefined || ${left} === null`; break;
      default: expression = `${left} === ${right}`;
    }
  }

  return {
    expression,
    outputs: {
      true: '_PLACEHOLDER_TRUE_',
      false: '_PLACEHOLDER_FALSE_',
    },
  };
}

function buildAggregateConfig(n8nNode: N8nNode, params: Record<string, unknown>) {
  const aggregate = (params.aggregate as string) || 'aggregateIndividualFields';
  const field = (params.fieldToAggregate as string) || '';

  return {
    operation: aggregate === 'aggregateIndividualFields' ? 'collect' : 'flatten',
    field,
    _originalParams: params,
  };
}

/**
 * Default agent/assistant persona assigned to a composed n8n
 * Agent/Chain node. NOT an invented placeholder like connectors'
 * `${vars.integrationEndpoint}` — it's the SAME default the engine itself
 * falls back to when no agent_id is configured at all (see
 * AgenticExecutor's own `agentId = ... || 'quox'` fallback in
 * agentic.executor.ts), and it's a real, registered persona
 * (quox-dashboard/src/config/entities/assistants/quox.json — "CommanderQ",
 * the platform's general-purpose orchestrator, valid for both agent_id and
 * assistant_id). Every composed node still carries an explicit warning
 * (matching the existing credential-warning pattern elsewhere in this
 * converter) telling the importing org to assign a dedicated persona if
 * the workflow deserves one distinct from the general orchestrator.
 */
const DEFAULT_IMPORTED_AGENT_ID = 'quox';

/**
 * n8n `@n8n/n8n-nodes-langchain.agent` -> QuoxFlow `agent:invoke`.
 *
 * IMPORTANT node-type correction vs. this stream's original brief: the
 * brief described `agent:invoke` as backed by `agentic.executor.ts`'s
 * observe-think-act loop (`AgenticConfig`: objective/max_iterations/
 * available_actions). That executor is real, but it's registered under
 * node type `agent:agentic`, not `agent:invoke` — `agent:invoke` is a
 * DIFFERENT, separately-registered node type/executor
 * (agent-invoke.executor.ts), a single stateless call to a named agent
 * (config: agent_id, prompt, system_prompt, context, ...). Emitting
 * `type: 'agent:invoke'` with objective/max_iterations/available_actions
 * fields (as the brief's field names suggested) would produce a node the
 * real executor's own validate() rejects (`prompt is required`) — a
 * broken import, not a working one. This composer targets `agent:invoke`
 * (the type name explicitly requested) with ITS real config shape, which
 * is honestly the better n8n-Agent match anyway: n8n's Agent node is a
 * single node invocation from the workflow's perspective (its own
 * internal tool-loop is opaque to the surrounding workflow), same as
 * agent:invoke — not an iteration count visible in the graph. There is
 * consequently no QuoxFlow-side "max_iterations"/"available_actions"
 * equivalent to set here; that N/A finding is reported rather than
 * invented fields on a node type that doesn't read them.
 */
function buildAgentInvokeConfig(
  n8nNode: N8nNode,
  params: Record<string, unknown>,
  aiCluster: AiCluster | undefined,
  warnings: string[]
): Record<string, unknown> {
  // n8n's Agent node shape (real samples, AI Agent Vault):
  //   parameters.text    — the runtime task/input, often an n8n expression
  //                        referencing upstream data (already converted to
  //                        ${...} syntax by convertObject() before this
  //                        function runs).
  //   parameters.agent   — a mode string ('conversationalAgent',
  //                        'reActAgent', 'sqlAgent', 'openAiFunctionsAgent',
  //                        or absent) — no QuoxFlow equivalent; not carried
  //                        forward. agent:invoke has no "agent style"
  //                        concept — the target agent's own persona/tools
  //                        decide how it reasons.
  //   parameters.options.systemMessage — the persona/instruction prompt.
  //   promptType === undefined ("auto" mode, observed on roughly a third
  //                        of real Agent nodes sampled) — parameters.text
  //                        is absent entirely; n8n reads the chat
  //                        trigger's input directly at runtime. QuoxFlow
  //                        has no equivalent auto-binding, so this falls
  //                        back to a generic ${input} expression with an
  //                        explicit warning rather than guessing.
  const rawText = (params.text ?? params.prompt) as string | undefined;
  const systemMessage = (params.options as Record<string, unknown> | undefined)?.systemMessage as string | undefined;

  let prompt: string;
  if (typeof rawText === 'string' && rawText.trim().length > 0) {
    prompt = rawText;
  } else {
    prompt = '${input}';
    warnings.push(
      `No explicit prompt template found on n8n Agent node "${n8nNode.name}" (n8n "auto" prompt mode — it reads the chat trigger's input directly at runtime, which this converter cannot resolve statically). Defaulting agent:invoke's prompt to "\${input}"; verify this resolves to the intended task text.`
    );
  }

  const config: Record<string, unknown> = {
    agent_id: DEFAULT_IMPORTED_AGENT_ID,
    prompt,
  };

  if (typeof systemMessage === 'string' && systemMessage.trim().length > 0) {
    // agent:invoke's `system_prompt` is a dedicated per-task persona/voice
    // channel forwarded to the collector as its own field (see
    // AgentInvokeExecutor) — a materially better fit for n8n's
    // options.systemMessage than folding it into `prompt` text.
    config.system_prompt = systemMessage;
  }

  warnings.push(
    `agent_id defaulted to "${DEFAULT_IMPORTED_AGENT_ID}" (CommanderQ, the platform's general-purpose orchestrator) — this n8n Agent node has no QuoxFlow-native equivalent persona. Assign a dedicated agent post-import if this workflow needs one distinct from the general orchestrator.`
  );

  if (aiCluster?.languageModel) {
    // Informational only — agent:invoke has no "model" field. The
    // assigned agent_id's own configuration determines the actual model.
    config.context = {
      _note: `Backed by n8n chat model "${aiCluster.languageModel.nodeName}" (${aiCluster.languageModel.n8nType}) in the source workflow. agent_id "${DEFAULT_IMPORTED_AGENT_ID}" (or whichever agent is assigned) determines the actual model used at runtime — this is informational metadata only.`,
    };
  }

  if (aiCluster?.memory) {
    // Cross-run memory finding (deliberately NOT built this pass — see
    // report): agent:invoke is a single stateless call within a workflow
    // run; there is no QuoxFlow node-level session-memory equivalent.
    // Persisting conversation state ACROSS separate workflow executions
    // would need wiring to QuoxCORE's memory service (quox-memory /
    // collector), which is outside quoxflow's own repo scope.
    warnings.push(
      `n8n memory node "${aiCluster.memory.nodeName}" (${aiCluster.memory.n8nType}) was attached to this Agent for cross-turn conversation history. agent:invoke is a single stateless call — QuoxFlow has no per-node session-memory equivalent within a workflow run, and cross-execution conversation persistence would require wiring to QuoxCORE's memory service (outside quoxflow's own scope). Not built this pass — flagging so the importing org knows conversation continuity is not preserved.`
    );
  }

  if (aiCluster?.tools.length) {
    const toolNames = aiCluster.tools.map(t => `${t.nodeName} (${t.n8nType})`).join(', ');
    warnings.push(
      `${aiCluster.tools.length} n8n tool node(s) were attached to this Agent and are NOT mapped: ${toolNames}. agent:invoke has no field for granting specific tool access per-call (the assigned agent's own registered tool set applies) — noted here for the importing org's awareness, not translated into any config. An honest gap, not a guessed one: QuoxFlow's available action/tool identifiers don't correspond to arbitrary n8n tool node types.`
    );
  }

  if (aiCluster?.outputParser) {
    warnings.push(
      `n8n output parser node "${aiCluster.outputParser.nodeName}" (${aiCluster.outputParser.n8nType}) was attached to this Agent and is not converted — structured-output validation is out of scope this pass (a real follow-on candidate: chain a data:transform validation step after this node).`
    );
  }

  return config;
}

/**
 * n8n `@n8n/n8n-nodes-langchain.chainLlm` -> QuoxFlow `assistant:invoke`.
 * Matches the brief closely (unlike the agent:invoke case above) — n8n's
 * "Basic LLM Chain" is genuinely a single pinned-persona LLM call, the
 * same shape as assistant:invoke.
 */
function buildAssistantInvokeConfig(
  n8nNode: N8nNode,
  params: Record<string, unknown>,
  aiCluster: AiCluster | undefined,
  warnings: string[]
): Record<string, unknown> {
  // n8n's Chain node shape (real samples): the user-turn content is under
  // `text` on newer typeVersions or `prompt` on older ones (both observed
  // in the vault — e.g. "Basic LLM Chain1" in ChatGPT Automatic Code
  // Review in Gitlab MR.json uses `prompt`). System/persona instructions
  // live in `messages.messageValues[]`: an entry with a plain `message`
  // string is n8n's default (untyped) role, which n8n treats as a system
  // message; an entry with `type: "HumanMessagePromptTemplate"` and
  // `messageType: "imageBinary"` (no `message` string) is binary image
  // input this converter cannot translate — flagged, not silently dropped.
  const rawText = (params.text ?? params.prompt) as string | undefined;
  const messagesParam = params.messages as
    | { messageValues?: Array<{ message?: string; type?: string; messageType?: string }> }
    | undefined;
  const messageValues = messagesParam?.messageValues ?? [];

  const systemParts: string[] = [];
  let hasUnhandledBinaryMessage = false;
  for (const mv of messageValues) {
    if (typeof mv?.message === 'string' && mv.message.trim().length > 0) {
      systemParts.push(mv.message);
    } else if (mv?.messageType === 'imageBinary' || mv?.type === 'HumanMessagePromptTemplate') {
      hasUnhandledBinaryMessage = true;
    }
  }

  let prompt: string;
  if (typeof rawText === 'string' && rawText.trim().length > 0) {
    prompt = rawText;
  } else {
    prompt = '${input}';
    warnings.push(
      `No explicit prompt template found on n8n Chain node "${n8nNode.name}". Defaulting assistant:invoke's prompt to "\${input}"; verify this resolves to the intended task text.`
    );
  }

  const config: Record<string, unknown> = {
    assistant_id: DEFAULT_IMPORTED_AGENT_ID,
    prompt,
  };

  if (systemParts.length > 0) {
    // NOTE: core/workflow.ts's AssistantInvokeNode.config types `context`
    // as `Record<string, unknown>`, but AssistantInvokeExecutor's own
    // runtime code (assistant-invoke.executor.ts) treats it as a STRING
    // ("The collector treats `context` as a STRING... Sending it as an
    // object stringifies to '[object Object]'"), with a `typeof
    // rawConfig.context === 'string'` guard that silently discards
    // anything else. That's a pre-existing type-declaration/runtime-
    // behaviour drift in the codebase, not introduced or fixed here —
    // flagged in this pass's report. Following the ACTUAL runtime
    // contract (not the out-of-sync type) is what makes this work at
    // execution time, so `context` is set as a string.
    config.context = systemParts.join('\n\n');
  }

  warnings.push(
    `assistant_id defaulted to "${DEFAULT_IMPORTED_AGENT_ID}" (CommanderQ) — this n8n Chain node has no QuoxFlow-native equivalent persona. Assign a dedicated assistant post-import if this workflow needs one.`
  );

  if (hasUnhandledBinaryMessage) {
    warnings.push(
      `n8n Chain node "${n8nNode.name}" includes an image/binary message template that this converter does not translate — the resulting prompt is text-only.`
    );
  }

  if (aiCluster?.languageModel) {
    warnings.push(
      `Backed by n8n chat model "${aiCluster.languageModel.nodeName}" (${aiCluster.languageModel.n8nType}) in the source workflow — informational only, the assigned assistant's own model applies at runtime.`
    );
  }

  return config;
}

/**
 * Resolve condition and switch output placeholders using edge information
 */
function resolveControlFlowOutputs(nodes: Node[], edges: Edge[]): void {
  for (const node of nodes) {
    if (node.type === 'flow:condition') {
      const config = node.config as { outputs?: { true?: string; false?: string } };
      if (!config.outputs) continue;

      // Find edges from this node
      const outgoingEdges = edges.filter(e => e.source === node.id);

      for (const edge of outgoingEdges) {
        // output-0 or no sourceHandle = true branch
        // output-1 = false branch
        if (!edge.sourceHandle || edge.sourceHandle === 'output-0') {
          config.outputs.true = edge.target;
        } else if (edge.sourceHandle === 'output-1') {
          config.outputs.false = edge.target;
        }
      }
    }

    if (node.type === 'flow:switch') {
      const config = node.config as { cases?: Array<{ target?: string }>; default?: string };
      if (!config.cases) continue;

      // Find edges from this node
      const outgoingEdges = edges.filter(e => e.source === node.id);

      for (const edge of outgoingEdges) {
        if (!edge.sourceHandle) {
          // Default output (no handle)
          if (config.default === '_PLACEHOLDER_DEFAULT_') {
            config.default = edge.target;
          }
        } else {
          // output-N = case N
          const match = edge.sourceHandle.match(/^output-(\d+)$/);
          if (match) {
            const caseIndex = parseInt(match[1], 10);
            if (config.cases[caseIndex]) {
              config.cases[caseIndex].target = edge.target;
            }
          }
        }
      }
    }
  }
}

/**
 * Sanitize a string to be used as an ID
 */
function sanitizeId(name: string | undefined): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

/**
 * Parse n8n workflow from JSON string
 */
export function parseN8nWorkflow(json: string): N8nWorkflow {
  const parsed = JSON.parse(json);

  // Handle both single workflow and export format
  if (parsed.nodes && parsed.connections) {
    return parsed as N8nWorkflow;
  }

  // n8n export format wraps workflows
  if (parsed.workflows?.[0]) {
    return parsed.workflows[0] as N8nWorkflow;
  }

  throw new Error('Invalid n8n workflow format');
}
