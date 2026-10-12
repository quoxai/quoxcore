/**
 * Internal URL scheme guard shared by Glass chat components.
 * Matches the allow-list used by the widget markdown renderer.
 */
export function isSafeUrl(url) {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  if (u.startsWith('//')) return true;
  if (/^https?:\/\//i.test(u)) return true;
  if (/^mailto:/i.test(u)) return true;
  return false;
}
