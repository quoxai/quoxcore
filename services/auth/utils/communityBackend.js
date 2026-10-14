/**
 * SEC-PLUGIN-TRUST P5: may a COMMUNITY plugin install run its backend?
 *
 * Option A (400739b37) kept every non-official backend off until the plugin
 * trust work landed. With C1 (scoped qplg_ credential), H2, M4, H3 (per-plugin
 * network + egress fence) and signature v2 live, a community backend may start
 * when ALL of these hold for the stored install:
 *   1. the manifest's backend image is pinned by digest (image@sha256:<64 hex>),
 *      so the bytes that run are the bytes the author signed for, not whatever a
 *      mutable tag points at on pull day;
 *   2. neither the bundle digest nor the signer key is revoked in the org;
 *   3. the signature is v2 (binds manifest + files) and verifies, recomputed from
 *      the STORED manifest and bytes, against a key this org trusts.
 * v1 (0.2.0) signatures bind the bundle only, so they never qualify: the backend
 * image lives in the manifest. Every failure, including a malformed row, is a
 * refusal with a reason. Pure apart from db reads; no network.
 */
import { FORMAT_V2, sha256Hex } from './pluginSignatureV2.js';
import { verifyPluginSignature, installRevocation } from './plugins.js';

export const DIGEST_PINNED_IMAGE = /^[a-z0-9][a-z0-9._\-/:]*@sha256:[0-9a-f]{64}$/;

const no = (reason) => ({ eligible: false, reason });

/** @returns {{eligible:true} | {eligible:false, reason:string}} */
export function communityBackendEligibility(db, row) {
    try {
        if (!row || !row.org_id) return no('install_missing');
        let manifest;
        try { manifest = JSON.parse(row.manifest_json); } catch { return no('manifest_unreadable'); }
        const image = manifest && manifest.backend && manifest.backend.image;
        if (typeof image !== 'string' || !image) return no('no_backend');
        if (!DIGEST_PINNED_IMAGE.test(image)) return no('image_not_digest_pinned');

        if (installRevocation(db, row.org_id, row).revoked) return no('revoked');

        let signature = null;
        try { signature = row.signature_json ? JSON.parse(row.signature_json) : null; } catch { signature = null; }
        if (!signature || typeof signature !== 'object' || signature.format !== FORMAT_V2) return no('signature_v2_required');

        const cssSha256 = row.css_blob ? sha256Hex(row.css_blob) : null;
        const v = verifyPluginSignature(db, row.org_id, { bundleSha256: row.bundle_sha256, cssSha256, manifest, signature });
        if (!v.valid) return no(v.reason || 'signature_invalid');
        if (v.binding !== 'v2') return no('signature_v2_required');
        return { eligible: true };
    } catch {
        return no('eligibility_check_failed');
    }
}
