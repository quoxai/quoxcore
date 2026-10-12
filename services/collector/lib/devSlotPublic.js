'use strict';

/**
 * Public projection of slot records (quox#665).
 *
 * devSlotsStore records carry discord_webhook_url because two server-side
 * paths need it (the Discord heal on checkout and the say webhook post). A
 * Discord webhook URL embeds its own token, so anyone who holds it can post
 * into the slot channel as the webhook, bypassing the say route's holder gate
 * and WARD witnessing. Clients only need to know a webhook exists.
 *
 * redactSlotSecrets deep-copies a response body, replacing every
 * discord_webhook_url with discord_webhook_set (boolean). slotResponseGuard
 * applies it to everything a /api/v1/slots route sends through res.json, so
 * no route (including future ones) can leak the URL by returning a record.
 */

function redactSlotSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSlotSecrets);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'discord_webhook_url') {
      out.discord_webhook_set = Boolean(v);
    } else {
      out[k] = redactSlotSecrets(v);
    }
  }
  return out;
}

function slotResponseGuard(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => json(redactSlotSecrets(body));
  next();
}

module.exports = { redactSlotSecrets, slotResponseGuard };
