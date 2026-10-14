/**
 * Dragon scenes: pure timelines t (ms) -> { pose, eyes, caption }. No timers, no I/O (portable to the web).
 * ONE dragon everywhere (v8): googly dot eyes (qeyes.js), a smile that opens to talk, pink cheeks, dim bat wings,
 * a spade tail with spines, fire from the mouth. /dragon (the pick), /dragon classic, hero and fire, the cinematic
 * moods, the greeting and /dragon-fly are all this dragon; moods are shown through the eyes and the smile only.
 */
import { restPose, kf, hash, clamp, smooth, dragonLayout, renderDragon } from './qdragon.js';
import { eyesForDragon, eyeState, blinkOpen, overlay, GOOGLY } from './qeyes.js';

const TAU = Math.PI * 2;

// ---- the pick: googly dot eyes, sway sway sway whip, then fire from the mouth (ported from cli.quox.ai) -------
// The same pure functions the website lab plays (src/components/lab/dragon/dragonlab.js pickCells), so the CLI
// and the web draw the same frames. Eyes are qeyes.js Braille dots (Dots v3), laid over the dragon by composeCells:
// they are the dragon's only eyes.
export const SWAY_MS = TAU / 0.0068; // one sway cycle (about 924 ms)
export const PICK = { sway: 3 * SWAY_MS, whip: 950, fire: 2500, rest: 700 };
export const PICK_EYES = 'dots';
export const PICK_MS = PICK.sway + PICK.whip + PICK.fire + PICK.rest;
/** Which phase of the pick t (ms) falls in: 'sway' | 'whip' | 'fire' | 'rest'. */
export function pickPhase(t) {
  const c = ((t % PICK_MS) + PICK_MS) % PICK_MS, w0 = PICK.sway, f0 = w0 + PICK.whip, r0 = f0 + PICK.fire;
  return c < w0 ? 'sway' : c < f0 ? 'whip' : c < r0 ? 'fire' : 'rest';
}
/** The eyes at t: shut (open 0) while it breathes, otherwise the idle blinks and glances. */
export function pickEyeState(t) {
  const c = ((t % PICK_MS) + PICK_MS) % PICK_MS, ft = c - PICK.sway - PICK.whip;
  return pickPhase(t) === 'fire' && ft > 120 && ft < 1500 ? { open: 0 } : eyeState('idle', t);
}
/** The dragon's pose (no quadrant eyes) at absolute time t. */
export function pickPose(t) {
  const p = restPose(), c = ((t % PICK_MS) + PICK_MS) % PICK_MS;
  p.tail.len = 1.55; p.tail.k = 3.2; p.tail.phase = t * 0.0068;
  const w0 = PICK.sway, f0 = w0 + PICK.whip, r0 = f0 + PICK.fire;
  if (c < w0) p.tail.amp = 0.6 + 1.6 * smooth(c / 350);
  else if (c < f0) {
    const u = (c - w0) / PICK.whip, crack = smooth(u / 0.2) * (1 - smooth((u - 0.35) / 0.55));
    p.tail.amp = 2.2 + 2.8 * crack; p.tail.phase += crack * 4; p.tail.k = 3.2 + 2.8 * crack; p.tail.curl = 0.8 * crack;
  } else if (c < r0) {
    const ft = c - f0;
    p.tail.amp = 2.2 - 1.6 * smooth(ft / 600);
    p.mouth = smooth(ft / 160) * (1 - smooth((ft - 1500) / 500));
    p.fire = { t: ft, dur: 1300, seed: 3 };
  } else p.tail.amp = 0.6;
  return p;
}
const EYES2 = GOOGLY; // the owner's eyes, unchanged: every scene, mood, greeting and the flight use them
const INK = [30, 41, 59]; // eye ink on the light theme (white would vanish on a light page)
/**
 * The pick at t ms. opts: style ('dots'), theme, mono (NO_COLOR: no colour), still (reduced motion: the settled
 * dragon, eyes open, no tail motion, no fire). Cells are { ch, rgb, bg } like every other clip.
 */
export function pickCells(t, cols = 64, style = PICK_EYES, { theme = 'dark', mono = false, still = false, size, lm, mouthSide = 'right', talk } = {}) {
  const L = dragonLayout(cols, { size, lm });
  let pose, eyes;
  if (still) { pose = restPose(); eyes = eyeState('open', 0); }
  else if (talk) { pose = talkPose(t, talk); eyes = eyeState('idle', t); } // talking: the pick's calm sway, the mouth working, no fire
  else { pose = pickPose(t); eyes = pickEyeState(t); }
  pose.mouthSide = mouthSide;
  return composeCells(pose, eyes, L, style, { theme, mono, t });
}
/** Body (renderDragon) with the Braille googly eyes laid over it: the one way a dragon frame is made. */
export function composeCells(pose, eyes, L, style, { theme, mono, t }) {
  const body = renderDragon(pose, L, { mono, t, theme });
  const layer = eyesForDragon(L, eyes, EYES2, style).map((row) => row.map((c) => c && {
    ch: c.ch, bg: null, rgb: !c.rgb || mono ? null : theme === 'light' ? INK : c.rgb,
  }));
  return overlay(body, layer);
}
/** How open the mouth is at t while it talks: 0..1, a deterministic syllable cadence (about 6 a second, with the odd pause). */
export const TALK_SYLLABLE_MS = 160;
export function talkOpen(t) {
  const k = Math.floor(t / TALK_SYLLABLE_MS), u = (t - k * TALK_SYLLABLE_MS) / TALK_SYLLABLE_MS;
  if (hash(k * 5 + 3) < 0.14) return 0; // a pause between words
  return (0.45 + 0.55 * hash(k * 7 + 11)) * Math.sin(Math.PI * u) ** 0.8;
}
/** The pose while it talks: calm tail sway, the mouth open by `talk` (a 0..1 number, or true for the cadence), no fire, no glow. */
export function talkPose(t, talk = true) {
  const p = restPose();
  p.tail.len = 1.55; p.tail.k = 3.2; p.tail.phase = t * 0.0068; p.tail.amp = 0.6;
  p.mouth = 0; p.smile = typeof talk === 'number' ? clamp(talk) : talkOpen(t);
  return p;
}
/** pickCells with the mouth talking and no fire: talkCells(t, cols, style, { mouthSide }) . */
export const talkCells = (t, cols = 64, style = PICK_EYES, opts = {}) => pickCells(t, cols, style, { ...opts, talk: opts.talk || true });

// ---- sleep: the screensaver dragon (eyes closed, a slow minimal sway, a breath of z; no whip, no fire) -------
export const SLEEP_Z = [' ', 'z', 'z z', 'z z Z'];
/** The z that drifts up with each slow breath at t ms (4.8 s cycle). */
export const sleepZ = (t) => SLEEP_Z[Math.floor((((t % 4800) + 4800) % 4800) / 1200)];
/** The sleeping pose at t ms: tail barely swaying (amp 0.1 vs the pick's 0.6), eyes shut, mouth closed, no fire. */
export function sleepPose(t, { still = false } = {}) {
  const p = restPose();
  p.fire = null; p.mouth = 0;
  if (!still) { p.tail.len = 1.4; p.tail.k = 2.6; p.tail.phase = t * 0.0011; p.tail.amp = 0.1; }
  const z = still ? 'z' : sleepZ(t);
  if (z.trim()) p.label = { text: z, rgb: [186, 230, 253] };
  return p;
}
/** Sleeping dragon cells: sleepCells(t, cols, style, { theme, mono, still, size, lm }). Eyes are always shut. */
export function sleepCells(t, cols = 64, style = PICK_EYES, { theme = 'dark', mono = false, still = false, size, lm } = {}) {
  const L = dragonLayout(cols, { size, lm });
  return composeCells(sleepPose(t, { still }), eyeState('closed', 0), L, style, { theme, mono, t });
}

// ---- the hero: talk on the right, sway sway sway whip, the mouth moves left, fire leftwards (cli.quox.ai hero) ---
export const HERO_TALK_MS = 1400, HERO_MOVE_MS = 450;
export const heroMs = (talkMs = HERO_TALK_MS) => talkMs + PICK.sway + PICK.whip + HERO_MOVE_MS + PICK.fire + PICK.rest;
export const HERO_MS = heroMs();
/** Hero timeline: 'talk' | 'sway' | 'whip' | 'move' | 'fire' | 'rest'. Loops on heroMs(talkMs). */
export function heroPhase(t, { talkMs = HERO_TALK_MS } = {}) {
  const T = heroMs(talkMs), c = ((t % T) + T) % T;
  const a = talkMs, b = a + PICK.sway, d = b + PICK.whip, e = d + HERO_MOVE_MS, f = e + PICK.fire;
  return c < a ? 'talk' : c < b ? 'sway' : c < d ? 'whip' : c < e ? 'move' : c < f ? 'fire' : 'rest';
}
/** The hero's pose and eye state at t. The tail keeps swaying through the move; fire comes from the left mouth. */
function heroFrame(t, talkMs) {
  const fr = heroFrame0(t, talkMs);
  fr.pose.flap = 0.12 * Math.sin(t * 0.0068 * 0.5); // the wings keep a gentle beat
  return fr;
}
function heroFrame0(t, talkMs) {
  const T = heroMs(talkMs), c = ((t % T) + T) % T, ph = heroPhase(t, { talkMs });
  const w0 = PICK.sway, f0 = w0 + PICK.whip;
  if (ph === 'talk') return { pose: talkPose(t, true), eyes: eyeState('idle', t) };
  // pick time pt: 0 at the start of the sway; frozen at the end of the whip during the move
  const base = c - talkMs, pt = ph === 'move' ? f0 - 1 : ph === 'fire' || ph === 'rest' ? base - HERO_MOVE_MS : base;
  const pose = pickPose(pt);
  pose.tail.phase += (t - pt) * 0.0068; // the sway never stutters at the seams
  pose.fire = ph === 'fire' && pt > f0 ? pose.fire : null;
  pose.mouthSide = ph === 'move' ? (c - talkMs - w0 - PICK.whip < HERO_MOVE_MS / 2 ? 'right' : 'left') : ph === 'fire' || ph === 'rest' ? 'left' : 'right';
  if (ph === 'move') pose.mouth = 0;
  // v2: the face turns left (mouth and cheeks slide, eyes look left), then the mouth opens wide to breathe
  const u = ph === 'move' ? smooth((c - talkMs - w0 - PICK.whip) / HERO_MOVE_MS) : ph === 'fire' ? 1 : ph === 'rest' ? 1 - smooth((c - talkMs - w0 - PICK.whip - HERO_MOVE_MS - PICK.fire) / PICK.rest) : 0;
  pose.faceX = -0.06 * u;
  if (ph === 'fire') pose.smile = pose.mouth; // the mouth opens wide to breathe
  pose.mouth = 0;
  const ft = pt - f0;
  if (ph === 'move') return { pose, eyes: { ...eyeState('idle', t), gx: -1 * u, gy: 0.4 } };
  return { pose, eyes: ph === 'fire' && ft > 120 && ft < 1500 ? { open: 0 } : eyeState('idle', t) };
}
/**
 * The hero at t ms (cli.quox.ai): the mouth on the right talks (no fire) for talkMs, then the tail sways three times
 * and whips, the mouth moves to the left and the dragon breathes fire leftwards, eyes shut. The Q needs room on its
 * left for the fire: lm defaults to as much margin as cols allow. still: eyes open, mouth closed, no fire.
 */
export function heroCells(t, cols = 64, style = PICK_EYES, { talkMs = HERO_TALK_MS, theme = 'dark', mono = false, still = false, size, lm } = {}) {
  if (lm === undefined) { const L0 = dragonLayout(cols, { size }); lm = Math.max(L0.qx0 / 2, Math.min(Math.ceil(L0.H * 1.25 / 2) + 4, Math.floor((cols * 2 - L0.qw) / 2) - 2)); }
  const L = dragonLayout(cols, { size, lm });
  if (still) return composeCells(restPose(), eyeState('open', 0), L, style, { theme, mono, t: 0 });
  const { pose, eyes } = heroFrame(t, talkMs);
  return composeCells(pose, eyes, L, style, { theme, mono, t });
}
const HERO_CAP = { talk: 'talking', sway: 'tail sway', whip: 'tail whip', move: 'the mouth moves to the left', fire: 'fire breath to the left, eyes shut', rest: 'settle' };

// ---- moods: the same dragon, expressed through the eyes and the smile only ----------------------------------------
export const MOODS = ['waiting', 'success', 'failure', 'greeting'];
const GREETING = "Hi, I'm Quox!";
const MOOD_NOTE = {
  waiting: 'waiting: eyes wide on you, a slow look about, a patient blink',
  success: 'success: a blink, then happy closed eyes and a big smile',
  failure: 'failure: the eyes sink and look away, the smile turns down',
  greeting: 'greeting: eyes open, look at you, a blink, the smile says hi',
};
const greetCells = (text, t) => {
  const n = Math.floor(clamp(t / 45, 0, text.length));
  return [...text].map((ch, i) => ({ ch: i < n ? ch : ' ', rgb: [56 + (168 - 56) * (i / (text.length - 1)), 189 + (85 - 189) * (i / (text.length - 1)), 248 + (247 - 248) * (i / (text.length - 1))].map(Math.round) }));
};
/** The calm base every mood sits on: the pick's easy tail sway, wings gently flapping, smile closed. */
function calmPose(t) {
  const p = talkPose(t, 0);
  p.flap = 0.12 * Math.sin(t * 0.0068 * 0.5);
  return p;
}
/** A mood at t ms since it began: { pose, eyes, caption }. still: the static representative form. */
export function moodFrame(mood, t, { still = false } = {}) {
  const p = calmPose(still ? 0 : t);
  let eyes = eyeState('open', 0);
  switch (mood) {
    case 'waiting': {
      const u = still ? 0 : t;
      eyes = { open: still ? 1 : blinkOpen((u % 2600) - 2200), gx: still ? 0 : 0.55 * Math.sin(u / 1500), gy: 0.55 };
      break;
    }
    case 'success': {
      const shut = still || (t >= 1100 && t < 3300);
      eyes = { open: shut ? 0 : blinkOpen(t - 450), gx: 0, gy: 1 };
      p.smile = still ? 0.9 : kf(t, [[1000, 0], [1400, 0.9], [3000, 0.9], [3400, 0]]);
      break;
    }
    case 'failure': {
      const k = still ? 1 : kf(t, [[0, 0], [350, 1]]);
      eyes = { open: 1 - 0.45 * k, gx: -0.7 * k, gy: 1 };
      p.frown = k > 0.5 ? 1 : 0;
      break;
    }
    case 'greeting': {
      eyes = { open: still ? 1 : kf(t, [[0, 0], [450, 1]]) * Math.min(blinkOpen(t - 1700), blinkOpen(t - 1960)), gx: 0, gy: 1 };
      p.smile = still ? 0 : t > 700 && t < 1700 ? talkOpen(t) : 0;
      p.label = { cells: greetCells(GREETING, still ? 1e9 : t - 400) };
      break;
    }
    default: throw new Error(`unknown dragon mood: ${mood}`);
  }
  return { pose: p, eyes, caption: MOOD_NOTE[mood] };
}

// ---- client clips (CLI-QUOX F3) ---------------------------------------------------------------------------

/** Where the fire clip starts inside the hero: just before the face turns left. */
const FIRE_OFFSET = HERO_TALK_MS + PICK.sway + PICK.whip;
const FIRE_MS = HERO_MOVE_MS + PICK.fire + PICK.rest;
const heroClipFrame = (t, offset = 0) => { const tt = t + offset; return { ...heroFrame(tt, HERO_TALK_MS), caption: HERO_CAP[heroPhase(tt)] }; };
/** The hero: talk, sway sway sway whip, the face turns left, fire from the mouth, settle. /dragon, classic and the pick all play it. */
const heroClip = {
  dur: HERO_MS,
  at: (t) => heroClipFrame(t),
  still: () => ({ pose: restPose(), eyes: eyeState('open', 0), caption: 'the dragon (static form)' }),
  cells: (t, cols, o) => heroCells(t, cols, PICK_EYES, o),
  width: 100, title: 'The dragon',
  caption: 'googly dot eyes, a smile that talks; the tail sways and whips, then the face turns left and the dragon breathes fire from its mouth, eyes squeezed shut (/dragon)',
};
/** /dragon fire: the hero's last act on its own: the face turns left, fire from the mouth, settle. */
const fireClip = {
  dur: FIRE_MS,
  at: (t) => heroClipFrame(t, FIRE_OFFSET),
  still: heroClip.still,
  cells: (t, cols, o) => heroCells(t + FIRE_OFFSET, cols, PICK_EYES, o),
  width: 100, title: 'Fire',
  caption: 'the face turns left and the dragon breathes fire from its mouth, eyes squeezed shut (/dragon fire)',
};
/** A mood as a short vignette (cinematic level only). No label unless asked: the status line already says what happened. */
const moodClip = (mood, dur, width, title, caption, label = false) => ({
  dur, width, title, caption,
  at(t) { const fr = moodFrame(mood, t); if (!label) fr.pose.label = null; return fr; },
  still() { const fr = moodFrame(mood, 0, { still: true }); if (!label) fr.pose.label = null; return fr; },
});

/**
 * Everything the client plays, by name. width = the frame the clip wants (the hero and fire need room to the left
 * for the fire; moods are compact). pick and idle (/dragon, /dragon classic) are the hero itself: no separate designs.
 */
export const CLIPS = {
  hero: heroClip,
  pick: heroClip,
  idle: heroClip,
  fire: fireClip,
  waiting: moodClip('waiting', 2500, 40, 'Mood: waiting', 'waiting for your approval: eyes wide on you (cinematic motion)'),
  success: moodClip('success', 2300, 40, 'Mood: success', 'done: a blink, then happy eyes and a big smile (cinematic motion)'),
  failure: moodClip('failure', 2200, 40, 'Mood: failure', 'failed: the eyes sink and look away, the smile turns down (cinematic motion)'),
  greeting: moodClip('greeting', 2600, 64, 'Mood: greeting', 'hello: the eyes open, look at you, blink, the smile says hi (the cinematic intro)', true),
};
export const CLIP_NAMES = Object.keys(CLIPS);
/** The moods the app plays at the cinematic level, keyed by what happened. */
export const MOOD_CLIPS = ['waiting', 'success', 'failure', 'greeting'];

/**
 * Cells of a clip at t ms: rows of { ch, rgb, bg }. opts: cols (the room there is), theme 'dark' | 'light',
 * mono (NO_COLOR: shapes only), still (reduced motion: the static form), size / lm (force a layout), label (false:
 * no words in the frame).
 */
export function clipCells(name, t, { cols = 100, theme = 'dark', mono = false, still = false, size, lm, label = true } = {}) {
  const c = CLIPS[name];
  if (!c) throw new Error(`unknown dragon clip: ${name}`);
  const L = dragonLayout(Math.max(size ? 8 : 40, Math.min(cols, c.width)), { size, lm }); // a forced size (the intro) may be narrower than 40
  const tt = Math.max(0, Math.min(t, c.dur));
  if (c.cells) return c.cells(tt, L.cols, { theme, mono, still, size, lm });
  const fr = still ? c.still() : c.at(tt);
  if (!label) fr.pose.label = null; // the intro has its own words beside the art
  return composeCells(fr.pose, fr.eyes, L, PICK_EYES, { theme, mono, t: tt });
}
/** The caption of a clip at t (what the dragon is doing now). */
export const clipCaption = (name, t) => CLIPS[name].at(Math.max(0, Math.min(t, CLIPS[name].dur))).caption;

// ---- the launch egg: the v8 dragon's googly-eye greeting beside the settled Q ------------------------------
import { qDims } from './qart.js';
export const EGG_MS = CLIPS.greeting.dur;
/** The egg at t ms (after the Q has settled): the v8 dragon opens its googly eyes, looks, blinks and smiles, at the Q's size. */
export function eggCells(size, t, { color = true, theme = 'dark' } = {}) {
  const L = dragonLayout(qDims(size).cols + 6, { size, lm: 0 });
  return clipCells('greeting', t, { cols: L.cols, size, lm: 0, theme, mono: !color, label: false });
}
