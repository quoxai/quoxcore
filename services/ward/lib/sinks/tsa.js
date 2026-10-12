/**
 * WARD-EXT-1: RFC 3161 TSA Sink
 *
 * Publishes signed tip hashes to an RFC 3161 Time Stamping Authority.
 * Zero-config default: uses FreeTSA.org (same as VOLT certification).
 *
 * The timestamp receipt (tsr_base64) proves the tip hash existed at a
 * specific time, independently verifiable with `openssl ts -verify`.
 *
 * sink_ref format: tsa:<tsa_host>#<tip_seq>
 */

const TSA_URL = process.env.WARD_TSA_URL || process.env.VOLT_TSA_URL || 'https://freetsa.org/tsr';
const SHA256_OID = [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];

/**
 * Request an RFC 3161 timestamp for a hex hash.
 * Builds DER-encoded TimeStampReq, POSTs to TSA, returns timestamp record.
 *
 * @param {string} hexHash - SHA-256 hash to timestamp (hex string)
 * @param {string} [tsaUrl] - TSA endpoint URL (default: FreeTSA)
 * @returns {Promise<{tsr_base64: string, tsa_url: string, requested_at: string} | null>}
 */
async function requestTimestamp(hexHash, tsaUrl) {
  const url = tsaUrl || TSA_URL;

  function derLength(len) {
    if (len < 0x80) return [len];
    if (len < 0x100) return [0x81, len];
    return [0x82, (len >> 8) & 0xff, len & 0xff];
  }
  function derSeq(items) {
    const body = Buffer.concat(items.map(i => Buffer.from(i)));
    return Buffer.from([0x30, ...derLength(body.length), ...body]);
  }

  if (!hexHash || !/^[0-9a-fA-F]{64}$/.test(hexHash)) {
    throw new Error(`Invalid SHA-256 hex hash: expected 64 hex chars, got ${hexHash?.length || 0}`);
  }
  const hashBytes = Buffer.from(hexHash, 'hex');
  const algId = derSeq([Buffer.from([0x06, SHA256_OID.length, ...SHA256_OID])]);
  const msgImprint = derSeq([algId, Buffer.from([0x04, ...derLength(hashBytes.length), ...hashBytes])]);
  const version = Buffer.from([0x02, 0x01, 0x01]);
  const certReq = Buffer.from([0x01, 0x01, 0xff]);
  const tsReq = derSeq([version, msgImprint, certReq]);

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/timestamp-query' },
    body: tsReq,
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) throw new Error(`TSA HTTP ${resp.status}`);

  const tsrBuffer = await resp.arrayBuffer();
  const tsr_base64 = Buffer.from(tsrBuffer).toString('base64');

  return { tsr_base64, tsa_url: url, requested_at: new Date().toISOString() };
}

/**
 * Publish a WARD tip to an RFC 3161 TSA.
 *
 * @param {object} tip - Signed WARD tip
 * @param {object} [config] - { tsa_url }
 * @returns {Promise<{success: boolean, sink_ref: string|null, tsr_base64: string|null, error: string|null}>}
 */
async function publish(tip, config = {}) {
  try {
    const hash = tip.tip_chain_hash;
    if (!hash) return { success: false, sink_ref: null, tsr_base64: null, error: 'No tip_chain_hash' };

    const tsaUrl = config.tsa_url || TSA_URL;
    const result = await requestTimestamp(hash, tsaUrl);

    if (!result?.tsr_base64) {
      return { success: false, sink_ref: null, tsr_base64: null, error: 'TSA returned empty response' };
    }

    const host = new URL(tsaUrl).host;
    const sinkRef = `tsa:${host}#${tip.tip_seq}`;

    return {
      success: true,
      sink_ref: sinkRef,
      tsr_base64: result.tsr_base64,
      error: null
    };
  } catch (err) {
    return { success: false, sink_ref: null, tsr_base64: null, error: err.message };
  }
}

/**
 * AUDIT-REAL #3: real RFC 3161 cryptographic verification of a published
 * TSA tip receipt.
 *
 * `sink_ref` alone (`tsa:<host>#<tip_seq>`) is not enough to fetch the
 * stored receipt — it carries the TSA host and the tip's chain-relative
 * sequence number, not its primary key. Real verification therefore takes
 * the `tip_id` (the store's primary key, as returned by createTip()/
 * insertTip()) so the actual persisted `tsr` (base64 DER, see
 * store.js updateTipReceipt()) and `tip_chain_hash` can be loaded and
 * checked with tsrVerify.js's verifyTimestampReceipt() — the same four
 * checks as the collector's tsrVerifier.cjs twin (parses, imprint_matches,
 * cms_signature_valid, signer_chains_to_ca).
 *
 * Structural-only checking on a bare sink_ref string previously stood in
 * for "verified" — this replaces that with a genuine cryptographic result.
 *
 * @param {string} tipId - ward_tips.tip_id whose receipt should be verified
 * @returns {Promise<{valid: boolean, checks: object, errors: string[]}>}
 */
async function verify(tipId) {
  if (!tipId || typeof tipId !== 'string') {
    return { valid: false, checks: {}, errors: ['tipId is required'] };
  }

  // Lazy import to avoid a hard dependency cycle for callers that only need publish().
  const { getTipById } = await import('../store.js');
  const { verifyTimestampReceipt } = await import('../tsrVerify.js');

  const tip = getTipById(tipId);
  if (!tip) {
    return { valid: false, checks: {}, errors: [`Tip not found: ${tipId}`] };
  }
  if (!tip.tsr) {
    return { valid: false, checks: {}, errors: [`No TSA receipt (tsr) stored for tip ${tipId}`] };
  }
  if (!tip.tip_chain_hash) {
    return { valid: false, checks: {}, errors: [`Tip ${tipId} has no tip_chain_hash`] };
  }

  return verifyTimestampReceipt({
    tsrBase64OrDer: tip.tsr,
    expectedHashHex: tip.tip_chain_hash,
    hashAlgorithm: 'sha256',
  });
}

export { publish, verify, requestTimestamp };
export const type = 'tsa';
