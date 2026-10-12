/**
 * AEE (Agent Envelope Exchange) Library
 * "HTTP headers for agent swarms"
 *
 * @fileoverview Main entry point for the AEE library
 *
 * @example
 * import { createChatQuery, storeEnvelope, getConversation } from '../lib/aee'
 *
 * // Create and store a chat query
 * const query = createChatQuery('Check disk on kuma01')
 * await storeEnvelope(query)
 *
 * // Later, get the full conversation
 * const messages = await getConversation(query.corr)
 */

// Types and validation
export {
  ENVELOPE_TYPES,
  PRIORITY_LEVELS,
  PROTOCOL_VERSION,
  REQUIRED_FIELDS,
  validateEnvelope,
  isAEEEnvelope
} from './types.js'

// ULID generation
export {
  ulid,
  ulidTime,
  isValidUlid,
  prefixedUlid,
  compareUlid
} from './ulid.js'

// Intent definitions
export {
  CHAT_INTENTS,
  AGENT_INTENTS,
  QuoxAgent_INTENTS,
  OPS_INTENTS,
  AEE_INTENTS,
  SYSTEM_INTENTS,
  AOCL_INTENTS,
  ACTION_INTENTS,
  ALL_INTENTS,
  INTENT_METADATA,
  getIntentMetadata,
  intentRequiresReply,
  getResponseIntent,
  isValidIntent,
  parseIntent
} from './intents.js'

// Envelope factory functions
export {
  createTask,
  createResult,
  createEvent,
  createError,
  createStream,
  createChatQuery,
  createChatResponse,
  createHeartbeat,
  createQuoxAgentJob,
  createQuoxAgentJobResult,
  createApprovalRequest,
  validateAndNormalize,
  getEnvelopeSummary,
  // AOCL layer support
  AOCL_LAYERS,
  AOCL_LAYER_ORDER,
  getLayerMetadata,
  createLayerEvent,
  createRunEvent
} from './envelope.js'

// IndexedDB storage
export {
  storeEnvelope,
  storeEnvelopes,
  getEnvelope,
  getConversation,
  findRelatedEvents,
  getThread,
  queryEnvelopes,
  getConversations,
  getUnsyncedEnvelopes,
  markSynced,
  deleteEnvelope,
  cleanupOldEnvelopes,
  getStats,
  clearAll,
  closeDB,
  // Server sync
  syncToServer,
  startBackgroundSync,
  stopBackgroundSync,
  // Server read (cross-device)
  getConversationsFromServer,
  getConversationFromServer
} from './store.js'

// Capability discovery
export {
  registerAgent,
  unregisterAgent,
  getAllAgents,
  getAgent,
  getAgentCapabilities,
  findAgentsByIntent,
  findAgentsByPattern,
  createCapabilityRequest,
  createCapabilityResponse,
  getCapabilityManifest
} from './capabilities.js'

// Default export for convenience
import { ulid } from './ulid.js'
export default ulid
