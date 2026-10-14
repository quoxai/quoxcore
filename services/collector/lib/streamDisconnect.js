'use strict';
/**
 * CLI-QUOX B1 / R1 #50: detect a client that went away mid-stream.
 *
 * On Node >= 16 an IncomingMessage emits 'close' once its body has been
 * consumed, not when the client disconnects. /chat/stream's body is parsed by
 * express.json before the handler runs, and the handler awaits the AOCL
 * preflight before it attaches listeners, so `req.on('close')` there never
 * fires and abandoned turns kept running. The response's 'close' fires when the
 * socket goes away; `writableFinished` tells a normal end from a disconnect.
 */
function onClientDisconnect(res, fn) {
  let fired = false;
  res.on('close', () => {
    if (fired || res.writableFinished) return;
    fired = true;
    try { fn(); } catch { /* cleanup must never throw into the socket layer */ }
  });
}

module.exports = { onClientDisconnect };
