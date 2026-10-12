// vaultRoot.js — vault-path security allowlist (P0.3 → R2, roadmap QUOXBRAIN #163)
//
// A vault's source_path is caller-supplied (org admins register their own
// vault). Without an allowlist, a registered vault could read arbitrary
// filesystem paths (`../../etc/passwd`) or escape via a symlink. This module
// is the single choke point both the API (validating POST /vaults) and the
// ingest engine (resolving the real path before walking it) must call.
//
// R2 (docs/STREAM_QUOXBRAIN_P1_CONTRACT.md §5): validating only "under the
// global QUOXBRAIN_VAULT_ROOT" was NOT tenant-safe — any org could register
// `/vaults/obsidian/<another-orgs-subdir>` and read that org's files through
// its own org_id rows. Every allowlist check is now bound to org_id: an org's
// allowed roots are the union of (a) its own default subdir
// `<QUOXBRAIN_VAULT_ROOT>/<org_id>` and (b) any root explicitly granted to
// it via `org_vault_roots` (migrations/002-vault-roots.sql). Default-deny —
// an org with no grants can only ever register under its own subdir.

import { realpathSync } from 'fs'
import { resolve, sep } from 'path'
import { getDatabase } from './db.js'

function realpathOrNull(p) {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/**
 * Resolves `process.env.QUOXBRAIN_VAULT_ROOT`'s real path, throwing the same
 * config error resolveSafeVaultPath has always thrown when it's unset/missing.
 */
function resolveGlobalRoot() {
  const root = process.env.QUOXBRAIN_VAULT_ROOT
  if (!root) {
    throw new Error('QUOXBRAIN_VAULT_ROOT is not configured — vault registration is disabled until it is set')
  }
  try {
    return { root, realRoot: realpathSync(root) }
  } catch (err) {
    throw new Error(`QUOXBRAIN_VAULT_ROOT does not exist: ${root} (${err.message})`)
  }
}

/**
 * The set of real, absolute paths `orgId` is allowed to register vaults
 * under: its own default subdir (`<VAULT_ROOT>/<orgId>`, no grant required)
 * plus every root explicitly granted to it in `org_vault_roots`.
 *
 * The default subdir is only ever admitted if its realpath actually lands
 * inside the global root — this is what stops a crafted orgId containing
 * `../` from being used to smuggle an out-of-root path into the allowlist.
 *
 * @param {string} orgId
 * @returns {string[]} real absolute paths (deduped)
 */
export function orgAllowedRoots(orgId) {
  if (!orgId || typeof orgId !== 'string') {
    throw new Error('orgId is required to resolve allowed vault roots')
  }

  const { realRoot } = resolveGlobalRoot()
  const roots = new Set()

  // Default per-org convention — every org implicitly owns its own subdir,
  // with zero grants required. It may not exist yet (a fresh org that has
  // never registered anything); that's fine, it's simply not an allowed
  // root until something is created there.
  const defaultSubdir = realpathOrNull(resolve(realRoot, orgId))
  if (defaultSubdir && (defaultSubdir === realRoot || defaultSubdir.startsWith(realRoot + sep))) {
    roots.add(defaultSubdir)
  }

  // Explicit grants (admin-only POST /admin/vault-roots) — e.g. a shared
  // demo vault granted to a specific org going forward.
  const db = getDatabase()
  const grants = db.prepare('SELECT root_path FROM org_vault_roots WHERE org_id = ?').all(orgId)
  for (const grant of grants) {
    const realGrant = realpathOrNull(grant.root_path)
    if (realGrant) roots.add(realGrant)
  }

  return [...roots]
}

/**
 * Resolves `sourcePath` against `process.env.QUOXBRAIN_VAULT_ROOT`, rejecting
 * anything that escapes the root (`..` traversal, absolute paths outside the
 * root, or a symlink that resolves outside the root) — then further rejects
 * anything outside `orgId`'s allowed roots (its own subdir, or an explicit
 * grant). Default-deny: an org with no grants can only register under its
 * own `<VAULT_ROOT>/<orgId>` subdir, never a sibling org's subdir or a
 * shared path.
 *
 * @param {string} sourcePath - caller-supplied vault path (absolute or
 *   relative to VAULT_ROOT)
 * @param {string} orgId - the calling org (req.org_id — never client body)
 * @returns {string} the real, absolute, safe path
 * @throws {Error} if VAULT_ROOT is unset, orgId is missing, the path doesn't
 *   exist, the resolved real path is outside VAULT_ROOT entirely, or it is
 *   outside orgId's allowed roots
 */
export function resolveSafeVaultPath(sourcePath, orgId) {
  if (!sourcePath || typeof sourcePath !== 'string') {
    throw new Error('source_path is required')
  }
  if (!orgId || typeof orgId !== 'string') {
    throw new Error('orgId is required for vault path resolution')
  }

  const { root, realRoot } = resolveGlobalRoot()

  // Absolute source_path is used as-is; a relative one is resolved against
  // the root itself (so registering "NodeBrain" means <root>/NodeBrain).
  const candidate = resolve(root, sourcePath)

  let realCandidate
  try {
    realCandidate = realpathSync(candidate)
  } catch (err) {
    throw new Error(`source_path does not exist: ${sourcePath} (${err.message})`)
  }

  const withinGlobalRoot = realCandidate === realRoot || realCandidate.startsWith(realRoot + sep)
  if (!withinGlobalRoot) {
    throw new Error(`source_path escapes the configured vault root: ${sourcePath}`)
  }

  const allowedRoots = orgAllowedRoots(orgId)
  const withinOrgRoot = allowedRoots.some((r) => realCandidate === r || realCandidate.startsWith(r + sep))
  if (!withinOrgRoot) {
    throw new Error(`source_path is outside org ${orgId}'s allowed vault roots (register under the org's own subdir, or request a grant via /admin/vault-roots): ${sourcePath}`)
  }

  return realCandidate
}

export default { resolveSafeVaultPath, orgAllowedRoots }
