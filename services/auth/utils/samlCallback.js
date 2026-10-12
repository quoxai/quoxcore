/**
 * ET-2B Phase B — SAML ACS orchestrator.
 *
 * Verifies a posted SAML Response via the injected samlImpl (in prod,
 * a per-provider @node-saml/node-saml SAML instance; in tests a stub
 * with a canned profile), maps profile attributes to internal claims,
 * then reuses the ET-2 Phase B provisioning helpers so OIDC and SAML
 * converge on the same user + membership + session shape.
 */

import { provisionSsoUser, upsertSsoSession } from './ssoProvisioning.js';
import { extractProfileGroups, resolveGroupRole, ROLE_RANK } from './samlGroupMapping.js';

// Pull a value out of a possibly-multi-valued SAML attribute. node-saml
// flattens single values to the string directly, multi-valued to an
// array. We normalise both forms to a single string.
function readAttr(profile, key) {
    if (!key) return null;
    const v = profile?.[key];
    if (v == null) return null;
    if (Array.isArray(v)) return v[0] ?? null;
    return String(v);
}

/**
 * Map a SAML profile (raw from node-saml) to the same claim shape that
 * the OIDC callback produces, so provisionSsoUser can be reused.
 */
export function mapProfileToClaims(attributeMap = {}, profile = {}) {
    const map = attributeMap && typeof attributeMap === 'object' ? attributeMap : {};

    const emailAttr = map.email;
    const email = (emailAttr && readAttr(profile, emailAttr)) || profile.nameID || null;
    if (!email || !String(email).includes('@')) {
        throw new Error('SAML profile has no usable email (missing mapped attribute AND nameID)');
    }

    const given  = map.firstName ? readAttr(profile, map.firstName) : null;
    const family = map.lastName  ? readAttr(profile, map.lastName)  : null;
    const name   = [given, family].filter(Boolean).join(' ').trim() || null;

    return {
        sub:            profile.nameID || String(email).toLowerCase(),
        email:          String(email).toLowerCase(),
        email_verified: true,                   // SAML IdP has already attested the identity
        name,
        saml_session_index: profile.sessionIndex || null,
    };
}

function safeRedirect(target) {
    if (typeof target !== 'string' || !target) return '/';
    // Only allow same-origin path redirects. Reject protocol-relative
    // (`//evil`) and absolute URLs to prevent open-redirect via
    // RelayState.
    if (!target.startsWith('/') || target.startsWith('//')) return '/';
    return target;
}

export async function handleSamlCallback({
    db,
    providerId,
    samlResponse,
    relayState,
    samlImpl,       // { validatePostResponse({ SAMLResponse }) → { profile, loggedOut } }
}) {
    if (!providerId)   throw new Error('providerId required');
    if (!samlResponse) throw new Error('samlResponse required');
    if (!samlImpl)     throw new Error('samlImpl required');

    const providerRow = db.prepare(`
        SELECT id, org_id, protocol, provider_key, enabled,
               entity_id, sso_url, x509_cert, attribute_map_json, group_role_map_json
        FROM sso_providers WHERE id = ?
    `).get(providerId);
    if (!providerRow)               throw new Error('provider not found');
    if (providerRow.protocol !== 'saml') throw new Error('provider is not SAML');
    if (!providerRow.enabled)       throw new Error('provider disabled');

    let validated;
    try {
        validated = await samlImpl.validatePostResponse({ SAMLResponse: samlResponse });
    } catch (err) {
        // Surface the underlying signature/schema error to the caller
        // unchanged — the route layer returns a 400 with this message.
        throw new Error(String(err?.message || err));
    }
    if (validated?.loggedOut) {
        throw new Error('received SAML LogoutResponse at ACS — ignoring (loggedOut=true)');
    }

    let attributeMap = {};
    try { attributeMap = JSON.parse(providerRow.attribute_map_json || '{}'); } catch { /* noop */ }
    const claims = mapProfileToClaims(attributeMap, validated?.profile || {});

    const { userId } = provisionSsoUser(db, {
        providerId,
        orgId:  providerRow.org_id,
        claims: {
            sub:            claims.sub,
            email:          claims.email,
            email_verified: true,
            name:           claims.name,
        },
    });

    upsertSsoSession(db, {
        providerId,
        userId,
        subject: claims.sub,
        email:   claims.email,
    });

    // ET-2B Phase C — group → role mapping. Applies ONLY if the
    // provider row has a non-empty group_role_map AND the profile
    // actually carried group claims. Never downgrades an owner.
    let groupRoleMap = {};
    try { groupRoleMap = JSON.parse(providerRow.group_role_map_json || '{}'); } catch { /* noop */ }
    const profileGroups = extractProfileGroups(attributeMap, validated?.profile || {});
    const mappedRole    = resolveGroupRole(groupRoleMap, profileGroups);
    if (mappedRole) {
        const existing = db.prepare(
            `SELECT role FROM org_memberships WHERE org_id = ? AND user_id = ?`,
        ).get(providerRow.org_id, userId);
        if (existing && existing.role !== 'owner') {
            const currentRank = ROLE_RANK[existing.role] ?? -1;
            const nextRank    = ROLE_RANK[mappedRole]    ?? -1;
            if (nextRank > currentRank) {
                db.prepare(`
                    UPDATE org_memberships SET role = ?, updated_at = datetime('now')
                    WHERE org_id = ? AND user_id = ?
                `).run(mappedRole, providerRow.org_id, userId);
            }
        }
    }

    return {
        userId,
        orgId:      providerRow.org_id,
        email:      claims.email,
        redirectTo: safeRedirect(relayState),
    };
}
