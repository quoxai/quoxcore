/**
 * BRAIN2-W11: OpenAI embedding model selection (BRAIN_EMBED_MODEL instance
 * setting, platformCapabilities.js). Dimensions stay 768 for both models
 * (3-large is truncated via the API `dimensions` param) so the schema and the
 * qdrant collection are unchanged. The stamp distinguishes the spaces: 3-small
 * keeps its legacy stamp so existing vectors stay valid; 3-large is stamped
 * 'text-embedding-3-large@768'.
 */
const configResolver = require('./configResolver.js');

const OPENAI_EMBED_MODELS = ['text-embedding-3-small', 'text-embedding-3-large'];
const DEFAULT_OPENAI_EMBED_MODEL = 'text-embedding-3-large';
const EMBED_DIMENSIONS = 768;

/** requested: explicit per-call model (bare name or stamp); else the setting; else default. */
function resolveOpenAIEmbedModel(requested) {
  const bare = typeof requested === 'string' ? requested.split('@')[0] : null;
  if (bare && OPENAI_EMBED_MODELS.includes(bare)) return bare;
  let v = null;
  try { v = configResolver.getInstanceSetting('BRAIN_EMBED_MODEL').value; } catch { v = null; }
  return OPENAI_EMBED_MODELS.includes(v) ? v : DEFAULT_OPENAI_EMBED_MODEL;
}

function openAIEmbedStamp(model, dims = EMBED_DIMENSIONS) {
  return model === 'text-embedding-3-small' ? model : `${model}@${dims}`;
}

module.exports = { OPENAI_EMBED_MODELS, DEFAULT_OPENAI_EMBED_MODEL, resolveOpenAIEmbedModel, openAIEmbedStamp };
