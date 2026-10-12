/**
 * Intent Examples for Semantic Classification
 *
 * Example utterances for each intent, used to train the semantic router.
 * More examples = better paraphrase handling.
 *
 * Structure:
 * - Each intent has 5-15 example utterances
 * - Examples cover variations in phrasing
 * - Examples are sorted by specificity (most specific first)
 */

/**
 * Intent example utterances
 * @type {Object.<string, string[]>}
 */
export const INTENT_EXAMPLES = {
  // ============================================================================
  // HIGH RISK INTENTS (require high confidence)
  // ============================================================================

  install_quoxagent: [
    'install quoxagent on docker01',
    'deploy quoxagent on docker01',
    'setup quoxagent on docker01',
    'install quoxagent agent on kuma01',
    'deploy quoxagent to all hosts',
    'set up quoxagent on gw-01',
    'can you install quoxagent on proxmox01',
    'put quoxagent on docker02',
    'add quoxagent to the new server',
    'roll out quoxagent to docker cluster'
  ],

  // ============================================================================
  // MEDIUM RISK INTENTS (status checks, listings)
  // ============================================================================

  fleet_status: [
    'quoxagent status',
    'fleet status',
    'agent status',
    'show fleet status',
    "what's the fleet status",
    'how are the agents doing',
    'quoxagent fleet overview',
    'status of all agents',
    'check agent status',
    "how's the quoxagent fleet looking",
    'give me the fleet status',
    'agent fleet health'
  ],

  health_check: [
    'check docker01',
    'health check on docker01',
    'run health check on kuma01',
    'check all hosts',
    'health check fleet',
    'is docker01 healthy',
    'check the health of proxmox01',
    'verify docker02 is working',
    'run diagnostics on gw-01',
    'check host health'
  ],

  list_agents: [
    'list agents',
    'show all agents',
    'show quoxagent agents',
    'what agents are connected',
    'list connected agents',
    'display all quoxagent agents',
    'which agents are online',
    'agent list',
    'show me the agents'
  ],

  list_hosts: [
    'list hosts',
    'show all hosts',
    'list known hosts',
    'what hosts do you know',
    'display all hosts',
    'show me the hosts',
    'which hosts are configured',
    'host list',
    'all available hosts'
  ],

  list_assistants: [
    'list assistants',
    'show all assistants',
    'what assistants are there',
    'what assistants are available',
    'display assistants',
    'which assistants exist',
    'assistant list',
    'show me the assistants'
  ],

  memory_search: [
    'what do you know about docker',
    'do you remember our conversation about kubernetes',
    'search memory for nginx',
    'what have I told you about proxmox',
    'recall information about networking',
    'what do you remember about the backup system',
    'find in memory anything about ssl',
    'check your memory for certificates',
    'what did we discuss about monitoring'
  ],

  preference_get: [
    "what's my preference for verbosity",
    'show my preference for communication style',
    'my verbosity preference',
    'what is my notification setting',
    'my communication preference',
    'show my timezone preference',
    'what format do I prefer'
  ],

  preference_list: [
    'list preferences',
    'show my preferences',
    'list all my preferences',
    'my settings',
    'show all preferences',
    'display my preferences',
    'what are my preferences'
  ],

  router_stats: [
    'router stats',
    'bypass stats',
    'how many queries are bypassed',
    'smart router statistics',
    'show router performance',
    'what is the bypass rate',
    'router metrics'
  ],

  host_details: [
    'tell me about docker01',
    'details about kuma01',
    'info on proxmox01',
    'what is docker02',
    'information about gw-01',
    'describe host docker03',
    'give me details on nas01',
    "what's the story with docker04"
  ],

  agent_info: [
    'what can WARDEN do',
    'tell me about DAEDALUS',
    'describe CIPHER agent',
    'what is VAULT',
    'information about SCHOLAR',
    'capabilities of PRISM',
    'what does ARCHIVIST do'
  ],

  // ============================================================================
  // LOW RISK INTENTS (informational)
  // ============================================================================

  what_is_quox: [
    'what is quox',
    'what are you',
    'tell me about yourself',
    'explain quox',
    'what is this system',
    'describe quox',
    'what does quox do',
    'explain what quox is'
  ],

  who_are_you: [
    'who are you',
    "what's your name",
    'identify yourself',
    'introduce yourself',
    'who am i talking to'
  ],

  capabilities: [
    'what can you do',
    'what can quox do',
    'your capabilities',
    "what are you capable of",
    'show me what you can do',
    'list your features',
    'what functions do you have',
    'what are your abilities'
  ],

  greeting: [
    'hello',
    'hi',
    'hey',
    'good morning',
    'good afternoon',
    'good evening',
    'greetings',
    'hi quox',
    'hello quox',
    'hey there'
  ],

  time_query: [
    "what's the time",
    'what time is it',
    'current time',
    'tell me the time',
    'what is the current time'
  ],

  help_query: [
    'help',
    'what can i ask',
    'commands',
    'how do i',
    'show me commands',
    'available commands',
    'how to use this'
  ]
}

/**
 * Get examples for an intent
 * @param {string} intentName
 * @returns {string[]}
 */
export function getExamplesForIntent(intentName) {
  return INTENT_EXAMPLES[intentName] || []
}

/**
 * Get all intent names
 * @returns {string[]}
 */
export function getAllIntentNames() {
  return Object.keys(INTENT_EXAMPLES)
}

/**
 * Get all examples flattened with intent labels
 * @returns {Array<{intent: string, text: string}>}
 */
export function getAllExamplesFlat() {
  const examples = []
  for (const [intent, texts] of Object.entries(INTENT_EXAMPLES)) {
    for (const text of texts) {
      examples.push({ intent, text })
    }
  }
  return examples
}

/**
 * Get total number of examples
 * @returns {number}
 */
export function getTotalExampleCount() {
  return Object.values(INTENT_EXAMPLES).reduce((sum, arr) => sum + arr.length, 0)
}

export default {
  INTENT_EXAMPLES,
  getExamplesForIntent,
  getAllIntentNames,
  getAllExamplesFlat,
  getTotalExampleCount
}
