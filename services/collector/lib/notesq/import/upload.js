'use strict';

/**
 * Attachment uploader: the auth service's internal service-key upload route
 * (POST /api/internal/files/upload), same caller shape as lib/imageStore.js.
 * The Idempotency-Key is sha256(orgId:contentSha), so a re-import never
 * duplicates a blob. Throws on any non-2xx (the caller records the failure).
 */

const crypto = require('node:crypto');
const { NAMESPACE } = require('./attachments.js');

function createAttachmentUploader({ fetchImpl, authUrl, serviceKey } = {}) {
  const f = fetchImpl || fetch;
  return async function uploadAttachment({ orgId, userId, sha, name, mime, bytes }) {
    const url = String(authUrl || process.env.AUTH_SERVICE_URL || 'http://auth:3101').replace(/\/$/, '');
    const key = serviceKey !== undefined ? serviceKey : (process.env.INTERNAL_SERVICE_KEY || '');
    if (!key) throw new Error('attachment upload unavailable (service key not configured)');
    if (!userId) throw new Error('attachment upload needs a user');
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime || 'application/octet-stream' }), name);
    form.append('org_id', orgId);
    form.append('created_by', String(userId));
    form.append('namespace', NAMESPACE);
    form.append('source_plugin', 'notesq');
    form.append('filename', name);
    const res = await f(`${url}/api/internal/files/upload`, {
      method: 'POST',
      headers: {
        'x-service-key': key,
        'idempotency-key': crypto.createHash('sha256').update(`${orgId}:${sha}`).digest('hex'),
      },
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    let json = null;
    try { json = await res.json(); } catch { /* handled below */ }
    if (res.status < 200 || res.status >= 300 || !json || !json.id) {
      throw new Error(`attachment upload failed (${res.status}${json && json.error ? ' ' + json.error : ''})`);
    }
    return json;
  };
}

module.exports = { createAttachmentUploader };
