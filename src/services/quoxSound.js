/**
 * QuoxSound (phase one): a tiny Web Audio earcon engine for the dashboard.
 *
 * Design rules (owner, QuoxSound plan): sound communicates STATE, not
 * personality. The more common the event, the quieter and shorter its sound.
 * `hitl` is reserved for "human action required" and nothing else. No sound
 * for hover, clicks or tool execution.
 *
 * Everything is synthesised in code (oscillators + envelopes), so there are
 * no audio assets and no licensing. The timbre mirrors the shipped phone
 * earcons (quox-voice/tools/gen_earcons.py): fundamental + quiet octave
 * (0.18) + quiet twelfth (0.07), and `success`/`denied` reuse the phone's
 * granted (587 -> 880 Hz) and denied (311 -> 233 Hz) intervals.
 *
 * Guarantees:
 *  - One shared AudioContext, created lazily and resumed on the first user
 *    gesture (browser autoplay policy). Never throws to callers.
 *  - Rate limit: at most one sound per type per 2s. A burst (5 approvals at
 *    once) plays one chime.
 *  - Profile gating: Silent | Minimal | Operational | Full, plus per-layer
 *    toggles (ui / agents / notifications / security).
 *  - Visibility: while the tab is hidden only the attention sounds (`hitl`,
 *    `critical`) play; feedback sounds are pointless when nobody is looking.
 *
 * Settings persist SERVER-SIDE via the `soundProfile` preferences namespace
 * (userPreferences.js NAMESPACE_MAP); localStorage is only the hydrated cache.
 * Playback emits no AEE evidence (not evidence-worthy); the setting change is
 * audited by PATCH /api/auth/me (AUTH_PROFILE_UPDATE).
 */

import { syncPreferenceToServer } from './userPreferences';

export const SOUND_STORAGE_KEY = 'quox-sound-profile';
export const SOUND_SERVER_NAMESPACE = 'soundProfile';

export const SOUND_IDS = ['hitl', 'notify', 'success', 'denied', 'critical'];

export const SOUND_LABELS = {
    hitl: 'Approval needed',
    notify: 'Notification',
    success: 'Success',
    denied: 'Blocked / denied',
    critical: 'Critical',
};

/** Which layer each sound belongs to (per-layer toggles gate on this). */
export const SOUND_LAYERS = {
    hitl: 'notifications',
    notify: 'notifications',
    success: 'agents',
    denied: 'security',
    critical: 'security',
};

export const LAYER_IDS = ['ui', 'agents', 'notifications', 'security'];

export const PROFILES = {
    silent: [],
    minimal: ['hitl', 'critical'],
    operational: ['hitl', 'critical', 'notify', 'success', 'denied'],
    // Phase one: same as Operational. Reserved for ambient UI ticks later.
    full: ['hitl', 'critical', 'notify', 'success', 'denied'],
};

export const PROFILE_IDS = ['silent', 'minimal', 'operational', 'full'];

export const DEFAULT_SOUND_SETTINGS = Object.freeze({
    profile: 'minimal',
    volume: 0.6,
    layers: Object.freeze({ ui: true, agents: true, notifications: true, security: true }),
});

/** Sounds allowed to play while the tab is hidden (attention, not feedback). */
const HIDDEN_ALLOWED = new Set(['hitl', 'critical']);

export const RATE_LIMIT_MS = 2000;

// ── settings ────────────────────────────────────────────────────────────

export function normalizeSoundSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const profile = PROFILE_IDS.includes(src.profile) ? src.profile : DEFAULT_SOUND_SETTINGS.profile;
    const v = Number(src.volume);
    const volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_SOUND_SETTINGS.volume;
    const layers = { ...DEFAULT_SOUND_SETTINGS.layers };
    if (src.layers && typeof src.layers === 'object') {
        for (const id of LAYER_IDS) {
            if (typeof src.layers[id] === 'boolean') layers[id] = src.layers[id];
        }
    }
    return { profile, volume, layers };
}

export function getSoundSettings() {
    try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SOUND_STORAGE_KEY) : null;
        return normalizeSoundSettings(raw ? JSON.parse(raw) : null);
    } catch {
        return normalizeSoundSettings(null);
    }
}

/** Persist: write the local cache, then queue the server write (source of truth). */
export function saveSoundSettings(next) {
    const normalized = normalizeSoundSettings(next);
    try { localStorage.setItem(SOUND_STORAGE_KEY, JSON.stringify(normalized)); } catch { /* quota */ }
    try { syncPreferenceToServer(SOUND_SERVER_NAMESPACE, normalized); } catch { /* best effort */ }
    return normalized;
}

/** Pure gate: may `id` play under these settings? */
export function isSoundEnabled(id, settings = getSoundSettings()) {
    const s = normalizeSoundSettings(settings);
    if (!SOUND_IDS.includes(id)) return false;
    if (s.volume <= 0) return false;
    if (!PROFILES[s.profile].includes(id)) return false;
    return s.layers[SOUND_LAYERS[id]] !== false;
}

// ── audio context ───────────────────────────────────────────────────────

let ctx = null;
let ctxFactory = null;
let unlockInstalled = false;
const lastPlayed = new Map();
let nowFn = () => Date.now();

function getCtx() {
    if (ctx) return ctx;
    try {
        const Ctor = ctxFactory
            || (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext));
        if (!Ctor) return null;
        ctx = new Ctor();
    } catch {
        ctx = null;
    }
    return ctx;
}

function resumeCtx() {
    try {
        const c = getCtx();
        if (c && c.state === 'suspended' && typeof c.resume === 'function') {
            const p = c.resume();
            if (p && typeof p.catch === 'function') p.catch(() => {});
        }
    } catch { /* never throw */ }
}

/**
 * Install the one-time gesture unlock. Browsers keep a fresh AudioContext
 * suspended until a user gesture; once resumed it can play while the tab is
 * hidden, which is what lets an approval chime reach a backgrounded tab.
 */
export function initQuoxSound() {
    if (unlockInstalled || typeof window === 'undefined') return;
    unlockInstalled = true;
    const unlock = () => {
        resumeCtx();
        window.removeEventListener('pointerdown', unlock, true);
        window.removeEventListener('keydown', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
}

// ── synthesis ───────────────────────────────────────────────────────────

const HARMONICS = [[1, 1], [2, 0.18], [3, 0.07]]; // same timbre as gen_earcons.py

/**
 * One voiced note: fundamental + quiet harmonics into a shared envelope.
 * attack/decay in seconds; decay is exponential to near-silence.
 */
function note(c, out, { freq, at, attack = 0.008, decay = 0.2, peak = 0.2, type = 'sine', glideTo = null, harmonics = HARMONICS }) {
    const env = c.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.linearRampToValueAtTime(peak, at + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    env.connect(out);
    for (const [mult, level] of harmonics) {
        const osc = c.createOscillator();
        osc.type = type;
        osc.frequency.setValueAtTime(freq * mult, at);
        if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo * mult, at + attack + decay);
        let node = osc;
        if (level !== 1) {
            const g = c.createGain();
            g.gain.setValueAtTime(level, at);
            osc.connect(g);
            node = g;
        }
        node.connect(env);
        osc.start(at);
        osc.stop(at + attack + decay + 0.02);
    }
}

/** Sound recipes. Each returns nothing; schedules nodes on `out` from time `t`. */
export const RECIPES = {
    // Calm 3-note chime, ~600ms: C5 -> E5 -> A5 (soft A-minor colour, unhurried
    // 150ms steps, bell decay). Reserved for "human action required".
    hitl(c, out, t) {
        note(c, out, { freq: 523.25, at: t, decay: 0.30, peak: 0.20 });
        note(c, out, { freq: 659.25, at: t + 0.15, decay: 0.30, peak: 0.19 });
        note(c, out, { freq: 880.0, at: t + 0.30, decay: 0.32, peak: 0.18 });
    },
    // Single soft two-tone, ~250ms: F5 -> Bb5 (a fourth), quiet.
    notify(c, out, t) {
        note(c, out, { freq: 698.46, at: t, attack: 0.01, decay: 0.10, peak: 0.11 });
        note(c, out, { freq: 932.33, at: t + 0.10, attack: 0.01, decay: 0.14, peak: 0.10 });
    },
    // Tiny resolving click, ~110ms: phone `granted` interval (D5 -> A5) shrunk.
    success(c, out, t) {
        note(c, out, { freq: 587.33, at: t, attack: 0.003, decay: 0.04, peak: 0.09 });
        note(c, out, { freq: 880.0, at: t + 0.045, attack: 0.003, decay: 0.07, peak: 0.09 });
    },
    // Muted low thunk, ~170ms: sine 233 Hz (phone `denied` floor) gliding down
    // to 150 Hz through a 600 Hz lowpass, fundamental only.
    denied(c, out, t) {
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(600, t);
        lp.connect(out);
        note(c, lp, { freq: 233.08, glideTo: 150, at: t, attack: 0.004, decay: 0.16, peak: 0.28, harmonics: [[1, 1]] });
    },
    // Dry distinct triplet, ~330ms: three 70ms square pulses at 622 Hz (D#5,
    // a tritone off the A of the chime), lowpassed at 2.4 kHz, no tail.
    // Deliberately unlike the notification family. Reserved.
    critical(c, out, t) {
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(2400, t);
        lp.connect(out);
        for (let i = 0; i < 3; i++) {
            note(c, lp, { freq: 622.25, at: t + i * 0.12, type: 'square', attack: 0.003, decay: 0.07, peak: 0.12, harmonics: [[1, 1]] });
        }
    },
};

function render(id, volume) {
    const c = getCtx();
    if (!c) return false;
    resumeCtx();
    const master = c.createGain();
    master.gain.setValueAtTime(Math.min(1, Math.max(0, volume)), c.currentTime);
    master.connect(c.destination);
    RECIPES[id](c, master, c.currentTime + 0.01);
    return true;
}

/**
 * Play an earcon, subject to profile, layers, visibility and rate limit.
 * Never throws. Returns a short reason string for tests and diagnostics:
 * 'played' | 'unknown' | 'disabled' | 'hidden' | 'rate_limited' | 'no_audio' | 'error'.
 *
 * opts.force: bypass profile + rate limit (Settings "Play test" button only).
 */
export function playSound(id, opts = {}) {
    try {
        if (!SOUND_IDS.includes(id)) return 'unknown';
        const settings = normalizeSoundSettings(opts.settings || getSoundSettings());
        if (!opts.force) {
            if (!isSoundEnabled(id, settings)) return 'disabled';
            const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
            if (hidden && !HIDDEN_ALLOWED.has(id)) return 'hidden';
            const now = nowFn();
            const last = lastPlayed.get(id);
            if (last !== undefined && now - last < RATE_LIMIT_MS) return 'rate_limited';
            lastPlayed.set(id, now);
        }
        const volume = opts.force && settings.volume <= 0 ? DEFAULT_SOUND_SETTINGS.volume : settings.volume;
        return render(id, volume) ? 'played' : 'no_audio';
    } catch {
        return 'error';
    }
}

// ── test seams ──────────────────────────────────────────────────────────

export function __setAudioContextFactory(factory) { ctxFactory = factory; ctx = null; }
export function __setNow(fn) { nowFn = fn || (() => Date.now()); }
export function __resetQuoxSound() { lastPlayed.clear(); ctx = null; }

export default { play: playSound, init: initQuoxSound, getSettings: getSoundSettings, saveSettings: saveSoundSettings };
