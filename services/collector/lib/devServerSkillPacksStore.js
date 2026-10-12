/**
 * devServerSkillPacksStore.js — durable persistence for which Dev Skills
 * Pack is installed on which host, and whether it's still current.
 *
 * DEVSUITE-SKILLS Phase 3 ("sync/update channel + drift surfacing").
 * skillPackInstaller.js already installs CORE_DEV_PACK on a host's first
 * dev_capabilities registration (see devServerSkillPackTrigger.js), and can
 * check a host's live status via checkPackStatus() — but that check is a
 * LIVE Bastion SSH round-trip every single time, and nothing durable
 * records the outcome. This module adds a `dev_server_skill_packs` table
 * (schema owned by migrations/aee/008-dev-server-skill-packs-table.sql,
 * applied to the existing aeeDb via runMigrations()) so the common case
 * (dashboard asks "is this host's pack current?") is a local read, not a
 * remote exec.
 *
 * Mirrors devServersStore.js's shape exactly: self-contained + dependency-
 * injected (no server.js import) so it unit-tests directly against a
 * better-sqlite3 db. UPSERT keyed by (host_id, pack_id), same discipline as
 * devServersStore.js / gpuNodesStore.js.
 *
 * Drift is always computed against a FRESH recompute of the pack's content
 * hash (skillPackInstaller.js's loadPackFileContents + computePackContentHash,
 * reading the actual skill files off disk right now) — never a cached
 * "current version" value, so an edit to a skill file is caught even
 * without a version bump.
 *
 * A periodic auto-sync-on-drift scheduler is explicitly OUT of scope for
 * this pass — sync is on-demand only (POST .../skill-pack-sync). A future
 * pass could add a cron-style sweep that calls the same sync path for every
 * 'drifted' host; that scheduler does not exist today.
 */

'use strict';

const {
  CORE_DEV_PACK,
  loadPackFileContents,
  computePackContentHash,
  checkPackStatus,
  summarizePackRights,
} = require('./skillPackInstaller.js');

const {
  hasCurrentAcceptance,
  computeRightsSha256,
  ACCEPTANCE_OFFER_ENDPOINT,
} = require('./skillPackAcceptance.js');

const {
  ensureApprovedInstallCallBastion: defaultEnsureApprovedInstallCallBastion,
} = require('./packInstallApproval.js');

// Reasons installSkillPack() returns that mean "the host's pack is
// confirmed installed at the pack's current content", whether or not this
// particular call actually wrote new files (up_to_date means the no-op
// check inside installSkillPack already found it current).
const SYNC_SUCCESS_REASONS = new Set(['first_install', 'updated', 'up_to_date']);

function rowToRecord(row) {
  if (!row) return null;
  return {
    host_id: row.host_id,
    pack_id: row.pack_id,
    org_id: row.org_id,
    installed_version: row.installed_version || null,
    installed_content_hash: row.installed_content_hash || null,
    installed_at: row.installed_at === null || row.installed_at === undefined ? null : row.installed_at,
    last_checked_at: row.last_checked_at === null || row.last_checked_at === undefined ? null : row.last_checked_at,
    status: row.status || 'unknown',
    installed_rights_json: row.installed_rights_json || null,
  };
}

function getSkillPackRecord(db, hostId, packId) {
  if (!db || !hostId || !packId) return null;
  const row = db.prepare('SELECT * FROM dev_server_skill_packs WHERE host_id = ? AND pack_id = ?').get(hostId, packId);
  return rowToRecord(row);
}

// Full write for a CONFIRMED install (first install, update, or a "already
// up to date" no-op check) — installed_version/installed_content_hash are
// exactly what was just confirmed live, so status is 'current' by
// construction at the moment of this write.
function upsertInstalledSkillPack(db, { hostId, orgId, packId, installedVersion, installedContentHash, installedRightsJson, now = () => Date.now() } = {}) {
  if (!db || !hostId || !packId) return null;

  const params = {
    host_id: hostId,
    pack_id: packId,
    org_id: orgId || 'default',
    installed_version: installedVersion || null,
    installed_content_hash: installedContentHash || null,
    installed_rights_json: installedRightsJson || null,
    now: now(),
    status: 'current',
  };

  db.prepare(`
    INSERT INTO dev_server_skill_packs (host_id, pack_id, org_id, installed_version, installed_content_hash, installed_rights_json, installed_at, last_checked_at, status)
    VALUES (@host_id, @pack_id, @org_id, @installed_version, @installed_content_hash, @installed_rights_json, @now, @now, @status)
    ON CONFLICT(host_id, pack_id) DO UPDATE SET
      org_id = CASE
        WHEN dev_server_skill_packs.org_id IS NOT NULL AND dev_server_skill_packs.org_id != 'default' AND @org_id = 'default'
          THEN dev_server_skill_packs.org_id
        ELSE @org_id
      END,
      installed_version = @installed_version,
      installed_content_hash = @installed_content_hash,
      installed_rights_json = COALESCE(@installed_rights_json, dev_server_skill_packs.installed_rights_json),
      installed_at = @now,
      last_checked_at = @now,
      status = @status
  `).run(params);

  return getSkillPackRecord(db, hostId, packId);
}

// Minimal-touch UPSERT: refreshes last_checked_at + status only, without
// disturbing installed_version/installed_content_hash. Used after a status
// check that didn't confirm a fresh install (e.g. a sync attempt that
// failed, or recording a drift-check result against an existing record).
// If no row exists yet, inserts one with null install fields — "we checked,
// but there's nothing durably known about what's installed."
function touchSkillPackCheck(db, { hostId, orgId, packId, status, now = () => Date.now() } = {}) {
  if (!db || !hostId || !packId) return null;

  const params = {
    host_id: hostId,
    pack_id: packId,
    org_id: orgId || 'default',
    status: status || 'unknown',
    now: now(),
  };

  db.prepare(`
    INSERT INTO dev_server_skill_packs (host_id, pack_id, org_id, installed_version, installed_content_hash, installed_at, last_checked_at, status)
    VALUES (@host_id, @pack_id, @org_id, NULL, NULL, NULL, @now, @status)
    ON CONFLICT(host_id, pack_id) DO UPDATE SET
      last_checked_at = @now,
      status = @status
  `).run(params);

  return getSkillPackRecord(db, hostId, packId);
}

// Pure drift-detection logic: hash match = current, hash mismatch =
// drifted, no record (or a record with no recorded hash) = unknown.
function resolveDriftStatus(record, currentContentHash) {
  if (!record || !record.installed_content_hash) {
    return { status: 'unknown', drifted: null };
  }
  const drifted = record.installed_content_hash !== currentContentHash;
  return { status: drifted ? 'drifted' : 'current', drifted };
}

// SEC-DEV-SKILLPACK-2 (2026-08-11 audit) — tenant-isolation guard shared by
// both handlers below. Neither GET .../skill-pack-status nor POST
// .../skill-pack-sync had a per-route authorization check — the global
// collectorAuthGate only confirms the caller is AUTHENTICATED (some org),
// never that they're authorized for THIS host's org. Any authenticated user
// of ANY org could read another org's skill-pack drift status, or trigger a
// real remote write (skill-pack install via Bastion) against another org's
// host, just by knowing/guessing its host_id.
//
// Requires BOTH sides to resolve to a real, non-empty org and match exactly.
// A service-key caller with no bound org (req.user is unset in that branch
// of requireServiceOrUserAuth — see utils/httpAuth.js) is NOT automatically
// authorized either — same "no silent trust" posture as the
// dev-profiles/enable fix (devCapabilityProfileIssuer.js's
// resolveDevProfileEnableAuth).
function callerCanAccessOrg(req, resourceOrgId) {
  const callerOrgId = req && req.user && req.user.org_id;
  return !!callerOrgId && !!resourceOrgId && callerOrgId === resourceOrgId;
}

/**
 * GET /api/v1/dev-servers/:hostId/skill-pack-status
 *
 * Reads the durable record for this host first (no remote call). If a
 * record exists, drift is determined by recomputing the pack's content hash
 * fresh from the actual skill files on disk right now and comparing it to
 * the recorded installed_content_hash — never a stale cached value.
 *
 * Only when NO durable record exists yet (e.g. a host that registered and
 * had its pack installed before this table existed) does this fall back to
 * a live Bastion status check, mirroring checkPackStatus()'s remote-marker
 * read. A successful live check backfills a durable record (parsed from the
 * remote marker file's own JSON — packId/version/contentHash) so future
 * checks for this host no longer need a live round trip.
 */
function createSkillPackStatusHandler(deps = {}) {
  const {
    getDb,
    callBastion,
    getDevServer,
    pack = CORE_DEV_PACK,
    loadPack = loadPackFileContents,
    hashPack = computePackContentHash,
    checkStatus = checkPackStatus,
    now = () => Date.now(),
  } = deps;

  return async function skillPackStatusHandler(req, res) {
    const hostId = req.params.hostId;

    if (typeof getDevServer !== 'function') {
      return res.status(500).json({ error: 'skill_pack_status_misconfigured' });
    }

    let db;
    try {
      db = getDb();
    } catch (err) {
      return res.status(500).json({ error: 'db_unavailable', detail: err.message });
    }

    // SEC-DEV-SKILLPACK-2: resolve which org owns this host BEFORE doing
    // anything else (durable read, live Bastion fallback, or otherwise) —
    // see callerCanAccessOrg's header comment above.
    let devServer;
    try {
      devServer = getDevServer(db, hostId);
    } catch (err) {
      return res.status(500).json({ error: 'dev_server_lookup_failed', detail: err.message });
    }
    if (!devServer) {
      return res.status(404).json({ error: 'dev_server_not_found' });
    }
    if (!callerCanAccessOrg(req, devServer.org_id)) {
      return res.status(403).json({ error: 'org_scope_mismatch' });
    }

    let record;
    try {
      record = getSkillPackRecord(db, hostId, pack.packId);
    } catch (err) {
      return res.status(500).json({ error: 'skill_pack_status_lookup_failed', detail: err.message });
    }

    if (record) {
      let currentHash;
      let rights = null;
      try {
        const files = loadPack(pack);
        currentHash = hashPack(pack, files);
        // SKILLRIGHTS Phase 9: label the pack's rights alongside drift —
        // recomputed fresh from disk, same source as the hash.
        rights = summarizePackRights(files);
      } catch (err) {
        return res.status(500).json({ error: 'pack_hash_compute_failed', detail: err.message });
      }
      const { status, drifted } = resolveDriftStatus(record, currentHash);
      try {
        touchSkillPackCheck(db, { hostId, orgId: record.org_id, packId: pack.packId, status, now });
      } catch (_e) {
        // Best-effort refresh of last_checked_at — never fails the response.
      }
      return res.json({
        status,
        installedVersion: record.installed_version,
        currentVersion: pack.version,
        drifted,
        rights,
        installedRights: record.installed_rights_json ? JSON.parse(record.installed_rights_json) : null,
      });
    }

    // No durable record yet — the only case this endpoint does a live call.
    if (typeof callBastion !== 'function') {
      return res.json({ status: 'unknown', installedVersion: null, currentVersion: pack.version, drifted: null });
    }

    let liveStatus;
    try {
      liveStatus = await checkStatus({ callBastion }, hostId, pack);
    } catch (_err) {
      return res.json({ status: 'unknown', installedVersion: null, currentVersion: pack.version, drifted: null });
    }

    if (!liveStatus || !liveStatus.installed) {
      return res.json({ status: 'unknown', installedVersion: null, currentVersion: pack.version, drifted: null });
    }

    let parsedMarker = null;
    try {
      parsedMarker = JSON.parse(liveStatus.remoteMarker);
    } catch (_e) {
      // Older/unexpected marker format — can't backfill version info below.
    }

    const drifted = !liveStatus.upToDate;
    const t = now();
    if (parsedMarker && parsedMarker.contentHash) {
      upsertInstalledSkillPack(db, {
        hostId,
        packId: pack.packId,
        installedVersion: parsedMarker.version || null,
        installedContentHash: parsedMarker.contentHash,
        now: () => t,
      });
      if (drifted) {
        touchSkillPackCheck(db, { hostId, packId: pack.packId, status: 'drifted', now: () => t });
      }
    }

    return res.json({
      status: drifted ? 'drifted' : 'current',
      installedVersion: (parsedMarker && parsedMarker.version) || null,
      currentVersion: pack.version,
      drifted,
    });
  };
}

/**
 * POST /api/v1/dev-servers/:hostId/skill-pack-sync
 *
 * On-demand sync: re-runs installSkillPack() for this host unconditionally,
 * reusing its existing fail-closed verification path, then updates the
 * durable record from the outcome. A periodic auto-sync-on-drift scheduler
 * is explicitly out of scope for this pass — this is the manual trigger
 * only (see header comment).
 */
// SKILLRIGHTS #478 Phase 11 (pricing-free slice): the notice that travels with
// every distribution response. States reservation, never prevention or
// ownership (binding bars), and points at the terms document. One constant so
// the CLI, dashboard and any future marketplace surface all show the same
// words.
//
// SUPERSEDED 2026-09-11 (external audit, finding 11): the notice used to say
// "Receiving a skill is acceptance that its declared terms travel with it and
// bind the recipient". This path records no affirmative assent to an
// identified terms version — it installs the pack and then returns the notice
// — so calling a distribution event "acceptance" claimed evidence that does
// not exist. What the record actually evidences is that the declared terms
// ACCOMPANIED the skill. An acceptance flow (assent bound to an authenticated
// actor, an exact revision and an identified terms version, captured BEFORE
// delivery) is not built, and no surface may imply it is.
// AMENDED 2026-09-11 (phase 11, this commit): the acceptance flow now exists,
// so the previous clause "an affirmative acceptance flow does not exist yet"
// became false the moment it shipped. It is replaced with what remains true of
// THIS response: a sync still records accompaniment, never assent. Assent is a
// separate, separately-evidenced record, and it is only REQUIRED under the
// 'require-acceptance' distribution policy. Saying "assent was recorded" here
// would be the same overclaim in the other direction.
const SKILLRIGHTS_DISTRIBUTION_NOTICE =
  'Skills distributed through QuoxSkills carry their SkillRights declarations with them. '
  + 'This distribution is recorded as evidence that the declared terms accompanied the skill; '
  + 'it does not by itself record the recipient\'s assent to them. '
  + 'Affirmative acceptance is a separate record (quox dev skills accept <packId>), required before distribution only under the require-acceptance policy. '
  + 'A declaration is a dated reservation of rights, not a technical shield, and it does not establish ownership. '
  + 'Full terms: services/collector/docs/QUOXSKILLS_RIGHTS_TERMS.md';

function createSkillPackSyncHandler(deps = {}) {
  const {
    getDb,
    callBastion,
    installSkillPack,
    getDevServer,
    pack = CORE_DEV_PACK,
    loadPack = loadPackFileContents,
    hashPack = computePackContentHash,
    now = () => Date.now(),
    // SKILLRIGHTS #478 Phase 9: async (orgId) => policy string, resolved
    // fresh per sync from the org's registered
    // DEV_SKILLPACK_DISTRIBUTION_POLICY setting (configResolver.getSetting
    // at the server.js wiring). Injected so the handler stays unit-testable;
    // absent resolver = undefined policy = 'allow' (labels only, no
    // refusal) — the pre-Phase-9 behaviour exactly.
    resolveDistributionPolicy = null,
    // SKILLRIGHTS #478 Phase 11: the acceptance gate. Injected (same DI
    // discipline as everything else here) so the handler unit-tests without
    // a real acceptance store. Defaults to the real one.
    hasAcceptance = hasCurrentAcceptance,
    rightsHash = computeRightsSha256,
    // DEVSUITE DoD 8-9 (2026-08-19): this route is a REAL REMOTE WRITE — it
    // pushes a signed skill pack onto a fleet host via Bastion — and it left
    // no evidence at all. Its sibling build-receipts route emits, this did
    // not, so the one dev-servers write in the product was the one action you
    // could not audit. Injected rather than imported so the handler stays
    // unit-testable and so a missing wiring is a no-op, never a crash.
    emitEnvelope = null,
    // DEVSUITE B′ (quox#608): folds the install's Bastion execs into ONE human
    // approval. Injected for tests; defaults to the real gate. Returns a
    // grant-minting callBastion once a human has approved the install item.
    ensureApprovedInstallCallBastion = defaultEnsureApprovedInstallCallBastion,
  } = deps;

  return async function skillPackSyncHandler(req, res) {
    const hostId = req.params.hostId;

    if (typeof installSkillPack !== 'function' || typeof getDevServer !== 'function') {
      return res.status(500).json({ error: 'skill_pack_sync_misconfigured' });
    }

    let db;
    try {
      db = getDb();
    } catch (err) {
      return res.status(500).json({ error: 'db_unavailable', detail: err.message });
    }

    let devServer;
    try {
      devServer = getDevServer(db, hostId);
    } catch (err) {
      return res.status(500).json({ error: 'dev_server_lookup_failed', detail: err.message });
    }
    if (!devServer) {
      return res.status(404).json({ error: 'dev_server_not_found' });
    }
    // SEC-DEV-SKILLPACK-2: this is a real remote-write trigger
    // (installSkillPack -> Bastion) — must never run against a host owned
    // by an org other than the authenticated caller's own. See
    // callerCanAccessOrg's header comment above.
    if (!callerCanAccessOrg(req, devServer.org_id)) {
      return res.status(403).json({ error: 'org_scope_mismatch' });
    }

    // SKILLRIGHTS Phase 9: resolve this org's distribution policy fresh per
    // sync. A resolver failure degrades to undefined (= 'allow') rather than
    // failing the sync — the policy can restrict distribution, its
    // infrastructure being down must not brick it.
    let distributionPolicy;
    if (typeof resolveDistributionPolicy === 'function') {
      try {
        distributionPolicy = await resolveDistributionPolicy(devServer.org_id);
      } catch (_e) {
        distributionPolicy = undefined;
      }
    }

    // SKILLRIGHTS #478 Phase 11 — AFFIRMATIVE ACCEPTANCE, enforced BEFORE the
    // download is authorized (the audit's finding 11 design answer: commit
    // acceptance first, then authorize delivery). Under 'require-acceptance',
    // a pack carrying ANY declared skill may not be pushed to a host until an
    // authenticated user of this org has accepted the identified terms for
    // exactly this content hash and these declared rights. A pack whose
    // skills are all undeclared is unaffected: there are no terms to accept,
    // and inventing a consent step for nothing would be governance theatre.
    if (distributionPolicy === 'require-acceptance') {
      let gate;
      try {
        const files = loadPack(pack);
        const packRights = summarizePackRights(files);
        gate = {
          declared: packRights.declared,
          contentHash: hashPack(pack, files),
          rightsSha256: rightsHash(packRights),
        };
      } catch (err) {
        // Fail CLOSED. Under this policy the org has said "no distribution
        // without recorded assent"; being unable to compute what would be
        // accepted is not permission to skip the acceptance.
        return res.status(500).json({ error: 'acceptance_check_failed', detail: err.message });
      }

      if (gate.declared > 0) {
        const accepted = hasAcceptance(db, {
          orgId: devServer.org_id,
          packId: pack.packId,
          contentHash: gate.contentHash,
          rightsSha256: gate.rightsSha256,
        });
        if (!accepted) {
          return res.status(409).json({
            error: 'acceptance_required',
            packId: pack.packId,
            offerEndpoint: ACCEPTANCE_OFFER_ENDPOINT,
            contentHash: gate.contentHash,
            rightsSha256: gate.rightsSha256,
            policy: distributionPolicy,
            message: `This org's distribution policy is require-acceptance and no user has accepted the current terms for pack '${pack.packId}' at this content. Run: quox dev skills accept ${pack.packId}`,
          });
        }
      }
    }

    // DEVSUITE B′ (quox#608): every install command goes over the HITL-gated
    // Bastion path (risky mode), so a grantless install is a guaranteed 403.
    // Fold the whole install into ONE human approval. But don't demand an
    // approval merely to discover a host is already current: short-circuit on
    // the durable record (the same drift signal the heartbeat trigger uses) —
    // even the live status check would need a grant, so trusting the record
    // here is both cheaper and avoids a pointless approval prompt.
    // Best-effort content hash: used to (a) short-circuit an already-current
    // host without an approval prompt, and (b) key the approval item so a
    // changed pack forces a fresh approval. FAIL-SOFT — a hash-compute failure
    // must never 500 a sync; it just means no short-circuit and a version-keyed
    // approval title.
    let currentContentHash = null;
    let currentFileCount = 0;
    try {
      const files = loadPack(pack);
      currentContentHash = hashPack(pack, files);
      currentFileCount = files.length;
    } catch (_e) { /* fall through: no short-circuit, version-keyed approval */ }

    if (currentContentHash) {
      try {
        const existing = getSkillPackRecord(db, hostId, pack.packId);
        if (existing && existing.installed_content_hash === currentContentHash) {
          const t0 = now();
          touchSkillPackCheck(db, { hostId, orgId: devServer.org_id, packId: pack.packId, status: 'current', now: () => t0 });
          return res.status(200).json({
            status: 'up_to_date',
            packId: pack.packId,
            version: pack.version,
            hostId,
            installedContentHash: existing.installed_content_hash,
          });
        }
      } catch (_e) {
        // Record read failure ⇒ fall through to the approval + install path.
      }
    }

    let installCallBastion = callBastion;
    try {
      const gate = await ensureApprovedInstallCallBastion({
        orgId: devServer.org_id,
        hostId,
        pack,
        contentHash: currentContentHash,
        fileCount: currentFileCount,
        baseCallBastion: callBastion,
      });
      if (!gate.approved) {
        if (gate.error) {
          return res.status(502).json({ error: 'install_approval_unavailable', detail: gate.error });
        }
        return res.status(202).json({
          status: 'awaiting_approval',
          itemId: gate.itemId,
          packId: pack.packId,
          version: pack.version,
          hostId,
          message: `This install needs one human approval. Approve inbox item ${gate.itemId} (quox inbox respond ${gate.itemId} --action approve), then re-run the sync.`,
        });
      }
      installCallBastion = gate.callBastion;
    } catch (err) {
      return res.status(500).json({ error: 'install_approval_failed', detail: err.message });
    }

    let result;
    try {
      result = await installSkillPack({ callBastion: installCallBastion }, {
        hostId,
        enabledCapabilities: devServer.enabled_capabilities,
        orgId: devServer.org_id,
        pack,
        distributionPolicy,
      });
    } catch (err) {
      return res.status(500).json({ error: 'skill_pack_sync_failed', detail: err.message });
    }

    // Rights summary recomputed fresh from the local pack files — the label
    // the CLI/dashboard shows beside sync results. Best-effort: unreadable
    // local files never fail the response.
    let rights = null;
    try {
      rights = summarizePackRights(loadPack(pack));
    } catch (_e) { /* labels omitted */ }

    const confirmed = !!(result && (result.installed === true || SYNC_SUCCESS_REASONS.has(result.reason)));
    const t = now();
    let record;
    if (confirmed) {
      let contentHash = null;
      try {
        contentHash = hashPack(pack, loadPack(pack));
      } catch (_e) {
        // Leave null if the local pack files are unreadable — status
        // still reflects a confirmed sync, just without a hash to compare.
      }
      record = upsertInstalledSkillPack(db, {
        hostId,
        orgId: devServer.org_id,
        packId: (result && result.packId) || pack.packId,
        installedVersion: (result && result.version) || pack.version,
        installedContentHash: contentHash,
        installedRightsJson: rights ? JSON.stringify(rights.entries) : null,
        now: () => t,
      });
    } else {
      record = touchSkillPackCheck(db, { hostId, orgId: devServer.org_id, packId: pack.packId, status: 'unknown', now: () => t });
    }

    // Witness the sync attempt, confirmed or not. A refused/unconfirmed sync is
    // exactly as interesting as a successful one for anyone auditing what was
    // pushed to a host, so this emits on BOTH paths rather than only success.
    if (typeof emitEnvelope === 'function') {
      try {
        emitEnvelope({
          type: 'event',
          intent: 'quox.dev.skillpack.sync',
          from: 'service.collector',
          to: `host.${hostId}`,
          payload: {
            org_id: devServer.org_id,
            host_id: hostId,
            pack_id: (result && result.packId) || pack.packId,
            version: (result && result.version) || pack.version,
            confirmed,
            reason: (result && result.reason) || null,
            distribution_policy: distributionPolicy || 'allow',
            rights_declared: rights ? rights.declared : null,
            rights_undeclared: rights ? rights.undeclared : null,
          },
        });
      } catch (_e) {
        // Evidence must never break the operation it witnesses.
      }
    }

    return res.json({
      synced: confirmed,
      reason: result && result.reason,
      // quox#611: surface WHICH clause failed and why (e.g. a bastion 403
      // approval-required) instead of only the generic reason.
      ...(result && result.error ? { error: String(result.error) } : {}),
      record,
      rights,
      policy: distributionPolicy || 'allow',
      rightsNotice: SKILLRIGHTS_DISTRIBUTION_NOTICE,
      rightsTermsRef: 'services/collector/docs/QUOXSKILLS_RIGHTS_TERMS.md',
      ...(result && result.reason === 'refused_by_rights_policy' ? { offendingRefs: result.offendingRefs } : {}),
    });
  };
}

module.exports = {
  SYNC_SUCCESS_REASONS,
  SKILLRIGHTS_DISTRIBUTION_NOTICE,
  getSkillPackRecord,
  upsertInstalledSkillPack,
  touchSkillPackCheck,
  resolveDriftStatus,
  callerCanAccessOrg,
  createSkillPackStatusHandler,
  createSkillPackSyncHandler,
};
