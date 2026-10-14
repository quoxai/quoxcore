/**
 * QC-BRUTALOOP-W12: build a minimal embed_config patch.
 *
 * The PATCH endpoint deep-merges embed_config over the stored copy (see
 * mergeEmbedConfig in services/auth/routes/widgets.js), so a tab holding a
 * stale widget prop must send ONLY the keys it changed, otherwise saving one
 * tab reverts another tab's edits. Keys removed from `next` become explicit
 * nulls (the server deletes on null).
 */
export function diffEmbedConfig(base, next) {
  const b = base && typeof base === 'object' ? base : {}
  const n = next && typeof next === 'object' ? next : {}
  const patch = {}
  for (const k of Object.keys(n)) {
    if (n[k] === undefined) continue
    if (JSON.stringify(n[k]) !== JSON.stringify(b[k])) patch[k] = n[k]
  }
  for (const k of Object.keys(b)) {
    if (!(k in n) || n[k] === undefined) patch[k] = null
  }
  return patch
}
