/**
 * Provider-agnostic outbound-call bridge (COMMANDERQ P10 — "just needs creds + hookups").
 *
 * The P10 call spine decides WHO to call and records/receipts it. This layer is
 * HOW the audio actually gets placed, behind pluggable providers. The whole point:
 * get every provider to the exact point where it works the moment credentials (and,
 * for Discord, the voice bridge) are supplied — and report that gap HONESTLY rather
 * than pretending. Nothing here dials without BOTH real credentials AND an explicit
 * TELEPHONY_LIVE=1 flag, so it is safe to ship un-credentialed.
 *
 * Drivers:
 *   - twilio  : Programmable Voice via the REST API (plain fetch, no SDK). One
 *               step from live: set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
 *               TWILIO_FROM (prod: vault), then TELEPHONY_LIVE=1.
 *   - discord : voice-channel audio. Needs the bigger hookup: @discordjs/voice
 *               installed, a bot token with Connect/Speak, and the audio bridge
 *               wired. Reports needs_hookup until then.
 *
 * readiness(orgId) tells you precisely what's missing; placeOutboundCall never
 * throws — it returns a status the caller records as evidence.
 */

'use strict';

function _env(k) { const v = process.env[k]; return v && String(v).trim() ? String(v).trim() : null; }
const _live = () => _env('TELEPHONY_LIVE') === '1';

// ── twilio ────────────────────────────────────────────────────────────────────
const twilio = {
  channel: 'twilio',
  requires: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'],
  readiness() {
    const missing = this.requires.filter((k) => !_env(k));
    if (missing.length) {
      return { channel: 'twilio', ready: false, needs: missing, kind: 'needs_credentials',
        note: `Set ${missing.join(', ')} (prod: vault), then TELEPHONY_LIVE=1 to dial.` };
    }
    if (!_live()) {
      return { channel: 'twilio', ready: false, needs: ['TELEPHONY_LIVE=1'], kind: 'ready_dry_run',
        note: 'Credentials present. Set TELEPHONY_LIVE=1 to place real calls (guarded off by default).' };
    }
    return { channel: 'twilio', ready: true, needs: [], kind: 'ready', note: 'Credentialed and live-enabled.' };
  },
  async placeCall({ recipient, message }) {
    const r = this.readiness();
    if (!r.ready) return { status: r.kind, provider: 'twilio', needs: r.needs, note: r.note };
    const sid = _env('TWILIO_ACCOUNT_SID'), token = _env('TWILIO_AUTH_TOKEN'), from = _env('TWILIO_FROM');
    // TwiML: a spoken message. A richer flow (gather, bridge to the agent) is a
    // follow-up; this proves the dial path end to end once creds are live.
    const twiml = `<Response><Say voice="Polly.Brian">${String(message || 'This is CommanderQ with an alert.').replace(/[<&]/g, ' ')}</Say></Response>`;
    const body = new URLSearchParams({ To: recipient, From: from, Twiml: twiml });
    try {
      const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body, signal: AbortSignal.timeout(15000),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) return { status: 'provider_error', provider: 'twilio', http: resp.status, error: data && (data.message || data.error) };
      return { status: 'placed', provider: 'twilio', call_sid: data.sid, to: recipient };
    } catch (e) {
      return { status: 'provider_error', provider: 'twilio', error: e.message };
    }
  },
};

// ── discord ─────────────────────────────────────────────────────────────────
const discord = {
  channel: 'discord',
  requires: ['DISCORD_BOT_TOKEN', 'DISCORD_VOICE_CHANNEL_ID', '@discordjs/voice', 'audio bridge'],
  readiness() {
    const missing = [];
    if (!_env('DISCORD_BOT_TOKEN')) missing.push('DISCORD_BOT_TOKEN');
    if (!_env('DISCORD_VOICE_CHANNEL_ID')) missing.push('DISCORD_VOICE_CHANNEL_ID');
    let voiceLib = false;
    try { require.resolve('@discordjs/voice'); voiceLib = true; } catch { missing.push('@discordjs/voice (not installed)'); }
    // The audio bridge (pipe the voice worker's audio into the Discord voice conn)
    // is a real build, not just a dep — always flagged until it exists.
    missing.push('audio bridge (owner-gated build)');
    return { channel: 'discord', ready: false, needs: missing, kind: 'needs_hookup', voiceLib,
      note: 'Needs a Discord bot with Connect/Speak, the voice lib, and the audio bridge wired. The governed spine (consent, intent, receipt) is already done.' };
  },
  async placeCall() {
    const r = this.readiness();
    return { status: 'needs_hookup', provider: 'discord', needs: r.needs, note: r.note };
  },
};

const PROVIDERS = { twilio, discord };
// Logical channel aliases → provider. NOTE: 'sms' is deliberately absent — the
// twilio driver only places VOICE calls (Calls.json/TwiML), so mapping sms here
// would silently voice-dial an sms-consented contact (a channel-scoped-consent
// violation). SMS belongs to a distinct Messages.json provider (future).
const CHANNEL_MAP = { twilio: 'twilio', phone: 'twilio', voice: 'twilio', discord: 'discord' };

function resolveProvider(channel) {
  const key = CHANNEL_MAP[String(channel || '').toLowerCase()];
  return key ? PROVIDERS[key] : null;
}

/** Attempt to place a call; never throws. Un-credentialed => a clean needs_* status. */
async function placeOutboundCall({ channel, recipient, message }) {
  const p = resolveProvider(channel);
  if (!p) return { status: 'no_provider', channel, note: `No call provider for channel '${channel}'.` };
  if (!recipient) return { status: 'no_recipient', provider: p.channel };
  try { return await p.placeCall({ recipient, message }); }
  catch (e) { return { status: 'provider_error', provider: p.channel, error: e.message }; }
}

/** Per-provider readiness — the "what's left before real calls" board. */
function readinessBoard() {
  return Object.values(PROVIDERS).map((p) => p.readiness());
}

module.exports = { placeOutboundCall, readinessBoard, resolveProvider, PROVIDERS, CHANNEL_MAP };
