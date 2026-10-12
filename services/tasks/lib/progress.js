// SSE progress event system — mirrors inboxEvents.js pattern

// Map of objectiveId → Set<response>
const subscribers = new Map()

/**
 * Subscribe a client (SSE response) to objective progress events.
 */
export function subscribe(objectiveId, res) {
  if (!subscribers.has(objectiveId)) {
    subscribers.set(objectiveId, new Set())
  }
  subscribers.get(objectiveId).add(res)

  // Clean up on disconnect
  res.on('close', () => {
    const subs = subscribers.get(objectiveId)
    if (subs) {
      subs.delete(res)
      if (subs.size === 0) {
        subscribers.delete(objectiveId)
      }
    }
  })
}

/**
 * Emit a progress event to all subscribers of an objective.
 * @param {string} objectiveId
 * @param {object} event - { type, ...data }
 */
export function emitProgress(objectiveId, event) {
  const subs = subscribers.get(objectiveId)
  if (!subs || subs.size === 0) return

  const data = JSON.stringify({
    ...event,
    objective_id: objectiveId,
    timestamp: new Date().toISOString()
  })

  for (const res of subs) {
    try {
      res.write(`event: ${event.type}\n`)
      res.write(`data: ${data}\n\n`)
    } catch {
      // Client disconnected — remove
      subs.delete(res)
    }
  }
}

/**
 * Get count of active subscribers for an objective.
 */
export function getSubscriberCount(objectiveId) {
  const subs = subscribers.get(objectiveId)
  return subs ? subs.size : 0
}
