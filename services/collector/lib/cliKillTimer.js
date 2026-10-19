'use strict';
/**
 * quox#1044 (WORKER1 CLI_1792137143765_3szs6r): the Claude CLI's kill timer, extendable once a
 * delegation breaches so the late-answer wait cannot push the outer process into its kill.
 * Total extension is capped (maxExtraMs) so a turn still ends.
 */
function createKillTimer({ ms, onKill, maxExtraMs = 60000, now = Date.now } = {}) {
  let deadline = now() + Math.max(0, Number(ms) || 0);
  let extra = 0;
  let timer = null;
  let cleared = false;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; if (!cleared) { cleared = true; try { onKill(); } catch { /* best-effort */ } } }, Math.max(0, deadline - now()));
  };
  arm();
  return {
    /** Push the kill out by ms (within the cap). Returns the ms actually added. */
    extend(addMs) {
      if (cleared) return 0;
      const add = Math.max(0, Math.min(Number(addMs) || 0, maxExtraMs - extra));
      if (!add) return 0;
      extra += add;
      deadline += add;
      arm();
      return add;
    },
    clear() { cleared = true; if (timer) clearTimeout(timer); timer = null; },
    extendedMs: () => extra,
  };
}

module.exports = { createKillTimer };
