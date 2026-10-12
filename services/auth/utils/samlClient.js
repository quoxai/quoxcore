/**
 * ET-2B Phase B — thin factory over @node-saml/node-saml.
 *
 * Keeps the node-saml API out of routes/utils so tests inject a
 * lighter stub. In prod the factory builds a per-provider SAML
 * instance from the registry row; every other module just sees
 * { validatePostResponse, getAuthorizeUrl }.
 */

import { SAML } from '@node-saml/node-saml';

export function createSamlClientFromProvider(providerRow, { spEntityId, acsUrl, sloUrl = null }) {
    if (!providerRow) throw new Error('providerRow required');
    if (providerRow.protocol !== 'saml') throw new Error('provider is not SAML');
    if (!providerRow.x509_cert) throw new Error('provider has no x509_cert');

    const saml = new SAML({
        // SP identity
        issuer:      spEntityId,
        callbackUrl: acsUrl,
        logoutCallbackUrl: sloUrl || undefined,
        // IdP identity
        idpIssuer:   providerRow.entity_id,
        entryPoint:  providerRow.sso_url,
        logoutUrl:   providerRow.slo_url || undefined,
        idpCert:     providerRow.x509_cert,
        identifierFormat: providerRow.nameid_format
            || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        // Disable request signing by default — most IdPs don't require it;
        // re-enable per-provider in a follow-up if a customer needs it.
        signatureAlgorithm: 'sha256',
        acceptedClockSkewMs: 5000,
        wantAssertionsSigned: true,
        wantAuthnResponseSigned: true,
    });

    return {
        async getAuthorizeUrl(relayState) {
            return new Promise((resolve, reject) => {
                saml.getAuthorizeUrl(
                    { RelayState: relayState || '/' },
                    (err, url) => err ? reject(err) : resolve(url),
                );
            });
        },
        async validatePostResponse({ SAMLResponse }) {
            return new Promise((resolve, reject) => {
                saml.validatePostResponse(
                    { SAMLResponse },
                    (err, profile, loggedOut) => err ? reject(err) : resolve({ profile, loggedOut }),
                );
            });
        },
        generateServiceProviderMetadata(signingCert = null) {
            return saml.generateServiceProviderMetadata(null, signingCert);
        },
    };
}
