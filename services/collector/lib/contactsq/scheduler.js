'use strict';

/**
 * ContactsQ retention scheduler (P4). Deliberately NOT boot-triggered: start()
 * only arms a wall-clock interval (no setTimeout warm-up, no immediate tick), and
 * each wake-up is a cheap check that acts only inside the org's run window
 * (default 03:15 UTC) once per day, honouring the per-org kill switch
 * (retention_reaper_enabled) and the failure backoff. See retention.js for the
 * triad. The interval is unref()'d so it never holds the process open.
 */

const { setSchedulerArmed } = require('./retention.js');

const CHECK_MS = 5 * 60 * 1000;

/** @param {{ service: { retentionTick: Function }, checkMs?: number, logger?: Function, now?: Function }} deps */
function createContactsqScheduler({ service, checkMs = CHECK_MS, logger, now } = {}) {
  if (!service || typeof service.retentionTick !== 'function') throw new Error('createContactsqScheduler requires service.retentionTick');
  const log = logger || ((m) => console.log(m));
  let timer = null;

  function check() {
    try {
      service.retentionTick({ nowMs: now ? now() : Date.now(), log });
    } catch (e) {
      // Surface it: a thrown tick must not look like an idle one.
      console.error(`[contactsq] retention check failed code=${(e && e.code) || 'error'}`);
    }
    // Recurring compliance report: same wall-clock tick, async, optional (older service shapes lack it).
    if (typeof service.reportTick === 'function') {
      Promise.resolve()
        .then(() => service.reportTick({ nowMs: now ? now() : Date.now(), log }))
        .catch((e) => console.error(`[contactsq] report check failed code=${(e && e.code) || 'error'}`));
    }
    // P7 CardDAV pull sync: same wall-clock tick (never at boot), async, one source at a time, re-entry guarded inside syncTick.
    const syncDone = typeof service.syncTick === 'function'
      ? Promise.resolve()
        .then(() => service.syncTick({ nowMs: now ? now() : Date.now(), log }))
        .catch((e) => console.error(`[contactsq] sync check failed code=${(e && e.code) || 'error'}`))
      : Promise.resolve();
    // LUCID awareness (dimension 21): heartbeat + asks, after sync so a source retired this tick is seen this tick.
    if (typeof service.awareTick === 'function') {
      syncDone.then(() => service.awareTick()).catch((e) => console.error(`[contactsq] aware tick failed code=${(e && e.code) || 'error'}`));
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(check, checkMs);
    if (timer.unref) timer.unref();
    setSchedulerArmed(true);
    log(`[contactsq] retention reaper armed (check every ${Math.round(checkMs / 1000)}s, runs once a day inside the org's UTC window; kill switch: Settings > retention_reaper_enabled)`);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    setSchedulerArmed(false);
  }

  return { start, stop, check };
}

module.exports = { createContactsqScheduler, CHECK_MS };
