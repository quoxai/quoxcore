'use strict';

/**
 * Per-step timing for a chat turn's prompt build (2026-10-16): the first CLI chat turn after a collector boot spent
 * ~32 s before dispatch (the next one ~5 s) and nothing said which step. mark() closes the step that just ran; the
 * [TurnTiming] dispatch line carries field() and first_after_boot. Log-only: never throws, never changes behaviour.
 */
let _first = true;

function takeFirstAfterBoot() {
  const f = _first;
  _first = false;
  return f;
}

function createTurnPhases({ t0 = Date.now(), clock = Date.now } = {}) {
  let last = t0;
  const list = [];
  return {
    mark(name) {
      try {
        const now = clock();
        list.push([String(name || 'step').replace(/[^a-z0-9_]/gi, '_'), Math.max(0, now - last)]);
        last = now;
      } catch { /* timing must never break a turn */ }
    },
    // a step that ran in parallel with others: logged, but the sequential clock (last) does not move
    note(name, ms) {
      try { list.push([String(name || 'step').replace(/[^a-z0-9_]/gi, '_'), Math.max(0, Math.round(Number(ms) || 0))]); } catch { /* timing must never break a turn */ }
    },
    phases() { return list.slice(); },
    field() { return `phases=${list.map(([n, ms]) => `${n}:${ms}`).join(',')}`; },
  };
}

module.exports = { createTurnPhases, takeFirstAfterBoot, _resetFirstForTest: () => { _first = true; } };
