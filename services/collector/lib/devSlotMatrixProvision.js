'use strict';

/**
 * devSlotMatrixProvision.js — DEVSUITE-SLOTS #456 phase 4: the collector's
 * client for deriving a Matrix room per slot through the existing M-ROOMS
 * path (design in QuoxPlan DEVSUITE-SLOTS plan v2 section 2b).
 *
 * Same shape as quoxchatMatrixRelay.js's provisionHandoffRoom(): POST auth's
 * service-key-gated /api/internal/matrix/provision-node (the exact call the
 * tasks service makes for agentic_team rooms), fail-soft by contract — a
 * Matrix or auth-service outage must NEVER fail the slot create/checkout/
 * retire response that triggered it. Callers treat a null/false return as
 * "not this attempt"; the auth-side matrix_rooms ledger stays 'pending' and
 * the next trigger (a later checkout, per the design) retries.
 *
 * dev_slots.matrix_room_id (collector DB) is a denorm cache only, written
 * back here via devSlotsStore.setSlotRoomId after a successful provision.
 * The matrix_rooms ledger in auth (UNIQUE(org_id, node_type, node_id)) is
 * the mapping TRUTH, per the substrate-native law — this module never
 * creates a second registry, it only calls the one that already exists.
 */

const AUTH_URL = () => process.env.AUTH_SERVICE_URL || 'http://auth:3101';
const AUTH_KEY = () => process.env.INTERNAL_SERVICE_KEY || null;
// Phase 5 (say route): same appservice reachability + key precedent as
// quoxchatMatrixRelay.js — host.docker.internal because the appservice
// (separate compose project) publishes :9860 on the docker bridge gateway.
const APPSERVICE_URL = () => (process.env.MATRIX_APPSERVICE_URL || 'http://host.docker.internal:9860').replace(/\/+$/, '');
const APPSERVICE_KEY = () => process.env.PROVISION_SERVICE_KEY || process.env.INTERNAL_SERVICE_KEY || null;

// Provisioning a slot room is NOT a quick lookup: auth calls the appservice,
// which creates a Matrix room, stamps its state events and invites members.
// The old 5s ceiling aborted the CLIENT while the server carried on and
// finished the work, so the room existed but its id was never written back and
// the slot looked room-less forever. Observed 2026-08-18: a create timed out at
// 5s, and an immediate retry returned status "exists" with a real room_id in
// 210ms. That is the signature of a timeout that is too short, not a service
// that is down. 30s matches what the operation actually does on a loaded box.
const AUTH_TIMEOUT_MS = Number(process.env.DEV_SLOT_AUTH_TIMEOUT_MS) || 30000;

async function authPost(path, body, { timeoutMs = AUTH_TIMEOUT_MS } = {}) {
  const key = AUTH_KEY();
  if (!key) {
    // #574: was a silent null. With no INTERNAL_SERVICE_KEY the slot room
    // never provisions and never writes back, but nothing said so — the
    // downstream "pending (status=unreachable)" line misattributed a missing
    // key to a network fault. Name the real cause.
    console.warn(`[DevSlotMatrix] INTERNAL_SERVICE_KEY not set; cannot reach auth to provision slot room (${path})`);
    return null;
  }
  try {
    const resp = await fetch(`${AUTH_URL()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': key },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.warn(`[DevSlotMatrix] auth ${path} returned ${resp.status}: ${text.slice(0, 200)}`);
      return null;
    }
    return await resp.json().catch(() => null);
  } catch (err) {
    console.warn(`[DevSlotMatrix] auth ${path} failed: ${err.message}`);
    return null;
  }
}

/**
 * Provision (or adopt) the Matrix room for one slot via auth's
 * provision-node. Returns the room id when the room went active this call,
 * else null (row stays pending on the auth side; a later checkout retries).
 *
 * @param {object} p
 * @param {string} p.orgId
 * @param {string} p.slotId - dev_slots.id, the ledger's node_id
 * @param {string} p.label - human room name, e.g. "Slots > builder"
 * @returns {Promise<string|null>} the Matrix room id, or null
 */
async function provisionSlotRoom({ orgId, slotId, label }) {
  if (!orgId || !slotId) return null;
  const result = await authPost('/api/internal/matrix/provision-node', {
    org_id: orgId,
    node_type: 'dev_slot',
    node_id: slotId,
    label,
  });
  const roomId = result && result.row && result.row.room_id ? result.row.room_id : null;
  if (!roomId) {
    console.warn(`[DevSlotMatrix] provision for slot ${slotId} pending (status=${result ? result.status : 'unreachable'})`);
  }
  return roomId;
}

/**
 * Retire the Matrix room for one slot via auth's deprovision-node. Fail-soft:
 * returns true only on a confirmed retire; a failure just means the ledger
 * row is left for a later retry, never blocking the slot retire response.
 *
 * @param {object} p
 * @param {string} p.orgId
 * @param {string} p.slotId - dev_slots.id, the ledger's node_id
 * @returns {Promise<boolean>}
 */
async function deprovisionSlotRoom({ orgId, slotId }) {
  if (!orgId || !slotId) return false;
  const result = await authPost('/api/internal/matrix/deprovision-node', {
    org_id: orgId,
    node_type: 'dev_slot',
    node_id: slotId,
  });
  return !!(result && (result.status === 'retired' || result.status === 'exists'));
}

/**
 * Localpart-safe puppet identity for a slot's `say` messages, mirroring
 * quoxchatMatrixRelay.js's puppetForConversation() shape: charset
 * [a-z0-9_-] (the appservice enforces it), tail-sliced so a ULID-shaped id
 * keeps its distinctive half. `slot_<id-tail>` deliberately does not reuse
 * quoxchat's `qc_` prefix — different puppet family, same room, so an
 * operator scanning a room's member list can tell a slot say apart from a
 * QuoxChat visitor at a glance.
 */
function puppetForSlot(slotId) {
  const id = String(slotId || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return { localpart: `slot_${id.slice(-12)}` };
}

/**
 * QUOXIDENTITY DEFECT #1: is a Matrix event's sender the slot's OWN puppet
 * (i.e. one relaySlotMessage itself posted via say/steer)? A room-wide
 * inbound webhook has no way to distinguish "a human/bridge posted" from
 * "we just posted and the room echoed it back to us" except by sender mxid,
 * so the inbound-by-room route must exclude this sender or every say/steer
 * would re-ingest itself as a new inbound message.
 *
 * @param {string} sender - Matrix mxid, e.g. "@slot_ab12cd34ef56:quox.example"
 * @param {string} slotId - dev_slots.id
 * @returns {boolean}
 */
function isSlotsOwnPuppetSender(sender, slotId) {
  if (!sender || !slotId) return false;
  const puppet = puppetForSlot(slotId);
  const match = /^@([^:]+):/.exec(String(sender));
  const localpart = match ? match[1] : String(sender).replace(/^@/, '');
  return localpart === puppet.localpart;
}

/**
 * Relay one `quox slot say` message into the slot's room as its slot_
 * puppet, via the same appservice /internal/relay-message path
 * quoxchatMatrixRelay.js's relayVisitorMessage() uses (no new appservice
 * endpoint). Fail-soft: returns the appservice event id or null.
 *
 * @param {object} p
 * @param {string} p.roomId
 * @param {string} p.slotId - dev_slots.id, source of the puppet localpart
 * @param {string} p.slotName - human-readable, used as the displayname
 * @param {string} p.text
 * @param {string} [p.from] - the session/human name behind the say, folded
 *   into the displayname so the room shows who actually spoke.
 * @returns {Promise<string|null>}
 */
async function relaySlotMessage({ roomId, slotId, slotName, text, from }) {
  const key = APPSERVICE_KEY();
  if (!key || !roomId || !slotId || !text) return null;
  const puppet = puppetForSlot(slotId);
  const displayname = from ? `${from} (${slotName || 'slot'})` : `Slot ${slotName || slotId}`;
  try {
    const resp = await fetch(`${APPSERVICE_URL()}/internal/relay-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': key },
      body: JSON.stringify({
        room_id: roomId,
        agent_localpart: puppet.localpart,
        displayname,
        body: text,
        // Slot rooms are created by their resident agent puppet (quox), not
        // the AS bot, so the bot cannot invite new puppets into them. Name
        // the room's default agent as the inviter; the appservice falls back
        // to the bot path when this is absent (quoxchat rooms).
        inviter_localpart: 'quox',
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn(`[DevSlotMatrix] relay-message returned ${resp.status} for ${roomId}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = await resp.json().catch(() => ({}));
    return data.event_id || null;
  } catch (err) {
    console.warn(`[DevSlotMatrix] relay-message failed for ${roomId}: ${err.message}`);
    return null;
  }
}

// DEVSUITE-SLOTS P6: outbound rendering to the owner's phone. When a bridge
// room is configured (the mautrix-telegram portal room with set-relay
// active), every slot `say` also renders a `[name] text` line there as the
// slot's puppet; the bridge relays it to Telegram. The slot ROOM remains the
// witnessed truth; this line is rendering only. Fail-soft: a bridge outage
// must never fail a say. The puppet must already be a member of the bridge
// room (one-time invite per slot, see scripts/slot-bridge-invite.sh) because
// relay-message's inviter fallbacks are not members of that room either.
//
// Phase 9: room resolution moved OUT of this module into the caller (server.js
// resolves the org's dev_slot_bridges row, falling back to
// QUOX_SLOT_BRIDGE_ROOM / QUOX_SLOT_DISCORD_ROOM only when no row exists —
// see the no-env-only-config house rule). renderSlotLineToBridge now just
// takes the resolved `rooms` array and fans out to each, fail-soft per room.

async function relayLineToRoom({ roomId, slotId, slotName, text, from }) {
  const key = APPSERVICE_KEY();
  const puppet = puppetForSlot(slotId);
  try {
    const resp = await fetch(`${APPSERVICE_URL()}/internal/relay-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': key },
      body: JSON.stringify({
        room_id: roomId,
        agent_localpart: puppet.localpart,
        displayname: from ? `${from} (${slotName || 'slot'})` : `Slot ${slotName || slotId}`,
        body: `[${slotName}] ${text}`,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn(`[DevSlotMatrix] bridge render returned ${resp.status} for slot ${slotName} -> ${roomId}: ${body.slice(0, 200)}`);
      return { ok: false, reason: describeRelayFailure(resp.status, body) };
    }
    const data = await resp.json().catch(() => ({}));
    return { ok: true, eventId: data.event_id || null };
  } catch (err) {
    console.warn(`[DevSlotMatrix] bridge render failed for slot ${slotName} -> ${roomId}: ${err.message}`);
    return { ok: false, reason: err.name === 'TimeoutError' ? 'the bridge did not respond in time' : err.message };
  }
}

/**
 * Turn a relay failure into something a person can act on.
 *
 * The raw body is a Matrix error inside a JSON wrapper inside an HTTP status,
 * e.g. `502 {"error":"relay_failed","message":"M_FORBIDDEN: You are not invited
 * to this room. (http://synapse:8008/_matrix/client/v3/rooms/%21wcW...)"}`.
 * Printing that at a customer is not reporting, it is forwarding.
 */
function describeRelayFailure(status, body) {
  const text = String(body || '');
  if (/M_FORBIDDEN|not invited/i.test(text)) {
    return 'the slot could not join that room; invite a Quox agent user to it once and it will self-heal';
  }
  if (/M_NOT_FOUND|unknown room/i.test(text)) return 'that room does not exist';
  if (status === 401 || status === 403) return 'the appservice rejected our credentials';
  if (status >= 500) return `the bridge returned ${status}`;
  return `the bridge returned ${status}`;
}

// A Discord bridge target may be a WEBHOOK URL instead of a Matrix portal room.
//
// Why this exists (2026-08-18, the hard way): mautrix-discord cannot hold a
// stable gateway connection with a bot account on this deployment. It logs
// `4002 Error while decoding payload` and reconnects roughly every 20 seconds,
// and Discord's abuse protection auto-reset the bot token after 1000+
// connections. Routing outbound through a webhook needs NO gateway connection
// at all: it is one HTTPS POST, so there is nothing to loop and nothing to get
// banned. It is also far less setup for a customer than bridging a portal.
//
// Trade-off, stated honestly: a webhook is OUTBOUND ONLY. Steering a slot from
// Discord still needs the bridge. Rendering is the part customers asked for.
const DISCORD_WEBHOOK_RE = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\//i;

function isDiscordWebhook(target) {
  return typeof target === 'string' && DISCORD_WEBHOOK_RE.test(target.trim());
}

/**
 * Owner 2026-10-05: "They aren't using it bro. Save my eyes." Sessions keep
 * posting updates as one long paragraph and running sessions never reload the
 * skill that says not to, so the renderer does it: a message with NO line
 * breaks that is longer than READABLE_MIN gets one sentence per line. Anything
 * already carrying a line break was formatted on purpose and is left alone.
 * Only the Discord rendering changes; the stored message is untouched.
 */
const READABLE_MIN = 120;
const NO_SPLIT_BEFORE = /\b(e\.g|i\.e|etc|vs|approx|incl|no|fig|cf|mr|ms|dr)\.$/i;
function splitSentences(s) {
  const out = [];
  let cur = '';
  // Sentence end = . ! ? (optionally closing ) " ') then whitespace, then a
  // capital, digit, '(', emoji/glyph, # or *. Versions/decimals have no space
  // after the dot, so they never match.
  const re = /([.!?][)"']?)\s+(?=[A-Z0-9(#*①-➿\u{1F300}-\u{1FAFF}])/gu;
  let last = 0; let m;
  while ((m = re.exec(s)) !== null) {
    const end = m.index + m[1].length;
    const piece = s.slice(last, end);
    if (NO_SPLIT_BEFORE.test(piece.trimEnd())) continue;
    cur += piece;
    out.push(cur.trim());
    cur = '';
    last = re.lastIndex;
  }
  cur += s.slice(last);
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Owner 2026-10-05: "could be more use of bold text". A short leading label
// ("Root cause:", "Fix:", "Next step:") reads as a heading when bolded.
function boldLabel(text) {
  const m = text.match(/^([A-Za-z][A-Za-z0-9 /&'-]{0,28}):\s+(.*)$/);
  if (!m || m[1].split(/\s+/).length > 4 || text.startsWith('**')) return text;
  return `**${m[1]}:** ${m[2]}`;
}

// Status words get bold everywhere (outside `code` and existing **bold**).
const STATUS_WORDS = /\b(DONE|FIXED|SHIPPED|DEPLOYED|LIVE|VERIFIED|PROVEN|MERGED|CLOSED|BLOCKED|FAILED|FAILING|BROKEN|DOWN|PENDING|WAITING|TODO|NEXT|WARNING|URGENT)\b/g;
function boldStatusWords(text) {
  return text.split(/(`[^`]*`|\*\*[^*]+\*\*)/).map((seg, i) => (i % 2 === 1 ? seg : seg.replace(STATUS_WORDS, '**$1**'))).join('');
}

function bulletsFor(sentence) {
  // Numbered items "(1) ... (2) ..." each become their own bullet; inside a
  // still-long item, semicolon clauses become sub-bullets.
  const items = sentence.split(/\s+(?=\(\d{1,2}\)\s)/).map((x) => x.trim()).filter(Boolean);
  const lines = [];
  for (const item of items) {
    const clauses = item.length > 120 ? item.split(/;\s+/).map((x) => x.trim()).filter(Boolean) : [item];
    lines.push(`- ${boldLabel(clauses[0])}`);
    for (const c of clauses.slice(1)) lines.push(`  - ${c}`);
  }
  return lines;
}

function reflow(s) {
  if (s.includes('\n') || s.length <= READABLE_MIN) return s;
  const sentences = splitSentences(s);
  if (sentences.length < 2) return s;
  const [head, ...rest] = sentences;
  const headline = !head.includes('**') && head.length <= 200 ? `**${head}**` : head;
  return [headline, ...rest.flatMap(bulletsFor)].join('\n');
}

function readableForDiscord(text) {
  const s = String(text == null ? '' : text);
  return boldStatusWords(reflow(s));
}

/**
 * Split a say into parts of at most `max` chars for Discord (quox#485): break
 * at a paragraph, else a line, else a word boundary, and hard-cut only a
 * single unbroken run longer than `max`. Nothing is dropped.
 */
function splitForDiscord(text, max = 1900) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return [s];
  const parts = [];
  let rest = s;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max * 0.3) cut = window.lastIndexOf('\n');
    if (cut < max * 0.3) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest.length) parts.push(rest);
  return parts;
}

/**
 * Post one slot line to a Discord webhook. The slot name becomes the sender,
 * so a reader sees WHICH slot spoke rather than one generic bot.
 * Fail-soft like every other render path. Never logs the URL: it carries a
 * token.
 *
 * A say longer than one Discord message used to be silently cut at 1900
 * chars (quox#485: a six-issue reply ended mid-sentence). It now goes out as
 * ordered posts marked (n/N); a failure part-way is reported, not hidden.
 */
async function renderSlotLineToWebhook({ slotName, text, from, url }) {
  const tag = `[${slotName}] `;
  const body = readableForDiscord(text);
  // Budget for the "(nn/nn) " marker so every post stays under 1900.
  const parts = splitForDiscord(body, 1900 - tag.length - 8);
  const total = parts.length;
  for (let i = 0; i < total; i += 1) {
    const marker = total > 1 ? `(${i + 1}/${total}) ` : '';
    const res = await postWebhookPart({ slotName, from, url, content: `${tag}${marker}${parts[i]}` });
    if (!res.ok) {
      return total > 1 ? { ok: false, reason: `${res.reason} (part ${i + 1}/${total}; earlier parts were posted)` } : res;
    }
  }
  return { ok: true, eventId: 'webhook' };
}

async function postWebhookPart({ slotName, from, url, content }) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: from ? `${from} (${slotName || 'slot'})` : `${slotName || 'slot'} (slot)`,
        content: content.slice(0, 2000),
        // A slot line must never be able to ping @everyone just by containing
        // the text: the sender is an agent session, not a person choosing to.
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      console.warn(`[DevSlotMatrix] discord webhook returned ${resp.status} for slot ${slotName}`);
      return {
        ok: false,
        reason: resp.status === 404
          ? 'that webhook no longer exists in Discord'
          : `Discord returned ${resp.status}`,
      };
    }
    return { ok: true };
  } catch (err) {
    console.warn(`[DevSlotMatrix] discord webhook failed for slot ${slotName}: ${err.message}`);
    return { ok: false, reason: err.name === 'TimeoutError' ? 'Discord did not respond in time' : err.message };
  }
}

/**
 * Render one slot line into every configured bridge, and REPORT what happened
 * to each.
 *
 * Why it reports (2026-08-18, found by driving it): this returned the first
 * successful event id and dropped everything else on the floor, so a say that
 * reached Discord and failed on Telegram was indistinguishable from a say that
 * reached both. `quox slot say demo` printed "Said into demo." while the
 * collector logged `bridge render returned 502` for Telegram in the same
 * second. The owner's report was "I say something and never see it", and this
 * is why they could not tell which half was broken.
 *
 * Delivery stays FAIL-SOFT: one bridge being down must never stop the others,
 * and never fails the say, because the witnessed record is the cache row and
 * the AEE envelope, not the render. What changes is that the caller now learns
 * the truth and can pass it on.
 *
 * `platform` is inferred from the target shape rather than the config key so
 * the label cannot drift from where the line actually went.
 */
// Discord (plain webhook content) and the Telegram/Matrix bridge both auto-link
// a URL ONLY when it already carries an http(s):// scheme. A bare `quox.ai/x`
// or a `[text](url)` markdown link reaches the owner as dead text (owner report
// 2026-10-10, SEER slot). This adds the scheme to bare quox.ai URLs at the
// bridge render seam so they become clickable, while the witnessed/stored slot
// text (the cache row + AEE envelope the `say` route writes) stays verbatim.
// Scope is deliberately quox.ai and its subdomains: other domains are posted
// with a scheme already, and a narrow target avoids mangling arbitrary text.
const BARE_QUOX_URL = /(^|[\s(<])((?:[a-z0-9-]+\.)*quox\.ai\b(?:\/[^\s<>)\]]*)?)/gi;
function linkifyBareUrls(text) {
  if (text == null) return text;
  return String(text).replace(BARE_QUOX_URL, (m, pre, url) => {
    // Keep trailing sentence punctuation outside the URL so the link ends cleanly.
    const trimmed = url.replace(/[.,;:!?]+$/, '');
    const trail = url.slice(trimmed.length);
    return `${pre}https://${trimmed}${trail}`;
  });
}

async function renderSlotLineToBridge({ slotId, slotName, text, from, rooms } = {}) {
  const roomList = Array.isArray(rooms) ? rooms.filter(Boolean) : [];
  const key = APPSERVICE_KEY();
  if (!roomList.length || !slotId || !text) return { eventId: null, results: [] };
  // Render-time only: the scheme is added to the human-facing bridge copy, not
  // to the canonical slot record.
  const rendered = linkifyBareUrls(text);
  if (!key) {
    return {
      eventId: null,
      results: roomList.map((target) => ({
        target: describeTarget(target),
        platform: isDiscordWebhook(target) ? 'discord' : 'matrix',
        ok: false,
        reason: 'the Matrix appservice key is not configured on this install',
      })),
    };
  }

  const results = await Promise.all(roomList.map(async (target) => {
    const webhook = isDiscordWebhook(target);
    const outcome = webhook
      ? await renderSlotLineToWebhook({ slotName, text: rendered, from, url: target.trim() })
      : await relayLineToRoom({ roomId: target, slotId, slotName, text: rendered, from });
    return {
      target: describeTarget(target),
      platform: webhook ? 'discord' : 'matrix',
      ok: !!outcome?.ok,
      reason: outcome?.ok ? null : (outcome?.reason || 'unknown failure'),
    };
  }));

  const delivered = results.find((r) => r.ok);
  return { eventId: delivered ? 'delivered' : null, results };
}

/**
 * A safe label for a bridge target. A Discord webhook URL carries a token in
 * its path, so it must never be echoed back to a caller or a log line.
 */
function describeTarget(target) {
  const t = String(target || '').trim();
  if (isDiscordWebhook(t)) {
    const id = (t.match(/webhooks\/(\d+)/) || [])[1];
    return id ? `discord webhook ${id}` : 'discord webhook';
  }
  return t;
}

// DEVSUITE-SLOTS phase 10 (POLISH P0, trust): ask the appservice whether a
// room would ACTUALLY carry a slot line to the named platform, before we agree
// to store it as a bridge room.
//
// The audit (QuoxPlan DEVSUITE note #2840, theme S5) found bridge-set was a
// silent no-op: any room id returned 200 and then rendered to nobody. The
// probe is a dry run of relayLineToRoom above (same puppet, same invite, same
// join) plus an m.bridge state read, so a "verified" verdict here means the
// exact code path `say` uses has already succeeded once.
//
// Returns null when the appservice is not configured or unreachable. Null is
// "unknown", never "fine": the caller must decide, and the route treats an
// unknown as a refusal unless the operator forces it.
async function probeBridgeRoom({ roomId, platform } = {}) {
  const key = APPSERVICE_KEY();
  if (!key || !roomId || !platform) return null;
  try {
    const resp = await fetch(`${APPSERVICE_URL()}/internal/bridge-probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': key },
      body: JSON.stringify({ room_id: roomId, platform }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn(`[DevSlotMatrix] bridge probe ${roomId} (${platform}) returned ${resp.status}: ${body.slice(0, 200)}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    console.warn(`[DevSlotMatrix] bridge probe ${roomId} (${platform}) failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  isDiscordWebhook,
  linkifyBareUrls,
  readableForDiscord,
  renderSlotLineToWebhook,
  splitForDiscord,
  provisionSlotRoom,
  deprovisionSlotRoom,
  relaySlotMessage,
  renderSlotLineToBridge,
  probeBridgeRoom,
  // QUOXIDENTITY DEFECT #1: exported so the inbound-by-room route can
  // recognise a slot's own puppet as the sender (a room-wide webhook
  // subscription echoes relaySlotMessage's own say/steer posts back to us;
  // without this they would be re-ingested as new inbound messages).
  puppetForSlot,
  isSlotsOwnPuppetSender,
};
