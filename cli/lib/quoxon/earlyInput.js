/**
 * Keys typed before the app is ready (R3 audit D4). bin/quox.js calls this before it loads React, Ink or any
 * command module, so the tty is raw (no cooked echo) and every key is kept for the composer. main() calls it
 * again and gets the same capture. Tiny on purpose: it must not import anything heavy.
 *
 * A line typed while the tty was still cooked reaches us when raw mode turns on, with the kernel's ICRNL
 * having turned its Enter into LF; that first read is mapped back to CR so the Enter submits as typed.
 */
import { PASTE_ON, PASTE_OFF } from './keys.js';

const COOKED_MS = 50; // the read that drains the cooked line buffer arrives right after raw mode turns on
let shared = null;

export function captureEarlyInput(stdin = process.stdin, stdout = process.stdout) {
  const own = stdin === process.stdin;
  if (own && shared) return shared;
  if (!stdin?.isTTY) return null;
  const chunks = [];
  const t0 = Date.now();
  const fn = (d) => {
    const s = typeof d === 'string' ? d : d.toString('utf8');
    chunks.push(Date.now() - t0 < COOKED_MS ? s.replace(/\n/g, '\r') : s);
  };
  try { stdin.setRawMode?.(true); stdin.resume?.(); } catch { /* not a tty after all */ }
  stdin.on('data', fn);
  if (stdout?.isTTY) stdout.write(PASTE_ON);
  const cap = {
    chunks,
    detach: () => stdin.off('data', fn),
    /** Nothing will take the terminal over (help, a flag error): give it back as it was. */
    release: () => {
      stdin.off('data', fn);
      try { stdin.setRawMode?.(false); stdin.pause?.(); } catch { /* ignore */ }
      if (stdout?.isTTY) stdout.write(PASTE_OFF);
      if (own) shared = null;
    }
  };
  if (own) shared = cap;
  return cap;
}
