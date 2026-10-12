/**
 * Gemini CLI Tool Executor
 *
 * Wraps Google's `gemini` CLI (v0.26+) for review-and-synthesis tasks.
 * Invokes the CLI in non-interactive mode with JSON output.
 *
 * Domain: code review, large-context analysis, content generation, sanity checks.
 * NOT for image generation (that's ImagesQ) or web research (that's PERPLEXITY).
 *
 * CLI pattern:
 *   gemini -p "prompt" --output-format json -m <model> 2>/dev/null
 *
 * JSON output shape:
 *   { response: string, stats: { models, tokens, tools, files }, error?: string }
 */

const { execFile: _execFile } = require('child_process');
const { getProviderKeys: _getProviderKeys } = require('../providerKeys');
const configResolver = require('../configResolver.js');

// Mutable reference for testing — tests can replace via _setGetProviderKeys().
// (vitest's module runner does not intercept nested CJS require() calls
// transitively in this repo's CJS/ESM hybrid setup — see test/dbQuery.test.js
// for the same rationale — so vi.mock('../providerKeys') would silently no-op
// here; this injection hook is the proven pattern instead, matching
// _setExecFile below.)
let _getProviderKeysFn = _getProviderKeys;

// Configurable
const GEMINI_CLI_PATH = process.env.GEMINI_CLI_PATH || 'gemini';
// VAULT-INTEG P17: was a bare process.env read — now resolved per-call via
// getGeminiDefaultModel() below (org-scoped when the caller forwards
// ctx.orgId). Kept here only as the ultimate fallback default.
const GEMINI_DEFAULT_MODEL_FALLBACK = 'gemini-2.5-pro';
// Kept for back-compat (no other consumer references this today, but this
// module doesn't own the removal of an exported constant) — a module-load
// snapshot, no longer what execGemini() actually uses for its timeout.
const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_CLI_TIMEOUT || '120000', 10); // 2 min default
const GEMINI_DEFAULT_TIMEOUT_MS = 120000; // 2 min default — matches platformCapabilities.js GEMINI_CLI_TIMEOUT's registry default
const GEMINI_MAX_PROMPT_LENGTH = 100000; // 100K chars — CLI handles up to 1M tokens

// VAULT-INTEG P13 slice 2: was a bare process.env read frozen at module
// load (GEMINI_TIMEOUT_MS above) — now resolved through
// configResolver.getInstanceSetting() (platformCapabilities.js
// GEMINI_CLI_TIMEOUT), called fresh on every execGemini() call, so a
// stored/env override applies to the very next tool call, no restart
// needed.
function getGeminiTimeoutMs() {
  const parsed = parseInt(configResolver.getInstanceSetting('GEMINI_CLI_TIMEOUT').value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : GEMINI_DEFAULT_TIMEOUT_MS;
}

// VAULT-INTEG P17: was a bare process.env read frozen at module load
// (GEMINI_DEFAULT_MODEL) — now resolved through configResolver.getSetting()
// (platformCapabilities.js GEMINI_CLI_MODEL), called fresh on every
// execGemini() call, org-scoped when the caller (geminiReview/geminiAnalyze/
// geminiGenerate) forwards ctx.orgId; falls back to the instance-wide
// resolution otherwise.
function getGeminiDefaultModel(orgId) {
  return configResolver.getSetting(orgId || null, 'GEMINI_CLI_MODEL').value || GEMINI_DEFAULT_MODEL_FALLBACK;
}

// Mutable reference for testing — tests can replace via _setExecFile()
let _execFn = _execFile;

/**
 * Execute a prompt via Gemini CLI and return parsed result.
 * @param {string} prompt - The prompt text
 * @param {Object} options - { model, sandbox, timeout }
 * @returns {Promise<{ success: boolean, response?: string, stats?: Object, error?: string }>}
 */
async function execGemini(prompt, options = {}) {
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { success: false, error: 'Prompt is required and must be a non-empty string.' };
  }

  if (prompt.length > GEMINI_MAX_PROMPT_LENGTH) {
    return { success: false, error: `Prompt exceeds maximum length (${GEMINI_MAX_PROMPT_LENGTH} chars).` };
  }

  const model = options.model || getGeminiDefaultModel(options.orgId);
  const timeout = options.timeout || getGeminiTimeoutMs();
  // `--sandbox` spins up a NESTED docker/podman sandbox. The collector runs the
  // CLI inside its own already-isolated container, which has no nested runtime,
  // so hardcoding it fails every call ("failed to determine command for
  // sandbox", proven live 2026-08-08). It is therefore opt-in via
  // GEMINI_CLI_SANDBOX=1 for hosts that do provide a runtime; default off,
  // because the collector container is itself the isolation boundary.
  const sandbox = process.env.GEMINI_CLI_SANDBOX === '1';

  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '-m', model,
  ];

  // Sandbox mode prevents file system writes and tool execution
  if (sandbox) {
    args.push('--sandbox');
  }

  return new Promise((resolve) => {
    _execFn(GEMINI_CLI_PATH, args, {
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB output buffer
      // Suppress color codes; inject a resolved vault/env API key into the
      // child process env when the caller resolved one (see
      // resolveGeminiApiKey below) — never rely on process.env alone.
      env: { ...process.env, NO_COLOR: '1', ...(options.apiKey ? { GEMINI_API_KEY: options.apiKey } : {}) },
    }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed || error.code === 'ETIMEDOUT') {
          resolve({ success: false, error: `Gemini CLI timed out after ${timeout}ms.` });
          return;
        }
        // CLI may exit non-zero but still have valid JSON output
        if (stdout && stdout.trim()) {
          try {
            const parsed = JSON.parse(stdout.trim());
            if (parsed.error) {
              resolve({ success: false, error: parsed.error, stats: parsed.stats || null });
            } else {
              resolve({ success: true, response: parsed.response || '', stats: parsed.stats || null });
            }
            return;
          } catch (_) {
            // Fall through to error handling
          }
        }
        resolve({
          success: false,
          error: error.message || 'Gemini CLI execution failed.',
          stderr: stderr ? stderr.substring(0, 500) : undefined
        });
        return;
      }

      if (!stdout || !stdout.trim()) {
        resolve({ success: false, error: 'Gemini CLI returned empty output.' });
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.error) {
          resolve({ success: false, error: parsed.error, stats: parsed.stats || null });
        } else {
          resolve({
            success: true,
            response: parsed.response || '',
            stats: parsed.stats || null,
            model_used: model
          });
        }
      } catch (_) {
        // Non-JSON output — return raw text as response
        resolve({
          success: true,
          response: stdout.trim().substring(0, 50000),
          model_used: model,
          note: 'Raw text output (non-JSON)'
        });
      }
    });
  });
}

/**
 * Resolve the Gemini API key for a tool call, in priority order:
 *   1. Already resolved by the dispatch hook (ctx._geminiApiKey — VAULT-P5.H)
 *   2. Org vault key via getProviderKeys(orgId), same resolver the proven
 *      Gemini chat path uses (server.js gemini chat handler).
 *   3. process.env.GEMINI_API_KEY (legacy/instance fallback only — never
 *      the sole source, per the no-env-only-config rule).
 * @param {Object} ctx - { orgId, _geminiApiKey }
 * @returns {Promise<string|null>}
 */
async function resolveGeminiApiKey(ctx = {}) {
  if (ctx && ctx._geminiApiKey) return ctx._geminiApiKey;
  const orgId = ctx?.orgId || null;
  if (orgId) {
    try {
      const keys = await _getProviderKeysFn(orgId);
      if (keys?.gemini_api_key) return keys.gemini_api_key;
    } catch (e) { /* fall through to env */ }
  }
  return process.env.GEMINI_API_KEY || null;
}

/**
 * Review code or configuration for issues, improvements, and best practices.
 * @param {Object} input - { code, language, context, focus }
 * @param {Object} ctx - { orgId, _geminiApiKey } — dispatch context for vault key resolution
 * @returns {Promise<Object>}
 */
async function geminiReview(input, ctx = {}) {
  const { code, language, context, focus } = input;

  if (!code || typeof code !== 'string') {
    return { success: false, error: 'code parameter is required.' };
  }

  const apiKey = await resolveGeminiApiKey(ctx);
  if (!apiKey) {
    return { success: false, error: 'Google Gemini API key not configured. Add it in Settings → Core Integrations.', tool: 'gemini_review' };
  }

  const focusAreas = focus || 'bugs, security, performance, readability';
  const langHint = language ? ` (${language})` : '';
  const contextHint = context ? `\n\nContext: ${context}` : '';

  const prompt = `You are an expert code reviewer. Review the following code${langHint} for: ${focusAreas}.${contextHint}

Provide a structured review with:
1. **Critical Issues** — bugs, security vulnerabilities, crashes
2. **Improvements** — performance, readability, maintainability
3. **Good Practices** — things done well (brief)
4. **Summary** — overall assessment (1-2 sentences)

Be specific: reference line numbers or code patterns, not generic advice.

\`\`\`${language || ''}
${code}
\`\`\``;

  const result = await execGemini(prompt, { apiKey, orgId: ctx.orgId });
  return { ...result, tool: 'gemini_review', language, focus: focusAreas };
}

/**
 * Analyze content with Gemini's large context window (logs, docs, configs).
 * @param {Object} input - { content, question, format }
 * @param {Object} ctx - { orgId, _geminiApiKey } — dispatch context for vault key resolution
 * @returns {Promise<Object>}
 */
async function geminiAnalyze(input, ctx = {}) {
  const { content, question, format } = input;

  if (!content || typeof content !== 'string') {
    return { success: false, error: 'content parameter is required.' };
  }
  if (!question || typeof question !== 'string') {
    return { success: false, error: 'question parameter is required.' };
  }

  const apiKey = await resolveGeminiApiKey(ctx);
  if (!apiKey) {
    return { success: false, error: 'Google Gemini API key not configured. Add it in Settings → Core Integrations.', tool: 'gemini_analyze' };
  }

  const formatHint = format ? `\n\nRespond in ${format} format.` : '';

  const prompt = `Analyze the following content and answer the question.

Question: ${question}${formatHint}

Content:
${content}`;

  const result = await execGemini(prompt, { apiKey, orgId: ctx.orgId });
  return { ...result, tool: 'gemini_analyze' };
}

/**
 * Generate content (docs, emails, summaries, reports) using Gemini.
 * @param {Object} input - { task, context, tone, format, length }
 * @param {Object} ctx - { orgId, _geminiApiKey } — dispatch context for vault key resolution
 * @returns {Promise<Object>}
 */
async function geminiGenerate(input, ctx = {}) {
  const { task, context, tone, format, length } = input;

  if (!task || typeof task !== 'string') {
    return { success: false, error: 'task parameter is required.' };
  }

  const apiKey = await resolveGeminiApiKey(ctx);
  if (!apiKey) {
    return { success: false, error: 'Google Gemini API key not configured. Add it in Settings → Core Integrations.', tool: 'gemini_generate' };
  }

  const parts = [`Task: ${task}`];
  if (context) parts.push(`Context: ${context}`);
  if (tone) parts.push(`Tone: ${tone}`);
  if (format) parts.push(`Format: ${format}`);
  if (length) parts.push(`Length: ${length}`);

  const prompt = parts.join('\n\n');

  const result = await execGemini(prompt, { apiKey, orgId: ctx.orgId });
  return { ...result, tool: 'gemini_generate' };
}

module.exports = {
  execGemini,
  geminiReview,
  geminiAnalyze,
  geminiGenerate,
  resolveGeminiApiKey,
  GEMINI_CLI_PATH,
  GEMINI_DEFAULT_MODEL: GEMINI_DEFAULT_MODEL_FALLBACK,
  GEMINI_TIMEOUT_MS,
  getGeminiTimeoutMs,
  getGeminiDefaultModel,
  GEMINI_MAX_PROMPT_LENGTH,
  // Test helper — allows tests to inject a mock execFile
  _setExecFile: (fn) => { _execFn = fn; },
  _resetExecFile: () => { _execFn = _execFile; },
  // Test helper — allows tests to inject a mock getProviderKeys (see note above)
  _setGetProviderKeys: (fn) => { _getProviderKeysFn = fn; },
  _resetGetProviderKeys: () => { _getProviderKeysFn = _getProviderKeys; },
};
