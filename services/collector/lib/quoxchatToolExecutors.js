/**
 * QuoxChat Tool Executors — CW-9.2
 *
 * Dispatch registry that executes a tool invocation returned by the LLM.
 * CW-9.2 lands the plumbing with every handler returning `tool_not_wired`.
 * CW-9.3 populates builtins (lead_capture, human_handoff, redirect_url).
 * CW-9.4–9.6 populate connector executors (REST, webhook, database).
 *
 * Contract:
 *   executeTool({ widget, tool, input, context }) → { ok, result?, error? }
 *     widget   : { id, org_id, public_key, ... }
 *     tool     : row from /api/internal/widgets/:id/tools
 *     input    : JSON object (already type-validated by Anthropic against input_schema)
 *     context  : { visitor_id, conversation_id, correlation_id, page_url }
 *
 * The executor never throws. Errors are returned as `{ ok: false, error }` so
 * the LLM receives a tool_result block and can recover gracefully.
 */

// ── CW-9.3: Builtin executors ───────────────────────────────────────────────

function authInternalCall(path, { method = 'POST', body, timeoutMs = 3000 } = {}) {
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) return Promise.reject(new Error('service_key_not_configured'));
  return fetch(`${authUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// ── "Hollywood bullshit" fix (2026-07-24) ───────────────────────────────────
// Data-collection builtins used to hard-refuse (ok:false) when a required
// field (email, message text) was missing, leaving it to the LLM to notice
// the refusal and ask again in prose — which it often skipped, instead
// narrating a warm confirmation with zero data ever captured ("Passed to
// the team." / "our team will confirm by email" with no message and no
// email on file). Now: a missing required field returns `needs_input`
// (still ok:true — the call itself was not an error) describing exactly
// what's missing so the widget can render a real inline form and collect it
// directly, with no LLM narration step in between. The success confirmation
// below is only ever returned once the data genuinely landed server-side.
function _emailValid(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

function _resolveEmail(input, context) {
  const rawInput = typeof input?.email === 'string' ? input.email.trim() : '';
  if (_emailValid(rawInput)) return rawInput;
  const rawContext = typeof context?.identified_email === 'string' ? context.identified_email.trim() : '';
  if (_emailValid(rawContext)) return rawContext;
  return '';
}

function _resolveName(input, context) {
  const rawInput = typeof input?.name === 'string' ? input.name.trim() : '';
  if (rawInput) return rawInput;
  const rawContext = typeof context?.identified_name === 'string' ? context.identified_name.trim() : '';
  return rawContext || '';
}

function _buildNeedsInput({ kind, fields, prefill, message }) {
  const needsInput = { kind, fields, prefill };
  return { ok: true, needs_input: needsInput, message, result: { needs_input: needsInput, message } };
}

const EMAIL_FIELD = { name: 'email', label: 'Your email', type: 'email', required: true, placeholder: 'you@example.com' };
const LEAD_PHONE_FIELD = { name: 'phone', label: 'Or your phone', type: 'tel', required: false, placeholder: '07700 900123' };
const PREFERRED_TIME_FIELD = { name: 'preferred_time', label: 'Preferred time (optional)', type: 'text', required: false, placeholder: 'e.g. Tuesday afternoon' };
const MESSAGE_FIELD = { name: 'message', label: 'Your message', type: 'textarea', required: true, placeholder: 'What would you like to tell the team?' };
const SUBJECT_FIELD = { name: 'subject', label: 'What is the issue about?', type: 'text', required: true, placeholder: 'Short summary of the problem' };
const DESCRIPTION_FIELD = { name: 'description', label: 'Details (optional)', type: 'textarea', required: false, placeholder: 'Anything that helps the team understand the issue' };

// QC-BRUTALOOP-W14b: a callback request with a phone and no email is a real
// lead (garages, trades); refusing it made the visitor type an email they
// had no reason to give.
function _resolvePhone(input) {
  const raw = typeof input?.phone === 'string' ? input.phone.trim() : '';
  return raw.replace(/\D/g, '').length >= 7 ? raw : '';
}

async function leadCapture({ widget, input, context }) {
  const email = _resolveEmail(input, context);
  const phone = _resolvePhone(input);
  if (!email && !phone) {
    return _buildNeedsInput({
      kind: 'lead_capture',
      fields: [{ ...EMAIL_FIELD, required: false }, LEAD_PHONE_FIELD],
      prefill: { name: _resolveName(input, context), email: typeof input?.email === 'string' ? input.email.trim() : '', phone: typeof input?.phone === 'string' ? input.phone.trim() : '' },
      message: "What's the best email or phone number to reach you on?",
    });
  }
  // Pro polish (PRO-1): intent is what the visitor wants (pricing, demo,
  // support, etc.). Stored in metadata_json — no schema migration needed.
  const intent = typeof input?.intent === 'string' ? input.intent.trim().slice(0, 200) : null;
  try {
    const resp = await authInternalCall(`/api/internal/widgets/${encodeURIComponent(widget.id)}/leads`, {
      body: {
        visitor_id: context?.visitor_id || null,
        conversation_id: context?.conversation_id || null,
        name: input.name || null,
        email: email || null,
        phone: phone || null,
        company: input.company || null,
        notes: input.notes || null,
        metadata: { intent, page_url: context?.page_url || null, captured_at: new Date().toISOString() },
      },
    });
    if (!resp.ok) return { ok: false, error: 'persist_failed', reason: 'persist_failed', message: `auth returned ${resp.status}` };
    const data = await resp.json().catch(() => ({}));
    return _leadSuccess(data, intent);
  } catch (err) {
    // QC-BRUTALOOP-W14: a timeout does not mean the row was not written. Read
    // back by (conversation_id + email) before telling the visitor it failed.
    try {
      const q = `${email ? `email=${encodeURIComponent(email)}` : `phone=${encodeURIComponent(phone)}`}&conversation_id=${encodeURIComponent(context?.conversation_id || '')}`;
      const back = await authInternalCall(`/api/internal/widgets/${encodeURIComponent(widget.id)}/leads/lookup?${q}`, { method: 'GET', timeoutMs: 4000 });
      if (back.ok) {
        const found = await back.json().catch(() => ({}));
        if (found?.id) return _leadSuccess({ id: found.id, duplicate: false, notified: true, readback: true }, intent);
      }
    } catch { /* fall through to the honest failure */ }
    return { ok: false, error: 'executor_network', reason: 'executor_network', message: String(err?.message || err).slice(0, 200) };
  }
}

function _leadSuccess(data, intent) {
  const ref = _leadRef(data.id, data.reference);
  const refTxt = ref ? ` (reference ${ref})` : '';
  const message = data.notified === false
    ? `Your details are saved${refTxt} and the team will see them in their records, but I could not alert anyone right away, so a reply may take a little longer.`
    : data.alerts_configured === false
      ? `Thanks, your details are saved${refTxt}. The team will see them on their desk and get in touch when they pick them up.`
      : data.duplicate
        ? `Thanks, we already have your details${refTxt}${Array.isArray(data.merged) && data.merged.length ? ` and I have updated them with what you just gave me (${data.merged.join(', ')})` : ''}, and the team will be in touch.`
        : `Thanks! We've got your details${refTxt} and will be in touch shortly.`;
  return {
    ok: true,
    lead_id: data.id || null,
    result: {
      captured: true,
      lead_id: data.id || null,
      reference: ref,
      duplicate: !!data.duplicate,
      merged: Array.isArray(data.merged) ? data.merged : [],
      intent,
      notified: data.notified !== false,
      message,
    },
  };
}

// Handover summary: the agent authors this in the SAME tool call that fires
// the handoff (no extra LLM round trip). Trimmed and capped here so a
// verbose model never blows out the inbox item / room message / transcript
// note it feeds into downstream.
const HANDOFF_SUMMARY_MAX_LEN = 500;

const EMAIL_IN_TEXT_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
// Wave 8: an address the visitor typed in this or a recent message.
function emailFromVisitorMessages(msgs) {
  for (const m of [...(Array.isArray(msgs) ? msgs : [])].reverse()) {
    const hit = typeof m === 'string' ? m.match(EMAIL_IN_TEXT_RE) : null;
    if (hit) return hit[0];
  }
  return null;
}
// Wave 8: the model must not make up who the visitor is. Names come from
// identified_name only, so a name the summary attaches to the visitor is dropped.
function scrubInventedName(summary, identifiedName) {
  if (!summary) return summary;
  const known = String(identifiedName || '').trim().toLowerCase();
  const NAME = "[A-Z][a-z'-]+(?:\\s+[A-Z][a-z'-]+){0,2}";
  return summary
    .replace(new RegExp(`\\b(?:visitor|customer|client|user)?\\s*name\\s*(?:is|:)\\s*(${NAME})\\.?\\s*`, 'gi'), (m, n) => (known && n.toLowerCase() === known ? m : ''))
    .replace(new RegExp(`\\b(Visitor|Customer|Client|User)\\s+(${NAME})(?=\\s+(?:is|was|has|wants|asked|asks|would|needs|called|enquired|inquired|said)\\b)`, 'g'), (m, role, n) => (known && n.toLowerCase() === known ? m : `The ${role}`))
    .replace(/\s{2,}/g, ' ').trim();
}

async function humanHandoff({ widget, input, context }) {
  if (!context?.conversation_id) {
    // Codex enum 2 #30: never confirm a handoff that has no durable
    // conversation to attach to. No handoff API has run at this point.
    return { ok: false, error: 'no_conversation', message: "I couldn't hand you over to the team just now because your conversation hasn't been saved yet. Please try again in a moment." };
  }
  const rawSummary = typeof input?.summary === 'string' && input.summary.trim()
    ? input.summary.trim().slice(0, HANDOFF_SUMMARY_MAX_LEN)
    : null;
  const summary = scrubInventedName(rawSummary, typeof context?.identified_name === 'string' ? context.identified_name : '') || null;
  const typedEmail = emailFromVisitorMessages(context?.visitorMessages);
  try {
    const resp = await authInternalCall(
      `/api/internal/widgets/${encodeURIComponent(widget.id)}/conversations/${encodeURIComponent(context.conversation_id)}/handoff`,
      {
        body: {
          reason: input?.reason || null,
          priority: input?.priority || 'normal',
          summary,
          // QUOXCHAT-PRO visitor name: identified attrs travel with the
          // handoff so auth can stamp the conversation + personalise the
          // HITL inbox title even when widget_visitors hasn't synced yet.
          visitor_name: (typeof context?.identified_name === 'string' && context.identified_name) || null,
          visitor_email: (typeof context?.identified_email === 'string' && context.identified_email) || typedEmail || null,
        },
        // W15: the handoff endpoint creates the Matrix room and fires alerts, so
        // it routinely takes longer than the 3s default. A timeout here made the
        // card red while the row had in fact been written.
        timeoutMs: 10000,
      }
    );
    if (!resp.ok) return { ok: false, error: 'persist_failed', message: `auth returned ${resp.status}` };
    return buildHandoffSuccess(await resp.json().catch(() => ({})));
  } catch (err) {
    // W15 read-back: a timeout does not mean the handoff was not written.
    try {
      if (context?.visitor_id && widget?.id) {
        const key = process.env.INTERNAL_SERVICE_KEY;
        const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
        const back = key ? await fetch(`${authUrl}/api/internal/widget-conversations/handoff?widget_id=${encodeURIComponent(widget.id)}&visitor_id=${encodeURIComponent(context.visitor_id)}`, {
          headers: { 'x-service-key': key }, signal: AbortSignal.timeout(4000),
        }) : null;
        if (back && back.ok) {
          const found = await back.json().catch(() => ({}));
          if (found?.conversation?.conversation_id === context.conversation_id) return buildHandoffSuccess({});
        }
      }
    } catch { /* fall through to the honest failure */ }
    return { ok: false, error: 'executor_network', message: String(err?.message || err).slice(0, 200) };
  }

  function buildHandoffSuccess(data) {
    // Wave 6 D9: never promise a pickup "shortly" when nobody is online.
    const av = context?.availability;
    const nobodyOnline = !!av && (av.human_available === false || av.operator_online === false);
    const knownEmail = (typeof context?.identified_email === 'string' && context.identified_email) || typedEmail || null;
    // Wave 12: with no alert channel configured nobody is pinged, so never
    // promise email contact; the team sees it on their desk and replies when
    // they pick it up.
    const noAlerts = data.alerts_configured === false;
    // QC-BRUTALOOP-W13: no email reply loop exists for widget conversations, so the
    // desk message promises only "reply here" and that the visitor can come back.
    const deskMsg = "I've passed this to the team. They will see your message on their desk and reply here in this chat when they pick it up. You can leave this page open or come back to it later.";
    const offlineMsg = noAlerts ? `No one is online right now. ${deskMsg}` : `No one is online right now, so I've passed this to the team and ${knownEmail ? `they will get back to you by email at ${knownEmail}` : 'they will get back to you once they are in. Please leave your email address so they can reach you'}.`;
    return {
      ok: true,
      result: {
        handed_off: true,
        notified: data.notified !== false,
        priority: data.priority || 'normal',
        message: data.notified === false
          ? (noAlerts ? `I've saved your request in the team's conversation records. They will see it on their desk and reply here in this chat when they pick it up. You can leave this page open or come back to it later.` : `I've saved your request for a person in the team's conversation records, but I could not alert anyone right away. ${knownEmail ? `They will reply by email at ${knownEmail} when they see it.` : 'Please leave your email address so they can reach you.'}`)
          : nobodyOnline
          ? (summary ? `${offlineMsg} Summary I passed on: ${summary}` : offlineMsg)
          : summary
            ? `Handing you over to a human, one of our team will pick up shortly. I've passed this to the team with a short summary: ${summary}`
            : 'Handing you over to a human, one of our team will pick up shortly.',
      },
    };
  }
}

// ── PRO-2 / QUOXCHAT-EMAIL: email_transcript builtin ────────────────────────
// Recipient-trust model (D3 — the open-relay answer):
//
//   The recipient is NEVER taken from this tool call by the auth endpoint —
//   auth resolves it server-side from widget_visitors.identified_attrs_json.
//   What this executor decides is whether THAT stored email is trusted:
//
//   trusted   = the visitor is HMAC-verified AND the email is
//               identify-sourced (the host site vouched for it).
//               → send. No captcha demanded here (the widget-level
//               bot_protection policy gate may still have required a
//               passing token before this executor ever ran).
//   untrusted = chat-typed or self-declared email ('chat' / 'declared').
//               → REQUIRES a passing bot_protection verdict for this
//               request (context.human_verified === true). A widget with
//               bot_protection unconfigured denies with an operator-facing
//               reason. There is NO degraded mode for untrusted
//               recipients: a captcha-less send to a typed address is an
//               open relay from our domain.
//
//   The optional `email` input lets "email my transcript to X" work in one
//   turn: the address is captured as a chat-sourced identified email
//   (visitors/upsert, source 'chat' — provenance is computed auth-side and
//   cannot be forged from here), and then follows the untrusted path above.
//
// The legacy env-keyed captcha (QUOXCHAT_TRANSCRIPT_RECAPTCHA_*) is retired:
// the per-widget bot_protection surface (#127: dashboard-configured, secret
// server-side, verified per message, witnessed) is the ONE captcha system.
//
// Belts unchanged: one send per conversation (in-process + durable auth-side
// cap), per-widget daily side-effect cap via SIDE_EFFECT_BUILTIN_RE, masked
// recipient in all visitor-facing output.
const { createDailyCapStore: _createCapStoreForTranscript } = require('./quoxchatDailyCapStore');
// One-send-per-conversation cap. 7 day TTL: comfortably outlives any live
// conversation window while keeping the in-process map bounded.
const _transcriptSentStore = _createCapStoreForTranscript({ ttlMs: 7 * 24 * 60 * 60 * 1000 });
const _TRANSCRIPT_SENT_MARK = 'sent';

// Found live during P4 dev verification: the sent-store arms only AFTER a
// successful response, and the durable auth-side cap stamps only on success,
// so two overlapping calls for the same conversation could BOTH send (proven
// on dev: two delivered message_ids 4s apart when the first call's timeout
// abandoned a send that was still completing). This in-flight guard closes
// the window: the loser of the race reports send_in_progress, and a FAILED
// attempt releases the guard so a retry is still allowed.
const _transcriptInFlight = new Set();

/**
 * Capture a chat-provided email as the visitor's identified email.
 * Provenance is stamped auth-side ('chat' — caller-supplied email_source is
 * stripped there), so this call cannot mint identify trust.
 */
async function captureChatEmail({ widget, context, email, name }) {
  const resp = await authInternalCall(`/api/internal/widgets/${encodeURIComponent(widget.id)}/visitors/upsert`, {
    body: {
      visitor_id: context.visitor_id,
      attrs: name ? { email, name } : { email },
      source: 'chat',
    },
  });
  if (!resp.ok) throw new Error(`visitor upsert returned ${resp.status}`);
}

async function emailTranscript({ widget, input, context }) {
  if (!context?.conversation_id) {
    return { ok: false, error: 'no_conversation', reason: 'no_conversation', message: 'Start a conversation before requesting a transcript.' };
  }

  // Resolve the candidate recipient and its provenance. An LLM-supplied
  // email that merely repeats the already-identified address keeps the
  // stored (possibly stronger) provenance instead of downgrading it.
  const inputEmail = typeof input?.email === 'string' ? input.email.trim() : '';
  const storedEmail = typeof context?.identified_email === 'string' ? context.identified_email : '';
  const storedSource = context?.identified_email_source
    || (storedEmail ? (context?.verified === true ? 'identify' : 'declared') : null);

  let candidate = null; // { email, source, needsCapture }
  if (inputEmail && (!storedEmail || inputEmail.toLowerCase() !== storedEmail.toLowerCase())) {
    if (!_emailValid(inputEmail)) {
      return { ok: false, error: 'invalid_email', reason: 'invalid_email', message: 'That email address does not look valid. Please check it and try again.' };
    }
    candidate = { email: inputEmail, source: 'chat', needsCapture: true };
  } else if (storedEmail) {
    candidate = { email: storedEmail, source: storedSource, needsCapture: false };
  }
  if (!candidate) {
    return {
      ok: false,
      error: 'visitor_email_unknown',
      reason: 'visitor_email_unknown',
      message: 'I don\'t have your email yet. Ask the visitor which email address the transcript should go to, then call this tool again with it in the `email` field.',
    };
  }

  // D3 trust matrix.
  const trusted = context?.verified === true && candidate.source === 'identify';
  if (!trusted) {
    if (context?.human_verified === undefined) {
      // Widget has no bot_protection configured: fail closed with an
      // operator-facing reason. No captcha, no send to an untrusted address.
      return {
        ok: false,
        error: 'captcha_required',
        reason: 'bot_protection_not_configured',
        // QUOXCHAT-BRUTALOOP: visitor-facing text only. The operator reason
        // stays in `reason` (evidence + admin logs), never in the chat.
        message: 'I cannot email the transcript from this chat. You can copy the conversation from this window, or leave your email and the team will follow up.',
      };
    }
    if (context.human_verified !== true) {
      return { ok: false, error: 'captcha_failed', reason: 'captcha_failed', message: 'We could not verify you\'re human. Please try again.' };
    }
  }

  // Fast in-process pre-check (belt) before the durable auth-side check
  // (braces, see the /email-transcript endpoint): avoids a wasted network
  // round trip on an obvious repeat within this collector process.
  const sessionKey = `${widget?.id || 'unknown'}:${context.conversation_id}`;
  if (_transcriptSentStore.peek(sessionKey, _TRANSCRIPT_SENT_MARK) > 0) {
    return { ok: false, error: 'already_sent', reason: 'already_sent', message: 'A transcript for this conversation has already been sent.' };
  }

  // A chat-typed address becomes the visitor's identified email ONLY after
  // the trust matrix above passed (a bot that fails captcha writes nothing).
  // Auth then resolves the recipient from the store it just gained — the
  // no-recipient-parameter property of the auth endpoint is untouched.
  if (candidate.needsCapture) {
    try {
      await captureChatEmail({ widget, context, email: candidate.email });
    } catch (err) {
      return { ok: false, error: 'capture_failed', reason: 'capture_failed', message: String(err?.message || err).slice(0, 200) };
    }
  }

  if (_transcriptInFlight.has(sessionKey)) {
    return { ok: false, error: 'already_sent', reason: 'send_in_progress', message: 'A transcript for this conversation is already being sent.' };
  }
  _transcriptInFlight.add(sessionKey);
  try {
    // 20s, not the 3s default: this call performs a real SMTP round trip
    // inside auth (prod relay is plesk.node.network:465). The 3s default
    // aborted live sends that then completed anyway, which is exactly the
    // window the in-flight guard above exists for.
    const resp = await authInternalCall(
      `/api/internal/widgets/${encodeURIComponent(widget.id)}/conversations/${encodeURIComponent(context.conversation_id)}/email-transcript`,
      { body: {}, timeoutMs: 20000 },
    );
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      return { ok: false, error: 'send_failed', reason: body.error || 'send_failed', message: `auth returned ${resp.status}` };
    }
    const data = await resp.json().catch(() => ({}));
    if (data.delivered !== true) {
      // Fail-closed: report the failure, never claim success (already_sent /
      // visitor_email_unknown / no_smtp all land here with their own reason).
      return { ok: false, error: 'send_failed', reason: data.reason || 'not_delivered', message: 'The transcript could not be emailed right now.' };
    }
    _transcriptSentStore.increment(sessionKey, _TRANSCRIPT_SENT_MARK);
    return {
      ok: true,
      // Evidence: how the recipient was trusted ('identify' = host-site
      // vouched; 'chat'/'declared' = captcha-passed untrusted source).
      recipient_trust: candidate.source,
      result: {
        sent: true,
        masked_email: data.masked_email || null,
        message: `Sent to ${data.masked_email || 'your email'}.`,
      },
    };
  } catch (err) {
    return { ok: false, error: 'executor_network', reason: 'executor_network', message: String(err?.message || err).slice(0, 200) };
  } finally {
    _transcriptInFlight.delete(sessionKey);
  }
}

// ── PRO-3: book_demo builtin ─────────────────────────────────────────────────
// Same landing spot as lead_capture (widget_leads + HITL inbox), flagged as a
// demo request so it surfaces to the org with higher priority than a plain
// lead. Reuses the existing /leads endpoint (metadata_json is free-form, so
// the demo flag + preferred_time ride there without a schema migration) and
// the existing createLeadInboxItem escalation, which PRO-3 extends to accept
// a priority override for demo requests.
async function bookDemo({ widget, input, context }) {
  // needs_input fix — same pattern as leadCapture/bookAppointment: a missing
  // or invalid email returns needs_input (still ok:true) so the widget
  // renders a real inline form, instead of an error the LLM narrates around.
  const email = _resolveEmail(input, context);
  if (!email) {
    return _buildNeedsInput({
      kind: 'book_demo',
      fields: [EMAIL_FIELD, PREFERRED_TIME_FIELD],
      prefill: { name: _resolveName(input, context), email: typeof input?.email === 'string' ? input.email.trim() : '' },
      message: "What's the best email so our team can set up your demo?",
    });
  }
  const preferredTime = typeof input?.preferred_time === 'string' ? input.preferred_time.trim().slice(0, 200) : null;
  const notes = typeof input?.notes === 'string' ? input.notes.trim().slice(0, 1000) : null;
  try {
    const resp = await authInternalCall(`/api/internal/widgets/${encodeURIComponent(widget.id)}/leads`, {
      body: {
        visitor_id: context?.visitor_id || null,
        conversation_id: context?.conversation_id || null,
        name: input?.name || null,
        email,
        notes,
        metadata: {
          intent: 'demo_request',
          demo: true,
          preferred_time: preferredTime,
          page_url: context?.page_url || null,
          captured_at: new Date().toISOString(),
        },
      },
    });
    if (!resp.ok) return { ok: false, error: 'persist_failed', reason: 'persist_failed', message: `auth returned ${resp.status}` };
    const data = await resp.json().catch(() => ({}));
    return {
      ok: true,
      lead_id: data.id || null,
      result: {
        booked: true,
        lead_id: data.id || null,
        reference: _leadRef(data.id, data.reference),
        duplicate: !!data.duplicate,
        preferred_time: preferredTime,
        message: data.duplicate
          ? 'Thanks, we already have your demo request and will be in touch.'
          : `Thanks! I've flagged this as a demo request${preferredTime ? ` for ${preferredTime}` : ''}${_leadRef(data.id, data.reference) ? ` (reference ${_leadRef(data.id, data.reference)})` : ''} and someone will reach out shortly.`,
      },
    };
  } catch (err) {
    return { ok: false, error: 'executor_network', reason: 'executor_network', message: String(err?.message || err).slice(0, 200) };
  }
}

// ── PRO-3: create_ticket builtin ────────────────────────────────────────────
// Support ticket, capturing the visitor's ask as a HITL inbox item (the
// canonical inbox path lead_capture/human_handoff already use — inbox_items
// has no 'ticket' kind, so this rides kind='task' the same way handoff does,
// distinguished by title/payload). Returns a reference number the LLM can
// relay to the visitor. Fail-soft on the network call only; validation
// failures are reported so the LLM can ask the visitor to try again.
async function createTicket({ widget, input, context }) {
  const subject = typeof input?.subject === 'string' ? input.subject.trim().slice(0, 200) : '';
  if (!subject) {
    // needs_input fix — missing subject renders an inline form (same pattern
    // as leadCapture/bookAppointment) instead of an LLM-narrated refusal.
    return _buildNeedsInput({
      kind: 'create_ticket',
      fields: [SUBJECT_FIELD, DESCRIPTION_FIELD],
      prefill: {
        subject: '',
        description: typeof input?.description === 'string' ? input.description.trim().slice(0, 2000) : '',
      },
      message: 'What is the issue about, in a sentence or two?',
    });
  }
  const description = typeof input?.description === 'string' ? input.description.trim().slice(0, 2000) : '';
  const email = typeof input?.email === 'string' ? input.email.trim() : '';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'invalid_email', reason: 'invalid_email', message: 'email must be a valid address if provided' };
  }
  try {
    const resp = await authInternalCall(`/api/internal/widgets/${encodeURIComponent(widget.id)}/tickets`, {
      body: {
        visitor_id: context?.visitor_id || null,
        conversation_id: context?.conversation_id || null,
        subject,
        description,
        email: email || null,
        page_url: context?.page_url || null,
      },
    });
    if (!resp.ok) return { ok: false, error: 'persist_failed', reason: 'persist_failed', message: `auth returned ${resp.status}` };
    const data = await resp.json().catch(() => ({}));
    return {
      ok: true,
      result: {
        created: true,
        reference: data.reference || null,
        message: `Got it. Your ticket reference is ${data.reference || 'on file'} — our team will follow up${email ? ` at ${email}` : ''}.`,
      },
    };
  } catch (err) {
    return { ok: false, error: 'executor_network', reason: 'executor_network', message: String(err?.message || err).slice(0, 200) };
  }
}

// ── PRO-3: send_resource builtin ────────────────────────────────────────────
// The safe version of "send me a doc": the LLM only ever supplies a
// `resource_key`, never a URL. The URL/title come from a SERVER-SIDE
// allowlist configured per-tool (tool.tool_config.resources, an admin-set
// { key: { url, title } } map) — mirroring how redirect_url's
// allowed_domains locks its target down. If the widget hasn't configured any
// resources, this returns a structured "no resources configured" result
// rather than failing or letting the model invent a URL.
async function sendResource({ tool, input }) {
  const cfg = tool?.tool_config || {};
  const resources = (cfg.resources && typeof cfg.resources === 'object') ? cfg.resources : null;
  if (!resources || Object.keys(resources).length === 0) {
    return {
      ok: true,
      result: {
        sent: false,
        reason: 'no_resources_configured',
        message: 'No resources are configured for this assistant yet.',
      },
    };
  }
  const key = typeof input?.resource_key === 'string' ? input.resource_key.trim() : '';
  const entry = key ? resources[key] : null;
  if (!entry || typeof entry.url !== 'string' || !entry.url) {
    return {
      ok: false,
      error: 'unknown_resource',
      reason: 'unknown_resource',
      message: `"${key || '(none)'}" is not a resource I can send. Available: ${Object.keys(resources).join(', ')}`,
    };
  }
  const title = typeof entry.title === 'string' && entry.title ? entry.title : key;
  return {
    ok: true,
    result: {
      sent: true,
      resource_key: key,
      url: entry.url,
      title,
      message: `Here's the ${title}: ${entry.url}`,
    },
  };
}

// ── PRO-3 action catalog: book_appointment / schedule_demo / leave_message ──
// Out-of-the-box actions an org can switch on per widget. All three land in
// widget_leads via the existing /leads internal endpoint (metadata_json is
// free-form, so lead_type + preferred_time ride there without a schema
// migration — same trick book_demo uses) and return a warm confirmation the
// LLM relays verbatim. routes/quoxchat.js fires a per-action org alert
// (appointment_requested / demo_requested / message_left) through the
// existing notifyWidgetChannels fan-out after the turn.
// Short, visitor-quotable reference for a captured lead (last 6 of the id).
function _leadRef(id, stored) {
  if (typeof stored === 'string' && /^[A-Za-z0-9]{4,12}$/.test(stored)) return stored.toUpperCase();
  const s = typeof id === 'string' ? id.replace(/[^A-Za-z0-9]/g, '') : '';
  return s.length >= 6 ? s.slice(-6).toUpperCase() : null;
}

function _makeLeadActionExecutor({ kind, leadType, intent, buildNotes, confirm, validateMissing, needsInputFields, needsInputMessage }) {
  return async function leadAction({ widget, input, context }) {
    const email = _resolveEmail(input, context);
    const missing = [];
    if (!email) missing.push('email');
    if (validateMissing) missing.push(...validateMissing(input));
    if (missing.length > 0) {
      return _buildNeedsInput({
        kind,
        fields: needsInputFields,
        prefill: { name: _resolveName(input, context), email: typeof input?.email === 'string' ? input.email.trim() : '' },
        message: needsInputMessage(missing),
      });
    }
    const preferredTime = typeof input?.preferred_time === 'string' ? input.preferred_time.trim().slice(0, 200) : null;
    const notes = buildNotes(input);
    try {
      const resp = await authInternalCall(`/api/internal/widgets/${encodeURIComponent(widget.id)}/leads`, {
        body: {
          visitor_id: context?.visitor_id || null,
          conversation_id: context?.conversation_id || null,
          name: input?.name || null,
          email,
          notes,
          metadata: {
            lead_type: leadType,
            intent,
            preferred_time: preferredTime,
            page_url: context?.page_url || null,
            captured_at: new Date().toISOString(),
          },
        },
      });
      if (!resp.ok) return { ok: false, error: 'persist_failed', reason: 'persist_failed', message: `auth returned ${resp.status}` };
      const data = await resp.json().catch(() => ({}));
      return {
        ok: true,
        lead_id: data.id || null,
        result: {
          captured: true,
          lead_type: leadType,
          lead_id: data.id || null,
          reference: _leadRef(data.id, data.reference),
          duplicate: !!data.duplicate,
          preferred_time: preferredTime,
          message: confirm({ duplicate: !!data.duplicate, preferredTime, email, ref: _leadRef(data.id, data.reference) }),
        },
      };
    } catch (err) {
      return { ok: false, error: 'executor_network', reason: 'executor_network', message: String(err?.message || err).slice(0, 200) };
    }
  };
}

const bookAppointment = _makeLeadActionExecutor({
  kind: 'book_appointment',
  leadType: 'appointment',
  intent: 'appointment_request',
  buildNotes: (input) => (typeof input?.notes === 'string' ? input.notes.trim().slice(0, 1000) : null),
  needsInputFields: [EMAIL_FIELD, PREFERRED_TIME_FIELD],
  needsInputMessage: () => "What's the best email so our team can confirm your appointment?",
  confirm: ({ duplicate, preferredTime, email, ref }) => duplicate
    ? `Thanks, we already have your appointment request${ref ? ` (reference ${ref})` : ''} and will be in touch to confirm.`
    : `Great, I've requested an appointment${preferredTime ? ` for ${preferredTime}` : ''}${ref ? ` (reference ${ref})` : ''}. Our team will confirm with you at ${email}.`,
});

const scheduleDemo = _makeLeadActionExecutor({
  kind: 'schedule_demo',
  leadType: 'demo',
  intent: 'demo_request',
  buildNotes: (input) => (typeof input?.notes === 'string' ? input.notes.trim().slice(0, 1000) : null),
  needsInputFields: [EMAIL_FIELD, PREFERRED_TIME_FIELD],
  needsInputMessage: () => "What's the best email so our team can confirm your demo?",
  // QUOXCHAT-BRUTALOOP D5: a request is not a booking. Say what happened
  // (a request reached the team) and hand the visitor a reference they can
  // quote back; never "scheduled" while no slot exists.
  confirm: ({ duplicate, preferredTime, email, ref }) => duplicate
    ? `Thanks, we already have your demo request${ref ? ` (reference ${ref})` : ''} and will be in touch.`
    : `Your demo request is with the team${preferredTime ? `, with ${preferredTime} as your preferred time` : ''}${ref ? ` (reference ${ref})` : ''}. They will email ${email} to agree a time.`,
});

const leaveMessage = _makeLeadActionExecutor({
  kind: 'leave_message',
  leadType: 'message',
  intent: 'message_for_team',
  validateMissing: (input) => {
    const msg = typeof input?.message === 'string' ? input.message.trim() : '';
    return msg ? [] : ['message'];
  },
  needsInputFields: [MESSAGE_FIELD, EMAIL_FIELD],
  needsInputMessage: (missing) => {
    const wantsMessage = missing.includes('message');
    const wantsEmail = missing.includes('email');
    if (wantsMessage && wantsEmail) return "What would you like to tell the team, and what's the best email for them to reply to?";
    if (wantsMessage) return 'What would you like to tell the team?';
    return "What's the best email for the team to reply to?";
  },
  buildNotes: (input) => {
    const msg = typeof input?.message === 'string' ? input.message.trim().slice(0, 2000) : '';
    const notes = typeof input?.notes === 'string' ? input.notes.trim().slice(0, 1000) : '';
    if (!msg) return notes || null;
    return notes ? `${msg}\n\n${notes}` : msg;
  },
  confirm: ({ duplicate, email, ref }) => duplicate
    ? `Thanks, we already have your message with our team${ref ? ` (reference ${ref})` : ''}.`
    : `Your message is with the team${ref ? ` (reference ${ref})` : ''}, they will reply to ${email}.`,
});

function normaliseRedirectUrl(raw, { allowedDomains = [], basePage } = {}) {
  if (!raw || typeof raw !== 'string') return { error: 'invalid_url', message: 'url is required' };
  // Only treat basePage as a resolution base when it's itself absolute http/https.
  let validBase = null;
  if (typeof basePage === 'string' && /^https?:\/\//i.test(basePage)) {
    try { validBase = new URL(basePage).toString(); } catch { /* noop */ }
  }
  let u;
  try {
    u = validBase ? new URL(raw, validBase) : new URL(raw);
  } catch {
    return { error: 'invalid_url', message: 'url is not parseable' };
  }
  if (!['http:', 'https:'].includes(u.protocol)) return { error: 'invalid_url', message: 'only http/https allowed' };
  if (allowedDomains.length > 0) {
    const host = u.hostname.toLowerCase();
    const allowed = allowedDomains.some(d => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));
    if (!allowed) return { error: 'url_not_allowed', message: `${host} is not in the widget's allowed domains` };
  }
  return { url: u.toString() };
}

// QUOXCHAT-BRUTALOOP CONN (finding 18): a redirect URL is later treated as
// link-gate support, so the model must never be able to mint its own. Only
// URLs that exactly match the widget's configured site_links, or whose host
// is on the operator-configured tool allowed_domains, are emitted. No
// configuration at all means deny.
function widgetSiteLinkUrls(widget) {
  const out = new Set();
  try {
    const raw = widget?.embed_config_json;
    const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(cfg?.site_links)) {
      for (const l of cfg.site_links) {
        if (l && typeof l.url === 'string') {
          try { const u = new URL(l.url.trim()); u.hash = ''; out.add(u.toString()); } catch { /* skip */ }
        }
      }
    }
  } catch { /* noop */ }
  return out;
}

async function redirectUrl({ widget, tool, input, context }) {
  let allowed = [];
  try {
    const toolCfg = tool?.tool_config || {};
    if (Array.isArray(toolCfg.allowed_domains)) allowed = toolCfg.allowed_domains.filter((d) => typeof d === 'string' && d.trim());
  } catch { /* noop */ }

  const siteLinks = widgetSiteLinkUrls(widget);
  const shape = normaliseRedirectUrl(input?.url, { allowedDomains: [], basePage: context?.page_url || undefined });
  if (shape.error) return { ok: false, error: shape.error, message: shape.message };
  const u = new URL(shape.url);
  u.hash = '';
  if (!siteLinks.has(u.toString())) {
    if (allowed.length === 0) {
      return { ok: false, error: 'url_not_allowed', message: "url is not one of the widget's configured links" };
    }
    const check = normaliseRedirectUrl(input?.url, { allowedDomains: allowed, basePage: context?.page_url || undefined });
    if (check.error) return { ok: false, error: check.error, message: check.message };
  }
  return {
    ok: true,
    result: {
      redirect_url: shape.url,
      label: input?.label ? String(input.label).slice(0, 80) : 'Open link',
      open_in_new_tab: input?.open_in_new_tab !== false,
    },
  };
}

const BUILTIN_EXECUTORS = {
  lead_capture: leadCapture,
  human_handoff: humanHandoff,
  redirect_url: redirectUrl,
  email_transcript: emailTranscript,
  book_demo: bookDemo,
  create_ticket: createTicket,
  send_resource: sendResource,
  book_appointment: bookAppointment,
  schedule_demo: scheduleDemo,
  leave_message: leaveMessage,
};

// ── CW-9.4: REST API connector executor ────────────────────────────────────

const { validateOutboundUrl, hmacSign } = require('./channels/baseDriver');

const REST_MAX_RESPONSE_BYTES = 64 * 1024; // 64 KB cap on body forwarded to the LLM
const REST_DEFAULT_TIMEOUT_MS = 5000;
const REST_MAX_TIMEOUT_MS = 15000;
const REST_ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Resolve `{placeholder}` tokens in a path / string against an input object.
 * Only shallow keys are allowed. Missing values become empty strings.
 * Whitelist characters so a malicious LLM can't inject path traversal.
 */
function substitutePlaceholders(raw, input) {
  if (typeof raw !== 'string') return raw;
  return raw.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, name) => {
    const v = input?.[name];
    if (v === undefined || v === null) return '';
    return encodeURIComponent(String(v));
  });
}

/** Dotted-path extractor — e.g. "data.user.email" or "items.0.id". */
function extractJsonPath(value, path) {
  if (!path || typeof path !== 'string') return value;
  const parts = path.split('.').filter(Boolean);
  let cur = value;
  for (const part of parts) {
    if (cur === null || cur === undefined) return null;
    if (Array.isArray(cur) && /^\d+$/.test(part)) { cur = cur[Number(part)]; continue; }
    if (typeof cur === 'object') { cur = cur[part]; continue; }
    return null;
  }
  return cur;
}

// QCX-1.3: vault-preferred secret resolution. Registered by the collector
// at boot via registerVaultResolver(fn); fn(vaultId) → { key, ... } or null.
// Keeps this module decoupled from server.js + trivially swappable in tests.
let _vaultResolver = null;
function registerVaultResolver(fn) {
  _vaultResolver = (typeof fn === 'function') ? fn : null;
}

function _resolveEnvVar(envVarName) {
  if (!envVarName || typeof envVarName !== 'string') return null;
  // Conservative env var name whitelist — blocks accidental shell-meta usage.
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(envVarName)) return null;
  const v = process.env[envVarName];
  return (typeof v === 'string' && v.length > 0) ? v : null;
}

/**
 * QCX-1.3: secret waterfall — vault → env fallback.
 * Accepts either:
 *   - a descriptor object { vault_id?, env_var? } — vault preferred, env fallback
 *   - a plain string (legacy) — treated as env var name
 * VAULT-P6.G (defense in depth): `orgId` is the executing widget's org and is
 * forwarded to the registered resolver (server.js registers
 * resolveCredentialById(credentialId, orgId)) so a vault_id can only ever
 * resolve to a credential belonging to the caller's own org — mirrors the
 * org_id threading already done for server.js's two chat-request call sites
 * and connectors/bridge.js (VAULT-P6.D).
 * Returns the secret value or null. Never throws — vault failures degrade to env.
 */
async function resolveSecret(ref, orgId) {
  if (!ref) return null;
  if (typeof ref === 'string') return _resolveEnvVar(ref);
  if (typeof ref !== 'object') return null;

  if (ref.vault_id && _vaultResolver) {
    try {
      const resolved = await _vaultResolver(ref.vault_id, orgId);
      const key = resolved?.key;
      if (typeof key === 'string' && key.length > 0) return key;
    } catch (err) {
      console.warn(`[QuoxChat] vault resolver threw for ${ref.vault_id}: ${err?.message || err}`);
    }
  }
  if (ref.env_var) return _resolveEnvVar(ref.env_var);
  return null;
}

// Helper: build a resolution descriptor from a connector-config shape. Centralises
// the precedence so each auth branch (api_key / bearer / webhook hmac) stays terse.
function connectorSecretRef(connCfg, kind) {
  if (!connCfg) return null;
  if (kind === 'hmac') {
    return { vault_id: connCfg.hmac_secret_vault_id || null, env_var: connCfg.hmac_secret_env_var || null };
  }
  return { vault_id: connCfg.secret_vault_id || null, env_var: connCfg.secret_env_var || null };
}

/**
 * Deep-substitute placeholders inside a JSON-compatible body template.
 * Values typed as `{ $input: 'field_name' }` are replaced with the LLM input
 * value for that field (keeping the original JS type — numbers stay numbers).
 */
function substituteBodyTemplate(tmpl, input) {
  if (tmpl === null || tmpl === undefined) return tmpl;
  if (Array.isArray(tmpl)) return tmpl.map(v => substituteBodyTemplate(v, input));
  if (typeof tmpl === 'object') {
    if (typeof tmpl.$input === 'string') {
      return input?.[tmpl.$input] ?? null;
    }
    const out = {};
    for (const [k, v] of Object.entries(tmpl)) out[k] = substituteBodyTemplate(v, input);
    return out;
  }
  if (typeof tmpl === 'string') return substitutePlaceholders(tmpl, input);
  return tmpl;
}

// QCX-ACTIONS P1 — normalise tool_config.identity_param. Accepts a bare
// string (query param name) or { name, in: 'query'|'body'|'header' }.
// Returns null for anything malformed so the caller can refuse honestly.
function normalizeIdentityParam(raw) {
  if (typeof raw === 'string') {
    const name = raw.trim();
    return name ? { name, in: 'query' } : null;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const where = raw.in === undefined ? 'query' : raw.in;
    if (!name || !['query', 'body', 'header'].includes(where)) return null;
    if (where === 'header' && !/^[A-Za-z0-9-]+$/.test(name)) return null;
    return { name, in: where };
  }
  return null;
}

// QCX-ACTIONS P4 — see the SSRF comment at the check site. Exact host:port
// match only; http/https only; metadata endpoints never exempt.
function isConnectorPrivateAllowlisted(url) {
  const raw = process.env.QUOXCHAT_CONNECTOR_PRIVATE_ALLOWLIST || '';
  if (!raw.trim()) return false;
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const hostname = url.hostname.toLowerCase();
  if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') return false;
  const host = url.port ? `${hostname}:${url.port}` : hostname;
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).includes(host);
}

// QUOXCHAT-BRUTALOOP CONN (finding 32): bounded read. Streams the body and
// cancels the request once the byte budget is exceeded. Falls back to
// resp.text() only for bodiless response doubles.
async function readCappedText(resp, maxBytes) {
  const body = resp?.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    let truncated = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const room = maxBytes - total;
        if (value.byteLength > room) {
          if (room > 0) chunks.push(value.subarray(0, room));
          total += Math.max(room, 0);
          truncated = true;
          try { await reader.cancel(); } catch { /* noop */ }
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } catch { /* partial read: keep what we have */ }
    return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), truncated };
  }
  const raw = await resp.text().catch(() => '');
  const buf = Buffer.from(raw, 'utf8');
  if (buf.length > maxBytes) return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: true };
  return { text: raw, truncated: false };
}

async function restApi({ widget, tool, input, context }) {
  const cfg = tool?.tool_config || {};
  const connCfg = tool?.connector_config || {};

  // QCX-ACTIONS P1 — server-injected identity. A tool that declares
  // identity_param acts on behalf of the signed-in visitor: it never runs
  // for unverified visitors, and the identity value is ALWAYS the
  // HMAC-verified external_user_id from server context — any LLM-supplied
  // value under the same name is stripped BEFORE placeholder substitution,
  // so a prompt-injected model cannot act as another customer.
  let identity = null;
  if (cfg.identity_param !== undefined && cfg.identity_param !== null) {
    identity = normalizeIdentityParam(cfg.identity_param);
    if (!identity) {
      return { ok: false, error: 'invalid_config', message: 'identity_param must be a param name or {name, in: query|body|header}' };
    }
    const externalUserId = typeof context?.external_user_id === 'string' ? context.external_user_id.trim() : '';
    if (context?.verified !== true || !externalUserId) {
      return { ok: false, error: 'identity_required', message: `${tool?.name || 'this tool'} acts on the signed-in customer's account and needs a verified sign-in` };
    }
    identity.value = externalUserId;
    if (input && typeof input === 'object' && identity.name in input) {
      input = { ...input };
      delete input[identity.name];
    }
  }

  // QUOXCHAT-BRUTALOOP — server-computed identity SIGNATURE. Some backends
  // (HostNode actions) verify the identity themselves: they require
  // user_hash = HMAC-SHA256(verified id, the widget's identity_secret). The
  // executor gets a signing FUNCTION from the route, never the secret, signs
  // only the HMAC-verified identity above, and strips any model-supplied
  // value under the same name. No signer -> fail closed before any fetch.
  let signature = null;
  if (cfg.identity_signature_param !== undefined && cfg.identity_signature_param !== null) {
    if (!identity) {
      return { ok: false, error: 'invalid_config', message: 'identity_signature_param requires identity_param' };
    }
    signature = normalizeIdentityParam(cfg.identity_signature_param);
    if (!signature) {
      return { ok: false, error: 'invalid_config', message: 'identity_signature_param must be a param name or {name, in: query|body|header}' };
    }
    if (typeof context?.signIdentity !== 'function') {
      return { ok: false, error: 'identity_signature_unavailable', message: `${tool?.name || 'this tool'} needs the widget's identity verification secret, which is not configured` };
    }
    signature.value = String(context.signIdentity(identity.value));
    if (input && typeof input === 'object' && signature.name in input) {
      input = { ...input };
      delete input[signature.name];
    }
  }
  const injected = [identity, signature].filter(Boolean);

  // 1. Validate config shape (the tool/connector should already have passed
  //    validation at create time; re-check cheaply because the row may be stale).
  if (!connCfg.base_url) return { ok: false, error: 'invalid_connector', message: 'base_url missing' };
  if (!cfg.method || !REST_ALLOWED_METHODS.has(String(cfg.method).toUpperCase())) {
    return { ok: false, error: 'invalid_config', message: `method must be one of ${[...REST_ALLOWED_METHODS].join('|')}` };
  }
  if (!cfg.path || typeof cfg.path !== 'string' || !cfg.path.startsWith('/')) {
    return { ok: false, error: 'invalid_config', message: 'path must start with /' };
  }
  const method = cfg.method.toUpperCase();

  // 2. Build target URL (placeholder substitution only — never user strings concatenated).
  let url;
  try {
    const resolvedPath = substitutePlaceholders(cfg.path, input);
    const base = new URL(connCfg.base_url);
    url = new URL(resolvedPath, base.toString());
    // Forbid host change via path substitution (defense in depth).
    if (url.host !== base.host) return { ok: false, error: 'invalid_path', message: 'path substitution cannot change host' };
  } catch {
    return { ok: false, error: 'invalid_url', message: 'could not construct request URL' };
  }

  // 3. Query params from config with $input substitution
  if (Array.isArray(cfg.query_params)) {
    for (const q of cfg.query_params) {
      if (!q || typeof q.name !== 'string') continue;
      const fromInput = typeof q.from === 'string' ? input?.[q.from] : q.value;
      if (fromInput !== undefined && fromInput !== null) url.searchParams.set(q.name, String(fromInput));
    }
  }

  // 3b. QCX-ACTIONS P1 — identity injection wins over config and input.
  for (const inj of injected) if (inj.in === 'query') url.searchParams.set(inj.name, inj.value);

  // 4. SSRF check on the final URL. QCX-ACTIONS P4: a DEPLOYMENT-level env
  // allowlist (exact host:port entries, comma-separated) may exempt named
  // private origins — e.g. a same-LAN billing panel the org's connectors
  // legitimately target. Env-only ON PURPOSE (qlarity-allowlist posture):
  // an org admin or a prompt-injected agent must not be able to
  // self-authorize LAN egress from the dashboard. Protocol and cloud
  // metadata blocks are NEVER bypassed.
  const ssrf = validateOutboundUrl(url.toString());
  if (!ssrf.valid && !isConnectorPrivateAllowlisted(url)) return { ok: false, error: 'ssrf_blocked', message: ssrf.error };

  // 5. Headers + auth
  const headers = { 'Accept': 'application/json' };
  const defaultHeaders = connCfg.default_headers;
  if (defaultHeaders && typeof defaultHeaders === 'object') {
    for (const [k, v] of Object.entries(defaultHeaders)) if (typeof v === 'string') headers[k] = v;
  }
  const authType = connCfg.auth_type || 'none';
  if (authType === 'api_key') {
    const ref = connectorSecretRef(connCfg, 'auth');
    const secret = await resolveSecret(ref, widget?.org_id);
    if (!secret) return { ok: false, error: 'missing_secret', message: `secret unavailable (vault_id=${ref.vault_id || '-'} env=${ref.env_var || '-'})` };
    if (connCfg.api_key_header) headers[connCfg.api_key_header] = secret;
    else if (connCfg.api_key_query) url.searchParams.set(connCfg.api_key_query, secret);
    else return { ok: false, error: 'invalid_connector', message: 'api_key auth requires api_key_header or api_key_query' };
  } else if (authType === 'bearer') {
    const ref = connectorSecretRef(connCfg, 'auth');
    const secret = await resolveSecret(ref, widget?.org_id);
    if (!secret) return { ok: false, error: 'missing_secret', message: `secret unavailable (vault_id=${ref.vault_id || '-'} env=${ref.env_var || '-'})` };
    headers['Authorization'] = `Bearer ${secret}`;
  } else if (authType !== 'none') {
    return { ok: false, error: 'invalid_connector', message: `auth_type ${authType} not supported in CW-9.4 (oauth coming later)` };
  }

  // 5b. QCX-ACTIONS P1 — header identity injection, after default_headers
  // and auth so nothing can clobber it.
  for (const inj of injected) if (inj.in === 'header') headers[inj.name] = inj.value;

  // 6. Body template (only for non-GET/DELETE)
  let body;
  const wantsBody = !['GET', 'DELETE'].includes(method);
  if (injected.some((inj) => inj.in === 'body') && !wantsBody) {
    return { ok: false, error: 'invalid_config', message: 'identity_param in:body requires a method with a request body' };
  }
  if (wantsBody && ((cfg.body_template !== undefined && cfg.body_template !== null) || injected.some((inj) => inj.in === 'body'))) {
    const payload = (cfg.body_template !== undefined && cfg.body_template !== null)
      ? substituteBodyTemplate(cfg.body_template, input)
      : {};
    for (const inj of injected) {
      if (inj.in !== 'body') continue;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { ok: false, error: 'invalid_config', message: 'identity_param in:body requires an object body_template' };
      }
      payload[inj.name] = inj.value;
    }
    body = JSON.stringify(payload);
    headers['Content-Type'] = 'application/json';
  }

  // 7. Timeout
  const timeoutMs = Math.min(Math.max(Number.isFinite(cfg.timeout_ms) ? cfg.timeout_ms : REST_DEFAULT_TIMEOUT_MS, 500), REST_MAX_TIMEOUT_MS);

  // 8. Execute. QUOXCHAT-BRUTALOOP CONN (finding 33): redirects are followed
  // manually (max 3 hops) and every hop's destination re-runs the SSRF /
  // private-allowlist check. Credentials never follow a hop to another origin.
  let resp;
  let curUrl = url;
  let curMethod = method;
  let curBody = body;
  let curHeaders = headers;
  try {
    for (let hop = 0; ; hop++) {
      resp = await fetch(curUrl.toString(), { method: curMethod, headers: curHeaders, body: curBody, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if (![301, 302, 303, 307, 308].includes(resp.status)) break;
      const loc = resp.headers && typeof resp.headers.get === 'function' ? resp.headers.get('location') : null;
      if (!loc) break;
      if (hop >= 3) return { ok: false, error: 'too_many_redirects', message: 'redirect limit (3) exceeded' };
      let next;
      try { next = new URL(loc, curUrl); } catch { return { ok: false, error: 'ssrf_blocked', message: 'invalid redirect location' }; }
      if (!['http:', 'https:'].includes(next.protocol)) return { ok: false, error: 'ssrf_blocked', message: 'redirect to non-http protocol blocked' };
      const hopSsrf = validateOutboundUrl(next.toString());
      if (!hopSsrf.valid && !isConnectorPrivateAllowlisted(next)) return { ok: false, error: 'ssrf_blocked', message: `redirect blocked: ${hopSsrf.error}` };
      try { await resp.body?.cancel?.(); } catch { /* noop */ }
      if (next.origin !== curUrl.origin) {
        curHeaders = { Accept: headers.Accept };
        curBody = undefined;
        curMethod = 'GET';
      } else if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && curMethod === 'POST')) {
        curMethod = 'GET';
        curBody = undefined;
      }
      curUrl = next;
    }
  } catch (err) {
    return { ok: false, error: 'fetch_failed', message: String(err?.message || err).slice(0, 200) };
  }

  // 9. Read with a hard byte cap (finding 32): stream and abort past the cap.
  const { text, truncated } = await readCappedText(resp, REST_MAX_RESPONSE_BYTES);

  // 10. Try JSON parse + JSONPath extract
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  let extracted = null;
  if (cfg.response_extract && parsed !== null) {
    extracted = extractJsonPath(parsed, cfg.response_extract);
  }

  if (!resp.ok) {
    return {
      ok: false,
      error: 'upstream_error',
      message: `${resp.status} ${resp.statusText}`.slice(0, 200),
      result: {
        status: resp.status,
        body: text.slice(0, 2048), // smaller cap on error paths
        truncated,
      },
    };
  }

  return {
    ok: true,
    result: {
      status: resp.status,
      data: cfg.response_extract ? extracted : (parsed ?? text),
      truncated,
    },
  };
}

// ── CW-9.5: Webhook connector executor ─────────────────────────────────────
// Fire-and-forget outbound POST with optional HMAC signing. The LLM never
// sees the response body — just a success/failure signal. Designed for
// notifications, lead forwarding, CRM pushes, etc.

const WEBHOOK_DEFAULT_TIMEOUT_MS = 5000;
const WEBHOOK_MAX_TIMEOUT_MS = 10000;
const WEBHOOK_HMAC_HEADER_DEFAULT = 'X-Quox-Signature';

async function webhook({ widget, tool, input, context }) {
  const cfg = tool?.tool_config || {};
  const connCfg = tool?.connector_config || {};

  if (!connCfg.url || typeof connCfg.url !== 'string') {
    return { ok: false, error: 'invalid_connector', message: 'webhook connector requires url' };
  }

  // SSRF check on the connector URL (path substitution not allowed for webhooks — url is fixed).
  const ssrf = validateOutboundUrl(connCfg.url);
  if (!ssrf.valid) return { ok: false, error: 'ssrf_blocked', message: ssrf.error };

  // Build payload: config template gets $input substitution, with optional Quox metadata envelope.
  const userPayload = cfg.body_template !== undefined && cfg.body_template !== null
    ? substituteBodyTemplate(cfg.body_template, input)
    : { ...input };

  const metaOn = cfg.include_metadata !== false; // default true
  const payload = metaOn
    ? {
        widget_id: widget?.id || null,
        conversation_id: context?.conversation_id || null,
        visitor_id: context?.visitor_id || null,
        tool_name: tool?.name || null,
        page_url: context?.page_url || null,
        invoked_at: new Date().toISOString(),
        data: userPayload,
      }
    : userPayload;

  const body = JSON.stringify(payload);

  const headers = { 'Content-Type': 'application/json' };
  if (connCfg.default_headers && typeof connCfg.default_headers === 'object') {
    for (const [k, v] of Object.entries(connCfg.default_headers)) {
      if (typeof v === 'string' && !/^authorization$/i.test(k)) headers[k] = v;
    }
  }

  // HMAC signature — optional but strongly encouraged for untrusted receivers.
  // QCX-1.3: prefer vault, fall back to env var.
  if (connCfg.hmac_secret_vault_id || connCfg.hmac_secret_env_var) {
    const ref = connectorSecretRef(connCfg, 'hmac');
    const secret = await resolveSecret(ref, widget?.org_id);
    if (!secret) return { ok: false, error: 'missing_secret', message: `hmac secret unavailable (vault_id=${ref.vault_id || '-'} env=${ref.env_var || '-'})` };
    const sig = hmacSign(body, secret);
    const headerName = connCfg.hmac_header || WEBHOOK_HMAC_HEADER_DEFAULT;
    headers[headerName] = `sha256=${sig}`;
  }

  const timeoutMs = Math.min(Math.max(Number.isFinite(cfg.timeout_ms) ? cfg.timeout_ms : WEBHOOK_DEFAULT_TIMEOUT_MS, 500), WEBHOOK_MAX_TIMEOUT_MS);

  try {
    const resp = await fetch(connCfg.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      return {
        ok: false,
        error: 'upstream_error',
        message: `${resp.status} ${resp.statusText}`.slice(0, 120),
        result: { status: resp.status, signed: !!(connCfg.hmac_secret_vault_id || connCfg.hmac_secret_env_var) },
      };
    }
    // Fire-and-forget: never forward the response body to the LLM.
    return {
      ok: true,
      result: {
        status: resp.status,
        signed: !!(connCfg.hmac_secret_vault_id || connCfg.hmac_secret_env_var),
        delivered_at: new Date().toISOString(),
      },
    };
  } catch (err) {
    return { ok: false, error: 'fetch_failed', message: String(err?.message || err).slice(0, 200) };
  }
}

// ── CW-9.6: Database connector executor (SQLite only for now) ──────────────
// Postgres / MySQL drivers land in CW-9.6b. Current scope covers the common
// widget use-case ("look up this order in our read-only replica") while
// keeping the blast radius small.

const { validateReadOnlySqlTemplate } = require('./quoxchatSqlValidator');

const DB_ROW_LIMIT_DEFAULT = 100;
const DB_ROW_LIMIT_MAX = 1000;
const DB_TIMEOUT_DEFAULT_MS = 5000;
const DB_TIMEOUT_MAX_MS = 30000;
const SUPPORTED_DRIVERS = new Set(['sqlite']);
// SQLite DB paths must be either ":memory:" or an absolute path under one of
// these roots. /tmp for tests, /var/lib/quox for production volumes.
const SQLITE_ALLOWED_PATH_PREFIXES = ['/var/lib/quox/', '/tmp/'];

function extractParamNames(sql) {
  const out = new Set();
  // `:name` tokens — must be preceded by whitespace/comma/paren, not by `:`
  // (to avoid matching `::cast` in Postgres or `::` qualifiers).
  const re = /(^|[\s,(=<>!+\-*\/])(:[a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m;
  while ((m = re.exec(sql)) !== null) out.add(m[2].slice(1));
  return Array.from(out);
}

function sqliteOpen(connCfg) {
  const raw = connCfg.db_path;
  if (!raw || typeof raw !== 'string') return { error: 'invalid_db_path', message: 'db_path required' };
  if (raw === ':memory:') {
    // :memory: is fine — mostly useful for tests; executor creates a fresh
    // in-process handle so no state is shared across calls.
  } else {
    if (raw.includes('..')) return { error: 'invalid_db_path', message: 'path traversal blocked' };
    if (!SQLITE_ALLOWED_PATH_PREFIXES.some(p => raw.startsWith(p))) {
      return { error: 'invalid_db_path', message: 'sqlite db_path must live under /var/lib/quox or /tmp' };
    }
  }
  let db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(raw, { readonly: true, fileMustExist: raw !== ':memory:' });
    db.pragma('query_only = ON');
  } catch (err) {
    return { error: 'db_open_failed', message: String(err?.message || err).slice(0, 200) };
  }
  return { db };
}

async function database({ tool, input }) {
  if (!tool) return { ok: false, error: 'invalid_invocation' };
  const cfg = tool.tool_config || {};
  const connCfg = tool.connector_config || {};

  if (!connCfg.driver || !SUPPORTED_DRIVERS.has(connCfg.driver)) {
    return { ok: false, error: 'unsupported_driver', message: `driver ${connCfg.driver || '(unset)'} — only sqlite supported in CW-9.6` };
  }
  if (!cfg.query_template) return { ok: false, error: 'missing_query_template' };

  // Re-run the validator at execute time as defence in depth — the template
  // came from the DB but could have been tampered with, and cheap validation
  // is worth running on every call.
  const v = validateReadOnlySqlTemplate(cfg.query_template, { allowedTables: cfg.allowed_tables || [] });
  if (!v.ok) return { ok: false, error: v.error, message: v.message };

  // Bind parameters — better-sqlite3 uses `:name` natively; any param that
  // appears in the SQL but not in input is a hard error (no silent NULL).
  const paramNames = extractParamNames(cfg.query_template);
  const bindObj = {};
  for (const n of paramNames) {
    if (!Object.prototype.hasOwnProperty.call(input || {}, n)) {
      return { ok: false, error: 'missing_param', message: `parameter :${n} not supplied` };
    }
    bindObj[n] = input[n];
  }

  const rowLimit = Math.min(Math.max(Number.isFinite(cfg.row_limit) ? cfg.row_limit : DB_ROW_LIMIT_DEFAULT, 1), DB_ROW_LIMIT_MAX);
  const timeoutMs = Math.min(Math.max(Number.isFinite(cfg.timeout_ms) ? cfg.timeout_ms : DB_TIMEOUT_DEFAULT_MS, 500), DB_TIMEOUT_MAX_MS);

  const opened = sqliteOpen(connCfg);
  if (opened.error) return { ok: false, error: opened.error, message: opened.message };
  const db = opened.db;

  try {
    // Apply the row-limit ceiling via SQLite's busy_timeout and the
    // application-level ceiling. Drivers handle LIMIT differently across
    // dialects, so we enforce via post-fetch slicing — simpler + consistent.
    db.pragma(`busy_timeout = ${timeoutMs}`);
    const stmt = db.prepare(cfg.query_template);
    // Execute with a node-side timeout fence — better-sqlite3 is synchronous,
    // so we just rely on busy_timeout + row-limit to bound cost.
    const all = stmt.all(bindObj);
    const truncated = all.length > rowLimit;
    const rows = truncated ? all.slice(0, rowLimit) : all;
    return {
      ok: true,
      result: {
        rows,
        row_count: rows.length,
        truncated,
      },
    };
  } catch (err) {
    return { ok: false, error: 'query_failed', message: String(err?.message || err).slice(0, 200) };
  } finally {
    try { db.close(); } catch { /* noop */ }
  }
}

// QCX-9 — QuoxFlow connector. Triggers a workflow with the LLM tool's
// input as triggerData; returns the execution result. The audited path:
// every call goes through QuoxFlow's own audit + run-state machine, so
// admins can replay the workflow side from the QuoxFlow logs alongside
// the AEE/VOLT trail this connector emits chat-side.
async function quoxflow({ widget, tool, input, context }) {
  const cfg = tool?.connector_config || {};
  const workflowId = cfg.workflow_id;
  if (!workflowId || typeof workflowId !== 'string') {
    return { ok: false, error: 'invalid_connector', message: 'quoxflow connector requires workflow_id' };
  }
  const baseUrl = process.env.QUOXFLOW_URL || 'http://quoxflow:3200';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
  const triggerData = {
    input,
    widget_id: widget?.id || null,
    conversation_id: context?.conversation_id || null,
    visitor_id: context?.visitor_id || null,
    orgId: widget?.org_id || null,
    invoked_at: new Date().toISOString(),
  };
  try {
    const resp = await fetch(`${baseUrl}/api/workflows/${encodeURIComponent(workflowId)}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
      },
      body: JSON.stringify({ triggerData, async: cfg.async === true }),
      signal: AbortSignal.timeout(Math.min(Math.max(Number.isFinite(cfg.timeout_ms) ? cfg.timeout_ms : 15000, 1000), 60000)),
    });
    if (resp.status === 404) {
      return { ok: false, error: 'workflow_not_found', message: `workflow ${workflowId} not found` };
    }
    if (!resp.ok) {
      return { ok: false, error: 'workflow_failed', status: resp.status, message: `quoxflow returned ${resp.status}` };
    }
    const body = await resp.json().catch(() => ({}));
    const result = body?.data || body;
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: 'connector_error', message: String(err?.message || err).slice(0, 200) };
  }
}

const CONNECTOR_EXECUTORS = {
  rest_api: restApi,
  webhook,
  database,
  quoxflow,
};

// QCL-SECURITY P1-5 — classify a tool as side-effecting (deny-by-default
// unless the widget policy explicitly allow-lists it). Scope matches the
// audit's named set exactly: webhook connectors (always fire an outbound
// request), rest_api connectors on a write method (GET is read-only),
// and any builtin whose kind/name reads as email/send/pay. Database
// connectors are read-only by construction (validateReadOnlySqlTemplate);
// human_handoff/redirect_url are existing low-risk builtins the audit did
// not flag and are left unaffected. lead_capture is ALSO left out of this
// set deliberately (see CAP_ONLY_BUILTIN_RE below) — it gets a daily-volume
// cap without the allow-list/verified-identity gating this set implies.
const SIDE_EFFECT_BUILTIN_RE = /email|send|pay/i;

// PRO-3 — send_resource's name matches /send/i above by coincidence: it
// makes no outbound call of any kind, it only relays an admin-configured
// allowlisted URL for the LLM to repeat back. Explicitly exempt it here
// rather than loosen SIDE_EFFECT_BUILTIN_RE for every other tool; it still
// gets the daily cap via CAP_ONLY_BUILTIN_RE below.
const SIDE_EFFECT_EXEMPT_BUILTIN_KINDS = new Set(['send_resource']);

// QUOXCHAT-EMAIL D1 — builtin kinds exempt from the verified-identity gate
// because their executor enforces a stronger, kind-specific trust model.
// email_transcript: the recipient is resolved server-side and must be either
// identify()-sourced or captcha-passed (see emailTranscript). Adding a kind
// here without such a model in its executor is a security regression.
const SELF_GUARDED_BUILTIN_KINDS = new Set(['email_transcript']);

function isSideEffectingTool(tool) {
  if (!tool) return false;
  if (tool.tool_type === 'connector') {
    if (tool.connector_type === 'webhook') return true;
    if (tool.connector_type === 'rest_api') {
      const method = String(tool.tool_config?.method || 'GET').toUpperCase();
      return method !== 'GET';
    }
    // QUOXCHAT-BRUTALOOP CONN (finding 31): workflow execution can do anything.
    if (tool.connector_type === 'quoxflow') return true;
    return false;
  }
  if (tool.tool_type === 'builtin') {
    const kind = String(tool.builtin_kind || tool.name || '');
    if (SIDE_EFFECT_EXEMPT_BUILTIN_KINDS.has(kind)) return false;
    return SIDE_EFFECT_BUILTIN_RE.test(kind);
  }
  return false;
}

// QCL-SECURITY P1-5(c) — resolve the recipient the LLM's tool input is
// aiming at, for the `recipient_policy: 'self_only'` guard. Prefers a
// tool-config-declared field name; falls back to common recipient-like
// keys so this works without per-tool config for the common case.
const RECIPIENT_FALLBACK_FIELDS = ['to', 'recipient', 'email', 'recipient_email'];

function extractRecipient(tool, input) {
  if (!input || typeof input !== 'object') return null;
  const declaredField = tool?.tool_config?.recipient_field;
  if (typeof declaredField === 'string' && declaredField && typeof input[declaredField] === 'string') {
    return input[declaredField];
  }
  for (const f of RECIPIENT_FALLBACK_FIELDS) {
    if (typeof input[f] === 'string') return input[f];
  }
  return null;
}

// QCL-SECURITY P1-5(b) — hard per-(widget, day) volume cap on side-effecting
// tool calls, independent of session/conversation_id (the P1-6 partner: a
// caller that opens many conversations — or none — still shares this
// counter). Generous default so an admin who allow-lists a side-effecting
// tool gets protection even if they never think to configure a cap.
const { defaultStore: dailyCapStore } = require('./quoxchatDailyCapStore');
const DEFAULT_DAILY_SIDE_EFFECT_CAP = 100;

// SECURITY AUDIT FIX (finding #4, MEDIUM) — lead_capture had no server-side
// cap of any kind (only the generic per-IP rate limiter upstream), so an
// LLM-mediated loop could flood a widget's HITL lead inbox with junk leads
// under a different fake email each turn. Rather than folding it into
// SIDE_EFFECT_BUILTIN_RE (which would also pull in the allow-list default-
// deny and unverified-visitor gate — breaking every widget's existing
// single-capture flow, which runs today unverified and un-allow-listed),
// lead_capture rides the SAME shared per-(widget, day) counter/cap
// email_transcript already uses, enforced independently of the
// side-effecting branch below. A legitimate single capture per visitor
// stays well under the cap; a flood does not.
//
// PRO-3 — book_demo and create_ticket join the same cap-only treatment for
// the same reason: both only write to the org's own DB (widget_leads /
// HITL inbox), have no external recipient a visitor could redirect, and
// would otherwise regress every widget's existing unverified/un-allow-listed
// flow if pulled into the full side-effecting gate. send_resource joins too,
// even though its name matches /send/i, because it makes no outbound call
// at all — it only looks up a server-side allowlisted URL to relay — so the
// full allow-list/verified-identity gate designed for actual outbound sends
// (email_transcript) is not the right fit; the daily cap alone is enough to
// bound abuse of a read-only lookup.
// PRO-3 action catalog — book_appointment / schedule_demo / leave_message
// join for the same reason as book_demo: they only write to the org's own
// widget_leads table (no external recipient a visitor could redirect), so
// the daily volume cap alone bounds abuse without regressing the default
// unverified/un-allow-listed widget flow.
const CAP_ONLY_BUILTIN_RE = /^(lead_capture|book_demo|create_ticket|send_resource|book_appointment|schedule_demo|leave_message)$/i;

function isCapOnlyBuiltin(tool) {
  if (!tool || tool.tool_type !== 'builtin') return false;
  return CAP_ONLY_BUILTIN_RE.test(String(tool.builtin_kind || tool.name || ''));
}

// ── QCX-ACTIONS P2 — per-visitor monthly action quota ──────────────────────
// Durable counters + the verified per-visitor override live auth-side
// (widget_visitor_usage_monthly / widget_visitors.action_quota_override);
// this helper wraps the two internal endpoints. Returns null on any
// failure so the caller can decide fail-open vs fail-closed explicitly.
async function fetchActionUsage(widgetId, visitorId) {
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) return null;
  try {
    const resp = await fetch(`${authUrl}/api/internal/widgets/${encodeURIComponent(widgetId)}/visitors/${encodeURIComponent(visitorId)}/action-usage`, {
      headers: { 'x-service-key': serviceKey },
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return null;
    return await resp.json().catch(() => null);
  } catch { return null; }
}

async function incrementActionUsage(widgetId, visitorId, sideEffecting) {
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) return;
  try {
    await fetch(`${authUrl}/api/internal/widgets/${encodeURIComponent(widgetId)}/visitors/${encodeURIComponent(visitorId)}/action-usage/increment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
      body: JSON.stringify({ side_effecting: sideEffecting === true }),
      signal: AbortSignal.timeout(2000),
    });
  } catch { /* counting is best-effort; the pre-check is the gate */ }
}

const DEFAULT_QUOTA_EXHAUSTED_MESSAGE = 'This account has used its monthly allowance of AI-assisted actions. The allowance resets next month, or grows with additional services.';

const DRY_RUN_MESSAGES = {
  human_handoff: 'Handing you over to a human, one of our team will pick up shortly.',
  lead_capture: "Thanks, I've passed your details to the team and they will be in touch.",
  leave_message: "Thanks, I've passed your message to the team.",
  book_appointment: "I've requested that appointment and the team will confirm it.",
  book_demo: "I've requested that demo and the team will confirm it.",
  schedule_demo: "I've requested that demo and the team will confirm it.",
  create_ticket: "I've opened a ticket and the team will follow up.",
  email_transcript: "I've emailed you a copy of this conversation.",
};

// Wave 9: simulation runs (Go live self-test) must never fire real side
// effects. redirect_url and send_resource are pure relays so they run normally.
function isDryRunTool(tool) {
  if (!tool) return false;
  if (tool.tool_type === 'connector') return isSideEffectingTool(tool);
  if (tool.tool_type === 'builtin') {
    const kind = String(tool.builtin_kind || tool.name || '');
    return isSideEffectingTool(tool) || Object.hasOwn(DRY_RUN_MESSAGES, kind);
  }
  return false;
}

async function executeTool({ widget, tool, input, context }) {
  if (!widget || !tool) return { ok: false, error: 'invalid_invocation' };

  if (context?.simulation === true && isDryRunTool(tool)) {
    const kind = String(tool.builtin_kind || tool.name || '');
    return {
      ok: true,
      result: {
        dry_run: true,
        ...(kind === 'human_handoff' ? { handed_off: true, notified: true, priority: input?.priority || 'normal' } : {}),
        message: DRY_RUN_MESSAGES[kind] || 'Done, the team has been notified.',
      },
      dry_run: true,
    };
  }

  // QUOXTRUST D4 (complete mediation) — the org GOV-4 governance/safety policy is
  // the SHARED boundary every effect path crosses; the native executeTool choke and
  // the connector bridge already route through it (referenceMonitor). A public
  // widget must not be a way around it: an org policy that denies (or requires
  // approval for) a tool must hold on the widget path too. Checked FIRST for
  // side-effecting tools, exactly as the bridge checks the monitor before its own
  // entitlement/rate gates. A widget visitor is ANONYMOUS and cannot be an approver,
  // so deny / require_approval / store-unavailable all resolve to BLOCK here (the
  // fail-safe reading) — we never mint an orphan approval card for an anonymous
  // visitor. Additive: with no matching org policy this is a no-op (checkStorePolicies
  // returns {policy:null}); it can only ever ADD a block, never clear the widget's
  // own tool_policies gate below.
  if (isSideEffectingTool(tool)) {
    try {
      const { checkStorePolicies, isSafeUnderPolicyOutage } = require('./approvalGate');
      const orgId = widget.org_id || widget.orgId || context?.orgId || null;
      const gov = await checkStorePolicies(tool.name, input || {}, { orgId });
      if (gov.policy && (gov.effect === 'deny' || gov.effect === 'require_approval')) {
        return { ok: false, error: 'policy_denied', message: `${tool.name} is blocked by an organization policy` };
      }
      if (gov.unavailable && !isSafeUnderPolicyOutage(tool.name)) {
        return { ok: false, error: 'policy_unavailable', message: 'this action could not be authorized right now; please try again shortly' };
      }
    } catch (govErr) {
      // Governance store errored on a side-effecting widget tool → fail closed,
      // same posture as the widget policy gate and action-quota blocks below.
      console.warn(`[quoxchat] org governance check errored for side-effecting tool ${tool?.name || tool?.builtin_kind}; failing closed:`, govErr?.message);
      return { ok: false, error: 'policy_unavailable', message: 'this action could not be authorized right now; please try again shortly' };
    }
  }

  // QC-BRUTALOOP-W13 — plan-level tool_calls_per_day cap (entitlements). Counts
  // EVERY tool call per widget per UTC day (in-process, same store as the
  // side-effect cap). The route injects the plan value as
  // tool_policies.plan_tool_calls_per_day_cap; absent/<=0 means not enforced.
  const planToolCap = widget.tool_policies?.plan_tool_calls_per_day_cap;
  if (Number.isFinite(planToolCap) && planToolCap > 0) {
    const planKey = `${widget.id}:plan_tool_calls`;
    if (dailyCapStore.peek(planKey) >= planToolCap) {
      return { ok: false, error: 'rate_limited', message: `this widget has reached its daily tool-call limit (${planToolCap}); please try again tomorrow` };
    }
    dailyCapStore.increment(planKey);
  }

  // QCX-6j / QCL-SECURITY P1-5 — policy gate. widget.tool_policies (if
  // present) is evaluated before any executor runs. Denied → policy_denied
  // result threads through the tool-loop's audit + sanitiser + LLM
  // follow-up turn just like a normal failure, so the model can react ("I'm
  // not allowed to do that") rather than crash.
  try {
    const { evaluateToolPolicy } = require('./quoxchatToolPolicy');
    const sideEffecting = isSideEffectingTool(tool);
    // Finding #4 — lead_capture is capped but NOT side-effecting for policy
    // purposes (default-deny / verified-identity / recipient_policy do not
    // apply to it; only the daily volume counter does).
    const capOnly = !sideEffecting && isCapOnlyBuiltin(tool);
    const cappedForDaily = sideEffecting || capOnly;
    const policy = widget.tool_policies || null;
    const dailyCap = cappedForDaily
      ? (Number.isFinite(policy?.daily_side_effect_cap) && policy.daily_side_effect_cap > 0
          ? policy.daily_side_effect_cap
          : DEFAULT_DAILY_SIDE_EFFECT_CAP)
      : null;
    const dailyCount = (cappedForDaily && dailyCap) ? dailyCapStore.peek(widget.id) : 0;
    if (capOnly && dailyCap && dailyCount >= dailyCap) {
      return { ok: false, error: 'policy_denied', message: `${tool.name} exceeded the widget's daily cap (${dailyCap})` };
    }
    const recipientPolicy = tool.tool_config?.recipient_policy || null;
    // QUOXCHAT-EMAIL D1 — builtins whose executor implements its own
    // recipient-trust model (identify-sourced recipient, or captcha-passed
    // chat-sourced recipient) are exempt from the blanket verified-identity
    // gate ONLY. Hardcoded on builtin_kind, never from widget config, so
    // neither an admin nor a prompt-injected LLM can mint exemptions.
    const selfGuarded = tool.tool_type === 'builtin' && SELF_GUARDED_BUILTIN_KINDS.has(String(tool.builtin_kind || ''));
    const verdict = evaluateToolPolicy(policy, {
      name: tool.name,
      side_effecting: sideEffecting,
      self_guarded: selfGuarded,
      verified: context?.verified === true,
      daily_cap: dailyCap,
      daily_count: dailyCount,
      recipient_policy: sideEffecting ? recipientPolicy : null,
      recipient: sideEffecting ? extractRecipient(tool, input) : null,
      identified_email: context?.identified_email || null,
      // CAPTCHA #127 — OFF BY DEFAULT. Only meaningful when widget.tool_policies
      // .bot_protection.enabled === true (see quoxchatToolPolicy.js); undefined
      // context.human_verified (bot_protection disabled/not-configured) is a no-op.
      human_verified: context?.human_verified === true,
    });
    if (!verdict.allow) {
      return { ok: false, error: 'policy_denied', message: verdict.reason || 'policy_denied' };
    }
    // Only count actual executions that passed the gate — a denied call
    // never consumes the daily budget.
    if (cappedForDaily && dailyCap) dailyCapStore.increment(widget.id);
  } catch (policyErr) {
    // QUOXTRUST T9 / D4 complete-mediation (2026-09-25) — the policy gate is
    // THE enforcement boundary for widget tool calls; if it THROWS we cannot
    // claim the call was authorized. The original bare `catch {}` fell THROUGH
    // to the executor on any exception (a malformed widget.tool_policies, a bug
    // in evaluateToolPolicy, a throw from extractRecipient/dailyCapStore) — a
    // fail-OPEN on exactly the side-effecting tools the gate exists to guard,
    // and the codex-cited D4 bypass. Fail CLOSED for side-effecting tools,
    // matching the action_quota block's own rule immediately below ("side-
    // effecting calls fail closed when the counter can't be read; read-only
    // calls fail open"). A read-only tool still tolerates a missing/erroring
    // optional policy module so a benign read is never broken.
    if (isSideEffectingTool(tool)) {
      console.warn(`[quoxchat] policy gate errored for side-effecting tool ${tool?.name || tool?.builtin_kind}; failing closed:`, policyErr?.message);
      return { ok: false, error: 'policy_unavailable', message: 'this action could not be authorized right now; please try again shortly' };
    }
    /* read-only tool: a missing/erroring optional policy module must not break a benign read */
  }

  // QCX-ACTIONS P2 — per-visitor monthly action quota. Only active when the
  // widget configures tool_policies.action_quota (no config → no lookups,
  // zero behaviour change). A verified per-visitor override (set by the
  // host's signed identify payload — "quota grows with paid services")
  // takes precedence over the widget default. Side-effecting calls FAIL
  // CLOSED when the counter can't be read; read-only calls fail open.
  let countThisCall = false;
  const quotaVisitorId = typeof context?.visitor_id === 'string' && context.visitor_id !== 'anon' ? context.visitor_id : null;
  const quota = widget.tool_policies?.action_quota;
  if (quota && typeof quota === 'object' && !Array.isArray(quota) && quotaVisitorId) {
    const sideEffecting = isSideEffectingTool(tool);
    const mode = quota.count === 'all' ? 'all' : 'side_effecting';
    countThisCall = mode === 'all' || sideEffecting;
    if (countThisCall) {
      const usage = await fetchActionUsage(widget.id, quotaVisitorId);
      if (!usage) {
        if (sideEffecting) {
          return { ok: false, error: 'action_quota_unverifiable', message: 'the action allowance could not be verified right now; please try again shortly' };
        }
        countThisCall = false; // read-only under 'all': fail open, uncounted
      } else {
        const cap = Number.isInteger(usage.action_quota_override) && usage.action_quota_override >= 0
          ? usage.action_quota_override
          : (Number.isFinite(quota.per_visitor_monthly_cap) && quota.per_visitor_monthly_cap > 0
              ? quota.per_visitor_monthly_cap
              : null);
        if (cap !== null) {
          const used = mode === 'all' ? (usage.tool_calls || 0) : (usage.side_effect_calls || 0);
          if (used >= cap) {
            const msg = typeof quota.exhausted_message === 'string' && quota.exhausted_message.trim()
              ? quota.exhausted_message.trim().slice(0, 500)
              : DEFAULT_QUOTA_EXHAUSTED_MESSAGE;
            return { ok: false, error: 'action_quota_exhausted', message: msg };
          }
        }
      }
    }
  }

  try {
    if (tool.tool_type === 'builtin') {
      // AGENT-OVERHAUL: own-property-safe lookup. A plain bracket lookup
      // (BUILTIN_EXECUTORS[tool.builtin_kind]) walks the prototype chain, so
      // a builtin_kind equal to an inherited Object.prototype member name
      // (toString, constructor, hasOwnProperty, __proto__, ...) would resolve
      // to that inherited value instead of undefined, letting it slip past
      // the unknown_builtin guard. Object.hasOwn() gates the lookup so any
      // such key falls through to the honest unknown_builtin error.
      const exec = Object.hasOwn(BUILTIN_EXECUTORS, tool.builtin_kind) ? BUILTIN_EXECUTORS[tool.builtin_kind] : undefined;
      if (!exec) return { ok: false, error: 'unknown_builtin', message: `no executor for ${tool.builtin_kind}` };
      const out = await exec({ widget, tool, input, context });
      // QCX-ACTIONS P2 — only a SUCCESSFUL execution consumes quota.
      if (countThisCall && out?.ok === true) await incrementActionUsage(widget.id, quotaVisitorId, isSideEffectingTool(tool));
      return out;
    }
    if (tool.tool_type === 'connector') {
      // Same own-property-safe lookup as above — see comment there.
      const exec = Object.hasOwn(CONNECTOR_EXECUTORS, tool.connector_type) ? CONNECTOR_EXECUTORS[tool.connector_type] : undefined;
      if (!exec) return { ok: false, error: 'unknown_connector', message: `no executor for ${tool.connector_type}` };
      const out = await exec({ widget, tool, input, context });
      if (countThisCall && out?.ok === true) await incrementActionUsage(widget.id, quotaVisitorId, isSideEffectingTool(tool));
      return out;
    }
    return { ok: false, error: 'unknown_tool_type', message: String(tool.tool_type) };
  } catch (err) {
    return { ok: false, error: 'executor_threw', message: String(err?.message || err).slice(0, 200) };
  }
}

// Registration hooks so later phases can swap stubs without editing this file.
function registerBuiltin(kind, fn) {
  if (typeof fn !== 'function') throw new Error('registerBuiltin requires a function');
  BUILTIN_EXECUTORS[kind] = fn;
}

function registerConnector(connector_type, fn) {
  if (typeof fn !== 'function') throw new Error('registerConnector requires a function');
  CONNECTOR_EXECUTORS[connector_type] = fn;
}

/**
 * QUOXCHAT-BRUTALOOP: offer email_transcript to the model only when it can
 * actually deliver for this visitor (trusted identify-sourced email, or bot
 * protection configured so a chat-typed address can be verified). Offering
 * an undeliverable tool made the bot collect an email and then fail.
 */
function transcriptDeliverable({ humanVerified, visitorVerified, emailSource } = {}) {
  if (visitorVerified === true && emailSource === 'identify') return true;
  return humanVerified !== undefined;
}

module.exports = {
  transcriptDeliverable,
  executeTool,
  registerBuiltin,
  registerConnector,
  BUILTIN_EXECUTORS,
  CONNECTOR_EXECUTORS,
  // Exposed for testing — implementations are swappable via register* hooks.
  leadCapture,
  humanHandoff,
  redirectUrl,
  normaliseRedirectUrl,
  emailTranscript,
  _transcriptSentStore,
  bookDemo,
  createTicket,
  sendResource,
  bookAppointment,
  scheduleDemo,
  leaveMessage,
  restApi,
  webhook,
  database,
  extractParamNames,
  substitutePlaceholders,
  substituteBodyTemplate,
  extractJsonPath,
  resolveSecret,
  registerVaultResolver,
  connectorSecretRef,
  // QCL-SECURITY P1-5
  isSideEffectingTool,
  extractRecipient,
  DEFAULT_DAILY_SIDE_EFFECT_CAP,
  // SECURITY AUDIT FIX (finding #4)
  isCapOnlyBuiltin,
};
