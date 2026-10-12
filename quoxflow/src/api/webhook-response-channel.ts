/**
 * Webhook Response Channel — MACHINERY
 *
 * Bridges the async (fire-and-forget) execution pipeline back to a
 * synchronously-held inbound webhook HTTP request when the triggered
 * workflow contains a `respondToWebhook` node.
 *
 * Flow:
 *   1. webhook-triggers.ts inspects the workflow definition. If it contains
 *      a respondToWebhook node, it calls `createPending(executionId)` BEFORE
 *      kicking off `executionService.executeAsync(...)`, then awaits the
 *      returned promise.
 *   2. The respond-webhook executor runs mid-pipeline (in the background
 *      execution) and calls `resolve(executionId, payload)`.
 *   3. The pending promise resolves with `payload`, and the webhook route
 *      returns it as the actual HTTP response instead of the default 202.
 *
 * If nothing calls `resolve()` within `timeoutMs`, the pending promise
 * resolves to `null` so the caller can fall back to the standard
 * fire-and-forget 202 response.
 *
 * In-memory only — same lifetime/scope as WebhookRegistry. A process
 * restart loses in-flight pending entries; callers already hold the HTTP
 * connection open so this only matters across a restart mid-request, which
 * would drop the connection anyway.
 */

export interface WebhookResponsePayload {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface PendingEntry {
  resolve: (payload: WebhookResponsePayload) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Falls back to the pre-existing 202 fire-and-forget behavior after this long. */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;

export class WebhookResponseChannel {
  private pending: Map<string, PendingEntry> = new Map();

  /**
   * Register a pending response slot for an execution.
   *
   * Returns a promise that resolves either when `resolve()` is called for
   * that executionId, or with `null` after `timeoutMs` elapses (no response
   * node fired in time — caller should fall back to 202).
   */
  createPending(
    executionId: string,
    timeoutMs: number = DEFAULT_RESPONSE_TIMEOUT_MS
  ): Promise<WebhookResponsePayload | null> {
    return new Promise(resolvePromise => {
      const timer = setTimeout(() => {
        this.pending.delete(executionId);
        resolvePromise(null);
      }, timeoutMs);
      // Don't let this timer keep a short-lived process (e.g. test runner) alive.
      if (typeof timer.unref === 'function') timer.unref();

      this.pending.set(executionId, {
        timer,
        resolve: payload => {
          clearTimeout(timer);
          this.pending.delete(executionId);
          resolvePromise(payload);
        },
      });
    });
  }

  /**
   * Resolve a pending response. Returns false (no-op) if there is no
   * pending entry for the executionId — e.g. no respondToWebhook node in
   * the workflow, or the pending entry already timed out / settled.
   */
  resolve(executionId: string, payload: WebhookResponsePayload): boolean {
    const entry = this.pending.get(executionId);
    if (!entry) return false;
    entry.resolve(payload);
    return true;
  }

  /** True if a pending response slot is currently registered for executionId. */
  has(executionId: string): boolean {
    return this.pending.has(executionId);
  }

  /** Test/shutdown helper — clears all pending entries without resolving them. */
  clear(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }
}

/** Global singleton — mirrors the module-level executor singletons pattern. */
export const webhookResponseChannel = new WebhookResponseChannel();
