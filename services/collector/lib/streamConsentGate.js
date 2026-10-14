'use strict';
/**
 * Same AI-consent enforcement POST /chat applies (verifyAIConsent, Security
 * Issue #72) for the /chat/stream provider branches. Fail closed. A caller with
 * no user subject (service key) is skipped, exactly as handleOpenAIChat does.
 */
const PROVIDER_LABELS = { openai: 'OpenAI', perplexity: 'Perplexity', gemini: 'Google Gemini', google: 'Google', openrouter: 'OpenRouter', huggingface: 'Hugging Face', groq: 'Groq', together: 'Together AI', openai_compatible: 'your custom hosted endpoint' };

/**
 * What a stuck user needs: which provider receives what, who can grant it (consent is per person, the user
 * themselves, via POST /api/consent), and the exact commands. Words only; the gate decision is unchanged.
 */
function consentGuidance(provider, reason, retryable) {
  const key = String(provider || '').toLowerCase();
  const label = PROVIDER_LABELS[key] || key || 'a third-party AI provider';
  if (retryable) {
    return { message: 'Quox could not check your AI data sharing consent just now, so nothing was sent. Try again in a moment.' };
  }
  const why = reason === 'consent_expired' ? 'Your AI data sharing consent is out of date and needs renewing.'
    : reason === 'provider_blocked' ? `You have blocked ${label} in your privacy settings.` : 'Quox needs your OK first.';
  return {
    message: `${why} This conversation (your messages and any tool results) would be sent to ${label}, a third party. Nothing was sent. Grant it yourself: run "quox consent grant --provider ${key || '<provider>'}" or /consent grant here, or open Settings > Privacy in the dashboard. Consent is personal, so no admin is needed. A local model (Ollama) needs no cloud consent: /connect ollama.`,
    grant: { who: 'you', cli: `quox consent grant --provider ${key || '<provider>'}`, slash: '/consent grant', dashboard_path: '/settings#privacy' },
  };
}

async function checkStreamConsent({ provider, userId, orgId, accessToken }, { verifyAIConsent }) {
  if (!userId) return { ok: true };
  let consent;
  try {
    consent = await verifyAIConsent(userId, provider, { orgId, accessToken, endpoint: 'chat_stream' });
  } catch {
    consent = { consented: false, reason: 'verification_unavailable' };
  }
  if (consent && consent.consented) return { ok: true };
  const reason = (consent && consent.reason) || 'no_consent';
  const retryable = reason === 'verification_unavailable' || reason === 'verification_failed';
  return { ok: false, event: { type: 'error', error: 'ai_consent_required', retryable, reason, provider: String(provider || '').toLowerCase(), ...consentGuidance(provider, reason, retryable) } };
}
module.exports = { checkStreamConsent };
