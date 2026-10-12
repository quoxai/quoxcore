/**
 * devServerSkillPackTrigger.js — DEVSUITE-DEVMODE/SKILLS wiring: connects
 * devServersStore.js's `isNewRegistration` signal (recordDevServerHeartbeat)
 * to skillPackInstaller.js's `installSkillPack`.
 *
 * Heartbeats fire every ~60s, and re-running the installer on every single
 * one would mean a Bastion round trip per host per minute forever, even
 * though installSkillPack already has its own already-installed no-op check
 * internally. This module installs the FIRST time a host registers
 * dev_capabilities, and on routine heartbeats it runs the P6 UPDATE CHANNEL:
 * a cheap local hash compare (durable record vs current pack content), with
 * a Bastion round trip only on drift, throttled per host.
 *
 * DI-testable, no server.js import — same self-contained pattern as
 * devServersStore.js and skillPackInstaller.js (both documented as testable
 * this way because server.js is a monolith that calls server.listen() at
 * module load and can't be required in a lightweight unit test).
 *
 * DEVSUITE-SKILLS Phase 3: after a confirmed install/up-to-date result, this
 * module also UPSERTs the outcome into the durable dev_server_skill_packs
 * table (devServerSkillPacksStore.js), recomputing the pack's content hash
 * fresh from the actual skill files on disk (never a cached value) so the
 * recorded hash always matches what was truly just confirmed. That table is
 * what lets the dashboard read "is this host's pack current?" without a
 * live Bastion round trip on every request. Recording is best-effort: a
 * failure here is caught and logged, never re-thrown into the fire-and-
 * forget chain below.
 */

'use strict';

const { CORE_DEV_PACK, loadPackFileContents, computePackContentHash, summarizePackRights } = require('./skillPackInstaller.js');
const { upsertInstalledSkillPack, getSkillPackRecord, SYNC_SUCCESS_REASONS } = require('./devServerSkillPacksStore.js');
const { computeRightsSha256, hasCurrentAcceptance } = require('./skillPackAcceptance.js');
const { ensureApprovedInstallCallBastion: defaultEnsureApprovedInstallCallBastion } = require('./packInstallApproval.js');

// DEVSUITE-SKILLS P6 (2026-08-15): the UPDATE CHANNEL. First-install alone is
// not a sync story — pack v4 only reached the fleet because a session drove
// the installer by hand. Routine heartbeats now compare the host's durable
// record hash against the CURRENT pack content hash and re-install on drift.
// Throttled per host so a failing install can't become a Bastion hammer, and
// the pack hash (21 file reads) is cached briefly so ~60s heartbeats from a
// whole fleet don't re-read the pack every time.
const RESYNC_MIN_INTERVAL_MS = 10 * 60 * 1000;
const PACK_HASH_CACHE_MS = 60 * 1000;
// DEVSUITE B′ / quox#609 — loop-hygiene RETIREMENT. When the approval item
// cannot be minted because the org has no owner/admin to approve ("No assignee
// found for this org"), the install can NEVER succeed until org config changes,
// so retrying every drift cycle (10 min) forever is futile churn. On that
// specific permanent-config failure, back the host off for hours instead of
// minutes. Transient failures and the normal awaiting-approval case keep the
// 10-min cadence so a legitimate approval is still picked up promptly.
const NO_APPROVER_BACKOFF_MS = 6 * 60 * 60 * 1000;
let _packHashCache = { hash: null, at: 0 };
const _lastResyncAttemptByHost = new Map();
const _noApproverBackoffUntil = new Map();

function _currentPackHash() {
  const nowMs = Date.now();
  if (_packHashCache.hash && nowMs - _packHashCache.at < PACK_HASH_CACHE_MS) {
    return _packHashCache.hash;
  }
  const hash = computePackContentHash(CORE_DEV_PACK, loadPackFileContents(CORE_DEV_PACK));
  _packHashCache = { hash, at: nowMs };
  return hash;
}

// Test hook: clears the throttle map and hash cache between cases.
function _resetResyncStateForTests() {
  _packHashCache = { hash: null, at: 0 };
  _lastResyncAttemptByHost.clear();
  _noApproverBackoffUntil.clear();
}

/**
 * Fire-and-forget: if this heartbeat was a first-time dev_capabilities
 * registration, kick off installSkillPack in the background. Never throws
 * into the caller — any rejection is caught and logged. The caller's
 * heartbeat ack must not wait on this (no Bastion round trip in the
 * request/response path), so this function does not return the install
 * promise; it only returns void.
 *
 * @param {{installSkillPack: Function, callBastion: Function, db?: object, log?: Function}} deps
 *   `db` is optional (omitting it skips the durable-record step, e.g. in
 *   older unit tests that only assert on installSkillPack's own call args).
 * @param {{isNewRegistration: boolean, heartbeat: object}} args
 */
// Default acceptance gate for the require-acceptance policy: computes what
// the sync route would demand assent for and whether a current acceptance
// exists. Injectable for tests.
function _defaultAcceptanceGate(db, orgId) {
  const files = loadPackFileContents(CORE_DEV_PACK);
  const rights = summarizePackRights(files);
  return {
    declared: rights.declared,
    accepted: hasCurrentAcceptance(db, {
      orgId,
      packId: CORE_DEV_PACK.packId,
      contentHash: computePackContentHash(CORE_DEV_PACK, files),
      rightsSha256: computeRightsSha256(rights),
    }),
  };
}

function maybeTriggerSkillPackInstall({ installSkillPack, callBastion, db, log = console.warn, resolveDistributionPolicy, acceptanceGate, ensureApprovedInstallCallBastion = defaultEnsureApprovedInstallCallBastion, resolveFleetOperatorOrgId }, { isNewRegistration, heartbeat }) {
  const dc = heartbeat && heartbeat.dev_capabilities;
  if (!dc || typeof dc !== 'object') return;
  if (typeof installSkillPack !== 'function' || typeof callBastion !== 'function') return;

  // quox#609 retirement: if this host is in a no-approver back-off window,
  // skip entirely (both first-registration and drift paths) until it expires.
  const blockedUntil = _noApproverBackoffUntil.get(heartbeat.host_id) || 0;
  if (Date.now() < blockedUntil) return;

  if (!isNewRegistration) {
    // Routine heartbeat: only proceed on DRIFT (P6 update channel). Requires
    // the durable table; without db there is nothing to compare against.
    if (!db) return;
    let currentHash;
    try {
      currentHash = _currentPackHash();
    } catch (hashErr) {
      log('[DEV] skill pack hash compute failed: %s', hashErr && hashErr.message);
      return;
    }
    let record;
    try {
      record = getSkillPackRecord(db, heartbeat.host_id, CORE_DEV_PACK.packId);
    } catch (recErr) {
      log('[DEV] skill pack record read failed for %s: %s', heartbeat.host_id, recErr && recErr.message);
      return;
    }
    // A host with NO record never had a confirmed install (or predates the
    // table): treat as drifted so it converges instead of staying dark.
    if (record && record.installed_content_hash === currentHash) return;

    const nowMs = Date.now();
    const last = _lastResyncAttemptByHost.get(heartbeat.host_id) || 0;
    if (nowMs - last < RESYNC_MIN_INTERVAL_MS) return;
    _lastResyncAttemptByHost.set(heartbeat.host_id, nowMs);
    log('[DEV] skill pack drift detected for %s (record %s) — resyncing', heartbeat.host_id, record ? (record.installed_version || '?') : 'absent');
  }

  // SKILLRIGHTS-11 follow-up: this background path is a real remote write
  // and must respect the org's distribution policy exactly like the sync
  // route (before this, require-declaration and require-acceptance were
  // both bypassed by first-registration/drift installs). Policy resolution
  // failure fails CLOSED here: an auto-installer that cannot learn the
  // policy does not push; the next heartbeat retries.
  // quox#638 (fleet-org approval gap) / quox#642 (instance-operator-org
  // fallback): a host that heartbeats without an org_id has no org whose
  // HITL approval it can be routed to. Before minting an approval nobody can
  // assign, fall back to the instance operator org (instance_config
  // 'fleet.operator_org_id', resolved async below, exact mirror of
  // resolveQuoxplanOwnerOrgId's pattern). Only DEFER when neither a real
  // heartbeat org nor a configured operator org is available. A real
  // heartbeat org always wins and never triggers the operator-org lookup.
  let orgId = (heartbeat.org_id && heartbeat.org_id !== 'default') ? heartbeat.org_id : null;
  // Captured by the first async callback below so the durable-record
  // callback further down can record against the org the install actually
  // used, even though that org may only be known after an async resolution.
  let resolvedOrgId = orgId;

  Promise.resolve()
    .then(async () => {
      if (!orgId && typeof resolveFleetOperatorOrgId === 'function') {
        try {
          orgId = await resolveFleetOperatorOrgId();
        } catch {
          orgId = null;
        }
      }
      if (!orgId) {
        log('[DEV] skill pack auto-install DEFERRED for %s: host has no attributed org (no org_id in heartbeat) and no instance operator org is configured (instance_config fleet.operator_org_id); waiting for org attribution', heartbeat.host_id);
        return null;
      }
      resolvedOrgId = orgId;

      let distributionPolicy;
      if (typeof resolveDistributionPolicy === 'function') {
        try {
          distributionPolicy = await resolveDistributionPolicy(orgId);
        } catch (polErr) {
          log('[DEV] skill pack auto-install SKIPPED for %s: distribution policy unresolvable (%s), failing closed', heartbeat.host_id, polErr && polErr.message);
          return null;
        }
      }
      if (distributionPolicy === 'require-acceptance') {
        let gate;
        try {
          gate = (typeof acceptanceGate === 'function') ? acceptanceGate(db, orgId) : _defaultAcceptanceGate(db, orgId);
        } catch (gateErr) {
          log('[DEV] skill pack auto-install SKIPPED for %s: acceptance gate failed (%s), failing closed', heartbeat.host_id, gateErr && gateErr.message);
          return null;
        }
        if (gate.declared > 0 && !gate.accepted) {
          log('[DEV] skill pack auto-install REFUSED for %s: policy require-acceptance and no recorded acceptance for the current pack terms (quox dev skills accept %s)', heartbeat.host_id, CORE_DEV_PACK.packId);
          return null;
        }
      }
      // DEVSUITE B′ (quox#608): the install's Bastion execs are HITL-gated
      // (risky mode). Fold them into ONE human approval — mint/find the
      // approval item, and only install once a human has approved it. Until
      // then this raises the approval request and returns without pushing
      // (the next drift heartbeat retries and installs once approved).
      let installCallBastion = callBastion;
      try {
        const files = loadPackFileContents(CORE_DEV_PACK);
        const gate = await ensureApprovedInstallCallBastion({
          orgId,
          hostId: heartbeat.host_id,
          pack: CORE_DEV_PACK,
          contentHash: computePackContentHash(CORE_DEV_PACK, files),
          fileCount: files.length,
          baseCallBastion: callBastion,
        });
        if (!gate.approved) {
          // Retire futile retries when the org has no owner/admin to approve
          // (the approval item can't even be minted). Any other error / the
          // normal awaiting-approval case keeps the 10-min drift cadence.
          if (gate.error && /no assignee found|no approver/i.test(gate.error)) {
            _noApproverBackoffUntil.set(heartbeat.host_id, Date.now() + NO_APPROVER_BACKOFF_MS);
            log('[DEV] skill pack install for %s RETIRED for %dh: org has no owner/admin to approve — add one and it resumes (%s)', heartbeat.host_id, NO_APPROVER_BACKOFF_MS / 3600000, gate.error);
          } else {
            log('[DEV] skill pack install for %s AWAITING approval (inbox item %s)', heartbeat.host_id, gate.itemId || (gate.error ? `error: ${gate.error}` : '?'));
          }
          return null;
        }
        installCallBastion = gate.callBastion;
      } catch (gErr) {
        log('[DEV] skill pack approval gate failed for %s: %s', heartbeat.host_id, gErr && gErr.message);
        return null;
      }
      return installSkillPack({ callBastion: installCallBastion }, {
        hostId: heartbeat.host_id,
        enabledCapabilities: dc.enabled_capabilities,
        orgId,
        distributionPolicy,
      });
    })
    .then((result) => {
      if (!db) return;
      const confirmed = !!(result && (result.installed === true || SYNC_SUCCESS_REASONS.has(result.reason)));
      if (!confirmed) return;
      try {
        const pack = CORE_DEV_PACK;
        const contentHash = computePackContentHash(pack, loadPackFileContents(pack));
        upsertInstalledSkillPack(db, {
          hostId: heartbeat.host_id,
          orgId: resolvedOrgId || heartbeat.org_id || 'default',
          packId: (result && result.packId) || pack.packId,
          installedVersion: (result && result.version) || pack.version,
          installedContentHash: contentHash,
        });
      } catch (recErr) {
        log('[DEV] skill pack record failed for %s: %s', heartbeat.host_id, recErr && recErr.message);
      }
    })
    .catch((err) => {
      log('[DEV] skill pack install failed for %s: %s', heartbeat.host_id, err && err.message);
    });
}

module.exports = { maybeTriggerSkillPackInstall, _resetResyncStateForTests, RESYNC_MIN_INTERVAL_MS, NO_APPROVER_BACKOFF_MS };
