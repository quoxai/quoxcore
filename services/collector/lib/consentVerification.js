const THIRD_PARTY_PROVIDERS = ['openai', 'perplexity', 'gemini', 'google'];

function requiresThirdPartyConsent(provider) {
  return THIRD_PARTY_PROVIDERS.includes(String(provider || '').toLowerCase());
}

function buildConsentVerificationRequest({
  authServiceUrl,
  userId,
  orgId,
  provider,
  endpoint = 'chat',
  accessToken,
  serviceKey,
}) {
  const baseUrl = authServiceUrl || 'http://localhost:3101';
  const headers = { 'Content-Type': 'application/json' };
  const body = {
    user_id: userId,
    provider,
    endpoint,
  };

  if (orgId) {
    body.org_id = orgId;
  }

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
    return {
      url: `${baseUrl}/api/consent/verify`,
      headers,
      body,
      authMode: 'user_access_token',
    };
  }

  if (serviceKey) {
    headers['X-Service-Key'] = serviceKey;
    return {
      url: `${baseUrl}/api/internal/consent/verify`,
      headers,
      body,
      authMode: 'internal_service_key',
    };
  }

  return {
    url: null,
    headers,
    body,
    authMode: 'missing_auth_metadata',
  };
}

module.exports = {
  THIRD_PARTY_PROVIDERS,
  requiresThirdPartyConsent,
  buildConsentVerificationRequest,
};
