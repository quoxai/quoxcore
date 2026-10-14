/**
 * Offline renderer for the QuoxSound earcons: the dashboard's Web Audio
 * recipes (src/services/quoxSound.js RECIPES) rendered sample by sample into
 * 16-bit mono PCM WAV. No assets, no dependencies.
 *
 * Timbre: fundamental + octave (0.18) + twelfth (0.07), linear attack then an
 * exponential decay to near-silence, same as the phone earcons. `success`
 * reuses the granted interval (587 -> 880 Hz), `denied` the denied floor
 * (233 Hz gliding down through a 600 Hz lowpass).
 */

export const SAMPLE_RATE = 44100;
const HARMONICS = [[1, 1], [2, 0.18], [3, 0.07]];
const FLOOR = 0.0001;

/** The recipes as data: the same notes, times and envelopes as the dashboard. */
export const RECIPES = {
  hitl: { notes: [
    { freq: 523.25, at: 0, decay: 0.30, peak: 0.20 },
    { freq: 659.25, at: 0.15, decay: 0.30, peak: 0.19 },
    { freq: 880.0, at: 0.30, decay: 0.32, peak: 0.18 }
  ] },
  notify: { notes: [
    { freq: 698.46, at: 0, attack: 0.01, decay: 0.10, peak: 0.11 },
    { freq: 932.33, at: 0.10, attack: 0.01, decay: 0.14, peak: 0.10 }
  ] },
  success: { notes: [
    { freq: 587.33, at: 0, attack: 0.003, decay: 0.04, peak: 0.09 },
    { freq: 880.0, at: 0.045, attack: 0.003, decay: 0.07, peak: 0.09 }
  ] },
  denied: { lowpass: 600, notes: [
    { freq: 233.08, glideTo: 150, at: 0, attack: 0.004, decay: 0.16, peak: 0.28, harmonics: [[1, 1]] }
  ] },
  critical: { lowpass: 2400, notes: [0, 1, 2].map(i => (
    { freq: 622.25, at: i * 0.12, type: 'square', attack: 0.003, decay: 0.07, peak: 0.12, harmonics: [[1, 1]] }
  )) }
};

function envelope(t, attack, decay, peak) {
  if (t < 0) return 0;
  if (t < attack) return FLOOR + (peak - FLOOR) * (t / attack);
  const d = t - attack;
  if (d < decay) return peak * Math.pow(FLOOR / peak, d / decay);
  return 0;
}

function renderNote(out, sr, n) {
  const attack = n.attack ?? 0.008;
  const decay = n.decay ?? 0.2;
  const peak = n.peak ?? 0.2;
  const harmonics = n.harmonics || HARMONICS;
  const len = attack + decay + 0.02;
  const start = Math.round(n.at * sr);
  const count = Math.min(out.length - start, Math.round(len * sr));
  for (const [mult, level] of harmonics) {
    let phase = 0;
    for (let i = 0; i < count; i++) {
      const t = i / sr;
      // exponential glide over attack + decay, then held (as exponentialRampToValueAtTime)
      const f = n.glideTo ? n.freq * Math.pow(n.glideTo / n.freq, Math.min(1, t / (attack + decay))) : n.freq;
      phase += (2 * Math.PI * f * mult) / sr;
      const osc = n.type === 'square' ? (Math.sin(phase) >= 0 ? 1 : -1) : Math.sin(phase);
      out[start + i] += osc * level * envelope(t, attack, decay, peak);
    }
  }
}

/** RBJ biquad lowpass, in place. */
function lowpass(buf, sr, cutoff, q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * cutoff) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0, b1 = (1 - cos) / a0, b2 = (1 - cos) / 2 / a0;
  const a1 = (-2 * cos) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    buf[i] = y;
  }
}

/** Render one earcon to float samples in [-1, 1]. */
export function renderEarcon(id, { volume = 0.6, sampleRate = SAMPLE_RATE } = {}) {
  const r = RECIPES[id];
  if (!r) throw new Error(`unknown earcon ${id}`);
  const secs = Math.max(...r.notes.map(n => n.at + (n.attack ?? 0.008) + (n.decay ?? 0.2) + 0.02));
  const out = new Float32Array(Math.ceil(secs * sampleRate));
  for (const n of r.notes) renderNote(out, sampleRate, n);
  if (r.lowpass) lowpass(out, sampleRate, r.lowpass);
  const g = Math.min(1, Math.max(0, volume));
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i] * g));
  return out;
}

/** Float samples -> 16-bit mono PCM WAV (44-byte RIFF header). */
export function toWav(samples, sampleRate = SAMPLE_RATE) {
  const data = samples.length * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + data, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);        // fmt chunk size
  buf.writeUInt16LE(1, 20);         // PCM
  buf.writeUInt16LE(1, 22);         // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);         // block align
  buf.writeUInt16LE(16, 34);        // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), 44 + i * 2);
  }
  return buf;
}

export const earconWav = (id, opts = {}) => toWav(renderEarcon(id, opts), opts.sampleRate ?? SAMPLE_RATE);
