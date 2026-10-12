/**
 * QuoxFlow Event Bus
 *
 * Internal event bus for inter-workflow triggers.
 * trigger:event nodes subscribe to AEE envelope events.
 * Enables patterns like "when approval granted → execute action".
 *
 * Uses a simple publish/subscribe model with envelope-based events.
 */

import { Envelope } from '../core/envelope.js';

export type EventHandler = (envelope: Envelope) => void | Promise<void>;

interface Subscription {
  id: string;
  pattern: string;        // Intent pattern (supports * wildcard)
  handler: EventHandler;
  workflowId?: string;    // Optional: scope to a specific workflow
  once: boolean;          // Fire once and auto-unsubscribe
  // QF-MT WP4: owning org, stamped by trigger-bootstrap from the owning
  // workflow row (stored.orgId ?? stored.metadata.orgId). Optional because
  // EventBus is also used for internal, non-workflow-scoped pub/sub —
  // subscriptions without an orgId are visible to SYSTEM_SCOPE callers only
  // when listed via GET /api/triggers/events (never leaked to a tenant).
  orgId?: string;
}

/**
 * EventBus provides publish/subscribe for AEE envelope events.
 *
 * Patterns support wildcards:
 *   - "quox.flow.completed" — exact match
 *   - "quox.flow.*" — matches any quox.flow intent
 *   - "ops.approval.*" — matches all approval events
 *   - "*" — matches everything
 */
export class EventBus {
  private subscriptions: Map<string, Subscription> = new Map();
  private nextId = 0;
  private eventLog: Array<{ ts: string; intent: string; subscribersNotified: number }> = [];
  private maxLogSize = 1000;

  /**
   * Subscribe to events matching a pattern.
   */
  subscribe(pattern: string, handler: EventHandler, options?: {
    workflowId?: string;
    once?: boolean;
    orgId?: string;
  }): string {
    const id = `sub-${++this.nextId}`;
    this.subscriptions.set(id, {
      id,
      pattern,
      handler,
      workflowId: options?.workflowId,
      once: options?.once ?? false,
      orgId: options?.orgId,
    });
    return id;
  }

  /**
   * Subscribe to a single event (auto-unsubscribes after first match).
   */
  once(pattern: string, handler: EventHandler, workflowId?: string, orgId?: string): string {
    return this.subscribe(pattern, handler, { workflowId, once: true, orgId });
  }

  /**
   * Unsubscribe by subscription ID.
   */
  unsubscribe(id: string): boolean {
    return this.subscriptions.delete(id);
  }

  /**
   * Unsubscribe all handlers for a workflow.
   */
  unsubscribeWorkflow(workflowId: string): number {
    let removed = 0;
    for (const [id, sub] of this.subscriptions) {
      if (sub.workflowId === workflowId) {
        this.subscriptions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Publish an envelope event to all matching subscribers.
   */
  async publish(envelope: Envelope): Promise<number> {
    const toRemove: string[] = [];
    let notified = 0;

    for (const [id, sub] of this.subscriptions) {
      if (this.matches(sub.pattern, envelope.intent)) {
        notified++;
        try {
          await sub.handler(envelope);
        } catch (err) {
          console.error(`[EventBus] Handler error for ${sub.pattern}:`, err instanceof Error ? err.message : err);
        }

        if (sub.once) {
          toRemove.push(id);
        }
      }
    }

    // Clean up one-shot subscriptions
    for (const id of toRemove) {
      this.subscriptions.delete(id);
    }

    // Log event
    this.eventLog.push({
      ts: new Date().toISOString(),
      intent: envelope.intent,
      subscribersNotified: notified,
    });
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog = this.eventLog.slice(-this.maxLogSize);
    }

    return notified;
  }

  /**
   * Check if a pattern matches an intent.
   * Supports * as wildcard for any segment.
   */
  private matches(pattern: string, intent: string): boolean {
    if (pattern === '*') return true;
    if (pattern === intent) return true;

    // Wildcard at end: "quox.flow.*" matches "quox.flow.completed"
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      return intent.startsWith(prefix + '.');
    }

    // Wildcard in middle: "quox.*.completed" matches "quox.flow.completed"
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]+') + '$');
      return regex.test(intent);
    }

    return false;
  }

  /**
   * Get count of active subscriptions.
   */
  get subscriberCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Get recent event log entries.
   */
  getRecentEvents(limit = 50): typeof this.eventLog {
    return this.eventLog.slice(-limit);
  }

  /**
   * Get all subscription patterns.
   */
  getSubscriptions(): Array<{
    id: string;
    pattern: string;
    workflowId?: string;
    once: boolean;
    orgId?: string;
  }> {
    return Array.from(this.subscriptions.values()).map(sub => ({
      id: sub.id,
      pattern: sub.pattern,
      workflowId: sub.workflowId,
      once: sub.once,
      orgId: sub.orgId,
    }));
  }

  /**
   * Clear all subscriptions and event log (for testing/shutdown).
   */
  clear(): void {
    this.subscriptions.clear();
    this.eventLog = [];
  }
}

/**
 * Global event bus instance.
 */
export const eventBus = new EventBus();
