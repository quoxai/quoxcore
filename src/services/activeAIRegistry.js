/**
 * activeAIRegistry — Global registry of active AI processes across the app.
 *
 * Tracks active chats, tool executions, workflows, and other AI work.
 * Lightweight pub/sub so the header indicator can react without polling.
 *
 * Usage:
 *   import { registerAI, unregisterAI, useActiveAI } from './activeAIRegistry'
 *
 *   // In ChatEngine/ChatTab:
 *   registerAI('chat-SESSION_123', { type: 'chat', agent: 'quox', label: 'Chat with QUOX' })
 *   unregisterAI('chat-SESSION_123')
 *
 *   // In header indicator:
 *   const { entries, count } = useActiveAI()
 */

import { useSyncExternalStore, useCallback } from 'react'

// Registry state
const registry = new Map()
const listeners = new Set()

function notify() {
  for (const listener of listeners) {
    listener()
  }
}

/**
 * Register an active AI process.
 * @param {string} id - Unique ID (e.g. 'chat-SESSION_123', 'objective-abc')
 * @param {object} meta - { type: 'chat'|'objective'|'workflow'|'tool', agent, label, startedAt? }
 */
export function registerAI(id, meta) {
  registry.set(id, {
    ...meta,
    id,
    startedAt: meta.startedAt || Date.now(),
  })
  notify()
}

/**
 * Unregister an AI process (completed, cancelled, or errored).
 */
export function unregisterAI(id) {
  if (registry.delete(id)) {
    notify()
  }
}

/**
 * Get current snapshot of all active AI processes.
 */
export function getActiveAI() {
  return Array.from(registry.values())
}

/**
 * Get count of active AI processes.
 */
export function getActiveAICount() {
  return registry.size
}

// useSyncExternalStore integration
function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return registry.size + '_' + Array.from(registry.keys()).join(',')
}

/**
 * React hook — returns current active AI processes with auto-rerender on change.
 */
export function useActiveAI() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)
  const entries = useCallback(() => getActiveAI(), [snapshot])
  return {
    entries: entries(),
    count: registry.size,
    snapshot,
  }
}
