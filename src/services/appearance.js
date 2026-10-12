/**
 * appearance.js — Background appearance settings
 *
 * Manages the dashboard background (body bg) across three modes:
 *   1. 'quox'  — canonical 5-orb cyan/purple gradient (default)
 *   2. 'image' — user-uploaded image with fit/darken/blur
 *   3. 'orbs'  — user-customised orb gradient
 *
 * Applies the computed CSS to a persistent <style id="qx-appearance"> tag
 * so it overrides the body rule in index.css globally. Persists state to
 * localStorage under key 'qx-appearance'.
 *
 * Usage:
 *   import { initAppearance, getAppearance, setAppearance } from './appearance'
 *   initAppearance()                // call once on app mount
 *   const state = getAppearance()
 *   setAppearance({ ...state, mode: 'orbs' })
 */

const STORAGE_KEY = 'qx-appearance';
const STYLE_ID = 'qx-appearance';

// Canonical Quox default — matches .glass-page in index.css / glass.css
export const QUOX_PRESET = {
  orbs: [
    { color: '#00e5ff', opacity: 0.28, x: 15, y: 20, w: 50, h: 40 },
    { color: '#8b5cf6', opacity: 0.32, x: 85, y: 15, w: 45, h: 40 },
    { color: '#3b82f6', opacity: 0.24, x: 75, y: 80, w: 50, h: 45 },
    { color: '#7c3aed', opacity: 0.20, x: 20, y: 88, w: 45, h: 40 },
    { color: '#00b4dc', opacity: 0.10, x: 50, y: 50, w: 30, h: 25 },
  ],
  baseTop: '#000000',
  baseBottom: '#050b22',
};

const DEFAULT_STATE = {
  mode: 'quox', // 'quox' | 'image' | 'orbs'
  image: {
    dataUrl: null,
    fit: 'cover', // 'cover' | 'contain' | '100% 100%' | 'auto' | 'repeat'
    darken: 40,   // 0-100 percent
    blur: 0,      // 0-30 px
  },
  orbs: {
    list: JSON.parse(JSON.stringify(QUOX_PRESET.orbs)),
    baseTop: QUOX_PRESET.baseTop,
    baseBottom: QUOX_PRESET.baseBottom,
  },
  slots: [null, null, null, null, null],
};

// ─── state ───────────────────────────────────────────────────────
let current = loadState();
const listeners = new Set();

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      return {
        ...DEFAULT_STATE,
        ...saved,
        image: { ...DEFAULT_STATE.image, ...(saved.image || {}) },
        orbs: { ...DEFAULT_STATE.orbs, ...(saved.orbs || {}) },
        slots: Array.isArray(saved.slots) ? saved.slots : DEFAULT_STATE.slots,
      };
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch {}
}

// ─── CSS generation ──────────────────────────────────────────────
function hexToRgba(hex, a = 1) {
  const h = hex?.replace('#', '') || '000000';
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function buildOrbsBackground(orbs) {
  const layers = orbs.list.map(o =>
    `radial-gradient(ellipse ${o.w}% ${o.h}% at ${o.x}% ${o.y}%, ${hexToRgba(o.color, o.opacity)}, transparent 70%)`
  );
  layers.push(`linear-gradient(180deg, ${orbs.baseTop} 0%, ${orbs.baseBottom} 100%)`);
  return layers.join(',');
}

function buildQuoxBackground() {
  return [
    'radial-gradient(ellipse 50% 40% at 15% 20%, rgba(0,229,255,0.28), transparent 70%)',
    'radial-gradient(ellipse 45% 40% at 85% 15%, rgba(139,92,246,0.32), transparent 70%)',
    'radial-gradient(ellipse 50% 45% at 75% 80%, rgba(59,130,246,0.24), transparent 70%)',
    'radial-gradient(ellipse 45% 40% at 20% 88%, rgba(124,58,237,0.20), transparent 70%)',
    'radial-gradient(ellipse 30% 25% at 50% 50%, rgba(0,180,220,0.10), transparent 70%)',
    'linear-gradient(180deg,#000 0%,#030714 45%,#050b22 100%)',
  ].join(',');
}

/**
 * Build the full CSS block to inject. Targets `body` and the `.glass-page`
 * class to override the defaults from index.css + glass.css.
 */
export function buildAppearanceCss(state = current) {
  if (state.mode === 'quox') {
    const bg = buildQuoxBackground();
    return `
body, .glass-page {
  background: ${bg} !important;
  background-attachment: fixed !important;
}
body::after, .glass-page::after {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background: linear-gradient(180deg, rgba(0,0,0,0.18), rgba(0,0,0,0.38));
}
`.trim();
  }

  if (state.mode === 'orbs') {
    const bg = buildOrbsBackground(state.orbs);
    return `
body, .glass-page {
  background: ${bg} !important;
  background-attachment: fixed !important;
}
body::after, .glass-page::after {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background: linear-gradient(180deg, rgba(0,0,0,0.18), rgba(0,0,0,0.38));
}
`.trim();
  }

  if (state.mode === 'image') {
    if (!state.image.dataUrl) {
      // fall back to quox if no image uploaded
      return buildAppearanceCss({ ...state, mode: 'quox' });
    }
    const url = state.image.dataUrl;
    const fit = state.image.fit;
    const isRepeat = fit === 'repeat';
    const sizeCss = isRepeat ? 'auto' : fit;
    const repeatCss = isRepeat ? 'repeat' : 'no-repeat';
    const darken = (state.image.darken / 100).toFixed(2);
    const blurPx = state.image.blur;

    // Strategy: use a fixed background-image on body, darken overlay via ::after.
    // Blur is applied by a wrapper via filter on a pseudo — can't blur body's
    // own background directly, so we use a fixed-position ::before to hold the
    // blurred image.
    return `
body, .glass-page {
  background: #000 !important;
}
body::before, .glass-page::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: -2;
  background-image: url(${url});
  background-size: ${sizeCss};
  background-position: center;
  background-repeat: ${repeatCss};
  ${blurPx > 0 ? `filter: blur(${blurPx}px);` : ''}
}
body::after, .glass-page::after {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: -1;
  background: rgba(0,0,0,${darken});
}
`.trim();
  }

  return '';
}

// ─── apply to DOM ────────────────────────────────────────────────
export function applyAppearance(state = current) {
  if (typeof document === 'undefined') return;
  let tag = document.getElementById(STYLE_ID);
  if (!tag) {
    tag = document.createElement('style');
    tag.id = STYLE_ID;
    document.head.appendChild(tag);
  }
  tag.textContent = buildAppearanceCss(state);
}

// ─── public API ──────────────────────────────────────────────────
export function initAppearance() {
  current = loadState();
  applyAppearance(current);
}

export function getAppearance() {
  return JSON.parse(JSON.stringify(current));
}

export function setAppearance(nextState) {
  current = { ...current, ...nextState };
  saveState();
  applyAppearance(current);
  listeners.forEach(fn => { try { fn(current); } catch {} });
}

export function resetAppearance() {
  current = JSON.parse(JSON.stringify(DEFAULT_STATE));
  saveState();
  applyAppearance(current);
  listeners.forEach(fn => { try { fn(current); } catch {} });
}

export function subscribeAppearance(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Utility exposed for the settings UI
export { hexToRgba, buildOrbsBackground, buildQuoxBackground };
