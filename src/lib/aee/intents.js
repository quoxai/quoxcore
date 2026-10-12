/**
 * QUOX Intent Registry
 * Defines all valid intents for the QUOX system
 *
 * @fileoverview Intent definitions for AEE protocol in QUOX
 *
 * Intent Naming Convention:
 * - Namespaced with dots: "{domain}.{category}.{action}"
 * - Domains: quox, quoxagent, ops, aee
 * - Examples: "quox.chat.query", "quoxagent.job.submit", "ops.approval.request"
 */

/**
 * Chat-related intents
 */
export const CHAT_INTENTS = {
  /** Human query to any agent */
  QUERY: 'quox.chat.query',
  /** Agent response to human */
  RESPONSE: 'quox.chat.response',
  /** Streaming chunk of response */
  STREAM_CHUNK: 'quox.chat.stream_chunk',
  /** Stream completed */
  STREAM_END: 'quox.chat.stream_end'
}

/**
 * Agent-to-agent communication intents
 */
export const AGENT_INTENTS = {
  /** Agent delegating to another agent */
  DELEGATE: 'quox.agent.delegate',
  /** Agent returning result to parent */
  DELEGATE_RESULT: 'quox.agent.delegate_result',
  /** Agent handoff (transfer conversation) */
  HANDOFF: 'quox.agent.handoff',
  /** Internal agent thinking/reasoning (for audit) */
  THINKING: 'quox.agent.thinking'
}

/**
 * QuoxAgent (Quox Helper Agent) intents
 */
export const QuoxAgent_INTENTS = {
  /** Heartbeat report (event, no reply expected) */
  HEARTBEAT: 'quoxagent.heartbeat.report',
  /** Submit command/job to QuoxAgent agent */
  JOB_SUBMIT: 'quoxagent.job.submit',
  /** Job execution result */
  JOB_RESULT: 'quoxagent.job.result',
  /** Job status update (streaming) */
  JOB_STATUS: 'quoxagent.job.status',
  /** QuoxAgent agent registration */
  REGISTER: 'quoxagent.agent.register',
  /** QuoxAgent agent deregistration */
  DEREGISTER: 'quoxagent.agent.deregister',
  /** Install QuoxAgent on a host */
  INSTALL: 'quoxagent.install.request',
  /** Install result */
  INSTALL_RESULT: 'quoxagent.install.result'
}

/**
 * Operations/infrastructure intents
 */
export const OPS_INTENTS = {
  /** Request human approval for action */
  APPROVAL_REQUEST: 'ops.approval.request',
  /** Human granted approval */
  APPROVAL_GRANT: 'ops.approval.grant',
  /** Human denied approval */
  APPROVAL_DENY: 'ops.approval.deny',
  /** Disk check operation */
  DISK_CHECK: 'ops.disk.check',
  /** Network ping operation */
  NETWORK_PING: 'ops.network.ping',
  /** Service status check */
  SERVICE_STATUS: 'ops.service.status',
  /** Generic operation result */
  RESULT: 'ops.operation.result',
  /** Kill switch activated */
  KILL_SWITCH: 'ops.safety.kill_switch',
  /** DEFCON level change */
  DEFCON_CHANGE: 'ops.safety.defcon_change'
}

/**
 * AEE protocol intents
 */
export const AEE_INTENTS = {
  /** Request agent capabilities */
  CAPABILITY_LIST: 'aee.capability.list',
  /** Capability list response */
  CAPABILITY_RESULT: 'aee.capability.result',
  /** Ping/health check */
  PING: 'aee.health.ping',
  /** Pong response */
  PONG: 'aee.health.pong',
  /** Protocol error */
  ERROR: 'aee.protocol.error',

  // Analytics intents (SCHOLAR agent)
  /** Analyze a conversation */
  ANALYZE_CONVERSATION: 'aee.analyze.conversation',
  /** Detect patterns in AEE data */
  ANALYZE_PATTERNS: 'aee.analyze.patterns',
  /** Get dashboard statistics */
  STATS_DASHBOARD: 'aee.stats.dashboard',
  /** Get host activity stats */
  STATS_HOST: 'aee.stats.host',
  /** Get user behavior stats */
  STATS_USER: 'aee.stats.user',

  // Memory intents (ARCHIVIST agent)
  /** Extract memories from conversation */
  MEMORY_EXTRACT: 'aee.memory.extract',
  /** Consolidate/deduplicate memories */
  MEMORY_CONSOLIDATE: 'aee.memory.consolidate',
  /** Restore context from conversation */
  CONTEXT_RESTORE: 'aee.context.restore',
  /** Generate proactive context */
  CONTEXT_PROACTIVE: 'aee.context.proactive',
  /** Query knowledge graph */
  KNOWLEDGE_GRAPH: 'aee.knowledge.graph'
}

/**
 * Settings / REGULA configuration plane intents.
 * Every settings read, change, import, export, reset, or explain emits
 * one of these. Bound to AOCL Layer 11 (config.plane).
 */
export const SETTINGS_INTENTS = {
  /** REGULA read a setting value for display/explanation */
  READ: 'quox.settings.read',
  /** A setting was changed (reversible, committed immediately) */
  CHANGED: 'quox.settings.changed',
  /** A settings bundle was imported */
  IMPORT: 'quox.settings.import',
  /** Settings exported as a bundle */
  EXPORT: 'quox.settings.export',
  /** Settings reset to defaults */
  RESET: 'quox.settings.reset',
  /** Validation run on a proposed change */
  VALIDATE: 'quox.settings.validate',
  /** REGULA explained a setting in plain English */
  EXPLAIN: 'quox.settings.explain',
  /** REGULA recommended a setting based on context */
  RECOMMEND: 'quox.settings.recommend',
  /** Settings audit sweep (drift watchdog) */
  AUDIT: 'quox.settings.audit',
  /** Intent envelope for a destructive change awaiting HITL approval */
  CHANGE_INTENT: 'quox.settings.change.intent',
  /** HITL-approved change committed */
  CHANGE_APPROVED: 'quox.settings.change.approved',
  /** HITL-rejected change */
  CHANGE_REJECTED: 'quox.settings.change.rejected',
}

/**
 * System/audit intents
 */
export const SYSTEM_INTENTS = {
  /** Conversation started */
  CONVERSATION_START: 'system.conversation.start',
  /** Conversation ended */
  CONVERSATION_END: 'system.conversation.end',
  /** Session timeout */
  SESSION_TIMEOUT: 'system.session.timeout',
  /** Error occurred */
  ERROR: 'system.error'
}

/**
 * AOCL (Agent Orchestration Control Layers) intents
 * OSI-model inspired processing layers for full auditability
 *
 * Layers:
 * - L0: ingress.normalize - Event normalization
 * - L1: identity.scope - Permissions (future)
 * - L2: route.smart - Smart Router
 * - L3: policy.gate - Safety checks (future)
 * - L4: plan.decompose - Intent decomposition (future)
 * - L5: context.retrieve - Memory/context building
 * - L6: shape.rewrite - Prompt restructuring (future)
 * - L7: delegate.execute - Claude/n8n execution
 * - L8: verify.check - Response validation (future)
 * - L9: assemble.respond - Response assembly
 * - L10: audit.writeback - Persist traces (implicit via AEE)
 */
export const AOCL_INTENTS = {
  /** Layer processing started */
  LAYER_START: 'aocl.layer.start',
  /** Layer processing completed successfully */
  LAYER_COMPLETE: 'aocl.layer.complete',
  /** Layer was bypassed (skipped) */
  LAYER_BYPASS: 'aocl.layer.bypass',
  /** Layer rejected the request */
  LAYER_REJECT: 'aocl.layer.reject',
  /** Processing run started (groups all layers for a request) */
  RUN_START: 'aocl.run.start',
  /** Processing run completed */
  RUN_COMPLETE: 'aocl.run.complete',
  /** Processing run failed */
  RUN_ERROR: 'aocl.run.error'
}

/**
 * QuoxFlow workflow engine intents
 * Emitted by QuoxFlow for workflow lifecycle and node execution events
 */
export const QUOXFLOW_INTENTS = {
  /** Workflow execution started */
  FLOW_STARTED: 'quox.flow.started',
  /** Workflow execution completed */
  FLOW_COMPLETED: 'quox.flow.completed',
  /** Workflow execution failed */
  FLOW_FAILED: 'quox.flow.failed',
  /** Workflow execution paused (e.g., awaiting approval) */
  FLOW_PAUSED: 'quox.flow.paused',
  /** Workflow execution resumed */
  FLOW_RESUMED: 'quox.flow.resumed',
  /** Node execution started */
  NODE_STARTED: 'quox.flow.node.started',
  /** Node execution completed */
  NODE_COMPLETED: 'quox.flow.node.completed',
  /** Node execution failed */
  NODE_FAILED: 'quox.flow.node.failed',
  /** Node was skipped (condition not met) */
  NODE_SKIPPED: 'quox.flow.node.skipped',
  /** Policy gate evaluated */
  POLICY_EVALUATED: 'quox.flow.policy.evaluated',
  /** Approval requested */
  APPROVAL_REQUESTED: 'quox.flow.approval.requested',
  /** Approval resolved (approved/denied) */
  APPROVAL_RESOLVED: 'quox.flow.approval.resolved',
  /** Evidence collected */
  EVIDENCE_COLLECTED: 'quox.flow.evidence.collected',
}

/**
 * Agentic thinking intents (QE2)
 * Emitted by agent:agentic executor during observe-think-act loop
 */
export const AGENTIC_INTENTS = {
  /** Agent observed environment state */
  THINK_OBSERVE: 'quox.agent.think.observe',
  /** Agent made a reasoning decision */
  THINK_DECIDE: 'quox.agent.think.decide',
  /** Agent executed an action based on decision */
  THINK_ACT: 'quox.agent.think.act',
}

/**
 * Background Task Service intents (Phase 4.B)
 * Lifecycle events for objectives, tasks, and checkpoints
 */
export const TASK_INTENTS = {
  /** Objective created */
  OBJECTIVE_CREATED: 'quox.task.objective.created',
  /** Objective decomposed into tasks (plan ready for review) */
  OBJECTIVE_DECOMPOSED: 'quox.task.objective.decomposed',
  /** Objective execution started (plan approved) */
  OBJECTIVE_STARTED: 'quox.task.objective.started',
  /** Objective paused */
  OBJECTIVE_PAUSED: 'quox.task.objective.paused',
  /** Objective completed successfully */
  OBJECTIVE_COMPLETED: 'quox.task.objective.completed',
  /** Objective failed */
  OBJECTIVE_FAILED: 'quox.task.objective.failed',
  /** Individual task started */
  TASK_STARTED: 'quox.task.task.started',
  /** Individual task completed */
  TASK_COMPLETED: 'quox.task.task.completed',
  /** Individual task failed */
  TASK_FAILED: 'quox.task.task.failed',
  /** HITL checkpoint created */
  CHECKPOINT_CREATED: 'quox.task.checkpoint.created',
  /** Checkpoint approved */
  CHECKPOINT_APPROVED: 'quox.task.checkpoint.approved',
  /** Checkpoint rejected */
  CHECKPOINT_REJECTED: 'quox.task.checkpoint.rejected',
}

/**
 * Action Tracker intents
 * CRUD lifecycle events for action items
 */
export const ACTION_INTENTS = {
  /** Action item created */
  ITEM_CREATED: 'quox.actions.item.created',
  /** Action item moved between columns */
  ITEM_MOVED: 'quox.actions.item.moved',
  /** Action item fields updated */
  ITEM_UPDATED: 'quox.actions.item.updated',
  /** Action item deleted */
  ITEM_DELETED: 'quox.actions.item.deleted',
  /** Action item auto-archived */
  ITEM_ARCHIVED: 'quox.actions.item.archived',
  /** Server sync completed */
  SYNC_COMPLETED: 'quox.actions.sync.completed',
  /** Server sync failed */
  SYNC_FAILED: 'quox.actions.sync.failed',
}

// ─── T2: Trust Chain Expansion Intents ────────────────────────────────────

/**
 * Tool execution intents (T2-A: Collector)
 */
export const TOOL_EXECUTION_INTENTS = {
  EXECUTED: 'ops.tool.executed',
  FAILED: 'ops.tool.failed',
}

/**
 * Terminal intents (T2-A: Collector)
 */
export const TERMINAL_INTENTS = {
  COMMAND: 'terminal.exec.command',
  FILE_WRITE: 'terminal.file.write',
  FILE_EDIT: 'terminal.file.edit',
  FILE_RESTORE: 'terminal.file.restore',
  FILE_DELETE: 'terminal.file.delete',
  FILE_RENAME: 'terminal.file.rename',
}

/**
 * GDPR intents (T2-A: Collector)
 */
export const GDPR_INTENTS = {
  DATA_PURGED: 'gdpr.data.purged',
  IMAGE_DELETED: 'ops.image.deleted',
}

/**
 * Memory service intents (T2-B: Backend)
 */
export const MEMORY_SERVICE_INTENTS = {
  CREATED: 'quox.memory.created',
  UPDATED: 'quox.memory.updated',
  DELETED: 'quox.memory.deleted',
  CORE_UPSERTED: 'quox.memory.core_upserted',
  CORE_DELETED: 'quox.memory.core_deleted',
  ENTITY_CREATED: 'quox.memory.entity_created',
  RELATION_CREATED: 'quox.memory.relation_created',
  SUMMARY_CREATED: 'quox.memory.summary_created',
  MIGRATED: 'quox.memory.migrated',
  BATCH_CREATED: 'quox.memory.batch_created',
  CONSOLIDATED: 'quox.memory.consolidated',
  CONV_BATCH_IMPORTED: 'quox.memory.conv_batch_imported',
  CONV_DELETED: 'quox.memory.conv_deleted',
  TIER_SET: 'quox.memory.tier_set',
  QUOTA_RECALCULATED: 'quox.memory.quota_recalculated',
}

/**
 * Files service intents (T2-B: Backend)
 */
export const FILES_INTENTS = {
  UPLOADED: 'quox.files.uploaded',
  UPLOADED_BASE64: 'quox.files.uploaded_base64',
  DELETED: 'quox.files.deleted',
  METADATA_SAVED: 'quox.files.metadata_saved',
  FOLDERS_SAVED: 'quox.files.folders_saved',
}

/**
 * Orchestrator service intents (T2-B: Backend)
 */
export const ORCHESTRATOR_INTENTS = {
  TASK_STARTED: 'quox.orchestrator.task_started',
  TASK_COMPLETED: 'quox.orchestrator.task_completed',
  TASK_FAILED: 'quox.orchestrator.task_failed',
  TASK_STOPPED: 'quox.orchestrator.task_stopped',
  CONTAINER_RESTARTED: 'quox.orchestrator.container_restarted',
  CONTAINER_RESTART_FAILED: 'quox.orchestrator.container_restart_failed',
  UPDATE_STARTED: 'quox.orchestrator.update_started',
  UPDATE_COMPLETED: 'quox.orchestrator.update_completed',
  UPDATE_FAILED: 'quox.orchestrator.update_failed',
  UPDATE_CANCELLED: 'quox.orchestrator.update_cancelled',
}

/**
 * Objective frontend intents (T2-C)
 */
export const OBJECTIVE_INTENTS = {
  CREATED: 'quox.objectives.created',
  UPDATED: 'quox.objectives.updated',
  CANCELLED: 'quox.objectives.cancelled',
  STARTED: 'quox.objectives.started',
  PAUSED: 'quox.objectives.paused',
  RESUMED: 'quox.objectives.resumed',
  TASK_RETRIED: 'quox.objectives.task_retried',
  TASK_SKIPPED: 'quox.objectives.task_skipped',
  CHECKPOINT_APPROVED: 'quox.objectives.checkpoint_approved',
  CHECKPOINT_REJECTED: 'quox.objectives.checkpoint_rejected',
  PLAN_APPROVED: 'quox.objectives.plan_approved',
  PLAN_REJECTED: 'quox.objectives.plan_rejected',
}

/**
 * Infrastructure/bastion frontend intents (T2-C)
 */
export const INFRA_INTENTS = {
  HOST_ADDED: 'quox.bastion.host_added',
  HOST_UPDATED: 'quox.bastion.host_updated',
  HOST_REMOVED: 'quox.bastion.host_removed',
  COMMAND_EXECUTED: 'quox.bastion.command_executed',
  REGISTRY_IMPORTED: 'quox.bastion.registry_imported',
  KEY_GENERATED: 'quox.bastion.key_generated',
  KEY_DEPLOYED: 'quox.bastion.key_deployed',
  KEY_REVOKED: 'quox.bastion.key_revoked',
  SUDO_SETUP: 'quox.bastion.sudo_setup',
  TOOL_RUN: 'quox.bastion.tool_run',
}

/**
 * Integration/vault frontend intents (T2-C)
 */
export const INTEGRATION_INTENTS = {
  CREDENTIAL_CREATED: 'quox.vault.credential_created',
  CREDENTIAL_UPDATED: 'quox.vault.credential_updated',
  CREDENTIAL_DELETED: 'quox.vault.credential_deleted',
  DEFAULT_SET: 'quox.vault.default_set',
}

/**
 * Tool catalog frontend intents (T2-C)
 */
export const TOOLCATALOG_INTENTS = {
  TOOL_INSTALLED: 'quox.catalog.tool_installed',
  TOOL_UPDATED: 'quox.catalog.tool_updated',
  TOOL_UNINSTALLED: 'quox.catalog.tool_uninstalled',
  AGENT_CREATED: 'quox.catalog.agent_created',
  AGENT_UPDATED: 'quox.catalog.agent_updated',
  AGENT_DELETED: 'quox.catalog.agent_deleted',
  TOOL_ASSIGNED: 'quox.catalog.tool_assigned',
  ASSIGNMENT_UPDATED: 'quox.catalog.assignment_updated',
  TOOL_REVOKED: 'quox.catalog.tool_revoked',
}

/**
 * Comms frontend intents (T2-C)
 */
export const COMMS_INTENTS = {
  CONFIG_SAVED: 'quox.comms.config_saved',
  CONFIG_RESET: 'quox.comms.config_reset',
  NOTIFICATION_SENT: 'quox.comms.notification_sent',
  WEBHOOK_REGISTERED: 'quox.comms.webhook_registered',
  WEBHOOK_DEACTIVATED: 'quox.comms.webhook_deactivated',
  ENDPOINT_CREATED: 'quox.comms.endpoint_created',
  ENDPOINT_UPDATED: 'quox.comms.endpoint_updated',
  ENDPOINT_DELETED: 'quox.comms.endpoint_deleted',
}

/**
 * Team frontend intents (T2-C)
 */
export const TEAM_INTENTS = {
  CREATED: 'quox.team.created',
  UPDATED: 'quox.team.updated',
  INSTALLED: 'quox.team.installed',
  UNINSTALLED: 'quox.team.uninstalled',
  PACK_INSTALLED: 'quox.team.pack_installed',
  CONTEXT_UPDATED: 'quox.team.context_updated',
  SCHEDULE_CREATED: 'quox.team.schedule_created',
  SCHEDULE_UPDATED: 'quox.team.schedule_updated',
  SCHEDULE_DELETED: 'quox.team.schedule_deleted',
  SCHEDULE_TOGGLED: 'quox.team.schedule_toggled',
}

/**
 * All intents combined
 */
export const ALL_INTENTS = {
  ...CHAT_INTENTS,
  ...AGENT_INTENTS,
  ...QuoxAgent_INTENTS,
  ...OPS_INTENTS,
  ...AEE_INTENTS,
  ...SYSTEM_INTENTS,
  ...AOCL_INTENTS,
  ...QUOXFLOW_INTENTS,
  ...TASK_INTENTS,
  ...ACTION_INTENTS,
  ...AGENTIC_INTENTS,
  ...TOOL_EXECUTION_INTENTS,
  ...TERMINAL_INTENTS,
  ...GDPR_INTENTS,
  ...MEMORY_SERVICE_INTENTS,
  ...FILES_INTENTS,
  ...ORCHESTRATOR_INTENTS,
  ...OBJECTIVE_INTENTS,
  ...INFRA_INTENTS,
  ...INTEGRATION_INTENTS,
  ...TOOLCATALOG_INTENTS,
  ...COMMS_INTENTS,
  ...TEAM_INTENTS,
  ...SETTINGS_INTENTS,
}

/**
 * Intent metadata for UI display and routing
 * @type {Record<string, {label: string, type: string, icon: string, requiresReply: boolean}>}
 */
export const INTENT_METADATA = {
  [CHAT_INTENTS.QUERY]: {
    label: 'Chat Query',
    type: 'task',
    icon: '💬',
    requiresReply: true
  },
  [CHAT_INTENTS.RESPONSE]: {
    label: 'Chat Response',
    type: 'result',
    icon: '🤖',
    requiresReply: false
  },
  [QuoxAgent_INTENTS.HEARTBEAT]: {
    label: 'Heartbeat',
    type: 'event',
    icon: '💓',
    requiresReply: false
  },
  [QuoxAgent_INTENTS.JOB_SUBMIT]: {
    label: 'Job Submit',
    type: 'task',
    icon: '⚡',
    requiresReply: true
  },
  [QuoxAgent_INTENTS.JOB_RESULT]: {
    label: 'Job Result',
    type: 'result',
    icon: '✅',
    requiresReply: false
  },
  [OPS_INTENTS.APPROVAL_REQUEST]: {
    label: 'Approval Request',
    type: 'task',
    icon: '🔐',
    requiresReply: true
  },
  [OPS_INTENTS.APPROVAL_GRANT]: {
    label: 'Approved',
    type: 'result',
    icon: '✅',
    requiresReply: false
  },
  [OPS_INTENTS.APPROVAL_DENY]: {
    label: 'Denied',
    type: 'result',
    icon: '❌',
    requiresReply: false
  },
  [OPS_INTENTS.KILL_SWITCH]: {
    label: 'Kill Switch',
    type: 'event',
    icon: '🛑',
    requiresReply: false
  },
  [AEE_INTENTS.ERROR]: {
    label: 'Protocol Error',
    type: 'error',
    icon: '⚠️',
    requiresReply: false
  },
  // Analytics intents
  [AEE_INTENTS.ANALYZE_CONVERSATION]: {
    label: 'Analyze Conversation',
    type: 'task',
    icon: '🔍',
    requiresReply: true
  },
  [AEE_INTENTS.ANALYZE_PATTERNS]: {
    label: 'Pattern Detection',
    type: 'task',
    icon: '📊',
    requiresReply: true
  },
  [AEE_INTENTS.STATS_DASHBOARD]: {
    label: 'Dashboard Stats',
    type: 'task',
    icon: '📈',
    requiresReply: true
  },
  // Memory intents
  [AEE_INTENTS.MEMORY_EXTRACT]: {
    label: 'Memory Extract',
    type: 'task',
    icon: '🧠',
    requiresReply: true
  },
  [AEE_INTENTS.CONTEXT_RESTORE]: {
    label: 'Context Restore',
    type: 'task',
    icon: '📚',
    requiresReply: true
  },
  [AEE_INTENTS.CONTEXT_PROACTIVE]: {
    label: 'Proactive Context',
    type: 'task',
    icon: '💡',
    requiresReply: true
  },
  // AOCL layer intents
  [AOCL_INTENTS.LAYER_START]: {
    label: 'Layer Start',
    type: 'event',
    icon: '▶️',
    requiresReply: false
  },
  [AOCL_INTENTS.LAYER_COMPLETE]: {
    label: 'Layer Complete',
    type: 'event',
    icon: '✅',
    requiresReply: false
  },
  [AOCL_INTENTS.LAYER_BYPASS]: {
    label: 'Layer Bypass',
    type: 'event',
    icon: '⏭️',
    requiresReply: false
  },
  [AOCL_INTENTS.LAYER_REJECT]: {
    label: 'Layer Reject',
    type: 'event',
    icon: '🚫',
    requiresReply: false
  },
  [AOCL_INTENTS.RUN_START]: {
    label: 'Run Start',
    type: 'event',
    icon: '🚀',
    requiresReply: false
  },
  [AOCL_INTENTS.RUN_COMPLETE]: {
    label: 'Run Complete',
    type: 'event',
    icon: '🏁',
    requiresReply: false
  },
  [AOCL_INTENTS.RUN_ERROR]: {
    label: 'Run Error',
    type: 'error',
    icon: '💥',
    requiresReply: false
  },
  // QuoxFlow workflow intents
  [QUOXFLOW_INTENTS.FLOW_STARTED]: {
    label: 'Flow Started',
    type: 'event',
    icon: '🔄',
    requiresReply: false
  },
  [QUOXFLOW_INTENTS.FLOW_COMPLETED]: {
    label: 'Flow Completed',
    type: 'event',
    icon: '✅',
    requiresReply: false
  },
  [QUOXFLOW_INTENTS.FLOW_FAILED]: {
    label: 'Flow Failed',
    type: 'error',
    icon: '❌',
    requiresReply: false
  },
  [QUOXFLOW_INTENTS.FLOW_PAUSED]: {
    label: 'Flow Paused',
    type: 'event',
    icon: '⏸️',
    requiresReply: false
  },
  [QUOXFLOW_INTENTS.FLOW_RESUMED]: {
    label: 'Flow Resumed',
    type: 'event',
    icon: '▶️',
    requiresReply: false
  },
  [QUOXFLOW_INTENTS.NODE_STARTED]: {
    label: 'Node Started',
    type: 'event',
    icon: '▶️',
    requiresReply: false
  },
  [QUOXFLOW_INTENTS.NODE_COMPLETED]: {
    label: 'Node Completed',
    type: 'event',
    icon: '✅',
    requiresReply: false
  },
  [QUOXFLOW_INTENTS.NODE_FAILED]: {
    label: 'Node Failed',
    type: 'error',
    icon: '❌',
    requiresReply: false
  },
  [QUOXFLOW_INTENTS.NODE_SKIPPED]: {
    label: 'Node Skipped',
    type: 'event',
    icon: '⏭️',
    requiresReply: false
  },
  [QUOXFLOW_INTENTS.POLICY_EVALUATED]: {
    label: 'Policy Evaluated',
    type: 'event',
    icon: '🛡️',
    requiresReply: false
  },
  [QUOXFLOW_INTENTS.APPROVAL_REQUESTED]: {
    label: 'Approval Requested',
    type: 'task',
    icon: '🔐',
    requiresReply: true
  },
  [QUOXFLOW_INTENTS.APPROVAL_RESOLVED]: {
    label: 'Approval Resolved',
    type: 'result',
    icon: '📋',
    requiresReply: false
  },
  [QUOXFLOW_INTENTS.EVIDENCE_COLLECTED]: {
    label: 'Evidence Collected',
    type: 'event',
    icon: '📎',
    requiresReply: false
  },
  // Agentic thinking intents (QE2)
  [AGENTIC_INTENTS.THINK_OBSERVE]: { label: 'Agent Observed', type: 'event', icon: '👁️', requiresReply: false },
  [AGENTIC_INTENTS.THINK_DECIDE]: { label: 'Agent Decision', type: 'event', icon: '🧠', requiresReply: false },
  [AGENTIC_INTENTS.THINK_ACT]: { label: 'Agent Action', type: 'event', icon: '⚡', requiresReply: false },
  // Task Service intents (Phase 4.B)
  [TASK_INTENTS.OBJECTIVE_CREATED]: { label: 'Objective Created', type: 'event', icon: '📋', requiresReply: false },
  [TASK_INTENTS.OBJECTIVE_DECOMPOSED]: { label: 'Objective Decomposed', type: 'event', icon: '🔀', requiresReply: false },
  [TASK_INTENTS.OBJECTIVE_STARTED]: { label: 'Objective Started', type: 'event', icon: '▶️', requiresReply: false },
  [TASK_INTENTS.OBJECTIVE_PAUSED]: { label: 'Objective Paused', type: 'event', icon: '⏸️', requiresReply: false },
  [TASK_INTENTS.OBJECTIVE_COMPLETED]: { label: 'Objective Completed', type: 'event', icon: '✅', requiresReply: false },
  [TASK_INTENTS.OBJECTIVE_FAILED]: { label: 'Objective Failed', type: 'error', icon: '❌', requiresReply: false },
  [TASK_INTENTS.TASK_STARTED]: { label: 'Task Started', type: 'event', icon: '⚙️', requiresReply: false },
  [TASK_INTENTS.TASK_COMPLETED]: { label: 'Task Completed', type: 'event', icon: '✅', requiresReply: false },
  [TASK_INTENTS.TASK_FAILED]: { label: 'Task Failed', type: 'error', icon: '❌', requiresReply: false },
  [TASK_INTENTS.CHECKPOINT_CREATED]: { label: 'Checkpoint Created', type: 'task', icon: '🔐', requiresReply: true },
  [TASK_INTENTS.CHECKPOINT_APPROVED]: { label: 'Checkpoint Approved', type: 'result', icon: '✅', requiresReply: false },
  [TASK_INTENTS.CHECKPOINT_REJECTED]: { label: 'Checkpoint Rejected', type: 'result', icon: '❌', requiresReply: false },
  // Action Tracker intents
  [ACTION_INTENTS.ITEM_CREATED]: { label: 'Action Created', type: 'event', icon: '📋', requiresReply: false },
  [ACTION_INTENTS.ITEM_MOVED]: { label: 'Action Moved', type: 'event', icon: '🔀', requiresReply: false },
  [ACTION_INTENTS.ITEM_UPDATED]: { label: 'Action Updated', type: 'event', icon: '✏️', requiresReply: false },
  [ACTION_INTENTS.ITEM_DELETED]: { label: 'Action Deleted', type: 'event', icon: '🗑️', requiresReply: false },
  [ACTION_INTENTS.ITEM_ARCHIVED]: { label: 'Action Archived', type: 'event', icon: '📦', requiresReply: false },
  [ACTION_INTENTS.SYNC_COMPLETED]: { label: 'Actions Synced', type: 'event', icon: '🔄', requiresReply: false },
  [ACTION_INTENTS.SYNC_FAILED]: { label: 'Sync Failed', type: 'error', icon: '⚠️', requiresReply: false },
}

/**
 * Get metadata for an intent
 * @param {string} intent - Intent string
 * @returns {Object|null} - Metadata or null if not found
 */
export function getIntentMetadata(intent) {
  return INTENT_METADATA[intent] || {
    label: intent.split('.').pop(),
    type: 'unknown',
    icon: '📋',
    requiresReply: false
  }
}

/**
 * Check if intent expects a reply
 * @param {string} intent - Intent string
 * @returns {boolean}
 */
export function intentRequiresReply(intent) {
  const meta = INTENT_METADATA[intent]
  return meta ? meta.requiresReply : false
}

/**
 * Get the expected response intent for a task intent
 * @param {string} taskIntent - Task intent
 * @returns {string|null} - Response intent or null
 */
export function getResponseIntent(taskIntent) {
  const mapping = {
    [CHAT_INTENTS.QUERY]: CHAT_INTENTS.RESPONSE,
    [QuoxAgent_INTENTS.JOB_SUBMIT]: QuoxAgent_INTENTS.JOB_RESULT,
    [QuoxAgent_INTENTS.INSTALL]: QuoxAgent_INTENTS.INSTALL_RESULT,
    [OPS_INTENTS.APPROVAL_REQUEST]: OPS_INTENTS.APPROVAL_GRANT, // or DENY
    [AEE_INTENTS.CAPABILITY_LIST]: AEE_INTENTS.CAPABILITY_RESULT,
    [AEE_INTENTS.PING]: AEE_INTENTS.PONG,
    [AGENT_INTENTS.DELEGATE]: AGENT_INTENTS.DELEGATE_RESULT
  }
  return mapping[taskIntent] || null
}

/**
 * Validate intent format
 * @param {string} intent - Intent string
 * @returns {boolean}
 */
export function isValidIntent(intent) {
  if (typeof intent !== 'string') return false
  const parts = intent.split('.')
  return parts.length >= 2 && parts.every(p => p.length > 0)
}

/**
 * Parse intent into components
 * @param {string} intent - Intent string
 * @returns {{domain: string, category: string, action: string}}
 */
export function parseIntent(intent) {
  const parts = intent.split('.')
  return {
    domain: parts[0] || '',
    category: parts[1] || '',
    action: parts.slice(2).join('.') || ''
  }
}
