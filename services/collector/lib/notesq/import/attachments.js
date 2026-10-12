'use strict';

/**
 * Attachment markdown for imported notes. A server-side port of the pure
 * helpers in src/components/notesq/lib/attachments.js (the NotesQ editor), so
 * an imported attachment looks exactly like one the editor would have written:
 * `![name](/api/orgs/<org>/files/<id>)` for images, `[name (size)](url)` for
 * everything else. Keep the two in step.
 */

const NAMESPACE = 'notesq';
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // mirrors the auth route cap

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif']);
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  pdf: 'application/pdf', txt: 'text/plain', svg: 'image/svg+xml', mp3: 'audio/mpeg', mp4: 'video/mp4',
};
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'application/pdf': 'pdf', 'text/plain': 'txt' };

const extOf = (name) => { const m = /\.([A-Za-z0-9]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
const mimeFromName = (name) => MIME_BY_EXT[extOf(name)] || 'application/octet-stream';
const extFromMime = (mime) => EXT_BY_MIME[String(mime || '').split(';')[0].trim().toLowerCase()] || 'bin';

function classifyFile({ name, type } = {}) {
  const mime = String(type || '').split(';')[0].trim().toLowerCase();
  if (mime && mime !== 'application/octet-stream') return IMAGE_MIMES.has(mime) ? 'image' : 'file';
  return IMAGE_EXTS.has(extOf(name)) ? 'image' : 'file';
}

function formatBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b < 0) return '0 B';
  if (b < 1024) return `${Math.round(b)} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const s = v >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1);
  return `${s} ${units[i]}`;
}

const attachmentUrl = (orgId, fileId) => `/api/orgs/${encodeURIComponent(orgId)}/files/${encodeURIComponent(fileId)}`;
const label = (s) => String(s || 'file').replace(/[[\]\\]/g, '_').replace(/[\r\n]+/g, ' ').trim() || 'file';

function buildAttachmentMarkdown({ name, size, type, url }) {
  const l = label(name);
  if (classifyFile({ name, type }) === 'image') return `![${l}](${url})`;
  return `[${l} (${formatBytes(size)})](${url})`;
}

module.exports = { NAMESPACE, MAX_ATTACHMENT_BYTES, classifyFile, formatBytes, attachmentUrl, buildAttachmentMarkdown, mimeFromName, extFromMime };
