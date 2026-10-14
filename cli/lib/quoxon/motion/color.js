/** Colour helpers for the motion engine: rgb triples, mixing, hex parsing. Pure. */
export const hexRgb = (hex) => {
  const m = String(hex || '').replace('#', '');
  const v = m.length === 3 ? m.split('').map((x) => x + x).join('') : m;
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) || 0);
};
export const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
export const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const rgbStr = (rgb) => `rgb(${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))).join(',')})`;
export const smooth = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
/** Deterministic hash in [0,1) so a frame is reproducible from (cell, time bucket, salt). */
export function hash3(a, b, c) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---- perceptual interpolation (OKLab) --------------------------------------------------------------
const toLin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const toSrgb = (c) => { const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; return Math.max(0, Math.min(255, v * 255)); };
export function rgbToOklab([r, g, b]) {
  const R = toLin(r), G = toLin(g), B = toLin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
export function oklabToRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}
/** Mix two rgb colours in OKLab (perceptually even: no muddy midpoint). */
export const mixOk = (a, b, t) => { const A = rgbToOklab(a), B = rgbToOklab(b); return oklabToRgb(A.map((v, i) => v + (B[i] - v) * t)); };
/** A smooth 0..1 pulse with period `ms` (cosine ease, no hard edges). */
export const pulse01 = (now, ms = 1200) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (now % ms)) / ms);
