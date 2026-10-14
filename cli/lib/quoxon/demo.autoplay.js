/**
 * Deterministic script for `quox --demo --autoplay`: the same timings on every run, so a screen
 * recording is repeatable. No Math.random, no wall clock in the plan; only fixed numbers and a seeded PRNG.
 */
export const AUTOPLAY_LABEL = 'DEMO: demo data, nothing real runs.';
export const AUTOPLAY_REQUEST = 'Show me what you can do (demo)';
export const AUTOPLAY_PROOF = '/proof';
export const AUTOPLAY = Object.freeze({ seed: 20261013, startMs: 900, typeMinMs: 38, typeMaxMs: 78, afterTypeMs: 450, approvalHoldMs: 2500, afterKeyMs: 400, afterTurnMs: 900, finalHoldMs: 600 });

/** Small seeded PRNG (mulberry32): deterministic across runs and platforms. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-character delays (ms) for typing `text` at a human pace; identical for the same seed. */
export function typingPlan(text, seed = AUTOPLAY.seed, { min = AUTOPLAY.typeMinMs, max = AUTOPLAY.typeMaxMs } = {}) {
  const r = prng(seed);
  return [...text].map(() => Math.round(min + r() * (max - min)));
}

/** Is autoplay requested? flag or QUOX_DEMO_AUTOPLAY=1. */
export const autoplayOn = (flag, env = process.env) => Boolean(flag) || /^(1|true|yes|on)$/i.test(String(env.QUOX_DEMO_AUTOPLAY || ''));
