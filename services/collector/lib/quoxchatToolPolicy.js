/**
 * QCX-6j — Per-widget tool-policy evaluator (deny-list MVP).
 *
 * Pure function called by /message before each tool invocation. Plan
 * extends this to geofencing, time-windows, $-threshold approval, and
 * full WARD policy scoping; the call-site contract is stable so those
 * extensions plug in without touching the loop body.
 *
 * QCL-SECURITY P1-5 (the email-flood fix) extends the `toolCall` shape with
 * optional fields the caller (quoxchatToolExecutors.executeTool) computes
 * per invocation. All new fields are optional and additive — a bare
 * `{ name }` (the original 2-field shape every existing caller/test uses)
 * behaves exactly as before:
 *
 *   toolCall.side_effecting   — bool. Tool kinds classified as side-effecting
 *                                (webhook, rest_api with a write method, any
 *                                email/send/pay builtin) default-DENY unless
 *                                explicitly allow-listed via
 *                                `policy.side_effect_allow_list` (array of
 *                                tool names). Non-side-effecting tools are
 *                                unaffected (existing deny-list-only
 *                                behaviour).
 *   toolCall.verified          — bool. When a side-effecting tool call comes
 *                                from a visitor QCL-IDENTITY has NOT verified,
 *                                it's denied unless the widget policy sets
 *                                `allow_unverified_side_effects: true`.
 *   toolCall.daily_cap /
 *   toolCall.daily_count       — numbers. Hard per-(widget, day) volume cap
 *                                on side-effecting tool calls, independent of
 *                                session/conversation (the counter lives in
 *                                quoxchatDailyCapStore, keyed by widget only
 *                                — the caller passes the current count in).
 *   toolCall.recipient_policy /
 *   toolCall.recipient /
 *   toolCall.identified_email  — when `recipient_policy === 'self_only'`, the
 *                                resolved recipient must exactly match the
 *                                visitor's own verified/captured email — a
 *                                visitor-supplied recipient is never trusted.
 *
 * CAPTCHA / bot-detection action gate (task #127) — OFF BY DEFAULT.
 * `policy.bot_protection = { enabled: bool, guard: 'side_effecting'|'all' }`
 * (the public-safe subset of embed_config_json.bot_protection the caller
 * threads in as widget.tool_policies.bot_protection). When absent or
 * `enabled !== true` this is a complete no-op — zero behaviour change on
 * every widget that hasn't configured it. When enabled:
 *   guard: 'side_effecting' (default) — gates the same set of tool calls
 *          the P1-5(a) side-effecting allow-list gates.
 *   guard: 'all'            — gates every tool call, side-effecting or not.
 * Either way, the gate requires `toolCall.human_verified === true` (set by
 * the caller after a server-side captchaVerifier.verifyCaptchaToken() call
 * on this message). This is independent of — and composes with, never
 * replaces — the P1-5(d) `verified` (visitor identity) gate below.
 *   toolCall.human_verified    — bool. Result of the current message's
 *                                CAPTCHA verification, when bot_protection
 *                                is enabled for this widget. undefined
 *                                (verification not run / not applicable)
 *                                is treated as not-verified.
 */

'use strict';

function evaluateToolPolicy(policy, toolCall) {
  if (!toolCall || typeof toolCall !== 'object' || typeof toolCall.name !== 'string') {
    return { allow: true };
  }

  const denyList = Array.isArray(policy?.tool_deny_list) ? policy.tool_deny_list : [];
  for (const denied of denyList) {
    if (typeof denied === 'string' && denied === toolCall.name) {
      return { allow: false, reason: `tool ${denied} blocked by widget policy` };
    }
  }

  // CAPTCHA #127 — OFF BY DEFAULT: only evaluated when the widget has
  // explicitly opted in via embed_config_json.bot_protection.enabled.
  if (policy?.bot_protection?.enabled === true) {
    const guard = policy.bot_protection.guard === 'all' ? 'all' : 'side_effecting';
    const applies = guard === 'all' || (guard === 'side_effecting' && toolCall.side_effecting === true);
    if (applies && toolCall.human_verified !== true) {
      return { allow: false, reason: `${toolCall.name} requires human verification (bot-protection check failed or was not performed)` };
    }
  }

  if (toolCall.side_effecting) {
    const allowList = Array.isArray(policy?.side_effect_allow_list) ? policy.side_effect_allow_list : [];
    if (!allowList.includes(toolCall.name)) {
      return {
        allow: false,
        reason: `${toolCall.name} is a side-effecting tool and is not allow-listed by widget policy (default-deny)`,
      };
    }

    // QUOXCHAT-EMAIL D1 — self_guarded exemption, verified-identity gate ONLY.
    // A builtin whose executor implements its own recipient-trust model
    // (email_transcript: identify-sourced recipient, or captcha-passed
    // chat-sourced recipient) is strictly better protected than this blanket
    // gate allows for, and the blanket gate is what kept the marketed
    // transcript action dead for every organic (verified=0) visitor.
    // self_guarded is hardcoded at the executor call site keyed on
    // builtin_kind — it is never read from widget config, so an admin (or a
    // prompt-injected LLM) cannot mint exemptions. Every other gate in this
    // block still applies to self_guarded calls.
    if (toolCall.self_guarded !== true && !toolCall.verified && policy?.allow_unverified_side_effects !== true) {
      // QCX-ACTIONS P3 — signup nudge. The denial reason is what the LLM
      // sees and relays, so a widget can replace the neutral default with
      // an invitation to sign in ("Sign in at /login to manage your
      // servers from chat"). Config-only text, capped, never from the
      // visitor or the model.
      const nudge = typeof policy?.unverified_message === 'string' && policy.unverified_message.trim()
        ? policy.unverified_message.trim().slice(0, 500)
        : null;
      return { allow: false, reason: nudge || `${toolCall.name} requires a verified visitor identity` };
    }

    if (
      Number.isFinite(toolCall.daily_cap) && toolCall.daily_cap > 0 &&
      Number.isFinite(toolCall.daily_count) && toolCall.daily_count >= toolCall.daily_cap
    ) {
      return { allow: false, reason: `${toolCall.name} exceeded the widget's daily side-effect cap (${toolCall.daily_cap})` };
    }

    if (toolCall.recipient_policy === 'self_only') {
      const resolved = typeof toolCall.recipient === 'string' ? toolCall.recipient.trim().toLowerCase() : '';
      const self = typeof toolCall.identified_email === 'string' ? toolCall.identified_email.trim().toLowerCase() : '';
      if (!resolved || !self || resolved !== self) {
        return { allow: false, reason: `${toolCall.name} recipient must be the visitor's own verified email (self_only policy)` };
      }
    }
  }

  return { allow: true };
}

module.exports = { evaluateToolPolicy };
