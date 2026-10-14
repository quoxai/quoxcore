/**
 * QuoxSound in the terminal: the controller the app calls from its single
 * dispatch point. Decides (mapping.js), gates (profile, rate limit, mode) and
 * plays (synthesised WAV through the OS player, or the terminal bell).
 *
 *   const snd = createSound({ api, stdout });
 *   snd.observe(prevState, nextState, action)   // after every reduce
 *   snd.focus(true|false)                      // from CSI I / CSI O (keys.js)
 *   await snd.command(arg, say)                // /sound
 *
 * Never throws, never blocks: players are spawned detached with a kill timer.
 * The setting is the dashboard's server-side `soundProfile` preference
 * (PATCH /api/auth/me), so dashboard and terminal agree; the active CLI
 * profile keeps a local copy for offline starts and as the fallback store.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { soundForEvent, createLimiter, normalizeSettings, allowed, PROFILE_IDS, PROFILE_LABELS } from './mapping.js';
import { soundMode, findPlayer, BEL, BEL_IDS } from './output.js';
import { earconWav } from './synth.js';

export const FOCUS_ON = '\x1b[?1004h';
export const FOCUS_OFF = '\x1b[?1004l';
export const PLAYER_TIMEOUT_MS = 5000;

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const USAGE = 'Usage: /sound [Silent | Minimal | Operational | Full | test]';

function offReason({ env, stdout, print }) {
  if (print) return '--print never makes sound';
  if (!stdout?.isTTY) return 'not a terminal';
  if (String(env.QUOX_SOUND ?? '').length && soundMode({ env: { QUOX_SOUND: env.QUOX_SOUND }, stdout: { isTTY: true } }) === 'off') return `QUOX_SOUND=${env.QUOX_SOUND}`;
  return 'CI';
}

function defaultCacheDir(env) {
  const base = env.XDG_CACHE_HOME || join(homedir(), '.cache');
  const dir = join(base, 'quox', 'sound');
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; } catch { return mkdtempSync(join(tmpdir(), 'quox-sound-')); }
}

export function createSound({
  api = null, stdout = null, env = process.env, print = false, platform = process.platform,
  has, spawn = nodeSpawn, now = Date.now, cacheDir = null, exitHook = (fn) => process.once('exit', fn),
  timeoutMs = PLAYER_TIMEOUT_MS
} = {}) {
  const mode = soundMode({ env, stdout, print });
  const limiter = createLimiter();
  const localProfile = safe(() => api?.localSoundProfile?.()) || null;
  let settings = normalizeSettings({ profile: localProfile || undefined });
  let source = localProfile ? 'local' : 'default';
  let userSet = false;
  let focused = null;
  let player; // undefined = not looked up yet
  let dir = cacheDir;
  let focusOn = false;
  let serverError = null;

  function safe(fn) { try { return fn(); } catch { return null; } }
  const write = (s) => { try { stdout?.write?.(s); } catch { /* never throw */ } };

  // Server preference (source of truth), loaded in the background; a /sound typed meanwhile wins.
  const ready = (async () => {
    if (mode === 'off' || !api?.soundSettings) return;
    try {
      const v = await api.soundSettings();
      if (v && !userSet) { settings = normalizeSettings(v); source = 'account'; safe(() => api.setLocalSoundProfile?.(settings.profile)); }
    } catch (e) { serverError = e?.message || 'unreachable'; }
  })();

  if (mode !== 'off') {
    write(FOCUS_ON);
    focusOn = true;
    safe(() => exitHook(dispose));
  }

  function getPlayer() {
    if (player === undefined) player = safe(() => findPlayer({ platform, ...(has ? { has } : {}) })) || null;
    return player;
  }

  function wavFile(id) {
    if (!dir) dir = defaultCacheDir(env);
    const vol = Math.round(settings.volume * 100);
    const file = join(dir, `quox-${id}-v${vol}.wav`);
    if (!existsSync(file)) {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, earconWav(id, { volume: settings.volume }));
      renameSync(tmp, file);
    }
    return file;
  }

  /** Emit `id` now (gates already passed). Returns how it went out: 'audio' | 'bel' | null. */
  function emit(id) {
    if (mode === 'off') return null;
    const p = mode === 'audio' ? getPlayer() : null;
    if (!p) {
      if (!BEL_IDS.has(id)) return null;
      write(BEL);
      return 'bel';
    }
    try {
      const file = wavFile(id);
      const child = spawn(p.cmd, p.args(file), { detached: true, stdio: 'ignore', windowsHide: true });
      child.on?.('error', () => {});
      child.unref?.();
      const t = setTimeout(() => { try { child.kill?.(); } catch { /* gone */ } }, timeoutMs);
      t.unref?.();
      return 'audio';
    } catch {
      if (BEL_IDS.has(id)) { write(BEL); return 'bel'; }
      return null;
    }
  }

  function observe(prev, next, action) {
    if (mode === 'off') return null;
    try {
      const id = soundForEvent(prev, action, { next, now: action?.now ?? now(), focused });
      if (!id || !allowed(id, settings) || !limiter.take(id, now())) return null;
      emit(id);
      return id;
    } catch { return null; }
  }

  function outputLine() {
    if (mode === 'off') return `Output: off (${offReason({ env, stdout, print })}).`;
    if (mode === 'bel') return 'Output: terminal bell, approvals and critical alerts only (over SSH the speaker is on your side).';
    const p = getPlayer();
    return p ? `Output: speaker via ${p.cmd}.` : 'Output: terminal bell, approvals and critical alerts only (no audio player found).';
  }

  function whereLine() {
    if (source === 'account') return 'Saved to your account; the dashboard uses the same setting.';
    if (source === 'local') return `Saved on this machine only${serverError ? ` (account setting unreachable: ${serverError})` : ''}.`;
    return `Default${serverError ? ` (account setting unreachable: ${serverError})` : ''}.`;
  }

  async function command(arg, say) {
    const a = String(arg || '').trim().toLowerCase();
    if (!a) {
      say(`Sound: ${cap(settings.profile)} (${PROFILE_LABELS[settings.profile]}). ${whereLine()}`);
      say(outputLine());
      say('Change with /sound silent|minimal|operational|full · /sound test plays the approval chime · QUOX_SOUND=off mutes this terminal.');
      return;
    }
    if (a === 'test') {
      if (mode === 'off') return say(outputLine(), 'warn');
      const how = emit('hitl');
      return say(how === 'audio' ? `Played the approval chime via ${getPlayer().cmd}.` : how === 'bel' ? 'Rang the terminal bell.' : 'Nothing to play on.', how ? undefined : 'warn');
    }
    if (!PROFILE_IDS.includes(a)) return say(USAGE, 'warn');
    userSet = true;
    settings = normalizeSettings({ ...settings, profile: a });
    safe(() => api?.setLocalSoundProfile?.(a));
    try {
      if (!api?.setSoundSettings) throw new Error('not available in this mode');
      await api.setSoundSettings(settings);
      source = 'account';
      serverError = null;
    } catch (e) {
      serverError = e?.message || 'failed';
      source = api?.setLocalSoundProfile ? 'local' : 'session';
    }
    const where = source === 'account' ? 'Saved to your account (the dashboard uses the same setting).'
      : source === 'local' ? `Saved on this machine only: the account setting could not be written (${serverError}).`
        : `For this session only: ${serverError}.`;
    say(`Sound: ${cap(a)} (${PROFILE_LABELS[a]}). ${where}`, source === 'account' ? 'ok' : 'warn');
  }

  function dispose() {
    if (!focusOn) return;
    focusOn = false;
    write(FOCUS_OFF);
  }

  return {
    mode, ready, observe, command, dispose, emit,
    focus(v) { focused = Boolean(v); },
    settings: () => ({ ...settings }),
    get focused() { return focused; }
  };
}
