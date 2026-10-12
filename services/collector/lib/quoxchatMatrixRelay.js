/**
 * QuoxChat Matrix relay — QUOXCHAT-PRO P2 (Option B).
 *
 * Every website chat that requests a human gets its own governed Matrix room
 * (auth-side node_type 'quoxchat', node_id = widget_conversations.id).
 * This lib is the collector's client for the three seams involved:
 *
 *   1. auth internal widget-conversation routes (routes/internal-widget-
 *      matrix.js): handoff lookup, matrix_room_id set/get, visitor/operator
 *      message persistence, by-room resolve;
 *   2. auth's /api/internal/matrix/provision-node (node_type 'quoxchat'),
 *      the same call the tasks service makes for agentic_team rooms;
 *   3. the quox-matrix appservice's /internal/relay-message, which posts the
 *      visitor's text into the room AS a qc_<conv> puppet (puppet senders
 *      are ignored by the appservice responder, so no agent ever
 *      double-answers relayed visitor text).
 *
 * Everything here is fail-soft by contract: a Matrix outage must never break
 * the visitor's chat. Callers treat null returns as "not this turn" — the
 * handed_off conversation with a NULL matrix_room_id is the durable
 * "provision pending" marker, retried on the next visitor message.
 *
 * LICENSE-ENFORCE LE-5: this whole module IS the QUOXCHAT-PRO P2 capability
 * — ordinary chat is gated separately on the base `quoxchat` entitlement
 * (routes/quoxchat.js licenseGuard), which stays unchanged. The Pro-only
 * surface (human handoff getting a live governed Matrix room) is gated here,
 * in provisionHandoffRoom(), the single choke point every handoff path (LLM
 * tool call, action chip, retry-on-next-message) routes through. An org
 * without the `quoxchat-pro` entitlement gets the same fail-soft "provision
 * pending" outcome as a real Matrix outage — never an error surfaced to the
 * visitor.
 */

const { isPluginLicensed: isPluginLicensedForOrg } = require('./licenseGate');

const AUTH_URL = () => process.env.AUTH_SERVICE_URL || 'http://auth:3101';
// The appservice publishes :9860 on the docker bridge gateway precisely so
// the collector (separate compose project) can reach it via
// host.docker.internal — same route approvalGate.js uses for HITL proposals.
const APPSERVICE_URL = () => (process.env.MATRIX_APPSERVICE_URL || 'http://host.docker.internal:9860').replace(/\/+$/, '');
const AUTH_KEY = () => process.env.INTERNAL_SERVICE_KEY || null;
const APPSERVICE_KEY = () => process.env.PROVISION_SERVICE_KEY || process.env.INTERNAL_SERVICE_KEY || null;

async function authGet(path) {
  const key = AUTH_KEY();
  if (!key) return null;
  try {
    const resp = await fetch(`${AUTH_URL()}${path}`, {
      headers: { 'x-service-key': key },
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return null;
    return await resp.json().catch(() => null);
  } catch { return null; }
}

async function authPost(path, body) {
  const key = AUTH_KEY();
  if (!key) return null;
  try {
    const resp = await fetch(`${AUTH_URL()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': key },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.warn(`[QuoxChatMatrix] auth ${path} returned ${resp.status}: ${text.slice(0, 200)}`);
      return null;
    }
    return await resp.json().catch(() => null);
  } catch (err) {
    console.warn(`[QuoxChatMatrix] auth ${path} failed: ${err.message}`);
    return null;
  }
}

/**
 * Word-safe short id for a visitor/conversation id. The old bare slice(-6)
 * mid-chopped word-like ids into gibberish ("proof-visitor" -> "isitor").
 * Rule: split on non-alphanumerics and take the LAST token; a pure-alpha
 * token is a word, so use it whole (capped) instead of chopping; anything
 * with digits is a random id where the trailing 6 chars are the
 * distinctive half (ULIDs/UUIDs).
 */
function shortVisitorLabel(id) {
  const raw = String(id || '').trim();
  if (!raw) return 'anon';
  const tokens = raw.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return 'anon';
  const last = tokens[tokens.length - 1];
  if (/^[a-zA-Z]+$/.test(last)) return last.slice(0, 12).toLowerCase();
  return last.slice(-6).toLowerCase();
}

/** Displayname-safe visitor name: control chars stripped, capped. */
function cleanVisitorName(name) {
  if (typeof name !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return cleaned || null;
}

/**
 * Visitor puppet identity for a conversation. Localpart charset [a-z0-9_-]
 * (the appservice enforces it); ULID tails are the distinctive half, so the
 * short forms use the END of the id. When the visitor gave a name, the
 * displayname is "<Name> (website)" instead of the anonymous short form.
 */
function puppetForConversation(conversationId, visitorName) {
  const id = String(conversationId).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const name = cleanVisitorName(visitorName);
  return {
    localpart: `qc_${id.slice(-12)}`,
    displayname: name
      ? `${name} (website)`
      : `Visitor ${shortVisitorLabel(conversationId)} (website)`,
  };
}

/** Room label for the provisioned room: "QuoxChat · <visitor label>". */
function roomLabelFor(conversation, visitorId) {
  const visitorLabel = cleanVisitorName(conversation?.visitor_name)
    || (conversation && conversation.visitor_email)
    || `Visitor ${shortVisitorLabel(visitorId || conversation?.conversation_id)}`;
  return `QuoxChat · ${visitorLabel}`;
}

/**
 * Latest handed-off conversation for (widget, visitor), or null. The
 * /message gate: while one exists, visitor messages skip the LLM.
 */
async function lookupHandoffConversation(widgetId, visitorId) {
  if (!widgetId || widgetId === 'demo' || !visitorId) return null;
  const data = await authGet(`/api/internal/widget-conversations/handoff?widget_id=${encodeURIComponent(widgetId)}&visitor_id=${encodeURIComponent(visitorId)}`);
  return data && data.conversation ? data.conversation : null;
}

/**
 * Strict variant: distinguishes "no handed-off conversation" ({conversation:
 * null}) from "could not find out" (throws). Codex enum 2 #10: a failed
 * lookup must never be read as "no handoff", or the AI answers inside a
 * conversation a human owns. A missing service key means auth is not
 * configured at all (nothing could be handed off), so that is "none".
 */
async function lookupHandoffConversationStrict(widgetId, visitorId) {
  if (!widgetId || widgetId === 'demo' || !visitorId) return { conversation: null };
  const key = AUTH_KEY();
  if (!key) return { conversation: null };
  const resp = await fetch(`${AUTH_URL()}/api/internal/widget-conversations/handoff?widget_id=${encodeURIComponent(widgetId)}&visitor_id=${encodeURIComponent(visitorId)}`, {
    headers: { 'x-service-key': key },
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) throw new Error(`handoff lookup returned ${resp.status}`);
  const data = await resp.json();
  return { conversation: data && data.conversation ? data.conversation : null };
}

/** Resolve a Matrix room back to its conversation (operator relay in). */
async function resolveConversationByRoom(roomId) {
  if (!roomId) return null;
  return authGet(`/api/internal/widget-conversations/by-room?room_id=${encodeURIComponent(roomId)}`);
}

/** Persist a visitor message sent while handed off (LLM skipped). */
async function persistVisitorMessage(conversationId, content) {
  return authPost(`/api/internal/widget-conversations/${encodeURIComponent(conversationId)}/visitor-message`, { content });
}

/**
 * Widget poll read: operator messages for a conversation, scoped to
 * (widget, visitor) auth-side. Returns { conversation_id, status, messages }
 * or null (not found / not yours / auth unreachable).
 */
async function fetchOperatorMessages(conversationId, widgetId, visitorId, after) {
  if (!conversationId || !widgetId || !visitorId) return null;
  const qs = new URLSearchParams({ widget_id: widgetId, visitor_id: visitorId });
  if (after) qs.set('after', String(after));
  return authGet(`/api/internal/widget-conversations/${encodeURIComponent(conversationId)}/operator-messages?${qs.toString()}`);
}

/** Persist an operator reply relayed out of the room. */
async function persistOperatorMessage(conversationId, content, senderName) {
  return authPost(`/api/internal/widget-conversations/${encodeURIComponent(conversationId)}/operator-message`, { content, sender_name: senderName || null });
}

/**
 * Provision (or adopt) the quoxchat room for a handed-off conversation via
 * auth's provision-node — the exact call the tasks service makes for
 * agentic_team rooms (service-key, fail-soft). Returns the room id when the
 * room went active this call, else null (row stays pending; the NULL
 * matrix_room_id on the conversation is the retry marker).
 *
 * LICENSE-ENFORCE LE-5: requires the org's `quoxchat-pro` entitlement.
 * Checked here rather than upstream so every handoff path (the belt in
 * routes/quoxchat.js, the awaiting-pickup relay, and this function's own
 * retry-on-next-message call) is covered by one gate. Unlicensed orgs fail
 * the same way an unreachable auth/appservice already does — null, room
 * stays pending, visitor sees no error — never a hard failure.
 */
async function provisionHandoffRoom({ orgId, conversationId, label }) {
  if (!orgId || !conversationId) return null;
  let proLicensed = false;
  try {
    proLicensed = await isPluginLicensedForOrg(orgId, 'quoxchat-pro');
  } catch (e) {
    proLicensed = false; // fail closed
  }
  if (!proLicensed) {
    console.warn(`[QuoxChatMatrix] provision for conversation ${conversationId} blocked: org ${orgId} has no quoxchat-pro entitlement`);
    return null;
  }
  const result = await authPost('/api/internal/matrix/provision-node', {
    org_id: orgId,
    node_type: 'quoxchat',
    node_id: conversationId,
    label,
  });
  const roomId = result && result.row && result.row.room_id ? result.row.room_id : null;
  if (!roomId) {
    console.warn(`[QuoxChatMatrix] provision for conversation ${conversationId} pending (status=${result ? result.status : 'unreachable'})`);
    return null;
  }
  // Store the room on the conversation so the operator relay can resolve it
  // by room id and later messages skip re-provisioning.
  await authPost(`/api/internal/widget-conversations/${encodeURIComponent(conversationId)}/matrix-room`, { matrix_room_id: roomId });
  return roomId;
}

/**
 * Stamp the visitor's self-given identity (name/email) onto a conversation
 * row. Auth verifies the conversation belongs to (widget, visitor) so a
 * leaked conversation id alone cannot rename someone else's chat.
 * Fail-soft like everything else here.
 */
async function setConversationVisitorIdentity(conversationId, { widgetId, visitorId, name, email }) {
  if (!conversationId || !widgetId || !visitorId) return null;
  return authPost(`/api/internal/widget-conversations/${encodeURIComponent(conversationId)}/visitor-identity`, {
    widget_id: widgetId,
    visitor_id: visitorId,
    visitor_name: name || null,
    visitor_email: email || null,
  });
}

/**
 * Handover summary prefixed onto the first relayed room message, when known,
 * so operators see why the visitor is here without opening the transcript.
 * Fail-soft by contract: no summary means the body is unchanged.
 */
function withHandoffSummary(text, summary) {
  const clean = typeof summary === 'string' ? summary.trim() : '';
  if (!clean) return text;
  return `Handover summary: ${clean}\n\n${text}`;
}

/**
 * Relay one visitor message into the conversation's room as its qc_ puppet.
 * Fail-soft: returns the appservice event id or null. `summary` (optional)
 * is the human_handoff handover note; when present it is prefixed onto the
 * relayed body so Rooms operators see it without opening the transcript.
 */
async function relayVisitorMessage({ roomId, conversationId, text, visitorName, summary }) {
  const key = APPSERVICE_KEY();
  if (!key || !roomId || !text) return null;
  const puppet = puppetForConversation(conversationId, visitorName);
  const body = withHandoffSummary(text, summary);
  try {
    const resp = await fetch(`${APPSERVICE_URL()}/internal/relay-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': key },
      body: JSON.stringify({
        room_id: roomId,
        agent_localpart: puppet.localpart,
        displayname: puppet.displayname,
        body,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn(`[QuoxChatMatrix] relay-message returned ${resp.status} for ${roomId}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = await resp.json().catch(() => ({}));
    return data.event_id || null;
  } catch (err) {
    console.warn(`[QuoxChatMatrix] relay-message failed for ${roomId}: ${err.message}`);
    return null;
  }
}

/**
 * Ensure a handed-off conversation has a live room, retrying a pending
 * provision, then relay a visitor message into it. Fire-and-forget friendly:
 * never throws. `summary` (optional) is the human_handoff handover note;
 * when present, whichever call provisions/first-relays into the room
 * includes it in that room message. Absent summary = identical behaviour to
 * before this parameter existed.
 */
async function ensureRoomAndRelay({ conversation, orgId, visitorId, text, summary }) {
  try {
    let roomId = conversation.matrix_room_id || null;
    if (!roomId) {
      roomId = await provisionHandoffRoom({
        orgId: orgId || conversation.org_id,
        conversationId: conversation.conversation_id,
        label: roomLabelFor(conversation, visitorId),
      });
    }
    if (!roomId) return null;
    return await relayVisitorMessage({
      roomId,
      conversationId: conversation.conversation_id,
      text,
      visitorName: conversation.visitor_name || null,
      summary,
    });
  } catch (err) {
    console.warn(`[QuoxChatMatrix] ensureRoomAndRelay failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  shortVisitorLabel,
  cleanVisitorName,
  puppetForConversation,
  roomLabelFor,
  withHandoffSummary,
  setConversationVisitorIdentity,
  lookupHandoffConversation,
  lookupHandoffConversationStrict,
  resolveConversationByRoom,
  fetchOperatorMessages,
  persistVisitorMessage,
  persistOperatorMessage,
  provisionHandoffRoom,
  relayVisitorMessage,
  ensureRoomAndRelay,
};
