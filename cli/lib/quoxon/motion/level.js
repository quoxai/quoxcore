/**
 * Motion levels (CLI-QUOX F3). One setting, four steps, chosen in /config or with QUOX_MOTION:
 *
 *   quiet       static except the elapsed timer (the old "reduced motion"; QUOX_REDUCED_MOTION=1 still means it)
 *   calm        the default: exactly what shipped before levels (Orbit & Lock, the status Q, reveals, the ring)
 *   expressive  calm, plus a short ignition glow when a tool row starts and a handoff dot while delegating
 *   cinematic   expressive, plus the dragon: it greets you after Orbit & Lock on every launch, and plays a mood
 *               for approvals (wide eyes, amber glint), success (a wink) and failure (a puff of smoke)
 *
 * Pure: no process access except through the env argument, no timers. The frame helpers return cells
 * { ch, rgb } like every other motion module, so the terminal and the web draw them the same way.
 */
export const LEVELS = ['quiet', 'calm', 'expressive', 'cinematic'];
export const DEFAULT_LEVEL = 'calm';

/** A saved or typed value -> a level, or null. The pre-levels values map across: full = calm, reduced = quiet. */
export function normaliseLevel(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'full') return 'calm';
  if (s === 'reduced') return 'quiet';
  return LEVELS.includes(s) ? s : null;
}

/** The level in force. QUOX_REDUCED_MOTION=1 and QUOX_TUI_LITE always mean quiet (accessibility wins). */
export function motionLevel(env = process.env) {
  if (env.QUOX_REDUCED_MOTION === '1' || env.QUOX_TUI_LITE) return 'quiet';
  return normaliseLevel(env.QUOX_MOTION) || DEFAULT_LEVEL;
}

export const atLeast = (level, min) => LEVELS.indexOf(normaliseLevel(level) || DEFAULT_LEVEL) >= LEVELS.indexOf(min);

/** What each level turns on. launchEgg: the rare dragon greeting on launch (cinematic greets every time instead). */
export function levelFeatures(level) {
  const l = normaliseLevel(level) || DEFAULT_LEVEL;
  return {
    animate: l !== 'quiet',
    ignition: atLeast(l, 'expressive'),
    handoff: atLeast(l, 'expressive'),
    introDragon: l === 'cinematic',
    moods: l === 'cinematic',
    launchEgg: l === 'calm' || l === 'expressive',
  };
}

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));

// ---- tool-row ignition glow --------------------------------------------------------------------------------
export const IGNITION_MS = 700;
/** Glow 0..1 at ms since a tool row started running: up in 80 ms, then an eased fall to 0 at IGNITION_MS. */
export function ignitionGlow(age) {
  if (!(age > 0) || age >= IGNITION_MS) return 0;
  if (age <= 80) return age / 80;
  const u = (age - 80) / (IGNITION_MS - 80);
  return (1 - u) ** 2;
}

// ---- handoff dot -------------------------------------------------------------------------------------------
export const HANDOFF_MS = 900;
const SKY = [56, 189, 248], VIOLET = [168, 85, 247], DIM = [58, 66, 82];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
/**
 * The handoff track at t ms: n cells, a bright dot travelling from Quox (left) to the agent it is handing to
 * (right) once every HANDOFF_MS, with one fading cell behind it. The dot shifts sky to violet as it goes.
 * still: the dot rests at the target (reduced motion never calls this, but a frozen frame must read right).
 */
export function handoffFrame(t, n = 6, { mono = false, still = false } = {}) {
  const u = still ? 0.999 : (((t % HANDOFF_MS) + HANDOFF_MS) % HANDOFF_MS) / HANDOFF_MS;
  const at = Math.min(n - 1, Math.floor(u * n));
  return Array.from({ length: n }, (_, i) => {
    const pos = n > 1 ? i / (n - 1) : 1;
    if (i === at) return { ch: '●', rgb: mono ? null : mix(SKY, VIOLET, pos) };
    if (i === at - 1 && !still) return { ch: '•', rgb: mono ? null : mix(DIM, mix(SKY, VIOLET, pos), 0.55) };
    return { ch: '·', rgb: mono ? null : mix(DIM, SKY, 0.25 * clamp(pos)) };
  });
}

// ---- dragon moods (cinematic) ------------------------------------------------------------------------------
const FAILED_TURN = new Set(['failed', 'unconfirmed']); // the same reading as the sound earcons (sound/mapping.js)
/**
 * prevState + action + nextState -> the mood the dragon should play, or null. Only accepted state CHANGES
 * count: an approval card appearing (waiting), a running turn finishing (success / failure). An interrupted
 * turn is the human pressing Esc: no reaction.
 */
export function moodForEvent(prev, action, next) {
  if (!prev || !action || !next) return null;
  if ((next.approvals?.length || 0) > (prev.approvals?.length || 0)) return 'waiting';
  if (action.type !== 'event' || action.ev?.type !== 'turn.finished' || !prev.turn) return null;
  const status = action.ev.status || 'completed';
  if (FAILED_TURN.has(status)) return 'failure';
  return status === 'completed' ? 'success' : null;
}
