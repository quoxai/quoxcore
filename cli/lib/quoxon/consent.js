/**
 * QUOXON-CONSENT: AI data sharing consent, in words a stuck user can act on.
 * Consent is PERSONAL (one record per user, POST /api/consent), so the person typing grants it; no admin is
 * involved. Cloud providers that receive the conversation need it; a local model (Ollama) never does.
 * This file only words things and shapes the two API calls. The gate itself is the server's.
 */
export const PRIVACY_PATH = '/settings#privacy';
const LABELS = { openai: 'OpenAI', perplexity: 'Perplexity', gemini: 'Google Gemini', google: 'Google', openrouter: 'OpenRouter', huggingface: 'Hugging Face', groq: 'Groq', together: 'Together AI', openai_compatible: 'your custom hosted endpoint' };
export const providerLabel = (p) => LABELS[String(p || '').toLowerCase()] || (p ? String(p) : 'your cloud AI provider');

// Keep in step with services/collector/lib/consentVerification.js THIRD_PARTY_PROVIDERS. Anthropic and local models are not in it.
export const CONSENT_PROVIDERS = ['openai', 'perplexity', 'gemini', 'google', 'openrouter', 'huggingface', 'groq', 'together', 'openai_compatible'];
export const needsConsent = (type) => CONSENT_PROVIDERS.includes(String(type || '').toLowerCase());

export const isConsentError = (ev) => ev?.type === 'error' && ev?.error === 'ai_consent_required';

/** The one-line headline for the error block (the card's first line). */
export function consentErrorText(ev) {
  if (ev?.retryable) return 'Quox could not check your AI data sharing consent just now, so nothing was sent. Try again in a moment.';
  return `Quox needs your OK before sending this conversation to ${providerLabel(ev?.provider)}.`;
}

/** The lines under the headline: what is shared, how to grant it, the local alternative, the dashboard link. Short lines, no clipping. */
export function consentHintLines(ev, dashboardBase) {
  if (ev?.retryable) return [];
  const who = providerLabel(ev?.provider);
  const prov = ev?.provider || '<provider>';
  const why = ev?.reason === 'consent_expired' ? 'Your earlier OK is out of date and needs renewing.'
    : ev?.reason === 'provider_blocked' ? `You have blocked ${who} in your privacy settings; granting turns it back on.` : null;
  const lines = [];
  if (why) lines.push(why);
  lines.push(`Shared: your messages and any tool results go to ${who}, a third party. Nothing was sent.`);
  lines.push('Grant it: /consent grant (records your OK and sends this message again), or quox consent grant --provider ' + prov + ' in a shell.');
  lines.push('Consent is personal, so you can give it yourself; no admin is needed.');
  if (dashboardBase) lines.push(`Or in the dashboard: ${String(dashboardBase).replace(/\/$/, '')}${ev?.grant?.dashboard_path || PRIVACY_PATH}`);
  lines.push('No cloud at all: a local model (Ollama) needs no consent. /connect ollama');
  return lines;
}

/** GET /api/consent record -> { granted, providers: { name: bool } }. */
export function consentState(rec) {
  const providers = rec?.provider_consent && typeof rec.provider_consent === 'object' ? rec.provider_consent : {};
  return { granted: Boolean(rec?.ai_data_sharing_consent), providers };
}

/** Is `provider` allowed to receive data under this record? Mirrors the server: overall consent on, provider not set false. */
export const consentCovers = (rec, provider) => {
  const s = consentState(rec);
  return s.granted && s.providers[String(provider || '').toLowerCase()] !== false;
};

export function consentStatusLines(rec, { provider = null } = {}) {
  const s = consentState(rec);
  const names = Object.entries(s.providers).map(([k, v]) => `${k} ${v ? 'yes' : 'blocked'}`);
  const lines = [[s.granted ? '✔ AI data sharing: you have given your OK.' : '· AI data sharing: not given yet, so nothing is sent to a cloud AI.', s.granted ? 'ok' : 'warn']];
  if (names.length) lines.push([`Per provider: ${names.join(', ')}.`]);
  if (!s.granted) lines.push([`/consent grant${provider ? ` ${provider}` : ''} gives it. Your messages and tool results then go to the cloud AI you chose. A local model (Ollama) never needs it.`]);
  return lines;
}

/** The body for POST /api/consent: keeps every other provider's setting (the server replaces the map wholesale). */
export function grantBody(rec, provider) {
  const keep = consentState(rec).providers;
  const p = String(provider || '').toLowerCase();
  return { ai_data_sharing_consent: true, provider_consent: { ...keep, ...(p ? { [p]: true } : {}) } };
}

/** What to say after /connect saves a hosted key and consent is not yet in place. */
export function connectConsentNote(providerId) {
  return `One more step before it can answer: ${providerLabel(providerId)} receives your messages, so Quox needs your OK. /consent grant ${providerId}`;
}
