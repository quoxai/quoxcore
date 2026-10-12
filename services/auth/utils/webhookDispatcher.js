/**
 * ET-3 Phase B — webhook dispatcher.
 *
 * Fans a team_event out to the webhooks that subscribed to its type,
 * signs each POST with HMAC-SHA256 (v1 scheme: "v1=hex(HMAC(secret,
 * timestamp + '.' + body))"), records the outcome in
 * webhook_deliveries. Retry scheduling is a follow-up — failures
 * simply persist with status='failed' and a next_retry_at stamp that
 * a background worker can claim.
 */

import { ulid } from './helpers.js';
import { createHmac, timingSafeEqual } from 'crypto';
import { listEnabledWebhooksForEvent } from './webhooks.js';

export function signPayload(secret, timestamp, body) {
    const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    return `v1=${mac}`;
}

export function verifyPayloadSignature(secret, timestamp, body, header) {
    if (typeof header !== 'string' || !header.startsWith('v1=')) return false;
    const expected = signPayload(secret, timestamp, body);
    if (expected.length !== header.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}

export function buildWebhookEnvelope(eventRow) {
    let metadata = {};
    try { metadata = JSON.parse(eventRow.metadata_json || '{}'); } catch { /* noop */ }
    return {
        id:         eventRow.id,
        type:       eventRow.event_type,
        org_id:     eventRow.org_id,
        created_at: eventRow.created_at,
        data: {
            team_id:         eventRow.team_id,
            actor_id:        eventRow.actor_id,
            subject_user_id: eventRow.subject_user_id,
            metadata,
        },
    };
}

// ──────────────────────────────────────────────────────────────────────
// Retry schedule: 1m, 5m, 30m, 2h, 12h. After five attempts, give up.
// ──────────────────────────────────────────────────────────────────────
const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];

// STABILITY-AUDITS: mirrors webhookRetry.js's timeout guard — the initial
// delivery fetch had no timeout either, so one hung subscriber endpoint
// could stall the whole event fan-out. Read at call time so tests can
// override per-case.
function webhookDeliveryTimeoutMs() {
    const raw = Number(process.env.WEBHOOK_DELIVERY_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

function nextRetryAt(attempt) {
    const idx = Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1);
    if (attempt > RETRY_DELAYS_MS.length) return null;
    return new Date(Date.now() + RETRY_DELAYS_MS[idx]).toISOString();
}

function recordDelivery(db, { webhookId, eventId, status, responseStatus, errorMessage, attempt = 1 }) {
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

export async function dispatchEventToWebhooks(db, orgId, eventRow, { fetchImpl = globalThis.fetch } = {}) {
    const subs = listEnabledWebhooksForEvent(db, orgId, eventRow.event_type);
    if (!subs.length) return { delivered: 0, failed: 0, skipped: 0 };

    const envelope  = buildWebhookEnvelope(eventRow);
    const body      = JSON.stringify(envelope);
    const timestamp = Math.floor(Date.now() / 1000).toString();

    let delivered = 0;
    let failed    = 0;
    for (const sub of subs) {
        const signature = signPayload(sub.secret, timestamp, body);
        try {
            const res = await fetchImpl(sub.url, {
                method:  'POST',
                headers: {
                    'Content-Type':      'application/json',
                    'User-Agent':        'Quox-Webhooks/1.0',
                    'X-Quox-Event-Type': eventRow.event_type,
                    'X-Quox-Event-Id':   eventRow.id,
                    'X-Quox-Timestamp':  timestamp,
                    'X-Quox-Signature':  signature,
                },
                body,
                signal: AbortSignal.timeout(webhookDeliveryTimeoutMs()),
            });
            if (res && res.ok) {
                recordDelivery(db, {
                    webhookId:      sub.id,
                    eventId:        eventRow.id,
                    status:         'success',
                    responseStatus: res.status,
                });
                delivered++;
            } else {
                const respBody = await safeText(res);
                recordDelivery(db, {
                    webhookId:      sub.id,
                    eventId:        eventRow.id,
                    status:         'failed',
                    responseStatus: res?.status ?? null,
                    errorMessage:   respBody?.slice(0, 500) || null,
                });
                failed++;
            }
        } catch (err) {
            recordDelivery(db, {
                webhookId:    sub.id,
                eventId:      eventRow.id,
                status:       'failed',
                errorMessage: String(err?.message || err).slice(0, 500),
            });
            failed++;
        }
    }
    return { delivered, failed, skipped: 0 };
}

async function safeText(res) {
    if (!res || typeof res.text !== 'function') return null;
    try { return await res.text(); } catch { return null; }
}
