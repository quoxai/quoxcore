/**
 * feedAutoMemorySource.js — The Feed's recurring trigger for the
 * ONE-BRAIN A3 fix (QuoxPlan #493): the orchestrator's own curated
 * cross-session memory corpus (MEMORY.md + topic files, `*.md` directly
 * under the auto-memory directory) was only ever pushed into Qortex's
 * "Agent Memory" vault by a HAND-RUN CLI script
 * (services/quoxbrain/readers/autoMemoryReader.mjs + readers/run.mjs) —
 * never wired to any cron/systemd timer or to this collector-side
 * scheduler. It was run once (2026-07-18) and never again, so the vault
 * silently froze at that day's content while MEMORY.md kept changing on
 * disk — a correctness bug (stale content served as current), NOT an
 * idempotency bug: services/quoxbrain/lib/ingest.js's content-hash skip
 * (ingestDocuments) already re-ingests a changed relPath correctly; there
 * was simply nothing left to call it periodically.
 *
 * This is a CJS PORT of autoMemoryReader.mjs's collectDocuments(), same
 * shape as brainFeedClient.js is a port of readers/lib/brainClient.mjs —
 * deliberately NOT a cross-service dynamic import() of the .mjs file: the
 * collector's Docker image never COPYs services/quoxbrain (see
 * services/collector/Dockerfile), so that file does not exist inside the
 * running container regardless of what's on the host filesystem. Keeping
 * the doc shape (relPath `memory/<name>`, kind 'note', sourceType
 * 'automemory', originStore 'files', originId relPath — ONE-BRAIN A1
 * provenance) byte-for-byte identical to autoMemoryReader.mjs means both
 * the host-run CLI and this scheduled ingester converge on the exact same
 * notes (same vault name "Agent Memory", same relPath keys) rather than
 * forking into two parallel copies.
 *
 * No watermark: unlike feedFolderSource.js (arbitrary, potentially large
 * connected folders), the auto-memory directory is a small, host-global,
 * always-relevant corpus — every tick simply re-collects every top-level
 * *.md file and re-pushes it. ingestDocuments()'s own content-hash skip
 * (server-side, per document) is what keeps a re-push of unchanged files
 * cheap and a no-op; that's the SAME mechanism the manual CLI reader
 * already relied on for its own idempotency, so this only fixes the
 * missing trigger, not the (already-correct) skip logic.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const brainFeedClient = require('./brainFeedClient.js');
const feedWatermark = require('./feedWatermark.js');
const { resolveSafeFolderPath } = require('./feedFolderSource.js');
const { probeDir } = require('./feedDirProbe');
const { redactSecrets } = require('./feedAiHistorySource.js');

const SOURCE_TYPE = 'automemory';
const VAULT_NAME = 'Agent Memory';
const MANIFEST_KEY = 'automemory:manifest';
// Same default + same directory autoMemoryReader.mjs uses — the collector
// container bind-mounts the host home directory read-only at the identical
// path (`/opt/quoxcore:/opt/quoxcore:ro` in docker-compose.yml), so this
// path resolves inside the container exactly as it does on the host.
const DEFAULT_MEMORY_DIR = '/opt/quoxcore/.claude/projects/-opt-quoxcore/memory';

/**
 * Lists top-level `*.md` files directly under `dir` (no recursion — mirrors
 * autoMemoryReader.mjs's listMarkdownFiles, which deliberately does not
 * walk subdirectories).
 */
function listMarkdownFiles(dir, fsImpl) {
  const probe = probeDir(dir, fsImpl);
  if (probe.state === 'denied' || probe.state === 'error') throw new Error(probe.error);
  if (probe.state === 'missing') return [];
  return fsImpl.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => path.join(dir, entry.name));
}

/**
 * Collects the auto-memory corpus as push-ingest document payloads — same
 * shape as autoMemoryReader.mjs's collectDocuments() (pure, no network).
 *
 * @param {{memoryDir?: string}} [opts]
 * @param {{fs?: object}} [deps] - injectable fs-shaped module (tests)
 * @returns {Array<object>}
 */
function collectDocuments({ memoryDir = DEFAULT_MEMORY_DIR } = {}, { fs: fsImpl = fs } = {}) {
  return listMarkdownFiles(memoryDir, fsImpl).map((absPath) => {
    // BRAIN2-W7 A 048: same secret redaction as the AI-history path.
    const content = redactSecrets(fsImpl.readFileSync(absPath, 'utf8'));
    const stat = fsImpl.statSync(absPath);
    const name = absPath.slice(memoryDir.length + 1);
    const relPath = `memory/${name}`;
    return {
      relPath,
      content,
      kind: 'note',
      sourceType: SOURCE_TYPE,
      occurredAt: stat.mtime.toISOString(),
      // ONE-BRAIN A1 provenance — matches autoMemoryReader.mjs exactly.
      originStore: 'files',
      originId: relPath,
    };
  });
}

/**
 * The Feed ingester entry point — same `ingester(orgId, opts, deps)` shape
 * every other SOURCE_INGESTERS entry uses (see feedFolderSource.js).
 *
 * @param {string} orgId
 * @param {{config?: {memoryDir?: string}, dryRun?: boolean, scope?: string, signal?: AbortSignal}} [opts]
 * @param {{
 *   fs?: object,
 *   collectDocumentsFn?: Function,
 *   ensurePushVaultFn?: Function,
 *   pushDocumentsFn?: Function,
 *   fetchImpl?: Function,
 *   userId?: string,
 * }} [deps]
 * @returns {Promise<{filesRead:number, docsPushed:number, skipped:string|null, error:string|null}>}
 */
async function ingestAutoMemory(orgId, opts = {}, deps = {}) {
  const result = { filesRead: 0, docsPushed: 0, skipped: null, error: null };

  const {
    fs: fsImpl = fs,
    collectDocumentsFn,
    ensurePushVaultFn = brainFeedClient.ensurePushVault,
    pushDocumentsFn = brainFeedClient.pushDocuments,
    pushDeletionsFn = brainFeedClient.pushDeletions,
    getManifestFn = (org) => feedWatermark.getWatermark(org, MANIFEST_KEY),
    setManifestFn = (org, v) => feedWatermark.setWatermark(org, MANIFEST_KEY, v),
    fetchImpl,
    userId,
  } = deps;
  const signal = opts.signal;

  // BRAIN2-W5 016: honour the stored scope. A user-scoped vault needs an
  // owner; a scheduled tick has none, so fail closed rather than widen to org.
  const vaultScope = opts.scope === 'user' ? 'user' : 'org';
  if (vaultScope === 'user' && !userId) {
    result.skipped = 'user scope requires a user';
    return result;
  }

  // BRAIN2-W3 B (008): the built-in default dir is machine-global host data.
  // It applies ONLY to the designated QUOXFEED_HOST_ORG; every other org
  // needs its own explicit (guarded) config.memoryDir or gets nothing.
  let memoryDir = DEFAULT_MEMORY_DIR;
  if (!opts.config?.memoryDir) {
    const hostOrg = process.env.QUOXFEED_HOST_ORG;
    if (!hostOrg || orgId !== hostOrg) {
      result.skipped = hostOrg ? 'not host org' : 'host org not designated';
      return result;
    }
  }
  if (opts.config?.memoryDir) {
    // Per-org override: same safety floor as folder sources (absolute, no
    // traversal, optional FEED_FOLDER_ALLOWED_ROOTS). The built-in default
    // is trusted and not run through the guard.
    const guard = resolveSafeFolderPath(opts.config.memoryDir, { orgId });
    if (!guard.ok) {
      result.skipped = `unsafe memoryDir, ${guard.error}`;
      console.error(`[FeedAutoMemorySource] org=${orgId}: ${result.skipped}`);
      return result;
    }
    memoryDir = guard.path;
  }
  const dryRun = !!opts.dryRun;

  if (!collectDocumentsFn) {
    const probe = probeDir(memoryDir, fsImpl);
    if (probe.state === 'missing') {
      result.skipped = `memoryDir missing, ${memoryDir}`;
      return result;
    }
    if (probe.state === 'denied' || probe.state === 'error') {
      result.error = probe.error;
      console.error(`[FeedAutoMemorySource] org=${orgId}: ${result.error}`);
      return result;
    }
  }

  let docs;
  try {
    docs = collectDocumentsFn
      ? collectDocumentsFn({ memoryDir })
      : collectDocuments({ memoryDir }, { fs: fsImpl });
  } catch (err) {
    result.error = `collect failed — ${err.message}`;
    console.error(`[FeedAutoMemorySource] org=${orgId}: ${result.error}`);
    return result;
  }

  result.filesRead = docs.length;
  if (dryRun) return result;

  // BRAIN2-W5 025: deletion reconciliation. The server's deleteAbsent only
  // works when the whole snapshot is ONE call, and an empty snapshot cannot be
  // pushed at all. So keep a manifest of the rel_paths of the last complete
  // snapshot and tombstone whatever disappeared (also covers split batches).
  let prevManifest = null;
  try {
    const raw = await getManifestFn(orgId);
    const parsed = raw ? JSON.parse(raw) : null;
    prevManifest = Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.error(`[FeedAutoMemorySource] org=${orgId}: manifest read failed, no deletions this tick — ${err.message}`);
  }
  const currentPaths = docs.map((d) => d.relPath);
  const removed = prevManifest ? prevManifest.filter((p) => !currentPaths.includes(p)) : [];
  const saveManifest = async () => {
    try { await setManifestFn(orgId, JSON.stringify([...currentPaths].sort())); }
    catch (err) { console.error(`[FeedAutoMemorySource] org=${orgId}: manifest write failed — ${err.message}`); }
  };

  if (docs.length === 0 && removed.length === 0) {
    await saveManifest(); // seed/refresh the (empty) manifest; nothing to push or delete
    return result;
  }

  try {
    const vaultId = await ensurePushVaultFn(orgId, VAULT_NAME, { scope: vaultScope, userId, fetchImpl, signal });
    if (!vaultId) {
      result.error = 'ensurePushVault returned no vaultId';
      console.error(`[FeedAutoMemorySource] org=${orgId}: ${result.error}`);
      return result;
    }

    // Full-snapshot source (every top-level *.md, all-or-nothing collect):
    // files removed from the dir must leave the brain too (BRAIN2-V3 A4).
    let pushResult = { added: 0, updated: 0 };
    if (docs.length > 0) {
      pushResult = await pushDocumentsFn(orgId, vaultId, docs, { userId, fetchImpl, deleteAbsent: true, signal });
      if (pushResult?.error) {
        result.error = pushResult.error;
        console.error(`[FeedAutoMemorySource] org=${orgId}: push failed — ${pushResult.error}`);
        return result;
      }
    }
    if (removed.length > 0) {
      const delResult = await pushDeletionsFn(orgId, vaultId, removed, { userId, fetchImpl, signal });
      if (delResult?.error) {
        // Keep the old manifest so the tombstones are retried next tick.
        result.error = `deletions failed — ${delResult.error}`;
        console.error(`[FeedAutoMemorySource] org=${orgId}: ${result.error}`);
        return result;
      }
    }
    await saveManifest();

    // Real progress only — a re-push of byte-identical content (the common
    // case once caught up) reports 0 here even though filesRead is nonzero,
    // so The Feed's whole-tick zero-progress backoff still means something.
    result.docsPushed = (pushResult.added || 0) + (pushResult.updated || 0);
  } catch (err) {
    result.error = `push failed — ${err.message}`;
    console.error(`[FeedAutoMemorySource] org=${orgId}: ${result.error}`);
  }

  return result;
}

module.exports = {
  ingestAutoMemory,
  collectDocuments,
  SOURCE_TYPE,
  VAULT_NAME,
  DEFAULT_MEMORY_DIR,
};
