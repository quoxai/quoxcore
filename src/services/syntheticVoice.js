/**
 * Synthetic voice effect (VOICE-P1).
 *
 * A subtle, intelligibility-safe "robotic" colour applied at playback time,
 * so it costs nothing at the TTS provider. The dry voice stays dominant; the
 * effect adds a metallic edge on top of it rather than replacing it:
 *
 *   in -> highpass -> lowpass (band-limit, "comms" feel)
 *      -> presence peak (keeps consonants crisp, helps intelligibility)
 *      -> dry .................................................. -> sum
 *      -> ring modulator (carrier sine, multiplies the signal) ..... -> sum
 *      -> short feedback comb (a few ms, metallic resonance) ...... -> sum
 *   sum -> output gain -> out
 *
 * Two renderers share SYNTHETIC_PARAMS:
 *   - buildSyntheticChain(ctx): Web Audio nodes for live playback.
 *   - renderSyntheticPcm(samples, rate): pure JS, for tests and offline samples.
 * Web Audio's lowpass/highpass Q is in dB, so the chain converts the shared
 * linear Q (Butterworth 0.7071) to dB to keep both renderers matched.
 */

export const SYNTHETIC_PARAMS = Object.freeze({
  highpassHz: 160,
  lowpassHz: 7200,
  passQ: 0.7071,
  presenceHz: 2800,
  presenceQ: 1.0,
  presenceGainDb: 3,
  ringHz: 58,
  ringMix: 0.22,
  combDelayMs: 6.5,
  combFeedback: 0.32,
  combMix: 0.26,
  dryMix: 0.78,
  outputGain: 1.15,
});

const linQToDb = (q) => 20 * Math.log10(q);

/**
 * Build the effect as Web Audio nodes. Returns { input, output, stop }.
 * Connect your source to `input` and `output` onward; call stop() on teardown.
 */
export function buildSyntheticChain(ctx, params = SYNTHETIC_PARAMS) {
  const p = { ...SYNTHETIC_PARAMS, ...params };

  const input = ctx.createGain();
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = p.highpassHz; hp.Q.value = linQToDb(p.passQ);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = p.lowpassHz; lp.Q.value = linQToDb(p.passQ);
  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking'; presence.frequency.value = p.presenceHz;
  presence.Q.value = p.presenceQ; presence.gain.value = p.presenceGainDb;

  input.connect(hp); hp.connect(lp); lp.connect(presence);

  const sum = ctx.createGain();
  const output = ctx.createGain();
  output.gain.value = p.outputGain;
  sum.connect(output);

  // Dry path
  const dry = ctx.createGain();
  dry.gain.value = p.dryMix;
  presence.connect(dry); dry.connect(sum);

  // Ring modulator: a gain node at 0 whose gain is driven by a sine carrier,
  // so its output is signal * sin(2*pi*f*t).
  const ring = ctx.createGain();
  ring.gain.value = 0;
  const carrier = ctx.createOscillator();
  carrier.type = 'sine'; carrier.frequency.value = p.ringHz;
  carrier.connect(ring.gain);
  const ringMix = ctx.createGain();
  ringMix.gain.value = p.ringMix;
  presence.connect(ring); ring.connect(ringMix); ringMix.connect(sum);
  carrier.start();

  // Feedback comb: delay with a feedback loop, tapped into the mix.
  const delay = ctx.createDelay(0.05);
  delay.delayTime.value = p.combDelayMs / 1000;
  const feedback = ctx.createGain();
  feedback.gain.value = p.combFeedback;
  const combMix = ctx.createGain();
  combMix.gain.value = p.combMix;
  presence.connect(delay); delay.connect(feedback); feedback.connect(delay);
  delay.connect(combMix); combMix.connect(sum);

  const nodes = [input, hp, lp, presence, dry, ring, ringMix, delay, feedback, combMix, sum, output];
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { carrier.stop(); } catch { /* already stopped */ }
    try { carrier.disconnect(); } catch { /* noop */ }
    for (const n of nodes) { try { n.disconnect(); } catch { /* noop */ } }
  };

  return { input, output, stop };
}

let sharedCtx = null;
function getSharedContext() {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new Ctor();
  return sharedCtx;
}

/**
 * Route an HTMLAudioElement through the effect. Safe by default: if Web Audio
 * is missing or the context will not start, the element is left untouched and
 * plays dry. Returns a cleanup function (always callable).
 */
export async function attachSyntheticEffect(audio, params = SYNTHETIC_PARAMS) {
  const noop = () => {};
  try {
    const ctx = getSharedContext();
    if (!ctx || !audio) return noop;
    if (ctx.state !== 'running') {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 300))]);
    }
    // A suspended context would swallow the audio once the element is routed
    // into it, so only attach when the context is actually running.
    if (ctx.state !== 'running') return noop;
    const source = ctx.createMediaElementSource(audio);
    const chain = buildSyntheticChain(ctx, params);
    source.connect(chain.input);
    chain.output.connect(ctx.destination);
    return () => {
      chain.stop();
      try { source.disconnect(); } catch { /* noop */ }
    };
  } catch (err) {
    console.warn('[SyntheticVoice] effect unavailable, playing dry:', err?.message);
    return noop;
  }
}

// ---------------------------------------------------------------------------
// Pure renderer (tests + offline samples). RBJ biquads match Web Audio's.
// ---------------------------------------------------------------------------

function biquadCoeffs(type, f0, sampleRate, q, gainDb = 0) {
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  } else if (type === 'highpass') {
    b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  } else {
    const A = Math.pow(10, gainDb / 40);
    b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function runBiquad(x, [b0, b1, b2, a1, a2]) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** Apply the effect to mono PCM (Float32Array, -1..1). Returns a new array. */
export function renderSyntheticPcm(samples, sampleRate, params = SYNTHETIC_PARAMS) {
  const p = { ...SYNTHETIC_PARAMS, ...params };
  let x = runBiquad(samples, biquadCoeffs('highpass', p.highpassHz, sampleRate, p.passQ));
  x = runBiquad(x, biquadCoeffs('lowpass', p.lowpassHz, sampleRate, p.passQ));
  x = runBiquad(x, biquadCoeffs('peaking', p.presenceHz, sampleRate, p.presenceQ, p.presenceGainDb));

  const out = new Float32Array(x.length);
  const d = Math.max(1, Math.round((p.combDelayMs / 1000) * sampleRate));
  const delayBuf = new Float32Array(x.length);
  const w = (2 * Math.PI * p.ringHz) / sampleRate;
  for (let i = 0; i < x.length; i++) {
    // delay line input = signal + feedback * delayed output
    const delayed = i >= d ? delayBuf[i - d] : 0;
    delayBuf[i] = x[i] + p.combFeedback * delayed;
    const ring = x[i] * Math.sin(w * i);
    let v = p.dryMix * x[i] + p.ringMix * ring + p.combMix * delayed;
    v *= p.outputGain;
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return out;
}

export default { SYNTHETIC_PARAMS, buildSyntheticChain, attachSyntheticEffect, renderSyntheticPcm };
