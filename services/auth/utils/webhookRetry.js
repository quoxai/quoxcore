/**
 * ET-3 Phase B follow-up — webhook retry worker.
 *
 * Scans webhook_deliveries for rows due a retry, re-signs the envelope
 * using the stored event + current webhook secret, re-POSTs, and
 * records a new delivery row for each attempt. After
 * RETRY_MAX_ATTEMPTS, the final failed row has next_retry_at = NULL
 * and is never picked up again.
 *
 * Retry backoff: 1m / 5m / 30m / 2h / 12h (matches the schedule in
 * webhookDispatcher.js — attempt N in the stored row is the attempt
 * that failed; the NEXT attempt will be N+1).
 */

import { ulid } from './helpers.js';
import { createHmac } from 'crypto';
import { decrypt } from './encryption.js';
import { buildWebhookEnvelope, signPayload } from './webhookDispatcher.js';

export const RETRY_MAX_ATTEMPTS = 5;

// STABILITY-AUDITS: the delivery fetch previously had no timeout — a
// single hung endpoint left `await fetchImpl(...)` pending forever, which
// meant the tick's `finally { inFlight = false; }` never ran either,
// permanently wedging the retry worker after one bad endpoint. Read at
// call time (not module load) so tests can override per-case.
function webhookDeliveryTimeoutMs() {
    const raw = Number(process.env.WEBHOOK_DELIVERY_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

// Next-retry schedule indexed by the CURRENT attempt number. After
// attempt 5 there is no next retry.
const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];

function nextRetryAt(attempt) {
    // Once we've burned RETRY_MAX_ATTEMPTS, give up — no more retries.
    if (attempt >= RETRY_MAX_ATTEMPTS) return null;
    const ms = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
    return new Date(Date.now() + ms).toISOString();
}

// ──────────────────────────────────────────────────────────────────────
// Queries
// ──────────────────────────────────────────────────────────────────────

/**
 * Returns the latest delivery row per (webhook, event) that is
 *   - status = 'failed'
 *   - next_retry_at <= now
 *   - attempt < RETRY_MAX_ATTEMPTS
 *   - NOT already superseded by a success row for the same pair
 */
export function findDueRetries(db, { now = Date.now(), limit = 50 } = {}) {
    const nowIso = new Date(now).toISOString();

    // Latest row per (webhook, event). Using a correlated subquery keeps
    // the SQL portable to plain SQLite (no window-function requirement).
    const rows = db.prepare(`
        SELECT d.*
        FROM webhook_deliveries d
        WHERE d.attempt = (
            SELECT MAX(attempt)
            FROM webhook_deliveries
            WHERE webhook_id = d.webhook_id AND event_id = d.event_id
        )
        AND d.status = 'failed'
        AND d.next_retry_at IS NOT NULL
        AND d.next_retry_at <= ?
        AND d.attempt < ?
        AND NOT EXISTS (
            SELECT 1 FROM webhook_deliveries s
            WHERE s.webhook_id = d.webhook_id
              AND s.event_id   = d.event_id
              AND s.status     = 'success'
        )
        ORDER BY d.next_retry_at ASC
        LIMIT ?
    `).all(nowIso, RETRY_MAX_ATTEMPTS, limit);
    return rows;
}

// ──────────────────────────────────────────────────────────────────────
// Single-delivery retry
// ──────────────────────────────────────────────────────────────────────

function insertDelivery(db, { webhookId, eventId, status, responseStatus, errorMessage, attempt }) {
    db.prepare(`
        INSERT INTO webhook_deliveries
            (id, webhook_id, event_id, status, response_status, error_message, attempt, next_retry_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        ulid(), webhookId, eventId, status,
        responseStatus ?? null,
        errorMessage ?? null,
        attempt,
        status === 'failed' ? nextRetryAt(attempt) : null,
    );
}

async function safeText(res) {
    if (!res || typeof res.text !== 'function') return null;
    try { return await res.text(); } catch { return null; }
}

export async function processOneRetry(db, row, { fetchImpl = globalThis.fetch } = {}) {
    const webhook = db.prepare(
        `SELECT id, url, secret_cipher, enabled FROM webhooks WHERE id = ?`,
    ).get(row.webhook_id);
    const event = db.prepare(
        `SELECT * FROM team_events WHERE id = ?`,
    ).get(row.event_id);

    const attempt = row.attempt + 1;

    // If the webhook itself has been deleted, the FK ON DELETE CASCADE
    // has already removed every delivery row for it. Nothing to do.
    if (!webhook) {
        return { status: 'abandoned', attempt, reason: 'webhook_deleted' };
    }
    // Event gone or webhook disabled — the webhook row still exists,
    // so we can record a terminal row (next_retry_at=null) so this
    // pair is never retried again.
    if (!event || !webhook.enabled) {
        db.prepare(`
            INSERT INTO webhook_deliveries
                (id, webhook_id, event_id, status, response_status, error_message, attempt, next_retry_at)
            VALUES (?, ?, ?, 'failed', NULL, ?, ?, NULL)
        `).run(
            ulid(), row.webhook_id, row.event_id,
            !event ? 'event missing' : 'webhook disabled',
            attempt,
        );
        return { status: 'abandoned', attempt, reason: !event ? 'event_missing' : 'webhook_disabled' };
    }

    const secret    = decrypt(webhook.secret_cipher);
    const envelope  = buildWebhookEnvelope(event);
    const body      = JSON.stringify(envelope);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signPayload(secret, timestamp, body);

    try {
        const res = await fetchImpl(webhook.url, {
            method:  'POST',
            headers: {
                'Content-Type':      'application/json',
                'User-Agent':        'Quox-Webhooks/1.0',
                'X-Quox-Event-Type': event.event_type,
                'X-Quox-Event-Id':   event.id,
                'X-Quox-Timestamp':  timestamp,
                'X-Quox-Signature':  signature,
                'X-Quox-Retry':      String(attempt),
            },
            body,
            signal: AbortSignal.timeout(webhookDeliveryTimeoutMs()),
        });
        if (res && res.ok) {
            insertDelivery(db, {
                webhookId:      row.webhook_id,
                eventId:        row.event_id,
                status:         'success',
                responseStatus: res.status,
                attempt,
            });
            return { status: 'success', attempt };
        }
        const respBody = await safeText(res);
        insertDelivery(db, {
            webhookId:      row.webhook_id,
            eventId:        row.event_id,
            status:         'failed',
            responseStatus: res?.status ?? null,
            errorMessage:   respBody?.slice(0, 500) || null,
            attempt,
        });
        return { status: 'failed', attempt };
    } catch (err) {
        insertDelivery(db, {
            webhookId:    row.webhook_id,
            eventId:      row.event_id,
            status:       'failed',
            errorMessage: String(err?.message || err).slice(0, 500),
            attempt,
        });
        return { status: 'failed', attempt };
    }
}

// ──────────────────────────────────────────────────────────────────────
// Tick + worker loop
// ──────────────────────────────────────────────────────────────────────

export async function runRetryTick(db, { fetchImpl, batchSize = 50, now = Date.now() } = {}) {
    const due = findDueRetries(db, { now, limit: batchSize });
    let succeeded = 0, failed = 0, abandoned = 0;
    for (const row of due) {
        const out = await processOneRetry(db, row, { fetchImpl });
        if (out.status === 'success')   succeeded++;
        else if (out.status === 'abandoned') abandoned++;
        else                           failed++;
    }
    return { processed: due.length, succeeded, failed, abandoned };
}

export function startRetryWorker(db, { intervalMs = 60_000, fetchImpl = globalThis.fetch, batchSize = 50 } = {}) {
    let stopped = false;
    let inFlight = false;
    const tick = async () => {
        if (stopped || inFlight) return;
        inFlight = true;
        try { await runRetryTick(db, { fetchImpl, batchSize }); }
        catch (err) { console.error('[webhook-retry] tick failed:', err.message); }
        finally { inFlight = false; }
    };
    const handle = setInterval(tick, intervalMs);
    if (typeof handle.unref === 'function') handle.unref();
    return {
        stop() {
            if (stopped) return;
            stopped = true;
            clearInterval(handle);
        },
    };
}
