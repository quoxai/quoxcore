/**
 * Generic Inbound Webhook Handler
 *
 * Receives webhooks from arbitrary external sources with configurable
 * payload mapping. Each webhook endpoint has a stored config that defines:
 *  - HMAC-SHA256 secret for signature validation
 *  - Dot-path payload mapping (e.g., "message.body" → text field)
 *  - Default org and agent routing
 *
 * Endpoint: POST /webhook/inbound/:endpointId
 *
 * Payload mapping extracts fields from any JSON structure:
 *   { text: "data.message", user_id: "data.sender.id", user_name: "data.sender.name" }
 *
 * AEE audit envelopes logged for all inbound messages.
 */

const crypto = require('crypto');

const AUTH_BASE_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`;
const COLLECTOR_PORT = process.env.COLLECTOR_PORT || 9848;
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

// ============================================================================
// Endpoint Config — resolved from auth service, cached with TTL
// ============================================================================

const _configCache = {};
const _configCacheTime = {};
const CONFIG_CACHE_TTL = 30_000;

/**
 * Fetch webhook endpoint config from auth service.
 * Cached for 30s per endpointId.
 * Returns:
 *   { id, name, secret, payload_mapping, default_org_id, default_agent, enabled, response_template }
 */
async function getEndpointConfig(endpointId) {
  const now = Date.now();
  if (_configCache[endpointId] && (now - _configCacheTime[endpointId]) < CONFIG_CACHE_TTL) {
    return _configCache[endpointId];
  }

  try {
    const resp = await fetch(
      `${AUTH_BASE_URL}/api/internal/webhook-endpoint-config?endpoint_id=${encodeURIComponent(endpointId)}`,
      {
        headers: INTERNAL_SERVICE_KEY ? { 'X-Service-Key': INTERNAL_SERVICE_KEY } : {},
        signal: AbortSignal.timeout(5000)
      }
    );
    if (resp.ok) {
      _configCache[endpointId] = await resp.json();
      _configCacheTime[endpointId] = now;
      return _configCache[endpointId];
    }
  } catch (err) {
    console.warn('[GenericWebhook] Config fetch failed:', err.message);
  }

  if (_configCache[endpointId]) return _configCache[endpointId];
  return null;
}

function clearEndpointConfigCache(endpointId) {
  if (endpointId) {
    delete _configCache[endpointId];
    delete _configCacheTime[endpointId];
  } else {
    Object.keys(_configCache).forEach(k => {
      delete _configCache[k];
      delete _configCacheTime[k];
    });
  }
}

// ============================================================================
// Payload Extraction — dot-path field mapping
// ============================================================================

/**
 * Resolve a dot-path on an object. E.g., "data.message.text" → obj.data.message.text
 * @param {object} obj - source object
 * @param {string} path - dot-separated path
 * @returns {*} resolved value or undefined
 */
function resolvePath(obj, path) {
  if (!path || !obj) return undefined;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Extract fields from payload using a mapping config.
 * @param {object} payload - raw webhook body
 * @param {object} mapping - { text: "path.to.text", user_id: "path.to.user", user_name: "path.to.name", channel: "path.to.channel" }
 * @returns {object} { text, userId, userName, channel, raw }
 */
function extractPayload(payload, mapping) {
  if (!payload) {
    return { text: '', userId: null, userName: null, channel: null, raw: payload };
  }
  if (!mapping) {
    return { text: JSON.stringify(payload).substring(0, 1000), userId: null, userName: null, channel: null, raw: payload };
  }

  return {
    text: mapping.text ? String(resolvePath(payload, mapping.text) || '') : '',
    userId: mapping.user_id ? String(resolvePath(payload, mapping.user_id) || '') : null,
    userName: mapping.user_name ? String(resolvePath(payload, mapping.user_name) || '') : null,
    channel: mapping.channel ? String(resolvePath(payload, mapping.channel) || '') : null,
    raw: payload
  };
}

// ============================================================================
// Signature Validation
// ============================================================================

/**
 * Validate HMAC-SHA256 signature.
 * Checks X-Signature-256 header format: sha256=<hex>
 * @param {string} secret
 * @param {string} rawBody
 * @param {string} signature - "sha256=<hex>" format
 * @returns {boolean}
 */
function validateWebhookSignature(secret, rawBody, signature) {
  if (!secret || !rawBody || !signature) return false;

  const prefix = 'sha256=';
  if (!signature.startsWith(prefix)) return false;

  const expected = prefix + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ============================================================================
// User Resolution & Routing
// ============================================================================

/**
 * Resolve a generic external user ID to Quox user.
 * Looks up notification_channels where channel_type='webhook' and config contains the user ID.
 */
async function resolveGenericUser(externalUserId, endpointId) {
  if (!externalUserId) return null;

  try {
    const resp = await fetch(
      `${AUTH_BASE_URL}/api/internal/generic-user-lookup?user_id=${encodeURIComponent(externalUserId)}&endpoint_id=${encodeURIComponent(endpointId)}`,
      {
        headers: INTERNAL_SERVICE_KEY ? { 'X-Service-Key': INTERNAL_SERVICE_KEY } : {},
        signal: AbortSignal.timeout(5000)
      }
    );
    if (resp.ok) {
      const data = await resp.json();
      return data.user || null;
    }
  } catch (err) {
    console.error('[GenericWebhook] User lookup failed:', err.message);
  }
  return null;
}

/**
 * Route message through /chat/claude pipeline.
 */
async function routeToChatPipeline(orgId, userId, prompt, sessionKey, defaultAgent) {
  const body = {
    prompt,
    selected_agent: defaultAgent || 'quox',
    session_id: `webhook_${sessionKey}`,
    conversation_history: [],
    org_id: orgId,
    user_id: userId
  };

  const headers = { 'Content-Type': 'application/json' };
  if (INTERNAL_SERVICE_KEY) {
    headers['X-Service-Key'] = INTERNAL_SERVICE_KEY;
  }

  const resp = await fetch(`http://127.0.0.1:${COLLECTOR_PORT}/chat/claude`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Chat pipeline returned ${resp.status}: ${errText.substring(0, 200)}`);
  }

  return resp.json();
}

/**
 * Create inbox item for inbound webhook message.
 */
async function createInboxItem(endpointName, userId, userName, text, orgId, endpointId) {
  if (!orgId) return;

  try {
    await fetch(`${AUTH_BASE_URL}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_SERVICE_KEY ? { 'X-Service-Key': INTERNAL_SERVICE_KEY } : {})
      },
      body: JSON.stringify({
        kind: 'info',
        priority: 'normal',
        title: `Webhook message from ${endpointName || endpointId}`,
        body_md: `**Source:** ${endpointName || endpointId}\n**From:** ${userName || userId || 'unknown'}\n\n${text.substring(0, 1000)}`,
        payload: { source: 'webhook', endpoint_id: endpointId, external_user_id: userId }
      }),
      signal: AbortSignal.timeout(5000)
    });
  } catch (err) {
    console.error('[GenericWebhook] Failed to create inbox item:', err.message);
  }
}

// ============================================================================
// Main Webhook Handler
// ============================================================================

/**
 * Main generic webhook handler.
 *
 * @param {object} req - Express request (must have rawBody attached, params.endpointId set)
 * @param {object} res - Express response
 * @param {object} [deps] - Injectable dependencies for testing
 */
async function handleGenericWebhook(req, res, deps = {}) {
  const _storeAuditEnvelope = deps.storeAuditEnvelope || (() => {});
  const _resolveUser = deps.resolveGenericUser || resolveGenericUser;
  const _routeToChatPipeline = deps.routeToChatPipeline || routeToChatPipeline;
  const _createInboxItem = deps.createInboxItem || createInboxItem;
  const _getConfig = deps.getEndpointConfig || getEndpointConfig;

  const endpointId = req.params.endpointId;
  if (!endpointId) {
    return res.status(400).json({ error: 'Missing endpoint ID' });
  }

  // 1. Resolve endpoint config
  const config = await _getConfig(endpointId);
  if (!config) {
    return res.status(404).json({ error: 'Unknown webhook endpoint' });
  }

  if (!config.enabled) {
    return res.status(403).json({ error: 'Webhook endpoint disabled' });
  }

  // 2. Validate signature if secret is configured
  if (config.secret && req.rawBody) {
    const signature = req.headers['x-signature-256'] || req.headers['x-hub-signature-256'];
    if (!signature || !validateWebhookSignature(config.secret, req.rawBody, signature)) {
      return res.status(403).json({ error: 'Invalid signature' });
    }
  }

  // 3. Extract payload using mapping
  const mapping = config.payload_mapping || {};
  const extracted = extractPayload(req.body, mapping);

  // 4. Send response based on template or default 200
  if (config.response_template) {
    res.json(config.response_template);
  } else {
    res.json({ ok: true, received: true });
  }

  // 5. Process async
  try {
    _storeAuditEnvelope({
      type: 'event',
      from: `webhook.${endpointId}`,
      to: 'agent.quox',
      intent: 'quox.channel.webhook.inbound',
      corr: `WH_${endpointId}_${Date.now()}`,
      payload: {
        endpoint_id: endpointId,
        endpoint_name: config.name,
        text: (extracted.text || '').substring(0, 200),
        user_id: extracted.userId
      }
    });

    const defaultOrgId = config.default_org_id;

    if (!extracted.text) {
      // No text extracted — still create inbox item with raw payload summary
      await _createInboxItem(config.name, null, null, JSON.stringify(extracted.raw).substring(0, 500), defaultOrgId, endpointId);
      return;
    }

    // Try to resolve user if userId was extracted
    const user = extracted.userId ? await _resolveUser(extracted.userId, endpointId) : null;

    if (user) {
      try {
        await _routeToChatPipeline(user.org_id, user.user_id, extracted.text, `${endpointId}_${extracted.userId}`, config.default_agent);

        _storeAuditEnvelope({
          type: 'result',
          from: 'agent.quox',
          to: `webhook.${endpointId}`,
          intent: 'quox.channel.webhook.outbound',
          corr: `WH_${endpointId}_${Date.now()}`,
          payload: { endpoint_id: endpointId, user_id: user.user_id, success: true }
        });
      } catch (err) {
        console.error('[GenericWebhook] Chat pipeline error:', err.message);
      }
    } else {
      // Unknown user or no user mapping — create inbox item
      await _createInboxItem(config.name, extracted.userId, extracted.userName, extracted.text, defaultOrgId, endpointId);

      _storeAuditEnvelope({
        type: 'event',
        from: 'agent.quox',
        to: `webhook.${endpointId}`,
        intent: 'quox.channel.webhook.inbound.inbox_created',
        corr: `WH_${endpointId}_${Date.now()}`,
        payload: { endpoint_id: endpointId, action: 'inbox_created' }
      });
    }
  } catch (err) {
    console.error('[GenericWebhook] Processing error:', err);
  }
}

module.exports = {
  handleGenericWebhook,
  extractPayload,
  resolvePath,
  validateWebhookSignature,
  getEndpointConfig,
  clearEndpointConfigCache,
  _internals: {
    resolveGenericUser,
    routeToChatPipeline,
    createInboxItem
  }
};
