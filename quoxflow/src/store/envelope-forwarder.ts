/**
 * Envelope Forwarder
 *
 * Fire-and-forget HTTP sink that POSTs envelopes to the collector's
 * /aee/sync endpoint. The collector's better-sqlite3 AEE DB is what
 * the dashboard's ActivityView reads from — without this, workflow
 * envelopes (aocl.ingress.received, quox.flow.node.started, etc.)
 * exist in QuoxFlow's own envelope store but never surface in the
 * activity view alongside chat envelopes. Result: workflow runs
 * appeared as bare entries with no AOCL or AEE detail.
 *
 * Errors are swallowed (logged once per minute max). The forwarder
 * MUST NOT block envelope persistence — quoxflow's own store is the
 * source of truth; the collector copy is for cross-system visibility.
 *
 * QUOXTRUST-B2: this sink used to be pure fire-and-forget with no way to
 * report the outcome, so a failed POST silently dropped the batch forever
 * even though the envelope still existed in quoxflow's own table. The sink
 * now resolves true/false so EnvelopeStore's durable outbox
 * (forward_status/drainPendingForwards) can retry a failed forward instead
 * of losing it.
 */
import type { Envelope } from '../core/envelope.js';

/**
 * QUOXTRUST-B2: widened from `void` to also allow reporting success/failure.
 * `EnvelopeStore`'s durable outbox (drainPendingForwards) needs to know
 * whether a forward actually landed so it can mark rows 'forwarded' or leave
 * them 'pending' for retry — a `void` sink is still accepted (legacy /
 * test callers) and is treated as an untrackable fire-and-forget call.
 */
export interface EnvelopeSink {
  (envelopes: Envelope[]): void | boolean | Promise<boolean>;
}

export interface CollectorForwarderOptions {
  collectorUrl: string;
  serviceKey?: string;
  /** Defaults to 5000ms. */
  timeoutMs?: number;
}

export function createCollectorForwarder(opts: CollectorForwarderOptions): EnvelopeSink {
  const url = `${opts.collectorUrl.replace(/\/$/, '')}/aee/sync`;
  const timeoutMs = opts.timeoutMs ?? 5000;
  let lastErrorLog = 0;

  return (envelopes: Envelope[]): Promise<boolean> => {
    if (!envelopes || envelopes.length === 0) return Promise.resolve(true);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (opts.serviceKey) headers['X-Service-Key'] = opts.serviceKey;

    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ envelopes }),
      signal: controller.signal,
    })
      .then(res => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return true;
      })
      .catch(err => {
        const now = Date.now();
        if (now - lastErrorLog > 60_000) {
          lastErrorLog = now;
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[EnvelopeForwarder] POST ${url} failed: ${msg} (further errors suppressed for 60s)`);
        }
        return false;
      })
      .finally(() => clearTimeout(timer));
  };
}
