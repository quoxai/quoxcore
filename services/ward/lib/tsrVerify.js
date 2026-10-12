/**
 * AUDIT-REAL #3: Real RFC 3161 timestamp receipt (TSR) verification for WARD.
 *
 * ESM twin of services/collector/lib/tsrVerifier.cjs. The logic is
 * deliberately duplicated rather than imported cross-service: WARD is a
 * standalone ESM package (own package.json/node_modules, also consumed
 * directly by the auth service via lib/wardAdapter.js) and is bind-mounted
 * into the collector container at a different path than its source tree
 * (see docker-compose.yml `./services/ward:/app/ward:ro` vs. the collector
 * root at `/app`), so a relative import from here to the collector's lib/
 * would resolve to different files on host-run tests vs. in-container
 * execution. Keep the two files in sync if the verification algorithm
 * changes — see the collector file's header comment for the full design
 * rationale (why pkijs's TSTInfo-specific `SignedData.verify()` branch is
 * bypassed via a content-type spoof for check #3/#4).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// AUDIT-REAL #3: vendored locally under services/ward/config/tsa/ (a
// duplicate of services/collector/config/tsa/freetsa-cacert.crt) rather
// than referenced cross-service — WARD is bind-mounted into the collector
// container at a different relative path than its source-tree layout (see
// docker-compose.yml), so a "../../collector/..." path would resolve
// correctly on host but not inside the container. Same file, same CA,
// vendored twice deliberately. Keep both in sync if FreeTSA rotates its CA.
const DEFAULT_CA_PATH = join(__dirname, '..', 'config', 'tsa', 'freetsa-cacert.crt');

const HASH_ALG_OIDS = {
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  sha1: '1.3.14.3.2.26',
};

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
 * Load the trust-anchor CA certs. Defaults to the collector's vendored
 * FreeTSA root (same CA used by both requestRFC3161Timestamp() in
 * server.js and services/ward/lib/sinks/tsa.js — both default to
 * https://freetsa.org/tsr). Override with TSA_CA_CERT_PATH.
 */
function loadTrustedCerts(caCertsPem) {
  if (caCertsPem) return parseCertsFromPem(caCertsPem);
  const caPath = process.env.TSA_CA_CERT_PATH || DEFAULT_CA_PATH;
  const pem = readFileSync(caPath, 'utf8');
  return parseCertsFromPem(pem);
}

function toDerBuffer(tsrBase64OrDer) {
  if (Buffer.isBuffer(tsrBase64OrDer)) return tsrBase64OrDer;
  if (tsrBase64OrDer instanceof Uint8Array) return Buffer.from(tsrBase64OrDer);
  if (typeof tsrBase64OrDer === 'string') return Buffer.from(tsrBase64OrDer, 'base64');
  throw new Error('tsrBase64OrDer must be a base64 string, Buffer, or Uint8Array');
}

/**
 * See tsrVerifier.cjs (collector twin) for the full rationale — pkijs's own
 * TSTInfo class throws on some real-world TSA responses, so we extract the
 * five mandatory leading fields (version/policy/messageImprint/
 * serialNumber/genTime) by fixed position instead.
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
 * See tsrVerifier.cjs for full JSDoc — identical contract.
 */
export async function verifyTimestampReceipt({ tsrBase64OrDer, expectedHashHex, hashAlgorithm = 'sha256', caCertsPem } = {}) {
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

export { parseCertsFromPem, loadTrustedCerts, DEFAULT_CA_PATH };
