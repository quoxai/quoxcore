/** The org as the status line shows it: its name, or a short "org …H398" until the name arrives. Never a raw ULID. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
export const isOrgId = (s) => ULID.test(String(s || '').trim());
export function orgLabel(name, id = null) {
  const n = name == null ? '' : String(name).trim();
  if (n && !isOrgId(n)) return n;
  const raw = isOrgId(n) ? n : (id ? String(id).trim() : '');
  if (!raw) return null;
  return isOrgId(raw) ? `org …${raw.slice(-4)}` : raw; // only a real ULID is masked
}
