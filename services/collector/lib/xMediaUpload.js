/**
 * X media uploads: simple multipart for still images, chunked v1.1 for
 * GIF/video. Every request reuses the existing OAuth1 signer. Per its
 * documented RFC 5849 parameter-source rules, multipart and JSON bodies
 * are EXCLUDED from signing; URL query parameters are included automatically.
 * Org containment is the caller's responsibility and is checked again at
 * approval time. Failures never permit a text-only publish fallback.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildOAuth1Header } = require('./connectors/oauth1.js');
const UPLOAD_URL = 'https://upload.twitter.com/1.1/media/upload.json';
const METADATA_URL = 'https://upload.twitter.com/1.1/media/metadata/create.json';
const MB = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * MB;
const CHUNK_BYTES = 5 * MB;
const PROCESSING_TIMEOUT_MS = 120000;
const ALLOWED_IMAGE_MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4',
};

function mediaLimitBytes(mimeType) {
  const { CONFIG } = require('./xPostingStore');
  const cap = mimeType === 'video/mp4' ? CONFIG.maxVideoBytes : mimeType === 'image/gif' ? CONFIG.maxGifBytes : MAX_IMAGE_BYTES;
  const ceiling = mimeType === 'video/mp4' ? 512 * MB : mimeType === 'image/gif' ? 15 * MB : MAX_IMAGE_BYTES;
  // Invalid configuration fails closed instead of silently removing a cap.
  return Number.isSafeInteger(cap) && cap > 0 ? Math.min(cap, ceiling) : 0;
}

function validateImageForUpload(absolutePath) {
  const ext = path.extname(absolutePath).toLowerCase();
  const mimeType = ALLOWED_IMAGE_MIME_BY_EXT[ext];
  if (!mimeType) return { ok: false, error: `unsupported image type "${ext || '(none)'}" (allowed: png, jpg, jpeg, webp, gif, mp4)` };
  let stat;
  try { stat = fs.statSync(absolutePath); }
  catch (err) { return { ok: false, error: `could not read image file: ${err.message}` }; }
  if (!stat.isFile()) return { ok: false, error: 'image path is not a regular file' };
  if (stat.size === 0) return { ok: false, error: 'media file is empty' };
  const limit = mediaLimitBytes(mimeType);
  if (stat.size > limit) return { ok: false, error: `media exceeds the ${limit / MB}MB limit (${stat.size} bytes)` };
  const mediaCategory = mimeType === 'video/mp4' ? 'tweet_video' : mimeType === 'image/gif' ? 'tweet_gif' : 'tweet_image';
  return { ok: true, mimeType, size: stat.size, mediaCategory };
}

function validateAltText(altText, mimeType) {
  if (altText === undefined) return null;
  if (typeof altText !== 'string' || Array.from(altText).length > 1000) return 'alt_text must be a string of at most 1000 characters';
  if (mimeType === 'video/mp4') return 'alt_text is supported for images and GIFs, not video';
  return null;
}

/** Multipart string fields and an optional raw binary file. */
function buildMultipartBody({ fieldName, filename, mimeType, buffer, fields = {} }) {
  const boundary = `QuoxXMedia${crypto.randomBytes(16).toString('hex')}`;
  const parts = Object.entries(fields).map(([key, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  if (buffer) {
    const safeFilename = String(filename).replace(/["\r\n\\]/g, '_');
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${safeFilename}"\r\nContent-Type: ${mimeType}\r\n\r\n`), buffer, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function request(credentials, url, { method = 'POST', body, contentType, empty = false, timeoutMs = 30000 } = {}) {
  const resp = await fetch(url, {
    method,
    headers: { Authorization: buildOAuth1Header({ method, url }, credentials), ...(contentType ? { 'Content-Type': contentType } : {}) },
    ...(body !== undefined ? { body } : {}),
    signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
  });
  const label = url.startsWith(METADATA_URL) ? 'metadata' : 'upload';
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`X media ${label} API ${resp.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  if (empty) return {};
  try { return await resp.json(); }
  catch (err) { throw new Error(`X media ${label} API returned a non-JSON response: ${err.message}`); }
}

function multipartRequest(credentials, fields, options = {}) {
  return request(credentials, UPLOAD_URL, { ...buildMultipartBody({ fields }), ...options });
}

async function waitForProcessing(credentials, mediaId, info, { sleep, processingTimeoutMs }) {
  const start = Date.now();
  let waited = 0;
  const remaining = () => processingTimeoutMs - Math.max(Date.now() - start, waited);
  const timeout = () => new Error(`X media processing timed out for ${mediaId} (state=${info?.state || 'missing'})`);
  while (info) {
    if (info.state === 'succeeded') return;
    if (!['pending', 'in_progress'].includes(info.state)) {
      throw new Error(`X media ${mediaId} processing ${info.state || 'missing'}: ${info.error?.message || 'unexpected processing state'}`);
    }
    const seconds = info.check_after_secs === undefined ? 1 : info.check_after_secs;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) throw new Error(`X media ${mediaId} invalid check_after_secs (state=${info.state})`);
    // A zero hint still gets a small yield, preventing a tight unbounded loop.
    const delay = Math.max(100, seconds * 1000);
    if (remaining() <= delay) throw timeout();
    await sleep(delay);
    waited += delay;
    if (remaining() <= 0) throw timeout();
    let status;
    try {
      const url = `${UPLOAD_URL}?${new URLSearchParams({ command: 'STATUS', media_id: mediaId })}`;
      status = await request(credentials, url, { method: 'GET', timeoutMs: Math.min(30000, remaining()) });
    } catch (err) {
      if (remaining() <= 0 || err.name === 'TimeoutError') throw timeout();
      throw err;
    }
    if (remaining() <= 0) throw timeout();
    if (!status?.processing_info) throw new Error(`X media ${mediaId} STATUS missing processing_info (state=${info.state})`);
    info = status.processing_info;
  }
}

/** Kept as uploadImage for existing callers; now accepts GIF and MP4 too. */
async function uploadImage(credentials, { imagePath, alt_text, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), processingTimeoutMs = PROCESSING_TIMEOUT_MS } = {}) {
  if (!imagePath) return { ok: false, error: 'imagePath is required' };
  try {
    const validated = validateImageForUpload(imagePath);
    if (!validated.ok) return validated;
    const altError = validateAltText(alt_text, validated.mimeType);
    if (altError) return { ok: false, error: altError };
    let mediaId;
    if (validated.mediaCategory === 'tweet_image') {
      const data = await request(credentials, UPLOAD_URL, buildMultipartBody({
        fieldName: 'media', filename: path.basename(imagePath), mimeType: validated.mimeType,
        buffer: fs.readFileSync(imagePath), fields: { media_category: 'tweet_image' },
      }));
      mediaId = data?.media_id_string;
    } else {
      const data = await multipartRequest(credentials, { command: 'INIT', total_bytes: validated.size, media_type: validated.mimeType, media_category: validated.mediaCategory });
      mediaId = data?.media_id_string;
      if (!mediaId) throw new Error('X media upload API response did not include media_id_string');
      const fd = fs.openSync(imagePath, 'r');
      try {
        for (let offset = 0, segment = 0; offset < validated.size; segment++) {
          const length = Math.min(CHUNK_BYTES, validated.size - offset);
          const chunk = Buffer.alloc(length);
          const read = fs.readSync(fd, chunk, 0, length, offset);
          if (read !== length) throw new Error(`X media ${mediaId} file changed during upload`);
          await multipartRequest(credentials, { command: 'APPEND', media_id: mediaId, segment_index: segment, media_data: chunk.toString('base64') }, { empty: true });
          offset += read;
        }
      } finally { fs.closeSync(fd); }
      const final = await multipartRequest(credentials, { command: 'FINALIZE', media_id: mediaId });
      if (final?.processing_info) await waitForProcessing(credentials, mediaId, final.processing_info, { sleep, processingTimeoutMs });
    }
    if (!mediaId) throw new Error('X media upload API response did not include media_id_string');
    if (alt_text !== undefined && alt_text !== '') {
      await request(credentials, METADATA_URL, { body: JSON.stringify({ media_id: mediaId, alt_text: { text: alt_text } }), contentType: 'application/json', empty: true });
    }
    return { ok: true, mediaId };
  } catch (err) { return { ok: false, error: err.message }; }
}
module.exports = { UPLOAD_URL, METADATA_URL, MAX_IMAGE_BYTES, CHUNK_BYTES, ALLOWED_IMAGE_MIME_BY_EXT, mediaLimitBytes, validateAltText, validateImageForUpload, buildMultipartBody, uploadImage };
