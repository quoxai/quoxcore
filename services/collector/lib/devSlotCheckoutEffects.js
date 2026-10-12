/**
 * Side effects of a successful slot checkout (audit envelopes, room/channel
 * heal, status card rewrite). Extracted from the checkout route so they can
 * be gated: a same-holder re-checkout (`result.refreshed`) is NOT a state
 * transition and must skip all of them (hot-loop fix 2026-10-11: a resident
 * supervisor re-checking out its own slot every 15 s burned ~7 s of main
 * thread per 90 s here).
 */
function runCheckoutSideEffects({
  result, orgId, name, actor, holder_session, holder_kind, host_id,
  storeAuditEnvelope, provisionSlotRoom, devSlots, devSlotDiscord,
}) {
  if (result.refreshed) return { skipped: true };
  // `checkout --create` folds an implicit create into this call (slice 1
  // above); witness it as its own quox.slot.create envelope too, same as
  // the explicit POST /api/v1/slots create path, so the audit trail shows
  // the slot was born, not just checked out.
  if (result.created) {
    storeAuditEnvelope({
      type: 'event', from: actor, to: 'audit.system', intent: 'quox.slot.create',
      corr: result.slot.id, payload: { org_id: orgId, name: name, via: 'checkout --create' },
    });
  }
  storeAuditEnvelope({
    type: 'event', from: `session.${holder_session}`, to: 'audit.system', intent: 'quox.slot.checkout',
    corr: result.slot.id,
    payload: { org_id: orgId, name: name, holder_session, holder_kind: holder_kind || null, host_id: host_id || null },
  });
  // Healing path for the crash window between create and the room landing:
  // if provision succeeded server-side but never wrote back (process died
  // mid fire-and-forget), a later checkout re-attempts it here. Idempotent
  // on the auth side (ledger UNIQUE + M_ROOM_IN_USE room adoption), so a
  // duplicate attempt against an already-provisioned slot is a safe no-op.
  if (!result.slot.matrix_room_id) {
    provisionSlotRoom({ orgId, slotId: result.slot.id, label: `Slots > ${name}` })
      .then((roomId) => {
        if (roomId) {
          devSlots.setSlotRoomId({ orgId, name: name, roomId });
          // #574: announce the heal-on-checkout write-back (was silent on success).
          console.log(`[DevSlotMatrix] slot ${name} room healed on checkout and written back: ${roomId}`);
        }
      })
      .catch((err) => console.warn(`[DevSlots] room provision re-attempt for ${name} failed (non-fatal): ${err.message}`));
  }
  // Item 5: heal a missing channel on checkout (same crash-window logic as
  // the room above), then rewrite the pinned status card to the new holder.
  {
    const slotName = name;
    const ensure = result.slot.discord_channel_id
      ? Promise.resolve({ channelId: result.slot.discord_channel_id, webhookUrl: result.slot.discord_webhook_url })
      : devSlotDiscord.provisionSlotDiscordChannel({ slotName }).then((ch) => {
          if (ch) {
            devSlots.setSlotDiscord({ orgId, name: slotName, channelId: ch.channelId, webhookUrl: ch.webhookUrl });
            // #574: announce the heal-on-checkout write-back (was silent on success).
            console.log(`[DevSlotDiscord] slot ${slotName} channel healed on checkout and written back: ${ch.channelId}`);
          }
          return ch;
        });
    ensure
      .then((ch) => ch && devSlotDiscord.updateSlotDiscordStatus({
        channelId: ch.channelId, slotName, state: 'held',
        holderSession: holder_session, hostId: host_id || null,
      }))
      .catch((err) => console.warn(`[DevSlots] discord status for ${slotName} failed (non-fatal): ${err.message}`));
  }
  return { skipped: false };
}

module.exports = { runCheckoutSideEffects };
