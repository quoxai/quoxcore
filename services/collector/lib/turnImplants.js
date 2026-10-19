'use strict';

/**
 * The memory and brain implants for one chat turn, built concurrently (2026-10-17). Per-implant timing showed
 * warm turns spending memory 0.5-2.0s and then brain 1.6-4.0s in sequence, though neither reads the other; the
 * turn now waits max(memory, brain). Each builder keeps its own budget (memoryImplant/brainImplant timeouts) and
 * degrades on its own: a failure yields an empty block plus the error, never the other block or the turn.
 */
async function timed(build, clock) {
  const t0 = clock();
  if (typeof build !== 'function') return { block: '', error: null, ms: 0 };
  try {
    const block = await build();
    return { block: typeof block === 'string' ? block : (block || ''), error: null, ms: clock() - t0 };
  } catch (err) {
    return { block: '', error: (err && err.message) || String(err), ms: clock() - t0 };
  }
}

/** Start both builds now; await each result when the caller is ready for it (both are already running). */
function startTurnImplants({ memory, brain, clock = Date.now } = {}) {
  return { memory: timed(memory, clock), brain: timed(brain, clock) };
}

async function buildTurnImplants({ memory, brain, clock = Date.now } = {}) {
  const t0 = clock();
  const started = startTurnImplants({ memory, brain, clock });
  const [m, b] = await Promise.all([started.memory, started.brain]);
  return {
    memoryBlock: m.block, memoryError: m.error, memoryMs: m.ms,
    brainBlock: b.block, brainError: b.error, brainMs: b.ms,
    wallMs: clock() - t0,
  };
}

module.exports = { buildTurnImplants, startTurnImplants };
