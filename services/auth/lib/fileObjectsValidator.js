/**
 * file_objects validators — FU-1
 *
 * Pure functions. No DB access, no async. Reused by both the HTTP route
 * handlers and any internal code that needs to normalise a namespace or
 * compute a blob path.
 */

// Namespace:
//   - first segment must start with a lowercase letter (identifies the plugin)
//   - later segments can start with a digit (e.g. a year, a widget_id)
//   - each segment: 1-40 chars of [a-z0-9_-]
//   - 1-4 total segments; ≤120 chars; no path traversal
const NS_FIRST_SEGMENT = /^[a-z][a-z0-9_-]{0,39}$/;
const NS_LATER_SEGMENT = /^[a-z0-9_-]{1,40}$/;

export function validateNamespace(ns) {
  if (!ns || typeof ns !== 'string') return 'namespace required';
  if (ns.length > 120) return 'namespace too long';
  if (ns.includes('..')) return 'namespace must not contain ..';
  const parts = ns.split('/');
  if (parts.length < 1 || parts.length > 4) return 'namespace must have 1-4 segments';
  if (!NS_FIRST_SEGMENT.test(parts[0])) {
    return `namespace first segment "${parts[0]}" invalid (must start with lowercase letter, 1-40 chars of [a-z0-9_-])`;
  }
  for (let i = 1; i < parts.length; i++) {
    if (!NS_LATER_SEGMENT.test(parts[i])) return `namespace segment "${parts[i]}" invalid (1-40 chars of [a-z0-9_-])`;
  }
  return null;
}

export function validateVirtualPath(vp) {
  if (!vp || typeof vp !== 'string') return 'virtual_path required';
  if (!vp.startsWith('/')) return 'virtual_path must start with /';
  if (vp.length > 500) return 'virtual_path too long';
  if (vp.includes('\u0000')) return 'virtual_path must not contain null byte';
  const parts = vp.split('/');
  for (const p of parts) {
    if (p === '..') return 'virtual_path must not contain ..';
  }
  return null;
}

/**
 * Compute the on-disk path for a blob, content-addressed under the org.
 * Format: {org_id}/{sha256[:2]}/{sha256}
 */
export function contentAddressedPath(orgId, sha256) {
  if (!orgId || typeof orgId !== 'string') throw new Error('orgId required');
  if (!sha256 || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new Error('sha256 must be 64 lowercase hex chars');
  }
  const lower = sha256.toLowerCase();
  return `${orgId}/${lower.slice(0, 2)}/${lower}`;
}

export default { validateNamespace, validateVirtualPath, contentAddressedPath };
