/**
 * POKE-WAKE (owner 2026-10-15: "/poke cli-site ... not listening right now ... this delay not ideal").
 *
 * A page is a slot message; an idle Claude Code session only reads slot mail when a turn starts
 * (the UserPromptSubmit slot-inbox hook). Nothing starts a turn in an idle session except input.
 * So `wake` is a slot CONTROL command (server-gated to a human org admin, never an agent) that the
 * session's own keeper runs: it types ONE FIXED LINE into the session's tmux pane, and only when
 * the pane is still and its prompt box is empty. The page text is never typed; the session reads
 * it through the normal slot path. Pure decisions live here; the keeper does the I/O.
 */

export const WAKE_TTL_MS = 10 * 60 * 1000; // a busy session is retried each control tick for this long
export const WAKE_COALESCE_MS = 60 * 1000; // repeat pokes inside this window do not type again
export const WAKE_SETTLE_MS = 2000; // two pane samples this far apart: any change = busy or a human typing

const SLOT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
// A box rule; the TOP one may carry the session title ("──── QUOXON ─", seen live 2026-10-15).
const RULE_RE = /^\s*─{8,}(?:.*─)?\s*$/;
const PROMPT_RE = /^\s*❯(?:[\s ]|$)/;
// FORCE-WAKE: captures are escape-aware (`capture-pane -e`). Claude Code draws its empty-box suggestion FAINT
// (ESC[2m) straight after the prompt; plain capture read it as a draft (proven live, v2.1.288, 2026-10-16).
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const PLACEHOLDER_RE = /❯[\s ]*(?:\x1b\[(?!2m)[0-9;]*m)*\x1b\[2m/;
const UNCAPTURABLE_RE = /\[(?:Pasted text|Image)\b/;
const plain = (line) => line.replace(ANSI_RE, '');

/** The only text a wake ever types. Names the slot, never carries the page. */
export function wakeText(slot) {
  if (typeof slot !== 'string' || !SLOT_RE.test(slot)) throw new Error(`not a slot name: ${JSON.stringify(slot)}`);
  return `[quox slot wake] a page is waiting on slot ${slot}: read it with \`quox slot read ${slot}\` and answer there with \`quox slot say ${slot}\`.`;
}

const flat = (s) => String(s).replace(/\s+/g, '');
/** WAKE-REAL: do these box lines (draftLines) hold exactly this slot's wake line, as Claude Code wrapped it? */
export function isWakeLine(lines, slot) {
  if (!Array.isArray(lines) || !lines.length || !SLOT_RE.test(String(slot || ''))) return false;
  return flat(lines.join('')) === flat(wakeText(slot));
}

// WAKE-REAL: what Claude Code (v2.1.288, seen live 2026-10-17) shows while a submitted line waits for a running
// turn: the line above the box with "ctrl+x ctrl+s to send now", and "Press up to edit queued messages" in it.
const QUEUED_RE = /Press up to edit queued|ctrl\+x ctrl\+s to send now/;
/** Did the last submit land in Claude Code's queue (session mid-turn) rather than start a turn? */
export function wakeQueued(text) {
  return typeof text === 'string' && QUEUED_RE.test(aboveFooter(text).split('\n').map(plain).join('\n'));
}

/**
 * The state of the LAST Claude Code prompt box on screen: 'empty', 'draft' (typing would send a
 * human's unsent text) or 'unknown' (no box: a dialog, menu or pager; never treated as empty).
 */
export function promptBoxState(text) {
  const lines = draftLines(text);
  if (lines === null) return 'unknown';
  return lines.join('\n').replace(/\u00a0/g, ' ').trim() ? 'draft' : 'empty';
}

/**
 * FORCE-WAKE: the last prompt box's draft as rendered, one entry per visual line (plain text, prompt
 * stripped, trailing spaces dropped); [] for an empty box (or the faint placeholder); null for no box.
 */
export function draftLines(text) {
  if (typeof text !== 'string' || !text) return null;
  const raw = text.split('\n');
  const lines = raw.map(plain);
  for (let i = lines.length - 1; i > 0; i -= 1) {
    if (!PROMPT_RE.test(lines[i]) || !RULE_RE.test(lines[i - 1])) continue;
    if (PLACEHOLDER_RE.test(raw[i])) return [];
    const body = [lines[i].replace(PROMPT_RE, '')];
    for (let j = i + 1; j < lines.length && !RULE_RE.test(lines[j]); j += 1) body.push(lines[j]);
    const out = body.map((l) => l.replace(/\u00a0/g, ' ').replace(/\s+$/, ''));
    while (out.length && !out[out.length - 1]) out.pop();
    return out.join('').trim() ? out : [];
  }
  return null;
}

/** The screen down to the last prompt box's closing rule: the footer below it ticks (shell counts,
 * agent timers) on an idle session, so it must not count as activity. No box = the whole screen. */
export function aboveFooter(text) {
  if (typeof text !== 'string') return text;
  const raw = text.split('\n');
  const lines = raw.map(plain);
  for (let i = lines.length - 1; i > 0; i -= 1) {
    if (!PROMPT_RE.test(lines[i]) || !RULE_RE.test(lines[i - 1])) continue;
    let j = i + 1;
    while (j < lines.length && !RULE_RE.test(lines[j])) j += 1;
    return raw.slice(0, Math.min(j + 1, raw.length)).join('\n');
  }
  return text;
}

/**
 * One wake attempt. before/after are two pane captures WAKE_SETTLE_MS apart (null = unreadable).
 * force (FORCE-WAKE, human-requested rows only): a draft yields { action: 'force' } instead of a refusal.
 * Returns { action: 'type' } | { action: 'force' } | { action: 'submit' } (our own stranded wake line) | { action: 'wait', reason } (leave the request pending) |
 * { action: 'done' | 'fail', result }.
 */
export function decideWake({ slot, before, after, firstSeenAt, nowMs, lastWokeAt = null, force = false }) {
  if (typeof before !== 'string' || typeof after !== 'string') return { action: 'fail', result: 'could not read the session pane' };
  if (lastWokeAt != null && nowMs - lastWokeAt < WAKE_COALESCE_MS) return { action: 'done', result: `already woken ${Math.round((nowMs - lastWokeAt) / 1000)}s ago` };
  const expired = nowMs - firstSeenAt > WAKE_TTL_MS;
  if (aboveFooter(before) !== aboveFooter(after)) {
    return expired ? { action: 'fail', result: `session still busy and the wake request is ${Math.floor((nowMs - firstSeenAt) / 60000)}m old (limit ${WAKE_TTL_MS / 60000}m); the page on ${slot} shows at its next prompt` } : { action: 'wait', reason: 'busy' };
  }
  const box = promptBoxState(after);
  // WAKE-REAL: the box holds OUR wake line, typed earlier but never submitted (Claude Code dropped its Enter;
  // QUOXON 2026-10-17 00:36:41, proven by sha c8d63692). It is not a human draft: submit it, never set it aside.
  if (box === 'draft' && isWakeLine(draftLines(after), slot)) return { action: 'submit' };
  if (box === 'draft' && force) {
    // FORCE-WAKE: a human wake sets the draft aside and puts it back unsent; only if it can be put back exactly.
    if (UNCAPTURABLE_RE.test(draftLines(after).join('\n'))) return { action: 'fail', result: 'not woken: the draft holds a collapsed pasted block or image, which cannot be set aside and put back exactly; the page shows at its next prompt' };
    return { action: 'force' };
  }
  if (box === 'draft') return { action: 'fail', result: 'not woken: an unsent draft is in the prompt box (typing would send it); the page shows at its next prompt' };
  if (box === 'unknown') {
    return expired ? { action: 'fail', result: `no empty prompt and the wake request is ${Math.floor((nowMs - firstSeenAt) / 60000)}m old (a dialog or menu is open); the page shows at its next prompt` } : { action: 'wait', reason: 'no prompt box' };
  }
  return { action: 'type' };
}
