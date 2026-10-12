/**
 * AUDIT-REAL #3: Real RFC 3161 timestamp receipt (TSR) verification.
 *
 * Replaces the structural-only checks previously done in
 * src/lib/volt/volt-timestamp.js (base64 + first-byte 0x30) and
 * services/ward/lib/sinks/tsa.js verify() (sink_ref prefix string check)
 * with genuine cryptographic verification via pkijs + asn1js:
 *
 *   1. `parses`               — the TSR is a well-formed ASN.1
 *                                TimeStampResp whose TSTInfo can be
 *                                extracted (version/policy/messageImprint/
 *                                serialNumber/genTime — the five mandatory
 *                                leading fields per RFC 3161 §2.4.2, always
 *                                present in that order regardless of which
 *                                optional fields (accuracy/nonce/tsa/
 *                                extensions) the TSA chose to include).
 *   2. `imprint_matches`      — TSTInfo.messageImprint.hashedMessage equals
 *                                the caller-supplied expectedHashHex for the
 *                                given hashAlgorithm.
 *   3. `cms_signature_valid`  — the CMS SignedData signature over the
 *                                encapsulated TSTInfo bytes verifies against
 *                                the embedded signing certificate.
 *   4. `signer_chains_to_ca`  — that signing certificate chains to a
 *                                supplied trust anchor (defaults to the
 *                                vendored FreeTSA root at
 *                                config/tsa/freetsa-cacert.crt, override via
 *                                TSA_CA_CERT_PATH).
 *
 * Every check is reported independently — `valid` is only true when ALL
 * four pass. No single boolean stands in for the whole receipt.
 *
 * Implementation note on pkijs + eContentType=id-ct-TSTInfo:
 * pkijs's own `SignedData.verify()` has a TSTInfo-specific branch that
 * re-derives the message imprint from a caller-supplied *original
 * pre-image* (`data`) — i.e. it expects the exact bytes that were hashed
 * to produce the TSR, which this system never retains (only the hash is
 * known/persisted). We already verify the imprint ourselves directly
 * against `expectedHashHex` (check #2 above), so for check #3 we
 * temporarily present the encapsulated content as generic CMS "data"
 * (`SignedData.ID_DATA`) to route through pkijs's standard, well-tested
 * CMS signature verification path (digest signed-attrs, verify signature
 * bytes against the embedded certificate) instead of the TSTInfo-specific
 * branch. This does not change which bytes are hashed/verified — content
 * type only selects which internal pkijs branch runs.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pkijs = require('pkijs');
const asn1js = require('asn1js');

const DEFAULT_CA_PATH = path.join(__dirname, '..', 'config', 'tsa', 'freetsa-cacert.crt');

// RFC 3161 message imprint hash algorithm OIDs we know how to check.
const HASH_ALG_OIDS = {
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  sha1: '1.3.14.3.2.26',
};

/**
 * Parse one or more PEM certificates into pkijs.Certificate instances.
 * @param {string} pem
 * @returns {import('pkijs').Certificate[]}
 */
function parseCertsFromPem(pem) {
  const certs = [];
  const re = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/g;
  let m;
  while ((m = re.exec(pem)) !== null) {
    const b64 = m[1].replace(/[^A-Za-z0-9+/=]/g, '');
    const der = Buffer.from(b64, 'base64');
    const asn1 = asn1js.fromBER(new Uint8Array(der).buffer);
    if (asn1.offset === -1) continue;
    certs.push(new pkijs.Certificate({ schema: asn1.result }));
  }
  return certs;
}

/**
 * Load the trust-anchor CA certs. Defaults to the vendored FreeTSA root;
 * override with TSA_CA_CERT_PATH (path to a PEM file, may contain multiple
 * certificates concatenated).
 * @param {string} [caCertsPem] - PEM string, if the caller already has it in memory
 * @returns {import('pkijs').Certificate[]}
 */
function loadTrustedCerts(caCertsPem) {
  if (caCertsPem) return parseCertsFromPem(caCertsPem);
  const caPath = process.env.TSA_CA_CERT_PATH || DEFAULT_CA_PATH;
  const pem = fs.readFileSync(caPath, 'utf8');
  return parseCertsFromPem(pem);
}

/**
 * Coerce input (base64 string or raw DER Buffer/Uint8Array) to a Buffer of DER bytes.
 */
function toDerBuffer(tsrBase64OrDer) {
  if (Buffer.isBuffer(tsrBase64OrDer)) return tsrBase64OrDer;
  if (tsrBase64OrDer instanceof Uint8Array) return Buffer.from(tsrBase64OrDer);
  if (typeof tsrBase64OrDer === 'string') return Buffer.from(tsrBase64OrDer, 'base64');
  throw new Error('tsrBase64OrDer must be a base64 string, Buffer, or Uint8Array');
}

/**
 * Manually extract the fixed-position mandatory leading fields of a
 * TSTInfo structure (RFC 3161 §2.4.2):
 *   TSTInfo ::= SEQUENCE {
 *     version        INTEGER,                    -- [0]
 *     policy         TSAPolicyId,                 -- [1]
 *     messageImprint MessageImprint,               -- [2]
 *     serialNumber   INTEGER,                      -- [3]
 *     genTime        GeneralizedTime,               -- [4]
 *     accuracy       Accuracy OPTIONAL,
 *     ordering       BOOLEAN DEFAULT FALSE,
 *     nonce          INTEGER OPTIONAL,
 *     tsa            [0] GeneralName OPTIONAL,
 *     extensions     [1] IMPLICIT Extensions OPTIONAL }
 *
 * We deliberately avoid pkijs's `TSTInfo` class here — its schema-based
 * `fromSchema()` throws on some real-world TSA responses (observed against
 * a live FreeTSA fixture) whose optional fields are a subset that trips
 * pkijs's strict positional schema matcher. The first five fields are
 * always present in this fixed order regardless of TSA vendor, so indexed
 * extraction is robust.
 */
function extractTstInfoFields(tstInfoDer) {
  const asn1 = asn1js.fromBER(tstInfoDer);
  if (asn1.offset === -1) throw new Error('TSTInfo is not valid ASN.1 (parse offset -1)');

  const seq = asn1.result;
  const kids = seq.valueBlock && seq.valueBlock.value;
  if (!Array.isArray(kids) || kids.length < 5) {
    throw new Error(`TSTInfo sequence has ${kids ? kids.length : 0} elements, expected >= 5`);
  }

  const messageImprintSeq = kids[2];
  const miKids = messageImprintSeq.valueBlock && messageImprintSeq.valueBlock.value;
  if (!Array.isArray(miKids) || miKids.length < 2) {
    throw new Error('TSTInfo.messageImprint is malformed');
  }

  const hashAlgSeq = miKids[0];
  const hashOid = hashAlgSeq.valueBlock.value[0].valueBlock.toString();
  const hashedMessageNode = miKids[1];
  const imprintHex = Buffer.from(hashedMessageNode.valueBlock.valueHexView).toString('hex');

  const genTimeNode = kids[4];
  const genTime = typeof genTimeNode.toDate === 'function' ? genTimeNode.toDate() : null;

  return { hashOid, imprintHex, genTime };
}

/**
 * Verify an RFC 3161 timestamp receipt against an expected hash.
 *
 * @param {object} opts
 * @param {string|Buffer} opts.tsrBase64OrDer - the TSR, base64-encoded or raw DER bytes
 * @param {string} opts.expectedHashHex - the hex-encoded hash that should have been timestamped
 * @param {string} [opts.hashAlgorithm='sha256'] - hash algorithm the expected hash was computed with
 * @param {string} [opts.caCertsPem] - PEM (may contain multiple certs); defaults to the vendored FreeTSA CA
 * @returns {{
 *   valid: boolean,
 *   checks: { parses: boolean, imprint_matches: boolean, cms_signature_valid: boolean, signer_chains_to_ca: boolean, genTime: string|null },
 *   errors: string[]
 * }}
 */
async function verifyTimestampReceipt({ tsrBase64OrDer, expectedHashHex, hashAlgorithm = 'sha256', caCertsPem } = {}) {
  const checks = {
    parses: false,
    imprint_matches: false,
    cms_signature_valid: false,
    signer_chains_to_ca: false,
    genTime: null,
  };
  const errors = [];

  if (!tsrBase64OrDer) {
    errors.push('tsrBase64OrDer is required');
    return { valid: false, checks, errors };
  }
  if (!expectedHashHex || typeof expectedHashHex !== 'string') {
    errors.push('expectedHashHex is required');
    return { valid: false, checks, errors };
  }

  let derBuf, asn1, tsResp, signedData, tstInfoBuf, fields;
  try {
    derBuf = toDerBuffer(tsrBase64OrDer);
    asn1 = asn1js.fromBER(new Uint8Array(derBuf).buffer);
    if (asn1.offset === -1) throw new Error('DER parse failed (offset -1) — truncated or corrupt TSR');

    tsResp = new pkijs.TimeStampResp({ schema: asn1.result });

    const status = tsResp.status && tsResp.status.status;
    // PKIStatus: 0 = granted, 1 = grantedWithMods
    if (status !== 0 && status !== 1) {
      throw new Error(`TSA response status not granted (status=${status})`);
    }
    if (!tsResp.timeStampToken) {
      throw new Error('TSA response has no timeStampToken');
    }

    signedData = new pkijs.SignedData({ schema: tsResp.timeStampToken.content });

    const eContent = signedData.encapContentInfo.eContent;
    if (!eContent) throw new Error('SignedData.encapContentInfo has no eContent (detached TSTInfo unsupported)');

    const raw = eContent.valueBlock.valueHexView;
    tstInfoBuf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);

    fields = extractTstInfoFields(tstInfoBuf);
    checks.genTime = fields.genTime ? fields.genTime.toISOString() : null;
    checks.parses = true;
  } catch (err) {
    errors.push(`parses: ${err.message}`);
    return { valid: false, checks, errors };
  }

  // Check 2: message imprint
  const expectedOid = HASH_ALG_OIDS[hashAlgorithm.toLowerCase()];
  if (!expectedOid) {
    errors.push(`imprint_matches: unsupported hashAlgorithm "${hashAlgorithm}"`);
  } else if (fields.hashOid !== expectedOid) {
    errors.push(`imprint_matches: TSR uses hash algorithm OID ${fields.hashOid}, expected ${expectedOid} (${hashAlgorithm})`);
  } else if (fields.imprintHex.toLowerCase() !== expectedHashHex.toLowerCase()) {
    errors.push(`imprint_matches: TSR message imprint ${fields.imprintHex} does not match expected hash ${expectedHashHex}`);
  } else {
    checks.imprint_matches = true;
  }

  // Check 3: CMS signature validity (spoof content type — see module doc comment)
  try {
    const realEContentType = signedData.encapContentInfo.eContentType;
    signedData.encapContentInfo.eContentType = pkijs.SignedData.ID_DATA;
    const sigResult = await signedData.verify({ signer: 0, checkChain: false, extendedMode: true });
    signedData.encapContentInfo.eContentType = realEContentType;
    checks.cms_signature_valid = sigResult.signatureVerified === true;
    if (!checks.cms_signature_valid) {
      errors.push(`cms_signature_valid: ${sigResult.message || 'signature did not verify'}`);
    }
  } catch (err) {
    errors.push(`cms_signature_valid: ${err.message}`);
  }

  // Check 4: signer certificate chains to trust anchor
  try {
    const trustedCerts = loadTrustedCerts(caCertsPem);
    if (trustedCerts.length === 0) throw new Error('no trusted CA certificates loaded');
    const realEContentType = signedData.encapContentInfo.eContentType;
    signedData.encapContentInfo.eContentType = pkijs.SignedData.ID_DATA;
    const chainResult = await signedData.verify({ signer: 0, checkChain: true, trustedCerts, extendedMode: true });
    signedData.encapContentInfo.eContentType = realEContentType;
    checks.signer_chains_to_ca = chainResult.signerCertificateVerified === true;
    if (!checks.signer_chains_to_ca) {
      errors.push(`signer_chains_to_ca: ${chainResult.message || 'certificate chain did not validate'}`);
    }
  } catch (err) {
    errors.push(`signer_chains_to_ca: ${err.message}`);
  }

  const valid = checks.parses && checks.imprint_matches && checks.cms_signature_valid && checks.signer_chains_to_ca;
  return { valid, checks, errors };
}

module.exports = { verifyTimestampReceipt, parseCertsFromPem, loadTrustedCerts, DEFAULT_CA_PATH };
