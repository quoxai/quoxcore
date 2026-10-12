'use strict';

/**
 * Which key answered a widget message. 'org' = resolved from the org's vault or
 * setup store (providerKeys); 'instance_env' = the host's environment fallback
 * (or the instance Claude key store); 'widget_endpoint' = the widget's own
 * OpenAI-compatible endpoint. The copy says "your key, your costs": operators
 * need to see when that is not what happened.
 */
function resolveKeySource({ provider, providerKeys, useCompat }) {
  if (useCompat) return 'widget_endpoint';
  const field = `${provider}_api_key`;
  return providerKeys && providerKeys[field] ? 'org' : 'instance_env';
}

module.exports = { resolveKeySource };
