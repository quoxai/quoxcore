/**
 * Where a terminal earcon goes: a local OS player, the terminal bell, or
 * nowhere. Pure decisions here; the controller (index.js) does the I/O.
 */
import { spawnSync } from 'node:child_process';

const OFF_VALUES = new Set(['off', '0', 'false', 'no', 'silent']);

/**
 * 'off'   : --print, non-TTY, CI, or QUOX_SOUND=off. Never a sound, never an escape write.
 * 'bel'   : over SSH the speaker is on the other end, so only the terminal bell can reach it.
 * 'audio' : a local desktop; play the WAV (falls back to the bell when no player exists).
 */
export function soundMode({ env = {}, stdout, print = false } = {}) {
  if (print || !stdout?.isTTY) return 'off';
  if (env.CI && !OFF_VALUES.has(String(env.CI).toLowerCase())) return 'off';
  if (OFF_VALUES.has(String(env.QUOX_SOUND ?? '').toLowerCase())) return 'off';
  if (env.SSH_CONNECTION || env.SSH_TTY) return 'bel';
  return 'audio';
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

const PLAYERS = {
  linux: [
    { cmd: 'pw-play', args: (f) => [f] },
    { cmd: 'paplay', args: (f) => [f] },
    { cmd: 'aplay', args: (f) => ['-q', f] }
  ],
  darwin: [{ cmd: 'afplay', args: (f) => [f] }],
  win32: [{ cmd: 'powershell', args: (f) => ['-NoProfile', '-NonInteractive', '-Command', `(New-Object Media.SoundPlayer(${psQuote(f)})).PlaySync()`] }]
};

/** Is `cmd` on PATH? (one lookup per player, cached by the controller) */
export function onPath(cmd, platform = process.platform) {
  try {
    const r = platform === 'win32'
      ? spawnSync('where', [cmd], { stdio: 'ignore', timeout: 2000 })
      : spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore', timeout: 2000 });
    return r.status === 0;
  } catch { return false; }
}

/** First available player for this platform, or null. */
export function findPlayer({ platform = process.platform, has = (c) => onPath(c, platform) } = {}) {
  const list = PLAYERS[platform] || PLAYERS.linux;
  return list.find(p => has(p.cmd)) || null;
}

/** Only these may ring the bell: the bell is for a human, not for feedback. */
export const BEL_IDS = new Set(['hitl', 'critical']);
export const BEL = '\x07';
