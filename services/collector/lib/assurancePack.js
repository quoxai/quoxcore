/**
 * AUD-WS-5: Assurance Pack builder.
 *
 * Produces a single signed JSON document an external auditor can take away
 * and verify independently. Includes (per include flags):
 *   - ward_chain      WARD integrity state + tip info for the period
 *   - volt_bundles    Signed VOLT bundles whose created_ts falls in period
 *   - audit_events    AEE envelopes matching the period
 *
 * The pack is itself signed via the persistent WARD Ed25519 keypair (same
 * trust anchor as WARD tips + VOLT bundle signatures). manifest_hash is a
 * SHA-256 over the canonical JSON of the pack with manifest_hash+signature
 * omitted — lets an auditor re-derive and verify without knowing our canonical
 * ordering rules (we use JSON.stringify with sorted keys, standard).
 *
 * Pure function — no HTTP, no DB singleton. Inject voltStatements + signer +
 * data-source callbacks. Returns the pack object.
 */

const crypto = require('crypto');

function ulid(prefix) {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${t}${r}`;
}

function canonicalStringify(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Build an assurance pack.
 *
 * @param {object} opts
 * @param {object} opts.voltStatements  prepared statements; must expose
 *                                      listBundlesInPeriod(from, to) OR
 *                                      the builder will skip volt_bundles.
 * @param {function} opts.signer        async signBundleManifest(manifest)
 *                                      returning { sig_type, key_id, signature, ... }
 * @param {function} opts.wardData      async () -> { chain_id, entries_count, tips, integrity }
 * @param {function} opts.auditEvents   async (period, orgId) -> array of envelope objects
 * @param {string}  opts.publicKeyPem   PEM string for the public key
 * @param {string}  opts.orgId
 * @param {object}  opts.period         { from: ISO, to: ISO } — both required
 * @param {string}  [opts.generatedBy]  user_id of the export requester
 * @param {object}  [opts.include]      { ward, volt, audit } — defaults all true
 * @returns {Promise<object>} the signed pack
 */
async function buildAssurancePack(opts) {
  const { voltStatements, signer, wardData, auditEvents, publicKeyPem, orgId, period, generatedBy } = opts;
  const include = Object.assign({ ward: true, volt: true, audit: true }, opts.include || {});

  if (!signer) throw new Error('assurance pack: signer is required');
  if (!period || !period.from || !period.to) {
    throw new Error('assurance pack: period.from and period.to are both required');
  }

  const pack = {
    $schema: 'quox-assurance-pack-v1',
    version: '1.0',
    pack_id: ulid('PKG'),
    generated_at: new Date().toISOString(),
    generated_by: generatedBy || null,
    org_id: orgId,
    period: { from: period.from, to: period.to },
    public_key_pem: publicKeyPem || null,
  };

  // ── WARD chain ─────────────────────────────────────────────────────────
  let wardEntriesCount = 0;
  if (include.ward && typeof wardData === 'function') {
    try {
      const ward = await wardData(period, orgId);
      pack.ward_chain = ward || { chain_id: null, entries_count: 0, tips: [] };
      wardEntriesCount = pack.ward_chain.entries_count || 0;
    } catch (err) {
      pack.ward_chain = { error: err.message };
    }
  }

  // ── VOLT bundles ───────────────────────────────────────────────────────
  let voltBundles = [];
  if (include.volt && voltStatements && voltStatements.listBundlesInPeriod) {
    try {
      const rows = voltStatements.listBundlesInPeriod.all(period.from, period.to);
      voltBundles = rows.map(r => ({
        bundle_id: r.bundle_id,
        run_id: r.run_id,
        created_ts: r.created_ts,
        // Parse the stored manifest+signature blob so the pack doesn't
        // contain doubly-nested JSON strings.
        data: safeJsonParse(r.data),
      }));
    } catch (err) {
      voltBundles = [];
      pack.volt_bundles_error = err.message;
    }
  }
  if (include.volt) pack.volt_bundles = voltBundles;

  // ── Audit events ───────────────────────────────────────────────────────
  let audit = [];
  if (include.audit && typeof auditEvents === 'function') {
    try {
      audit = await auditEvents(period, orgId);
    } catch (err) {
      audit = [];
      pack.audit_events_error = err.message;
    }
  }
  if (include.audit) pack.audit_events = audit;

  // ── Stats summary ──────────────────────────────────────────────────────
  pack.stats = {
    volt_bundles: voltBundles.length,
    ward_entries: wardEntriesCount,
    audit_events: audit.length,
  };

  // ── manifest_hash over the pack excluding manifest_hash + signature ────
  const toHash = { ...pack };
  delete toHash.manifest_hash;
  delete toHash.signature;
  pack.manifest_hash = sha256Hex(canonicalStringify(toHash));

  // ── Sign over { pack_id, period, manifest_hash, org_id } ───────────────
  const signMessage = {
    pack_id: pack.pack_id,
    org_id: pack.org_id,
    period: pack.period,
    manifest_hash: pack.manifest_hash,
  };
  pack.signature = await signer(signMessage);

  return pack;
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

module.exports = {
  buildAssurancePack,
  canonicalStringify,
  sha256Hex,
};
