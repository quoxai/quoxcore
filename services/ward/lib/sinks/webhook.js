/**
 * WARD-EXT-2: Webhook Sink
 *
 * POSTs signed tip JSON to a customer-provided URL.
 * sink_ref format: webhook:<url_hash>#<tip_seq>
 */

import crypto from 'crypto';
import { assertSafeEgressUrl } from '../egressGuard.js';

/**
 * @param {object} tip - Signed WARD tip
 * @param {object} config - { webhook_url, auth_header }
 * @returns {Promise<{success: boolean, sink_ref: string|null, error: string|null}>}
 */
async function publish(tip, config = {}) {
  const { webhook_url, auth_header } = config;

  if (!webhook_url) {
    return { success: false, sink_ref: null, error: 'No webhook_url configured' };
  }

  const body = JSON.stringify({
    event: 'ward.tip.published',
    tip_id: tip.tip_id,
    chain_id: tip.chain_id,
    tip_seq: tip.tip_seq,
    tip_chain_hash: tip.tip_chain_hash,
    entry_count: tip.entry_count,
    created_at: tip.created_at,
    sig: tip.sig,
    key_id: tip.key_id,
    published_at: new Date().toISOString()
  });

  const headers = { 'Content-Type': 'application/json' };
  if (auth_header) headers['Authorization'] = auth_header;

  try {
    // TRUST-PROOF audit cycle 1: guard the sink URL like every other
    // server-side fetch of a configurable URL (../egressGuard.js, verbatim
    // from the canonical auth guard). redirect:'manual' + treating 3xx as
    // failure closes the redirect-to-internal bypass: a tip webhook has no
    // legitimate reason to redirect.
    await assertSafeEgressUrl(webhook_url);
    const res = await fetch(webhook_url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    if (res.status >= 300 && res.status < 400) {
      return { success: false, sink_ref: null, error: `Webhook redirected (HTTP ${res.status}) — redirects are refused (egress guard)` };
    }

    if (!res.ok) {
      return { success: false, sink_ref: null, error: `Webhook HTTP ${res.status}` };
    }

    const urlHash = crypto.createHash('sha256').update(webhook_url).digest('hex').slice(0, 12);
    const sinkRef = `webhook:${urlHash}#${tip.tip_seq}`;
    return { success: true, sink_ref: sinkRef, error: null };
  } catch (err) {
    return { success: false, sink_ref: null, error: err.message };
  }
}

function verify(sinkRef) {
  return sinkRef && sinkRef.startsWith('webhook:');
}

export { publish, verify };
export const type = 'webhook';
