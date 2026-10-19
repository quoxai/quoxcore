/**
 * Gemini Image Executor
 *
 * Inline executor for gemini_image entity tools.
 * Calls Google's Gemini API for image generation, editing, and analysis.
 *
 * Supported tool IDs:
 *   - gemini_image.generate  → text-to-image
 *   - gemini_image.edit      → image editing with instructions
 *   - gemini_image.describe  → image analysis (vision)
 *   - gemini_image.models    → list available models
 */

const MODEL_MAP = {
  flash: 'gemini-2.5-flash-image'
};

const MODEL_INFO = [
  {
    id: 'flash',
    model: MODEL_MAP.flash,
    name: 'Gemini Flash (Nano Banana 2)',
    description: 'Fast image generation with good quality. Supports text-to-image and image editing.',
    supports: ['generate', 'edit'],
    pricing: 'Standard Gemini Flash pricing'
  }
];

const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '1:8', '4:1', '8:1'];

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const { buildInternalServiceHeaders } = require('./internalServiceHeaders.js');
const { credentialUnavailableResult } = require('./providerKeys.js');

/**
 * Resolve model alias to full model ID.
 */
function resolveModel(alias) {
  return MODEL_MAP[alias] || MODEL_MAP.flash;
}

const AUTH_BASE_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`;

/**
 * Resolve Gemini API key via QuoxVault waterfall: vault → env var.
 *
 * @param {object} ctx - Execution context with orgId
 * @returns {Promise<{key: string, vaultCheckedNoDefault: boolean}>}
 *   `vaultCheckedNoDefault` is true only when the vault resolver was actually
 *   reached, answered 2xx, and reported no key for gemini — i.e. we KNOW this
 *   org has no *default* gemini credential. Fleet #397: /api/setup/internal/resolve
 *   only ever returns the DEFAULT credential for a provider (see
 *   resolveProviderKey() in services/auth/services/credentialResolver.js,
 *   which calls getDefaultCredential() and nothing else) — it has no way to
 *   tell "zero credentials of this type" apart from "credential(s) exist,
 *   none marked default". We don't invent that distinction here either; we
 *   only track the one thing the response DOES tell us (no default key),
 *   so the caller can give an honest, narrower message instead of blindly
 *   telling a user with a non-default key that nothing was ever added.
 */
async function resolveApiKey(ctx) {
  // Try vault first if we have an org context
  let vaultUnavailable = false;
  if (ctx?.orgId) {
    try {
      const resp = await fetch(`${AUTH_BASE_URL}/api/setup/internal/resolve`, {
        method: 'POST',
        headers: buildInternalServiceHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ org_id: ctx.orgId, providers: ['gemini'] }),
        signal: AbortSignal.timeout(5000)
      });
      if (resp.ok) {
        const data = await resp.json();
        // Vault response shape: { providers: { gemini: { key, source } } }.
        // Note: the normalised helper getProviderKeys() in server.js maps this
        // to gemini_api_key downstream — only this raw-vault path uses .key.
        const key = data?.providers?.gemini?.key;
        if (key) return { key, vaultCheckedNoDefault: false };
        // Vault reachable, answered normally, but no default gemini key.
        return { key: process.env.GEMINI_API_KEY || '', vaultCheckedNoDefault: !process.env.GEMINI_API_KEY };
      }
      vaultUnavailable = true; // non-2xx: the credential service did not give an answer
    } catch (err) {
      // Vault unavailable (timeout/network) — fall through to env var, but
      // remember it so a missing key is reported as unavailable, not absent.
      vaultUnavailable = true;
    }
  }

  // Fallback to environment variable
  const envKey = process.env.GEMINI_API_KEY || '';
  return { key: envKey, vaultCheckedNoDefault: false, vaultUnavailable: !envKey && vaultUnavailable };
}

/**
 * Get the Gemini API key from environment (sync fallback for tests).
 */
function getApiKey() {
  return process.env.GEMINI_API_KEY || '';
}

/**
 * Build the "no API key" error, naming the actual remedy when we know one.
 * Fleet #397: "not configured" is only true when there's genuinely no
 * credential anywhere. When the vault resolver was reached and reported no
 * *default* gemini credential, the more likely case for a user who just ran
 * `vault create` is a non-default credential — point them at `vault
 * set-default` as well, since we cannot tell which case it is from here.
 */
function buildMissingKeyError(vaultCheckedNoDefault) {
  if (vaultCheckedNoDefault) {
    return 'Gemini API key not configured: no default Gemini credential is set for this organization. '
      + 'If you already added one with "quox vault create --type gemini", it may just not be the default — '
      + 'run "quox vault set-default <credential_id>" (see "quox vault list --type gemini" for the ID) or set it '
      + 'as default from Settings → Core Integrations. Otherwise, add a Gemini credential in Settings → Core '
      + 'Integrations or set GEMINI_API_KEY.';
  }
  return 'Gemini API key not configured. Add it in Settings → Core Integrations or set GEMINI_API_KEY.';
}

/**
 * Build the Gemini API URL for a given model and action.
 */
function buildApiUrl(model, apiKey) {
  return `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`;
}

/**
 * Execute a generate (text-to-image) request.
 */
async function executeGenerate(input) {
  const apiKey = input._resolvedApiKey || getApiKey();
  if (!apiKey) {
    return { success: false, error: buildMissingKeyError(input._vaultCheckedNoDefault) };
  }

  const { prompt, model, aspect_ratio, person_generation, temperature, number_of_images } = input;

  if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
    return { success: false, error: 'prompt is required and must be a non-empty string' };
  }

  if (model && !MODEL_MAP[model]) {
    return { success: false, error: `Invalid model: ${model}. Valid options: ${Object.keys(MODEL_MAP).join(', ')}` };
  }

  if (aspect_ratio && !VALID_ASPECT_RATIOS.includes(aspect_ratio)) {
    return { success: false, error: `Invalid aspect_ratio: ${aspect_ratio}. Valid options: ${VALID_ASPECT_RATIOS.join(', ')}` };
  }

  const modelId = resolveModel(model);
  const url = buildApiUrl(modelId, apiKey);

  const generationConfig = {
    responseModalities: ['TEXT', 'IMAGE']
  };

  if (temperature !== undefined) {
    generationConfig.temperature = temperature;
  }

  // Pass aspect ratio to Gemini API via imageConfig (controls output dimensions)
  if (aspect_ratio) {
    generationConfig.imageConfig = { aspectRatio: aspect_ratio };
  }

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig
  };

  // Safety settings for person generation
  if (person_generation === 'ALLOW_ADULT') {
    body.safetySettings = [
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' }
    ];
  }

  // Generate multiple images by making parallel requests
  const count = Math.min(Math.max(number_of_images || 1, 1), 4);

  try {
    const requests = Array.from({ length: count }, () =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000)
      })
    );

    const responses = await Promise.all(requests);
    const images = [];

    for (const resp of responses) {
      if (!resp.ok) {
        const errorText = await resp.text();
        let errorMsg = `Gemini API ${resp.status}`;
        try {
          const errorJson = JSON.parse(errorText);
          errorMsg = errorJson.error?.message || errorMsg;
        } catch { errorMsg = `${errorMsg}: ${errorText.substring(0, 200)}`; }

        if (resp.status === 401) return { success: false, error: `Authentication failed: ${errorMsg}. Check your GEMINI_API_KEY.` };
        if (resp.status === 429) return { success: false, error: `Rate limit exceeded: ${errorMsg}. Try again later.` };
        if (resp.status === 400) return { success: false, error: `Bad request: ${errorMsg}` };
        return { success: false, error: errorMsg };
      }

      const data = await resp.json();
      const extracted = extractImages(data);
      images.push(...extracted);
    }

    if (images.length === 0) {
      // Check if content was blocked
      const firstResp = responses[0];
      if (firstResp.ok) {
        return { success: false, error: 'No images generated. The content may have been blocked by safety filters. Try a different prompt.' };
      }
      return { success: false, error: 'No images generated. Check the prompt and try again.' };
    }

    return {
      success: true,
      images,
      model_used: modelId,
      prompt_used: prompt,
      count: images.length
    };
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return { success: false, error: 'Request timed out after 60 seconds. Try a simpler prompt or smaller image size.' };
    }
    return { success: false, error: `Gemini API error: ${err.message}` };
  }
}

/**
 * Execute an edit (image + text → new image) request.
 */
async function executeEdit(input) {
  const apiKey = input._resolvedApiKey || getApiKey();
  if (!apiKey) {
    return { success: false, error: buildMissingKeyError(input._vaultCheckedNoDefault) };
  }

  const { prompt, image_base64, image_url, model, aspect_ratio } = input;

  if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
    return { success: false, error: 'prompt is required for editing' };
  }

  if (!image_base64 && !image_url) {
    return { success: false, error: 'Either image_base64 or image_url is required for editing' };
  }

  if (model && !MODEL_MAP[model]) {
    return { success: false, error: `Invalid model: ${model}. Valid options: ${Object.keys(MODEL_MAP).join(', ')}` };
  }

  if (aspect_ratio && !VALID_ASPECT_RATIOS.includes(aspect_ratio)) {
    return { success: false, error: `Invalid aspect_ratio: ${aspect_ratio}. Valid options: ${VALID_ASPECT_RATIOS.join(', ')}` };
  }

  // Build image part
  let imagePart;
  if (image_base64) {
    imagePart = {
      inlineData: {
        mimeType: 'image/png',
        data: image_base64
      }
    };
  } else {
    // Fetch the image from URL and convert to base64
    try {
      const imgResp = await fetch(image_url, { signal: AbortSignal.timeout(15000) });
      if (!imgResp.ok) {
        return { success: false, error: `Failed to fetch image from URL: ${imgResp.status}` };
      }
      const imgBuffer = await imgResp.arrayBuffer();
      const contentType = imgResp.headers.get('content-type') || 'image/png';
      imagePart = {
        inlineData: {
          mimeType: contentType,
          data: Buffer.from(imgBuffer).toString('base64')
        }
      };
    } catch (err) {
      return { success: false, error: `Failed to fetch image: ${err.message}` };
    }
  }

  const modelId = resolveModel(model);
  const url = buildApiUrl(modelId, apiKey);

  const editGenerationConfig = {
    responseModalities: ['TEXT', 'IMAGE']
  };

  if (aspect_ratio) {
    editGenerationConfig.imageConfig = { aspectRatio: aspect_ratio };
  }

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        imagePart
      ]
    }],
    generationConfig: editGenerationConfig
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000)
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      let errorMsg = `Gemini API ${resp.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMsg = errorJson.error?.message || errorMsg;
      } catch { errorMsg = `${errorMsg}: ${errorText.substring(0, 200)}`; }

      if (resp.status === 401) return { success: false, error: `Authentication failed: ${errorMsg}` };
      if (resp.status === 429) return { success: false, error: `Rate limit exceeded: ${errorMsg}` };
      return { success: false, error: errorMsg };
    }

    const data = await resp.json();
    const images = extractImages(data);

    if (images.length === 0) {
      return { success: false, error: 'No edited image returned. The content may have been blocked by safety filters.' };
    }

    return {
      success: true,
      images,
      model_used: modelId,
      prompt_used: prompt,
      count: images.length
    };
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return { success: false, error: 'Edit request timed out after 60 seconds.' };
    }
    return { success: false, error: `Gemini API error: ${err.message}` };
  }
}

// SDK-TEAM finding (ev_mvf2e9jj_f38d98, 2026-10-19): Google refused a describe (402, credits depleted) and the answer
// still offered "a guess from general knowledge" of what the picture shows. A describe that did not read the image
// says so, and tells the model how to answer.
const DESCRIBE_NOT_READ_RULE = 'The image was not read. Say plainly that it could not be read and why (the error above), '
  + 'and offer to retry later or use another provider. Never describe, guess or infer what the image shows: not from the '
  + 'URL, the filename or general knowledge, not even labelled as a guess.';

/**
 * Execute a describe (vision) request. Any failure carries image_read:false and the answer rule.
 */
async function executeDescribe(input) {
  const r = await describeImage(input);
  return r && r.success === false ? { ...r, image_read: false, answer_rule: DESCRIBE_NOT_READ_RULE } : r;
}

async function describeImage(input) {
  const apiKey = input._resolvedApiKey || getApiKey();
  if (!apiKey) {
    return { success: false, error: buildMissingKeyError(input._vaultCheckedNoDefault) };
  }

  const { image_base64, image_url, prompt } = input;

  if (!image_base64 && !image_url) {
    return { success: false, error: 'Either image_base64 or image_url is required' };
  }

  // Build image part
  let imagePart;
  if (image_base64) {
    imagePart = {
      inlineData: {
        mimeType: 'image/png',
        data: image_base64
      }
    };
  } else {
    try {
      const imgResp = await fetch(image_url, { signal: AbortSignal.timeout(15000) });
      if (!imgResp.ok) {
        return { success: false, error: `Failed to fetch image from URL: ${imgResp.status}` };
      }
      const imgBuffer = await imgResp.arrayBuffer();
      const contentType = imgResp.headers.get('content-type') || 'image/png';
      imagePart = {
        inlineData: {
          mimeType: contentType,
          data: Buffer.from(imgBuffer).toString('base64')
        }
      };
    } catch (err) {
      return { success: false, error: `Failed to fetch image: ${err.message}` };
    }
  }

  const describePrompt = prompt || 'Describe this image in detail.';

  // Use flash for vision (fast + cheap). quox#1122: gemini-2.0-flash was retired by Google
  // ("no longer available"), which failed every describe.
  const modelId = 'gemini-2.5-flash';
  const url = buildApiUrl(modelId, apiKey);

  const body = {
    contents: [{
      parts: [
        { text: describePrompt },
        imagePart
      ]
    }]
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      let errorMsg = `Gemini API ${resp.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMsg = errorJson.error?.message || errorMsg;
      } catch { errorMsg = `${errorMsg}: ${errorText.substring(0, 200)}`; }
      return { success: false, error: errorMsg };
    }

    const data = await resp.json();
    const textParts = [];

    for (const candidate of data.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        if (part.text) textParts.push(part.text);
      }
    }

    return {
      success: true,
      description: textParts.join('\n') || 'No description generated.',
      model_used: modelId
    };
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return { success: false, error: 'Vision request timed out after 30 seconds.' };
    }
    return { success: false, error: `Gemini API error: ${err.message}` };
  }
}

/**
 * List available models and their capabilities.
 */
async function executeModels() {
  return {
    success: true,
    models: MODEL_INFO,
    note: 'Use the model "id" value (flash or pro) in the model parameter.'
  };
}

/**
 * Extract image data from Gemini API response.
 * Returns array of { base64, mime_type }.
 */
function extractImages(data) {
  const images = [];

  for (const candidate of data.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (part.inlineData && part.inlineData.data) {
        images.push({
          base64: part.inlineData.data,
          mime_type: part.inlineData.mimeType || 'image/png'
        });
      }
    }
  }

  return images;
}

/**
 * Main executor — routes to the appropriate handler based on tool ID.
 * Resolves the API key from vault (via ctx.orgId) before executing.
 */
async function execute(toolId, input, ctx) {
  // Resolve API key from vault before executing image tools
  if (toolId !== 'gemini_image.models') {
    const { key, vaultCheckedNoDefault, vaultUnavailable } = await resolveApiKey(ctx);
    if (!key && vaultUnavailable) {
      return credentialUnavailableResult('Gemini');
    }
    if (key) {
      // Inject the resolved key so handlers use it. A successful resolution
      // still hands handlers a plain string — they do `input._resolvedApiKey
      // || getApiKey()` and expect a string, not an object.
      input = { ...input, _resolvedApiKey: key };
    } else if (vaultCheckedNoDefault) {
      // No key, but we know why: vault was reached and has no default
      // gemini credential for this org. Let the handler give the narrower,
      // honest error instead of a blanket "not configured".
      input = { ...input, _vaultCheckedNoDefault: true };
    }
  }

  switch (toolId) {
    case 'gemini_image.generate':
      return executeGenerate(input);
    case 'gemini_image.edit':
      return executeEdit(input);
    case 'gemini_image.describe':
      return executeDescribe(input);
    case 'gemini_image.models':
      return executeModels();
    default:
      return { success: false, error: `Unknown tool: ${toolId}` };
  }
}

module.exports = {
  execute,
  executeGenerate,
  executeEdit,
  executeDescribe,
  executeModels,
  extractImages,
  resolveModel,
  buildApiUrl,
  MODEL_MAP,
  MODEL_INFO,
  VALID_ASPECT_RATIOS,
  GEMINI_API_BASE
};
