'use strict';
/**
 * preLLMGate — QUOXTRUST FND_01M3S9XRKK (T2 fail-closed) — the pre-LLM governance gate
 * (L1 identity / injection / PII / L3 policy) wrapped so a THROW fails CLOSED.
 *
 * /chat/resolve-plan previously ran this gate inside a try/catch that only logged
 * "(fail-open)" and proceeded to plan resolution when the gate threw — bypassing the
 * injection/PII/policy screen. Its sibling chat entry points (/chat/stream, the unified
 * provider path) do NOT swallow the throw. This helper makes the fail-closed behavior a
 * single testable unit the buggy site now uses.
 *
 * Behaviour (deliberately minimal — fixes ONLY the confirmed throw path):
 *   - gate denies (preflight.proceed === false) → refuse with its status/body;
 *   - gate THROWS (dependency error) → FAIL CLOSED: refuse 503 governance_unavailable;
 *   - setup not ok → proceed with no aoclCtx (PRESERVED from the original resolve-plan
 *     behaviour; the !setup.ok path is a separate, smaller inconsistency vs /chat/stream,
 *     not changed here to avoid an unverified regression);
 *   - otherwise → proceed with the aoclCtx.
 *
 * Deps are injected (setupPipelinePhase, runPreLLMPipeline) so this is unit-testable
 * without booting server.js.
 *
 * @returns {Promise<{proceed:boolean, aoclCtx?:any, refusal?:{status:number, body:object}}>}
 */
async function preLLMGate({ voltDb, req, source, deps }) {
    const { setupPipelinePhase, runPreLLMPipeline } = deps || {};
    try {
        const setup = setupPipelinePhase(req, { source });
        if (!setup || !setup.ok) {
            // Preserve original resolve-plan behaviour: no gate context, proceed.
            return { proceed: true, aoclCtx: null };
        }
        const preflight = await runPreLLMPipeline(voltDb, setup.aoclCtx);
        if (!preflight || !preflight.proceed) {
            return {
                proceed: false,
                refusal: {
                    status: (preflight && preflight.httpStatus) || 403,
                    body: {
                        error: preflight && preflight.errorCode,
                        message: preflight && preflight.errorMessage,
                        deniedByLayer: preflight && preflight.deniedAtLayer,
                        matchedPolicies: preflight && preflight.matchedPolicies,
                    },
                },
            };
        }
        return { proceed: true, aoclCtx: setup.aoclCtx };
    } catch (gateErr) {
        // QUOXTRUST T2 — FAIL CLOSED. A pre-LLM screen that throws must not let the
        // request proceed unscreened (the sibling chat paths already fail closed here).
        console.error('[preLLMGate] pre-LLM gate error — failing closed (was fail-open):', gateErr && gateErr.message);
        return {
            proceed: false,
            refusal: {
                status: 503,
                body: {
                    error: 'governance_unavailable',
                    message: 'Pre-LLM governance gate could not be evaluated; request refused (fail-closed).',
                },
            },
        };
    }
}

module.exports = { preLLMGate };
