'use strict';

/**
 * SKILLRIGHTS #478 Phase 12 (pricing-free core) — org rights disclosure
 * ledger. See test/skillRightsLedger.test.js for the contract.
 *
 * Read-model ONLY, assembled per request from the durable records phases
 * 9-11 already write (dev_server_skill_packs, skill_protections, envelopes).
 * No new table: a disclosure that kept its own copy of the facts would
 * eventually disagree with the facts, and the generated-artefact-goes-stale
 * failure mode is well documented in this codebase. Slow is fine here;
 * wrong is not. Writes nothing, by design.
 *
 * What this is NOT (yet, honestly): a runtime execution ledger. It
 * discloses what was DISTRIBUTED and PROTECTED under which declared
 * rights, with evidence refs. "Skill X was EXECUTED by agent Y under
 * licence L at time T" is workstream 10 (usage ledger) and does not exist;
 * no surface may imply otherwise.
 */

const { listAcceptances, ACCEPTANCE_INTENT, ACCEPTANCE_HONEST_CLAIM } = require('./skillPackAcceptance.js');

const SYNC_INTENT = 'quox.dev.skillpack.sync';
const PROTECT_INTENT = 'quox.skills.protect';

/** Summarise a parsed rights entries array ([{ref, license}]) . */
function summarizeEntries(entries) {
  const byLicense = {};
  let declared = 0;
  for (const e of entries) {
    if (e && e.license) {
      declared += 1;
      byLicense[e.license] = (byLicense[e.license] || 0) + 1;
    }
  }
  return { total: entries.length, declared, undeclared: entries.length - declared, byLicense, entries };
}

/**
 * Build the org's rights disclosure ledger.
 * deps.getPolicy(orgId) -> the org's distribution policy value (the same
 * resolver path the sync route uses); failures degrade to policy: null +
 * policyError rather than failing the whole disclosure.
 */
async function buildRightsLedger(db, orgId, { getPolicy } = {}) {
  let policy = null;
  let policyError;
  if (typeof getPolicy === 'function') {
    try {
      policy = (await getPolicy(orgId)) ?? null;
    } catch (err) {
      policy = null;
      policyError = err.message;
    }
  }

  const distRows = db.prepare(
    'SELECT * FROM dev_server_skill_packs WHERE org_id = ? ORDER BY host_id',
  ).all(orgId);

  const distributions = distRows.map((row) => {
    let rights = null;
    let rightsUnreadable = false;
    if (row.installed_rights_json) {
      try {
        const entries = JSON.parse(row.installed_rights_json);
        if (Array.isArray(entries)) rights = summarizeEntries(entries);
        else rightsUnreadable = true;
      } catch {
        rightsUnreadable = true;
      }
    }
    const d = {
      hostId: row.host_id,
      packId: row.pack_id,
      installedVersion: row.installed_version || null,
      installedAt: row.installed_at ?? null,
      lastCheckedAt: row.last_checked_at ?? null,
      status: row.status || 'unknown',
      // null rights = "no rights record for this install" (pre-tracking or
      // unreadable) — disclosed as unknown, never zero-filled.
      rights,
    };
    if (rightsUnreadable) d.rightsUnreadable = true;
    return d;
  });

  const protRows = db.prepare(
    'SELECT id, srid, skill_name, manifest_sha256, license, mode, org_key_id, aee_envelope_id, created_at FROM skill_protections WHERE org_id = ? ORDER BY created_at DESC, id DESC',
  ).all(orgId);
  const protections = protRows.map((r) => ({
    srid: r.srid,
    skillName: r.skill_name,
    manifestSha256: r.manifest_sha256,
    license: r.license,
    mode: r.mode,
    orgKeyId: r.org_key_id,
    aeeEnvelopeId: r.aee_envelope_id,
    createdAt: r.created_at,
  }));

  // SKILLRIGHTS #478 Phase 11 — the acceptances this org has recorded: who
  // assented, to which terms, for which exact pack content and declared
  // rights, and where the evidence envelope is. Tolerant of a DB that
  // predates migration 027 (the rest of the disclosure still stands).
  let acceptances = [];
  let acceptancesUnavailable;
  try {
    acceptances = listAcceptances(db, orgId);
  } catch (err) {
    acceptancesUnavailable = err.message;
  }

  const countIntent = (intent) => {
    try {
      return db.prepare('SELECT COUNT(*) AS n FROM envelopes WHERE intent = ? AND org_id = ?').get(intent, orgId).n;
    } catch {
      return 0; // envelopes table absent (stripped deployment): counts are 0, not a crash
    }
  };

  const byLicense = {};
  let skillsDistributed = 0;
  let skillsDeclared = 0;
  for (const d of distributions) {
    if (!d.rights) continue;
    skillsDistributed += d.rights.total;
    skillsDeclared += d.rights.declared;
    for (const [id, n] of Object.entries(d.rights.byLicense)) {
      byLicense[id] = (byLicense[id] || 0) + n;
    }
  }

  const ledger = {
    orgId,
    generatedAt: new Date().toISOString(),
    policy,
    distributions,
    protections,
    acceptances,
    // The one sentence an acceptance row evidences, carried with the rows so
    // no consuming surface has to invent its own wording (or a stronger one).
    acceptanceClaim: ACCEPTANCE_HONEST_CLAIM,
    evidence: {
      syncEnvelopes: countIntent(SYNC_INTENT),
      protectEnvelopes: countIntent(PROTECT_INTENT),
      acceptanceEnvelopes: countIntent(ACCEPTANCE_INTENT),
      intents: [SYNC_INTENT, PROTECT_INTENT, ACCEPTANCE_INTENT],
    },
    summary: {
      hosts: distributions.length,
      hostsWithRightsRecord: distributions.filter((d) => d.rights).length,
      skillsDistributed,
      skillsDeclared,
      skillsUndeclared: skillsDistributed - skillsDeclared,
      protections: protections.length,
      acceptances: acceptances.length,
      byLicense,
    },
  };
  if (policyError) ledger.policyError = policyError;
  if (acceptancesUnavailable) ledger.acceptancesUnavailable = acceptancesUnavailable;
  return ledger;
}

module.exports = { buildRightsLedger };
