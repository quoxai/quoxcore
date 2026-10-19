'use strict';
// #970: `quox tool exec --select/--summary/--limit` shapes a large result client-side and
// sends the shape here so the tool receipt records which view of the result the caller
// (usually the model on the CLI-tools path) was shown. Content-free and bounded: the path
// text (max 300 chars), the summary flag and the limit. Anything else is dropped.

function sanitizeOutputShape(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  if (typeof raw.select === 'string' && raw.select.trim()) out.select = raw.select.trim().slice(0, 300);
  if (raw.summary === true) out.summary = true;
  if (Number.isInteger(raw.limit) && raw.limit >= 1 && raw.limit <= 10000) out.limit = raw.limit;
  return Object.keys(out).length ? out : null;
}

module.exports = { sanitizeOutputShape };
