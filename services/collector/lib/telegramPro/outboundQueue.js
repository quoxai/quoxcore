/**
 * Telegram Outbound Coalescing Queue, QTG-PRO P0.
 *
 * Every outbound Telegram Bot API message for the Telegram Pro subsystem
 * should flow through this queue instead of calling sendMessage directly.
 * It keeps one lane per (bot, chat, thread), paces each lane against the
 * verified platform limits, and degrades to digest-editing under pressure
 * instead of hammering the API and collecting 429s.
 *
 * Verified platform facts (do not relax these numbers without re-checking
 * against Telegram's current published limits):
 *   - ~1 msg/s per chat (burst 1).
 *   - 20 msg/min per group chat (chat ids are negative for groups and
 *     supergroups). This is tighter than the per-chat 1/s pace, so a group
 *     lane sustained at the chat-bucket max rate will eventually run into
 *     this ceiling on its own.
 *   - ~30 msg/s global, per bot token, shared across every chat that bot
 *     talks to.
 *   - editMessageText shares the same flood limits as sendMessage.
 *   - On HTTP 429 the response body carries parameters.retry_after
 *     (seconds). The correct response is to pause that lane for that long
 *     and requeue the failed send at the head of the lane, never drop it.
 *   - Text is capped at 4096 characters; long text is split on line
 *     boundaries where possible rather than mid-word.
 *   - Messages older than 48h cannot be edited; we treat 47h as the cutoff
 *     so a digest never gets caught right at the wire.
 *   - General (the built-in forum topic) must never receive
 *     message_thread_id, not even 1. A null/undefined threadKey means the
 *     field is omitted entirely.
 *
 * Digest mode: once a lane's backlog exceeds 3 queued items, or the
 * estimated time to drain the current backlog through the applicable
 * token buckets exceeds 5s, queued items are coalesced into a single
 * message (joined with newlines) instead of being sent one at a time.
 * If a digest is already open for the lane, the new text is appended via
 * editMessageText; otherwise the coalesced batch becomes a fresh message
 * that anchors a new digest. A digest closes (so the next message is a
 * plain send again) when:
 *   - notifyInbound() is called for that lane (a human reply must never
 *     be buried under a message that keeps getting silently edited), or
 *   - the open digest crosses the 47h edit window, or
 *   - an edit attempt against it fails permanently (falls back to plain
 *     sends for the batch that would have been appended), or
 *   - the lane drains and stays idle for 60s.
 */

'use strict';

const MAX_TEXT_LENGTH = 4096;
const EDIT_WINDOW_MS = 47 * 60 * 60 * 1000;
const DIGEST_BACKLOG_THRESHOLD = 3;
const DIGEST_WAIT_THRESHOLD_MS = 5000;
const IDLE_CLOSE_MS = 60 * 1000;
const MAX_NETWORK_RETRIES = 2;
// QUOXTRUST v1.8 RB4 (resource bounds): cap a lane's in-memory queue so a flood of
// sends cannot grow memory without bound. Cross-restart durability is named debt.
const MAX_LANE_QUEUE_DEPTH = 1000;
const NETWORK_BACKOFF_MS = 300;

const CHAT_CAPACITY = 1;
const CHAT_REFILL_PER_MS = 1 / 1000; // 1 msg/s per chat

const GROUP_CAPACITY = 20;
const GROUP_REFILL_PER_MS = 20 / 60000; // 20 msg/min per group chat

const GLOBAL_CAPACITY = 30;
const GLOBAL_REFILL_PER_MS = 30 / 1000; // 30 msg/s per bot

/**
 * Real Telegram Bot API caller, used when createQueue is not given an
 * injected `api` function (tests always inject one).
 */
async function defaultApi(token, method, params) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(10000),
  });
  return resp.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildHtml(text, escaped) {
  return escaped ? text : escapeHtml(text);
}

/**
 * Splits text into <=maxLen chunks, preferring to cut on a newline. Parts
 * always concatenate back (via join('')) to exactly the original string,
 * so a digest can safely reassemble an item's html from its parts.
 */
function splitText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen - 1);
    if (cut <= 0) {
      cut = maxLen; // no usable boundary, hard split
    } else {
      cut += 1; // keep the newline with the part that precedes it
    }
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

/**
 * Keeps a digest message inside the text limit by dropping the oldest
 * content, since the most recent coalesced lines matter most once a
 * digest is already overflowing.
 */
function truncateForDigest(text) {
  return text.length > MAX_TEXT_LENGTH ? text.slice(-MAX_TEXT_LENGTH) : text;
}

function refillBucket(bucket, now) {
  const t = now();
  const elapsed = Math.max(0, t - bucket.lastRefill);
  if (elapsed === 0) return;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs);
  bucket.lastRefill = t;
}

function createQueue({ api = defaultApi, now = () => Date.now(), persistRef = () => {} } = {}) {
  const lanes = new Map(); // laneKey -> lane state
  const chatBuckets = new Map(); // `${botId}::${chatId}` -> bucket, 1/s
  const groupBuckets = new Map(); // `${botId}::${chatId}` -> bucket, 20/min, groups only
  const globalBuckets = new Map(); // botId -> bucket, 30/s

  function threadPart(threadKey) {
    return threadKey === null || threadKey === undefined ? 'general' : String(threadKey);
  }

  function laneKeyFor(botId, chatId, threadKey) {
    return `${botId}::${chatId}::${threadPart(threadKey)}`;
  }

  function getOrCreateBucket(map, key, capacity, refillPerMs) {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, capacity, refillPerMs, lastRefill: now() };
      map.set(key, bucket);
    }
    return bucket;
  }

  function getOrCreateLane(botId, token, chatId, threadKey) {
    const key = laneKeyFor(botId, chatId, threadKey);
    let lane = lanes.get(key);
    if (lane) {
      lane.token = token; // token can be refreshed between sends
      return lane;
    }

    const isGroup = Number(chatId) < 0;
    lane = {
      key,
      botId,
      token,
      chatId,
      threadKey: threadKey === undefined ? null : threadKey,
      isGroup,
      queue: [],
      processing: false,
      openDigest: null, // { messageId, text, createdAt }
      idleTimer: null,
      chatBucket: getOrCreateBucket(chatBuckets, `${botId}::${chatId}`, CHAT_CAPACITY, CHAT_REFILL_PER_MS),
      groupBucket: isGroup
        ? getOrCreateBucket(groupBuckets, `${botId}::${chatId}`, GROUP_CAPACITY, GROUP_REFILL_PER_MS)
        : null,
      globalBucket: getOrCreateBucket(globalBuckets, botId, GLOBAL_CAPACITY, GLOBAL_REFILL_PER_MS),
    };
    lanes.set(key, lane);
    return lane;
  }

  function laneBuckets(lane) {
    return lane.groupBucket ? [lane.chatBucket, lane.groupBucket, lane.globalBucket] : [lane.chatBucket, lane.globalBucket];
  }

  /**
   * How long, in ms, it would take the tightest applicable bucket to build
   * up enough tokens to drain `backlog` queued items. Used to decide
   * whether a lane should switch to digest mode.
   */
  function estimateDrainMs(lane, backlog) {
    let maxWait = 0;
    for (const bucket of laneBuckets(lane)) {
      refillBucket(bucket, now);
      const deficit = backlog - bucket.tokens;
      if (deficit > 0) {
        const waitMs = deficit / bucket.refillPerMs;
        if (waitMs > maxWait) maxWait = waitMs;
      }
    }
    return maxWait;
  }

  async function waitForBuckets(buckets) {
    while (true) {
      for (const bucket of buckets) refillBucket(bucket, now);
      if (buckets.every((bucket) => bucket.tokens >= 1)) {
        for (const bucket of buckets) bucket.tokens -= 1;
        return;
      }
      let waitMs = 0;
      for (const bucket of buckets) {
        if (bucket.tokens < 1) {
          const deficit = 1 - bucket.tokens;
          const w = deficit / bucket.refillPerMs;
          if (w > waitMs) waitMs = w;
        }
      }
      await sleep(Math.max(1, Math.ceil(waitMs)));
    }
  }

  function buildParams(lane, text, { replyToMessageId, disableNotification, editMessageId } = {}) {
    const params = {
      chat_id: lane.chatId,
      text,
      parse_mode: 'HTML',
    };
    if (lane.threadKey !== null && lane.threadKey !== undefined) {
      params.message_thread_id = lane.threadKey;
    }
    if (editMessageId) {
      params.message_id = editMessageId;
    } else {
      if (replyToMessageId) params.reply_to_message_id = replyToMessageId;
      if (disableNotification) params.disable_notification = true;
    }
    return params;
  }

  /**
   * Delivers a single API call (send or edit) with 429 pause handling and
   * bounded network/API-error retries. Never throws; the caller inspects
   * the returned status.
   */
  async function deliverWithRetry(lane, method, params) {
    let attempts = 0;
    while (true) {
      await waitForBuckets(laneBuckets(lane));

      let response;
      try {
        response = await api(lane.token, method, params);
      } catch (err) {
        attempts += 1;
        if (attempts > MAX_NETWORK_RETRIES) return { status: 'failed', error: err };
        await sleep(NETWORK_BACKOFF_MS * attempts);
        continue;
      }

      if (response && response.ok === false) {
        if (response.error_code === 429) {
          const retryAfterSec = (response.parameters && response.parameters.retry_after) || 1;
          return { status: 'paused', retryAfterMs: retryAfterSec * 1000 };
        }
        attempts += 1;
        if (attempts > MAX_NETWORK_RETRIES) {
          return { status: 'failed', error: new Error(response.description || `Telegram API ${method} failed`) };
        }
        await sleep(NETWORK_BACKOFF_MS * attempts);
        continue;
      }

      const messageId = response && response.result && response.result.message_id;
      return { status: 'ok', messageId };
    }
  }

  function persistSend(lane, messageId, kind) {
    persistRef({
      botId: lane.botId,
      tgChatId: lane.chatId,
      messageThreadId: lane.threadKey ?? null,
      messageId,
      kind,
    });
  }

  async function sendSingleItem(lane, item) {
    while (item.partIndex < item.parts.length) {
      const part = item.parts[item.partIndex];
      const params = buildParams(lane, part, {
        replyToMessageId: item.partIndex === 0 ? item.replyToMessageId : null,
        disableNotification: item.disableNotification,
      });

      const outcome = await deliverWithRetry(lane, 'sendMessage', params);

      if (outcome.status === 'paused') {
        lane.queue.unshift(item);
        await sleep(outcome.retryAfterMs);
        return;
      }
      if (outcome.status === 'failed') {
        item.reject(outcome.error);
        return;
      }

      item.messageIds.push(outcome.messageId);
      persistSend(lane, outcome.messageId, 'send');
      item.partIndex += 1;
    }

    item.resolve({
      ok: true,
      messageId: item.messageIds[item.messageIds.length - 1],
      chatId: lane.chatId,
      threadKey: lane.threadKey ?? null,
      digested: false,
    });
  }

  function itemHtml(item) {
    return item.parts.join('');
  }

  function resolveDigestBatch(batchItems, lane, messageId) {
    for (const item of batchItems) {
      item.resolve({
        ok: true,
        messageId,
        chatId: lane.chatId,
        threadKey: lane.threadKey ?? null,
        digested: true,
      });
    }
  }

  async function sendDigestBatch(lane, batchItems) {
    const addition = batchItems.map(itemHtml).join('\n');
    const digest = lane.openDigest;
    const tooOld = digest && now() - digest.createdAt >= EDIT_WINDOW_MS;

    if (digest && !tooOld) {
      const newText = truncateForDigest(`${digest.text}\n${addition}`);
      const params = buildParams(lane, newText, { editMessageId: digest.messageId });
      const outcome = await deliverWithRetry(lane, 'editMessageText', params);

      if (outcome.status === 'ok') {
        digest.text = newText;
        persistSend(lane, digest.messageId, 'digest');
        resolveDigestBatch(batchItems, lane, digest.messageId);
        return;
      }
      if (outcome.status === 'paused') {
        lane.queue.unshift(...batchItems);
        await sleep(outcome.retryAfterMs);
        return;
      }
      // Edit failed permanently: close the digest and fall back to fresh
      // sends for the items that would have been appended to it.
      lane.openDigest = null;
      lane.queue.unshift(...batchItems);
      return;
    }

    if (tooOld) lane.openDigest = null;

    const anchorText = truncateForDigest(addition);
    const params = buildParams(lane, anchorText, {
      disableNotification: batchItems[0] ? batchItems[0].disableNotification : false,
    });
    const outcome = await deliverWithRetry(lane, 'sendMessage', params);

    if (outcome.status === 'ok') {
      lane.openDigest = { messageId: outcome.messageId, text: anchorText, createdAt: now() };
      persistSend(lane, outcome.messageId, 'digest');
      resolveDigestBatch(batchItems, lane, outcome.messageId);
      return;
    }
    if (outcome.status === 'paused') {
      lane.queue.unshift(...batchItems);
      await sleep(outcome.retryAfterMs);
      return;
    }
    for (const item of batchItems) item.reject(outcome.error);
  }

  function clearIdleTimer(lane) {
    if (lane.idleTimer) {
      clearTimeout(lane.idleTimer);
      lane.idleTimer = null;
    }
  }

  function scheduleIdleClose(lane) {
    clearIdleTimer(lane);
    if (!lane.openDigest) return;
    lane.idleTimer = setTimeout(() => {
      lane.openDigest = null;
      lane.idleTimer = null;
    }, IDLE_CLOSE_MS);
    if (typeof lane.idleTimer.unref === 'function') lane.idleTimer.unref();
  }

  async function processLane(laneKey) {
    const lane = lanes.get(laneKey);
    if (!lane || lane.processing) return;
    lane.processing = true;
    clearIdleTimer(lane);

    try {
      while (lane.queue.length > 0) {
        const backlog = lane.queue.length;
        const drainEstimateMs = estimateDrainMs(lane, backlog);
        const shouldDigest = backlog > DIGEST_BACKLOG_THRESHOLD || drainEstimateMs > DIGEST_WAIT_THRESHOLD_MS;

        if (shouldDigest) {
          const batch = lane.queue.splice(0, lane.queue.length);
          await sendDigestBatch(lane, batch);
        } else {
          const item = lane.queue.shift();
          await sendSingleItem(lane, item);
        }
      }
    } finally {
      lane.processing = false;
      scheduleIdleClose(lane);
    }
  }

  function kickLane(laneKey) {
    processLane(laneKey).catch((err) => {
      console.error('[telegramPro.outboundQueue] lane processing error:', err && err.message);
    });
  }

  function send({
    botId,
    token,
    chatId,
    threadKey = null,
    text,
    escaped = false,
    replyToMessageId = null,
    disableNotification = false,
  } = {}) {
    if (!botId || !token) return Promise.reject(new Error('outboundQueue.send requires botId and token'));
    if (chatId === undefined || chatId === null) return Promise.reject(new Error('outboundQueue.send requires chatId'));
    if (typeof text !== 'string' || text.length === 0) {
      return Promise.reject(new Error('outboundQueue.send requires non-empty text'));
    }

    const lane = getOrCreateLane(botId, token, chatId, threadKey);
    // QUOXTRUST v1.8 RB4: shed when a lane's queue is saturated — bound memory
    // under a send flood rather than growing the in-memory queue without limit.
    if (lane.queue.length >= MAX_LANE_QUEUE_DEPTH) {
      return Promise.reject(new Error(`outboundQueue lane saturated (${lane.queue.length}/${MAX_LANE_QUEUE_DEPTH}) — send shed`));
    }
    const html = buildHtml(text, escaped);
    const parts = splitText(html, MAX_TEXT_LENGTH);

    return new Promise((resolve, reject) => {
      lane.queue.push({
        parts,
        partIndex: 0,
        messageIds: [],
        replyToMessageId: replyToMessageId || null,
        disableNotification: !!disableNotification,
        resolve,
        reject,
      });
      kickLane(lane.key);
    });
  }

  function notifyInbound(chatId, threadKey) {
    const wantedThread = threadPart(threadKey);
    for (const lane of lanes.values()) {
      if (String(lane.chatId) === String(chatId) && threadPart(lane.threadKey) === wantedThread) {
        lane.openDigest = null;
        clearIdleTimer(lane);
      }
    }
  }

  function stats() {
    const laneStats = {};
    for (const [key, lane] of lanes) {
      laneStats[key] = {
        depth: lane.queue.length,
        openDigest: lane.openDigest ? { messageId: lane.openDigest.messageId } : null,
        chatTokens: lane.chatBucket.tokens,
        groupTokens: lane.groupBucket ? lane.groupBucket.tokens : null,
        globalTokens: lane.globalBucket.tokens,
      };
    }
    return { lanes: laneStats };
  }

  return { send, notifyInbound, stats };
}

module.exports = { createQueue };
