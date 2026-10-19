/**
 * QUOXON-STEPUP: the human step-up PIN, TUI side.
 *
 * Why this exists: a typed "y" cannot prove a person typed it (an agent can drive this terminal, and some
 * hold a human profile's CLI login). The SERVER decides what needs a person (agent-raised or high-risk
 * approvals, policy overrides) and refuses with 403 step_up_required. This module only collects a PIN,
 * trades it for a short-lived step-up token (POST /api/me/step-up) and carries that token on the retry.
 * Nothing here is a security boundary on its own: it is the front half of a server-enforced check.
 *
 * The PIN rules, all deliberate:
 *   - the digits live in a closure box; they never enter dispatch, the composer buffer, history, the
 *     undo/redo stacks, the dev transcript, the observer, or any log; the box is zeroed on every exit
 *   - the card renders a COUNT of filled dots, never a digit
 *   - 3 wrong tries lock PIN entry for this window (the server also rate-limits per user and locks)
 *   - agent logins never get a PIN field: they are told a person must approve
 */
import { graphemes } from '../textBuffer.js';

export const WINDOW_MS = 10 * 60 * 1000;
export const MAX_TRIES = 3;
export const PIN_LEN = 6;
export const BEAT_MS = 300;       // cosmetic floor for the "verifying" beat; the request itself is real
export const RESULT_HOLD_MS = 900; // how long AUTHORISED / DENIED stays on screen
export const LOCK_MS = WINDOW_MS;  // local lock for this window after MAX_TRIES wrong tries
export const NEEDS_PERSON = 'needs a person: approve from your phone or a human session';
export const NO_PIN_LINE = 'Set a PIN in the dashboard: Settings > Account > Approval PIN';

/** The PIN digits. Closure only: no accessor but take(), nothing serialisable. */
export function createPinBox() {
  let d = '';
  return {
    push(t) { for (const ch of String(t || '')) { if (d.length >= PIN_LEN) break; if (ch >= '0' && ch <= '9') d += ch; } return d.length; },
    backspace() { d = d.slice(0, -1); return d.length; },
    clear() { d = ''; },
    count: () => d.length,
    take() { const out = d; d = ''; return out; },
    toJSON: () => '[pin]',
    toString: () => '[pin]',
    [Symbol.for('nodejs.util.inspect.custom')]: () => '[pin]'
  };
}

export const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Terminal cell width: emoji-presentation glyphs take two cells. */
export function cellWidth(s) {
  let w = 0;
  for (const g of graphemes(String(s ?? ''))) w += /\p{Emoji_Presentation}/u.test(g.text) ? 2 : 1;
  return w;
}



/** One-line collapse under this many columns. */
export const NARROW_COLS = 50;
export const CARD_W = 58;
/** Below this many columns the card is drawn still: no pulse, no shimmer. */
export const ANIM_MIN_COLS = 60;

/** Word-wrap to `w` cells; a word longer than a line is split, nothing is ever dropped. */
export function wrapCells(text, w) {
  const out = []; let cur = '';
  const push = () => { if (cur) out.push(cur); cur = ''; };
  for (const word of String(text ?? '').split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (cellWidth(rest) > w) { // hard-split an over-long word
      push(); let part = ''; let n = 0;
      for (const g of graphemes(rest)) { const gw = cellWidth(g.text); if (n + gw > w) break; part += g.text; n += gw; }
      out.push(part); rest = rest.slice(part.length);
    }
    if (!rest) continue;
    if (cur && cellWidth(cur) + 1 + cellWidth(rest) > w) push();
    cur = cur ? `${cur} ${rest}` : rest;
  }
  push();
  return out;
}

/**
 * Pure: the card as lines of [{ text, role? }] segments. roles: gold (frame, title, filled slots, countdown),
 * prose (ink, empty slots, subject), ok, error, key (the per-digit pulse and the verifying sweep). Never grey.
 * `view` carries counts only, never digits. Optional animation inputs, both plain numbers: `pulse` (slot index
 * just filled) and `tick` (shimmer frame). Without them the card is static, which is what narrow, slow and
 * NO_COLOR terminals get.
 */
export function cardLines(view, cols) {
  const { phase, filled = 0, subject = {}, tries = MAX_TRIES, offset = 0, until = 0, now = 0, error = null, pulse = -1, tick = null } = view;
  const shown = phase === 'verifying' || phase === 'ok' ? PIN_LEN : filled; // the box was taken at submit: 6 were typed
  const dots = Array.from({ length: PIN_LEN }, (_, i) => (i < shown ? '●' : '○'));
  const shift = offset ? 1 : 0; // the "tiny shake": one redraw one cell to the right
  const verifyText = '▰▰▰▰ verifying';
  const status = (() => {
    switch (phase) {
      case 'verifying': {
        if (tick == null) return [{ text: verifyText, role: 'gold' }];
        const chars = [...verifyText]; const at = tick % (chars.length + 3);
        return chars.map((ch, i) => ({ text: ch, role: i >= at - 2 && i <= at ? 'text' : 'gold' }));
      }
      case 'ok': return [{ text: '✔ AUTHORISED', role: 'ok' }, { text: ` · human present for ${mmss(until - now)}`, role: 'gold' }];
      case 'denied': return [{ text: `✖ DENIED · ${tries} ${tries === 1 ? 'try' : 'tries'} left`, role: 'error' }];
      case 'locked': return [{ text: '⛔ LOCKED · use your phone or a human session', role: 'error' }];
      case 'nopin': return [{ text: NO_PIN_LINE, role: 'error' }];
      case 'agent': return [{ text: NEEDS_PERSON, role: 'error' }];
      default: return null;
    }
  })();
  const pinSeg = [{ text: 'PIN  ', role: 'prose' }, ...dots.flatMap((d, i) => [{ text: d, role: d === '●' ? 'gold' : 'prose' }, { text: i < PIN_LEN - 1 ? ' ' : '', role: 'prose' }])];
  const segW = (segs) => segs.reduce((n, s) => n + cellWidth(s.text), 0);
  const riskSeg = (r) => (r === 'high' || r === 'urgent' ? { text: String(r), role: 'error' } : { text: String(r), role: 'prose' });

  if (cols < NARROW_COLS) { // one line: no frame, nothing lost that matters
    const head = [{ text: '🔐 ', role: 'gold' }];
    if (status) return [[...head, ...status]];
    return [[...head, ...pinSeg, { text: ' · Esc cancels', role: 'prose' }]];
  }

  const W = Math.min(CARD_W, cols);
  const inner = W - 2;
  const row = (segs, sh = 0) => { // │ + content centred + │; `sh` nudges it right (the shake)
    const used = segW(segs);
    const lp = Math.max(0, Math.floor((inner - used) / 2) + sh);
    return [{ text: '│', role: 'gold' }, { text: ' '.repeat(lp), role: 'prose' }, ...segs, { text: ' '.repeat(Math.max(0, inner - used - lp)), role: 'prose' }, { text: '│', role: 'gold' }];
  };
  const blank = () => row([{ text: '', role: 'prose' }]);
  const title = view.title || 'AUTHORISATION REQUIRED';
  const topHead = `╭─ 🔐 ${title} `;
  const top = [{ text: topHead + '─'.repeat(Math.max(1, W - 1 - cellWidth(topHead))) + '╮', role: 'gold' }];
  const footText = phase === 'locked' || phase === 'agent' || phase === 'nopin' ? ' esc closes ' : ' a person must confirm this · Esc cancels ';
  const foot = [{ text: '╰─' + footText + '─'.repeat(Math.max(1, W - 3 - cellWidth(footText))) + '╯', role: 'gold' }];

  // The six PIN slots: three rows tall, heavy gold border once filled, a teal flash on the digit just typed,
  // a teal sweep while verifying, green ticks when authorised, red when denied.
  const slotRows = () => {
    const rows = [[], [], []];
    for (let i = 0; i < PIN_LEN; i++) {
      const full = i < shown;
      let role = full ? 'gold' : 'prose'; let mid = full ? '◉' : ' ';
      if (phase === 'input' && i === pulse && full) role = 'key';
      if (phase === 'verifying' && tick != null && i === tick % (PIN_LEN + 2)) role = 'key';
      if (phase === 'ok') { role = 'ok'; mid = '✔'; }
      if (phase === 'denied') { role = 'error'; mid = '✖'; }
      const heavy = full || phase === 'denied';
      const [t, m, b] = heavy ? ['┏━━━┓', `┃ ${mid} ┃`, '┗━━━┛'] : ['╭───╮', '│   │', '╰───╯'];
      const gap = i < PIN_LEN - 1 ? ' ' : '';
      rows[0].push({ text: t + gap, role }); rows[1].push({ text: m + gap, role }); rows[2].push({ text: b + gap, role });
    }
    return rows.map((r) => row(r, shift));
  };

  const out = [top, blank()];
  const innerW = inner - 4;
  for (const l of wrapCells(subject.line1 || '', innerW)) out.push(row([{ text: l, role: 'prose' }]));
  if (subject.raisedBy || subject.risk) {
    const segs = [];
    if (subject.raisedBy) segs.push({ text: `raised by ${subject.raisedBy}`, role: 'prose' });
    if (subject.risk) segs.push({ text: subject.raisedBy ? ' · risk ' : 'risk ', role: 'prose' }, riskSeg(subject.risk));
    if (segW(segs) <= innerW) out.push(row(segs));
    else { // too wide for one row: raised-by wraps, risk gets its own row
      if (subject.raisedBy) for (const l of wrapCells(`raised by ${subject.raisedBy}`, innerW)) out.push(row([{ text: l, role: 'prose' }]));
      if (subject.risk) out.push(row([{ text: 'risk ', role: 'prose' }, riskSeg(subject.risk)]));
    }
  }
  out.push(blank());
  if (phase === 'input' || phase === 'denied' || phase === 'verifying') {
    out.push(...slotRows());
    out.push(row([...pinSeg], shift));
    out.push(blank());
  }
  if (phase === 'ok') { out.push(...slotRows()); out.push(blank()); }
  if (phase !== 'input') out.push(row(status, shift));
  if (phase === 'ok') out.push(blank());
  if (error) for (const l of wrapCells(error, innerW)) out.push(row([{ text: l, role: 'error' }]));
  out.push(foot);
  return out;
}

/**
 * The controller (same shape as the /login and /connect controllers: isOpen / view / onEvent).
 *   deps.api            { stepUpVerify(pin, {orgId, scopes}) }  -> { step_up_token, expires_at, scopes }
 *   deps.agentLogin     this window is an agent login: no PIN field, ever
 *   deps.refresh        re-render
 *   deps.note           (text, tone) -> a line to the transcript pane (never carries digits)
 *   deps.emit           dispatch({ type: 'stepup.result', ok })  (sound cue; carries no digits)
 */
export function createStepUp({ api, agentLogin = false, onAgentLogin = () => {}, refresh = () => {}, note = () => {}, emit = () => {}, settingsUrl = () => null, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const box = createPinBox();
  let card = null;
  let resolveCard = null;
  let tries = MAX_TRIES;
  let lockedUntil = 0;
  let busy = false;
  const tokens = new Map(); // scope -> { token, until }
  let presentUntil = 0;     // set only by /authenticate: the "human present" window shown in the status bar

  const finish = (result) => { box.clear(); const r = resolveCard; card = null; resolveCard = null; busy = false; refresh(); r?.(result); };
  const live = (scope) => { const t = tokens.get(scope); if (t && t.until > now()) return t; tokens.delete(scope); return null; };

  async function submit() {
    if (busy || !card) return;
    try { await submitInner(); } finally { busy = false; }
  }
  async function submitInner() {
    const pin = box.take(); // out of the box in one move; the local `pin` is dropped when this function returns
    busy = true; card.phase = 'verifying'; card.filled = 0; refresh();
    const t0 = now();
    let res = null; let err = null;
    try { res = await api.stepUpVerify(pin, { orgId: card.orgId, scopes: card.scopes }); }
    catch (e) { err = e; }
    const waited = now() - t0;
    if (waited < BEAT_MS) await sleep(BEAT_MS - waited); // cosmetic floor only; a slow call is never padded
    if (!card) return;
    if (res?.step_up_token) {
      const until = now() + WINDOW_MS;
      for (const s of res.scopes || card.scopes) tokens.set(s, { token: res.step_up_token, until });
      if (card.window) presentUntil = until;
      card.phase = 'ok'; card.until = until; card.now = now(); refresh(); emit({ type: 'stepup.result', ok: true });
      await sleep(RESULT_HOLD_MS);
      return finish({ ok: true, token: res.step_up_token, scopes: res.scopes || card.scopes });
    }
    const status = err?.status; const code = err?.body?.error || err?.code;
    if (status === 409 || code === 'no_pin_set') { card.phase = 'nopin'; Promise.resolve(settingsUrl()).then((u) => note(u ? `${NO_PIN_LINE} (${u})` : NO_PIN_LINE, 'warn')).catch(() => {}); refresh(); emit({ type: 'stepup.result', ok: false }); return; }
    if (status === 423 || code === 'pin_locked') { lockedUntil = now() + LOCK_MS; card.phase = 'locked'; refresh(); emit({ type: 'stepup.result', ok: false }); return; }
    if (status === 401 || code === 'wrong_pin') {
      tries = Number.isFinite(err?.body?.tries_left) ? Math.min(tries - 1, err.body.tries_left) : tries - 1;
      emit({ type: 'stepup.result', ok: false });
      if (tries <= 0) { lockedUntil = now() + LOCK_MS; card.phase = 'locked'; refresh(); return; }
      card.phase = 'denied'; card.tries = tries; card.offset = 1; refresh();
      await sleep(80); if (!card) return; card.offset = 0; refresh();
      await sleep(RESULT_HOLD_MS - 80); if (!card) return;
      card.phase = 'input'; card.error = null; refresh();
      return;
    }
    if (status === 403 && (code === 'step_up_human_only')) { card.phase = 'agent'; refresh(); return; }
    card.phase = 'input'; card.error = (err?.message || 'could not verify').replace(/\s+/g, ' ').slice(0, 80); refresh();
  }

  return {
    /** Live token for a scope, or null. */
    token: (scope) => live(scope)?.token || null,
    headers: (scope) => { const t = live(scope); return t ? { 'x-step-up-token': t.token } : {}; },
    presentMs: () => Math.max(0, presentUntil - now()),
    drop(scope) { tokens.delete(scope); },
    clear() { tokens.clear(); presentUntil = 0; box.clear(); },
    isOpen: () => Boolean(card),
    view() { return card ? { ...card, filled: box.count(), tries, now: now() } : null; },
    /**
     * Ask for a person. Resolves { ok, token?, reason? } and never throws. Reuses a live token for the scope.
     * opts: { scope: 'approve'|'override', scopes?, orgId?, subject?, window?: true (the /authenticate window) }
     */
    request({ scope = 'approve', scopes = null, orgId = null, subject = {}, window: asWindow = false, title = null } = {}) {
      if (typeof agentLogin === 'function' ? agentLogin() : agentLogin) { note(`This window is an agent login: ${NEEDS_PERSON}.`, 'warn'); onAgentLogin(); return Promise.resolve({ ok: false, reason: 'agent_login' }); }
      if (!asWindow && live(scope)) return Promise.resolve({ ok: true, token: live(scope).token, scopes: [scope], reused: true });
      if (card) return Promise.resolve({ ok: false, reason: 'busy' });
      if (lockedUntil > now()) { note(`⛔ LOCKED · PIN entry is locked for ${mmss(lockedUntil - now())}. Use your phone or a human session.`, 'error'); return Promise.resolve({ ok: false, reason: 'locked' }); }
      tries = MAX_TRIES;
      box.clear();
      card = { phase: 'input', subject, title, scope, scopes: scopes || (asWindow ? ['approve', 'override'] : [scope]), orgId, window: asWindow, error: null, offset: 0 };
      refresh();
      return new Promise((r) => { resolveCard = r; });
    },
    onEvent(e) {
      if (!card) return false;
      if (busy || card.phase === 'verifying' || card.phase === 'ok' || card.phase === 'denied') return true; // swallowed while the call is in flight and during the DENIED beat
      const ph = card.phase;
      if (ph === 'locked' || ph === 'nopin' || ph === 'agent') { if (e.type === 'key' && (e.name === 'escape' || e.name === 'enter' || e.name === 'ctrl-c')) finish({ ok: false, reason: ph }); return true; }
      if (e.type === 'paste' || e.type === 'text') { box.push(e.text); if (box.count() >= PIN_LEN) submit(); else refresh(); return true; }
      if (e.type !== 'key') return true;
      if (e.name === 'escape' || e.name === 'ctrl-c') { finish({ ok: false, reason: 'cancelled' }); return true; }
      if (e.name === 'backspace') { box.backspace(); refresh(); return true; }
      if (e.name === 'kill-line' || e.name === 'delete-word') { box.clear(); refresh(); return true; }
      return true; // every other key is swallowed: nothing falls through to the composer
    }
  };
}
