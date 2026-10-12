// BRAIN2-W5 128: scope the Cortex chat's browser storage (conversation, session
// and correlation id live in localStorage under the ChatEngine sessionPrefix)
// by org AND user, so switching org or account never restores another
// tenant's conversation. Short non-reversible hash keeps the prefix (which also
// prefixes correlation ids, capped at 64 chars server-side) compact.
export function cortexSessionPrefix(orgId, userId) {
  const s = `${orgId || 'noorg'}:${userId || 'nouser'}`
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return `CORTEX-${n.toString(36)}`
}
